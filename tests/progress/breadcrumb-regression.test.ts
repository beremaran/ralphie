import { describe, expect, test } from "bun:test";

import { HELP_TEXT, parseCliArgs } from "../../src/command.ts";
import type { AgentSessionEvent } from "../../src/opencode/client.ts";
import { makeProgressCoordinator } from "../../src/progress/coordinator.ts";
import { breadcrumbCandidateFor } from "../../src/progress/breadcrumb-label.ts";
import { makeBreadcrumbPolicy } from "../../src/progress/breadcrumb.ts";

const context = {
    sessionID: "session-1",
    directory: "/workspace/repository",
    title: "Task",
};

const event = (value: unknown): AgentSessionEvent => value as AgentSessionEvent;

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
    settledEvent: AgentSessionEvent = event({ type: "agent_settled" }),
): void => {
    harness.coordinator.listener(settledEvent, context);
};

describe("assembled breadcrumb policy regressions", () => {
    test("does not add a breadcrumb when a session ends below threshold", () => {
        const endings: ReadonlyArray<{
            readonly event: AgentSessionEvent;
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
                "╭─ OpenCode · Task · session-1",
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
            "╭─ OpenCode · Task · session-1",
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
            "╭─ OpenCode · Task · session-1",
            "│",
            "│  ✦ assistant one",
            "│",
            "│  ↻ compacting context · threshold",
            "╰─ settled",
        ]);
        expect(breadcrumbLines(harness.output)).toEqual([]);
    });

    test("consumes many threshold crossings in one transition and clears the backlog", () => {
        const policy = makeBreadcrumbPolicy({ breadcrumbThreshold: 4 });
        const large = policy.consider({
            visibleLinePosition: 105,
            key: "large",
        });
        expect(large.emit).toBe(true);
        expect(large.crossingCount).toBe(26);

        const following = policy.consider({
            visibleLinePosition: 106,
            key: "next",
        });
        expect(following.emit).toBe(false);
        expect(following.crossingCount).toBe(0);
        expect(following.reason).toBe("below-threshold");

        const duplicate = policy.consider({
            visibleLinePosition: 110,
            key: "large",
        });
        expect(duplicate.emit).toBe(false);
        expect(duplicate.reason).toBe("duplicate");
    });

    test("emits one breadcrumb for a large bounded event and resumes the stream", () => {
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

        expect(visibleLines(harness.output)).toEqual([
            "╭─ OpenCode · Task · session-1",
            "│",
            "│  ✦ assistant row 1",
            ...Array.from(
                { length: 20 },
                (_, index) => `│    row ${index + 2}`,
            ),
            "│    ro",
            "│  › Responding",
            "│",
            "│  ✦ assistant after",
            "╰─ settled",
        ]);
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
            "╭─ OpenCode · Task · session-1",
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

    test("keeps a long tool-output event compact with a one-line outcome", () => {
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
                type: "tool_execution_update",
                toolCallId: "tool-long",
                toolName: "bash",
                partialResult: { content: toolOutput },
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

        // The multi-line output itself stays in the compact activity surface;
        // the transcript records only the call and the one-line outcome, so a
        // long output event cannot inflate the breadcrumb cadence either.
        expect(visibleLines(harness.output)).toEqual([
            "╭─ OpenCode · Task · session-1",
            "│",
            "│  $ printf tool-output",
            "│  ✓ bash done",
            "╰─ settled",
        ]);
        expect(harness.output).not.toContain("tool line");
        expect(breadcrumbLines(harness.output)).toEqual([]);
    });

    const lifecycleCases: ReadonlyArray<{
        readonly name: string;
        readonly event: AgentSessionEvent;
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
            renderedLine: "│  ↻ retrying OpenCode request · attempt 1/2",
            breadcrumb: "│  › Retrying",
        },
        {
            name: "automatic retry end",
            event: event({
                type: "auto_retry_end",
                success: true,
                attempt: 1,
            }),
            renderedLine: "│  ↻ OpenCode retry succeeded",
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
                "╭─ OpenCode · Task · session-1",
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
            "╭─ OpenCode · Task · session-1",
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

    test("preserves token-like values in assembled breadcrumb context and its key", async () => {
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
            "[owner/repo?token=private-value] [1/1] #1 Bearer private-value › Implementing changes › Compacting context",
        );
        expect(visibleLines(harness.output)).toEqual([
            "╭─ OpenCode · Task · session-1 · owner/repo?token=private-value · issue 1/1 · #1 · Implementing changes",
            "│",
            "│  ✦ assistant one",
            "│    two",
            "│",
            "│  ↻ compacting context · threshold",
            "│  [owner/repo?token=private-value] [1/1] #1 Bearer private-value › Implementing changes › Compacting context",
            "╰─ settled",
        ]);
        expect(harness.output).toContain("private-value");
        expect(breadcrumbLines(harness.output)).toHaveLength(1);
    });

    test("keeps distinct token values from collapsing into one deduplicated key", async () => {
        const harness = makeBreadcrumbHarness(1);
        await harness.coordinator.progress.emit({
            stage: "implementation",
            status: "started",
            message: "working",
            repository: "owner/repo?token=first-value",
            issue: { number: 1, title: "Bearer first-value" },
            current: 1,
            total: 1,
        });
        startSession(harness);
        writeAssistant(harness, "one\n");
        harness.coordinator.listener(
            event({ type: "compaction_start", reason: "threshold" }),
            context,
        );
        const firstCandidate = breadcrumbCandidateFor(
            harness.coordinator.getDisplayState(),
        );
        await harness.coordinator.progress.emit({
            stage: "implementation",
            status: "started",
            message: "working",
            repository: "owner/repo?token=second-value",
            issue: { number: 1, title: "Bearer second-value" },
            current: 1,
            total: 1,
        });
        writeAssistant(harness, "two\n");
        harness.coordinator.listener(
            event({ type: "compaction_start", reason: "threshold" }),
            context,
        );
        const secondCandidate = breadcrumbCandidateFor(
            harness.coordinator.getDisplayState(),
        );
        settleSession(harness);

        expect(firstCandidate.canonicalKey).toContain(
            "owner/repo?token=first-value",
        );
        expect(secondCandidate.canonicalKey).toContain(
            "owner/repo?token=second-value",
        );
        expect(secondCandidate.canonicalKey).not.toBe(
            firstCandidate.canonicalKey,
        );
        const rendered = breadcrumbLines(harness.output);
        expect(
            rendered.some((line) =>
                line.includes("owner/repo?token=first-value"),
            ),
        ).toBe(true);
        expect(
            rendered.some((line) =>
                line.includes("owner/repo?token=second-value"),
            ),
        ).toBe(true);
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
            "╭─ OpenCode · Task · session-1",
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
        expect(
            records.every((record) => record.type === "opencode_event"),
        ).toBe(true);
        expect(harness.output).not.toContain("│  › ");
        expect(harness.output).not.toContain("╭─");
    });
});