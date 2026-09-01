import { describe, expect, test } from "bun:test";

import { HELP_TEXT, parseCliArgs } from "../../src/command.ts";
import type { CodexSessionEvent } from "../../src/codex/client.ts";
import { makeProgressCoordinator } from "../../src/progress/coordinator.ts";
import { breadcrumbCandidateFor } from "../../src/progress/breadcrumb-label.ts";

const context = {
    sessionID: "session-1",
    directory: "/workspace/repository",
    title: "Task",
};

const event = (value: unknown): CodexSessionEvent => value as CodexSessionEvent;

type BreadcrumbHarness = ReturnType<typeof makeBreadcrumbHarness>;

const makeBreadcrumbHarness = (
    breadcrumbThreshold = 4,
    mode: "plain" | "json" = "plain",
) => {
    let output = "";
    const coordinator = makeProgressCoordinator({
        mode,
        verbose: false,
        colors: false,
        width: () => 120,
        breadcrumbThreshold,
        write: (text) => {
            output += text;
        },
    });
    return {
        coordinator,
        get output() {
            return output;
        },
        clearOutput: () => {
            output = "";
        },
    };
};

const visibleLines = (output: string): ReadonlyArray<string> =>
    output.trimEnd().split("\n");

const breadcrumbLines = (output: string): ReadonlyArray<string> =>
    visibleLines(output).filter((line) => line.includes("› "));

const startSession = (harness: BreadcrumbHarness): void => {
    harness.coordinator.listener(event({ type: "agent_start" }), context);
};

const writeAssistant = (
    harness: BreadcrumbHarness,
    delta: string,
    contentIndex?: number,
): void => {
    harness.coordinator.listener(
        event({
            type: "message_update",
            assistantMessageEvent: {
                type: "text_delta",
                ...(contentIndex === undefined ? {} : { contentIndex }),
                delta,
            },
        }),
        context,
    );
};

const settleSession = (
    harness: BreadcrumbHarness,
    settledEvent: CodexSessionEvent = event({ type: "agent_settled" }),
): void => {
    harness.coordinator.listener(settledEvent, context);
};

describe("assembled breadcrumb policy regressions", () => {
    test("does not add a breadcrumb when a session ends below threshold", () => {
        const endings: ReadonlyArray<{
            readonly event: CodexSessionEvent;
            readonly footer: string;
        }> = [
            {
                event: event({ type: "agent_end", willRetry: false }),
                footer: "╰─ done",
            },
            {
                event: event({ type: "agent_end", willRetry: true }),
                footer: "╰─ retrying…",
            },
            {
                event: event({ type: "agent_settled" }),
                footer: "╰─ settled",
            },
        ];

        for (const ending of endings) {
            const harness = makeBreadcrumbHarness();
            startSession(harness);
            writeAssistant(harness, "one");
            settleSession(harness, ending.event);

            expect(visibleLines(harness.output)).toEqual([
                "╭─ Codex · Task · session-1",
                "│",
                "│  ✦ assistant one",
                ending.footer,
            ]);
            expect(breadcrumbLines(harness.output)).toEqual([]);
        }
    });

    test("emits at the exact assembled visible-line threshold", () => {
        const harness = makeBreadcrumbHarness();
        startSession(harness);
        writeAssistant(harness, "one\ntwo\nthree\nfour\n");
        settleSession(harness);

        expect(visibleLines(harness.output)).toEqual([
            "╭─ Codex · Task · session-1",
            "│",
            "│  ✦ assistant one",
            "│    two",
            "│    three",
            "│    four",
            "│  › Responding",
            "╰─ settled",
        ]);
        expect(breadcrumbLines(harness.output)).toEqual(["│  › Responding"]);
    });

    test("suppresses a lifecycle candidate when accumulation is insufficient", () => {
        const harness = makeBreadcrumbHarness();
        startSession(harness);
        writeAssistant(harness, "one");
        harness.coordinator.listener(
            event({ type: "compaction_start", reason: "threshold" }),
            context,
        );
        settleSession(harness);

        expect(visibleLines(harness.output)).toEqual([
            "╭─ Codex · Task · session-1",
            "│",
            "│  ✦ assistant one",
            "│",
            "│  ↻ compacting context · threshold",
            "╰─ settled",
        ]);
        expect(breadcrumbLines(harness.output)).toEqual([]);
    });

    test("handles more than 100 visible lines and clears the consumed backlog", () => {
        const rows = Array.from(
            { length: 101 },
            (_, index) => `row ${index + 1}`,
        );
        const harness = makeBreadcrumbHarness();
        startSession(harness);
        writeAssistant(harness, rows.join("\n"));
        const afterLargeEvent = harness.output;

        harness.coordinator.listener(event({ type: "turn_end" }), context);
        expect(harness.output).toBe(afterLargeEvent);

        writeAssistant(harness, "after", 1);
        settleSession(harness);

        const expectedRows = [
            "╭─ Codex · Task · session-1",
            "│",
            "│  ✦ assistant row 1",
            ...rows.slice(1).map((row) => `│    ${row}`),
            "│  › Responding",
            "│",
            "│  ✦ assistant after",
            "╰─ settled",
        ];
        const lines = visibleLines(harness.output);
        expect(lines).toEqual(expectedRows);
        expect(lines.length).toBe(107);
        expect(lines.length).toBeGreaterThan(100);
        expect(breadcrumbLines(harness.output)).toEqual(["│  › Responding"]);
    });

    test("prefers a lifecycle candidate over a pending periodic candidate", () => {
        const harness = makeBreadcrumbHarness(3);
        startSession(harness);
        // The assistant block leaves the periodic Responding candidate pending.
        writeAssistant(harness, "periodic one\nperiodic two");
        // Compaction crosses the cadence boundary. Responding and Compacting
        // context are both candidates at this transcript boundary, but the
        // lifecycle candidate must win.
        harness.coordinator.listener(
            event({ type: "compaction_start", reason: "threshold" }),
            context,
        );
        settleSession(harness);

        expect(visibleLines(harness.output)).toEqual([
            "╭─ Codex · Task · session-1",
            "│",
            "│  ✦ assistant periodic one",
            "│    periodic two",
            "│",
            "│  ↻ compacting context · threshold",
            "│  › Compacting context",
            "╰─ settled",
        ]);
        const breadcrumbs = breadcrumbLines(harness.output);
        expect(breadcrumbs).toEqual(["│  › Compacting context"]);
        expect(breadcrumbs).not.toContain("│  › Responding");
    });

    test("renders one breadcrumb for a single long tool-output event", () => {
        const harness = makeBreadcrumbHarness();
        const toolOutput = Array.from(
            { length: 14 },
            (_, index) => `tool line ${index + 1}`,
        ).join("\n");

        startSession(harness);
        harness.coordinator.listener(
            event({
                type: "tool_execution_start",
                toolCallId: "tool-long",
                toolName: "bash",
                args: { command: "printf tool-output" },
            }),
            context,
        );
        harness.coordinator.listener(
            event({
                type: "tool_execution_end",
                toolCallId: "tool-long",
                toolName: "bash",
                isError: false,
                result: { content: [{ type: "text", text: toolOutput }] },
            }),
            context,
        );
        settleSession(harness);

        expect(visibleLines(harness.output)).toEqual([
            "╭─ Codex · Task · session-1",
            "│",
            "│  $ printf tool-output",
            ...Array.from(
                { length: 12 },
                (_, index) => `│    tool line ${index + 1}`,
            ),
            "│    … output truncated",
            "│  ✓ bash done · 14 lines · truncated",
            "│  › Waiting",
            "╰─ settled",
        ]);
        expect(breadcrumbLines(harness.output)).toEqual(["│  › Waiting"]);
    });

    const lifecycleCases: ReadonlyArray<{
        readonly name: string;
        readonly event: CodexSessionEvent;
        readonly renderedLine: string;
        readonly breadcrumb: string;
    }> = [
        {
            name: "compaction start",
            event: event({ type: "compaction_start", reason: "threshold" }),
            renderedLine: "│  ↻ compacting context · threshold",
            breadcrumb: "│  › Compacting context",
        },
        {
            name: "compaction end",
            event: event({
                type: "compaction_end",
                reason: "threshold",
                result: undefined,
                aborted: false,
                willRetry: false,
            }),
            renderedLine: "│  ↻ context compaction done",
            breadcrumb: "│  › Waiting",
        },
        {
            name: "automatic retry start",
            event: event({
                type: "auto_retry_start",
                attempt: 1,
                maxAttempts: 2,
                delayMs: 10,
                errorMessage: "temporary",
            }),
            renderedLine: "│  ↻ retrying Codex request · attempt 1/2",
            breadcrumb: "│  › Retrying",
        },
        {
            name: "automatic retry end",
            event: event({
                type: "auto_retry_end",
                success: true,
                attempt: 1,
            }),
            renderedLine: "│  ↻ Codex retry succeeded",
            breadcrumb: "│  › Waiting",
        },
        {
            name: "scheduled summary retry",
            event: event({
                type: "summarization_retry_scheduled",
                attempt: 1,
                maxAttempts: 2,
                delayMs: 10,
                errorMessage: "temporary",
            }),
            renderedLine: "│  ↻ retrying context summary · attempt 1/2",
            breadcrumb: "│  › Retrying",
        },
        {
            name: "summary retry attempt from a branch",
            event: event({
                type: "summarization_retry_attempt_start",
                source: "branchSummary",
            }),
            renderedLine: "│  ↻ retrying context summary",
            breadcrumb: "│  › Retrying",
        },
        {
            name: "summary retry attempt from compaction",
            event: event({
                type: "summarization_retry_attempt_start",
                source: "compaction",
                reason: "overflow",
            }),
            renderedLine: "│  ↻ retrying context summary",
            breadcrumb: "│  › Retrying",
        },
        {
            name: "summary retry finished",
            event: event({ type: "summarization_retry_finished" }),
            renderedLine: "│  ↻ context summary finished",
            breadcrumb: "│  › Waiting",
        },
    ];

    for (const lifecycleCase of lifecycleCases) {
        test(`arbitrates the lifecycle candidate for ${lifecycleCase.name}`, () => {
            const harness = makeBreadcrumbHarness();
            startSession(harness);
            writeAssistant(harness, "one\ntwo");
            harness.coordinator.listener(lifecycleCase.event, context);
            settleSession(harness);

            expect(visibleLines(harness.output)).toEqual([
                "╭─ Codex · Task · session-1",
                "│",
                "│  ✦ assistant one",
                "│    two",
                "│",
                lifecycleCase.renderedLine,
                lifecycleCase.breadcrumb,
                "╰─ settled",
            ]);
            expect(breadcrumbLines(harness.output)).toEqual([
                lifecycleCase.breadcrumb,
            ]);
        });
    }

    test("de-duplicates adjacent canonical lifecycle keys without dropping cadence", () => {
        const harness = makeBreadcrumbHarness(2);
        startSession(harness);
        writeAssistant(harness, "one");
        const compactionStart = event({
            type: "compaction_start",
            reason: "threshold",
        });
        harness.coordinator.listener(compactionStart, context);
        harness.coordinator.listener(compactionStart, context);
        harness.coordinator.listener(
            event({
                type: "compaction_end",
                reason: "threshold",
                result: undefined,
                aborted: false,
                willRetry: false,
            }),
            context,
        );
        settleSession(harness);

        expect(visibleLines(harness.output)).toEqual([
            "╭─ Codex · Task · session-1",
            "│",
            "│  ✦ assistant one",
            "│",
            "│  ↻ compacting context · threshold",
            "│  › Compacting context",
            "│",
            "│  ↻ compacting context · threshold",
            "│",
            "│  ↻ context compaction done",
            "│  › Waiting",
            "╰─ settled",
        ]);
        expect(breadcrumbLines(harness.output)).toEqual([
            "│  › Compacting context",
            "│  › Waiting",
        ]);
    });

    test("redacts secrets in assembled breadcrumb context and its key", async () => {
        const harness = makeBreadcrumbHarness();
        await harness.coordinator.progress.emit({
            stage: "implementation",
            status: "started",
            message: "working",
            repository: "owner/repo?token=private-value",
            issue: { number: 1, title: "Bearer private-value" },
            current: 1,
            total: 1,
        });
        harness.clearOutput();
        startSession(harness);
        writeAssistant(harness, "one\ntwo");
        harness.coordinator.listener(
            event({ type: "compaction_start", reason: "threshold" }),
            context,
        );
        const candidate = breadcrumbCandidateFor(
            harness.coordinator.getDisplayState(),
        );
        settleSession(harness);

        expect(candidate.canonicalKey).toBe(
            "[owner/repo?token=[REDACTED]] [1/1] #1 Bearer [REDACTED] › Implementing changes › Compacting context",
        );
        expect(visibleLines(harness.output)).toEqual([
            "╭─ Codex · Task · session-1 · owner/repo?token=[REDACTED] · issue 1/1 · #1 · Implementing changes",
            "│",
            "│  ✦ assistant one",
            "│    two",
            "│",
            "│  ↻ compacting context · threshold",
            "│  [owner/repo?token=[REDACTED]] [1/1] #1 Bearer [REDACTED] › Implementing changes › Compacting context",
            "╰─ settled",
        ]);
        expect(harness.output).not.toContain("private-value");
        expect(breadcrumbLines(harness.output)).toHaveLength(1);
    });

    test("resumes an incomplete assistant stream after automatic insertion", () => {
        const harness = makeBreadcrumbHarness();
        startSession(harness);
        writeAssistant(harness, "one\ntwo");
        harness.coordinator.listener(
            event({ type: "compaction_start", reason: "threshold" }),
            context,
        );
        writeAssistant(harness, "after");
        settleSession(harness);

        expect(visibleLines(harness.output)).toEqual([
            "╭─ Codex · Task · session-1",
            "│",
            "│  ✦ assistant one",
            "│    two",
            "│",
            "│  ↻ compacting context · threshold",
            "│  › Compacting context",
            "│    after",
            "╰─ settled",
        ]);
        expect(breadcrumbLines(harness.output)).toEqual([
            "│  › Compacting context",
        ]);
    });

    test("keeps the default CLI and output-mode surface free of breadcrumb options", () => {
        const defaults = parseCliArgs(["owner/repository"]).options;
        expect(defaults).toMatchObject({
            verbose: false,
            json: false,
            quiet: false,
        });
        expect(defaults).not.toHaveProperty("breadcrumbThreshold");
        expect(HELP_TEXT).toContain("--output <mode>");
        expect(HELP_TEXT).not.toContain("breadcrumb");

        expect(
            parseCliArgs(["owner/repository", "--output", "verbose"]).options,
        ).toMatchObject({ verbose: true, json: false, quiet: false });
        expect(
            parseCliArgs(["owner/repository", "--output", "json"]).options,
        ).toMatchObject({ verbose: false, json: true, quiet: false });
        expect(
            parseCliArgs(["owner/repository", "--output", "quiet"]).options,
        ).toMatchObject({ verbose: false, json: false, quiet: true });
    });

    test("keeps breadcrumbs out of JSON output", () => {
        const harness = makeBreadcrumbHarness(1, "json");
        startSession(harness);
        writeAssistant(harness, "one\ntwo");
        settleSession(harness);

        const records = visibleLines(harness.output).map((line) =>
            JSON.parse(line),
        );
        expect(records.map((record) => record.event.type)).toEqual([
            "agent_start",
            "message_update",
            "agent_settled",
        ]);
        expect(records.every((record) => record.type === "codex_event")).toBe(
            true,
        );
        expect(harness.output).not.toContain("│  › ");
        expect(harness.output).not.toContain("╭─");
    });
});