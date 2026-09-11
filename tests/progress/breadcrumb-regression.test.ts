import { describe, expect, test } from "bun:test";

import { HELP_TEXT, parseCliArgs } from "../../src/command.ts";
import type { AgentSessionEvent } from "../../src/core/ports/agent.ts";
import { makeProgressCoordinator } from "../../src/adapters/progress/coordinator.ts";
import { breadcrumbCandidateFor } from "../../src/adapters/progress/breadcrumb-label.ts";
import { makeBreadcrumbPolicy } from "../../src/adapters/progress/breadcrumb-label.ts";

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
    harness.coordinator.piListener(event({ type: "agent_start" }), context);
};

const writeAssistant = (
    harness: BreadcrumbHarness,
    delta: string,
    contentIndex?: number,
): void => {
    harness.coordinator.piListener(
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

/** The only lifecycle breadcrumb pi emits besides `agent_end`. */
const completeTool = (harness: BreadcrumbHarness): void => {
    harness.coordinator.piListener(
        event({
            type: "tool_execution_end",
            toolCallId: "tool-1",
            toolName: "bash",
            isError: false,
            result: { content: [{ type: "text", text: "" }] },
        }),
        context,
    );
};

const settleSession = (harness: BreadcrumbHarness): void => {
    harness.coordinator.piListener(event({ type: "agent_end" }), context);
};

describe("assembled breadcrumb policy regressions", () => {
    test("does not add a breadcrumb when a session ends below threshold", () => {
        const harness = makeBreadcrumbHarness();
        startSession(harness);
        writeAssistant(harness, "one");
        settleSession(harness);

        expect(visibleLines(harness.output)).toEqual([
            "╭─ pi · Task · session-1",
            "│",
            "│  ✦ assistant one",
            "╰─ done",
        ]);
        expect(breadcrumbLines(harness.output)).toEqual([]);
    });

    test("emits at the exact assembled visible-line threshold", () => {
        const harness = makeBreadcrumbHarness();
        startSession(harness);
        writeAssistant(harness, "one\ntwo\nthree\nfour\n");
        settleSession(harness);

        expect(visibleLines(harness.output)).toEqual([
            "╭─ pi · Task · session-1",
            "│",
            "│  ✦ assistant one",
            "│    two",
            "│    three",
            "│    four",
            "│  › Responding",
            "╰─ done",
        ]);
        expect(breadcrumbLines(harness.output)).toEqual(["│  › Responding"]);
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

        harness.coordinator.piListener(event({ type: "turn_end" }), context);
        expect(harness.output).toBe(afterLargeEvent);

        writeAssistant(harness, "after", 1);
        settleSession(harness);

        expect(visibleLines(harness.output)).toEqual([
            "╭─ pi · Task · session-1",
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
            "╰─ done",
        ]);
        expect(breadcrumbLines(harness.output)).toEqual(["│  › Responding"]);
    });

    test("prefers a lifecycle candidate over a pending periodic candidate", () => {
        const harness = makeBreadcrumbHarness(3);
        startSession(harness);
        // The assistant block leaves the periodic Responding candidate pending.
        writeAssistant(harness, "periodic one\nperiodic two");
        // The tool completion crosses the cadence boundary. Responding and
        // Waiting are both candidates at this transcript boundary, but the
        // lifecycle candidate must win.
        completeTool(harness);
        settleSession(harness);

        expect(visibleLines(harness.output)).toEqual([
            "╭─ pi · Task · session-1",
            "│",
            "│  ✦ assistant periodic one",
            "│    periodic two",
            "│  ✓ bash done",
            "│  › Waiting",
            "╰─ done",
        ]);
        const breadcrumbs = breadcrumbLines(harness.output);
        expect(breadcrumbs).toEqual(["│  › Waiting"]);
        expect(breadcrumbs).not.toContain("│  › Responding");
    });

    test("keeps a long tool-output event compact with a one-line outcome", () => {
        const harness = makeBreadcrumbHarness();
        const toolOutput = Array.from(
            { length: 14 },
            (_, index) => `tool line ${index + 1}`,
        ).join("\n");

        startSession(harness);
        harness.coordinator.piListener(
            event({
                type: "tool_execution_start",
                toolCallId: "tool-long",
                toolName: "bash",
                args: { command: "printf tool-output" },
            }),
            context,
        );
        harness.coordinator.piListener(
            event({
                type: "tool_execution_update",
                toolCallId: "tool-long",
                toolName: "bash",
                partialResult: { content: toolOutput },
            }),
            context,
        );
        harness.coordinator.piListener(
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
            "╭─ pi · Task · session-1",
            "│",
            "│  $ printf tool-output",
            "│  ✓ bash done",
            "╰─ done",
        ]);
        expect(harness.output).not.toContain("tool line");
        expect(breadcrumbLines(harness.output)).toEqual([]);
    });

    test("preserves token-like values in assembled breadcrumb context and its key", async () => {
        const harness = makeBreadcrumbHarness(3);
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
        completeTool(harness);
        const candidate = breadcrumbCandidateFor(
            harness.coordinator.getDisplayState(),
        );
        settleSession(harness);

        expect(candidate.canonicalKey).toBe(
            "[owner/repo?token=private-value] [1/1] #1 Bearer private-value › Implementing changes › Waiting",
        );
        expect(visibleLines(harness.output)).toEqual([
            "╭─ pi · Task · session-1 · owner/repo?token=private-value · issue 1/1 · #1 · Implementing changes",
            "│",
            "│  ✦ assistant one",
            "│    two",
            "│  ✓ bash done",
            "│  [owner/repo?token=private-value] [1/1] #1 Bearer private-value › Implementing changes › Waiting",
            "╰─ done",
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
        completeTool(harness);
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
        completeTool(harness);
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
        const harness = makeBreadcrumbHarness(3);
        startSession(harness);
        writeAssistant(harness, "one\ntwo");
        completeTool(harness);
        writeAssistant(harness, "after");
        settleSession(harness);

        expect(visibleLines(harness.output)).toEqual([
            "╭─ pi · Task · session-1",
            "│",
            "│  ✦ assistant one",
            "│    two",
            "│  ✓ bash done",
            "│  › Waiting",
            "│    after",
            "╰─ done",
        ]);
        expect(breadcrumbLines(harness.output)).toEqual(["│  › Waiting"]);
    });

    test("keeps the default CLI and output-mode surface free of breadcrumb options", () => {
        const defaults = parseCliArgs(["owner/repository"]).options;
        expect(defaults).toMatchObject({ json: false });
        expect(defaults).not.toHaveProperty("breadcrumbThreshold");
        expect(HELP_TEXT).toContain("--output <mode>");
        expect(HELP_TEXT).not.toContain("breadcrumb");

        expect(
            parseCliArgs(["owner/repository", "--output", "json"]).options,
        ).toEqual({ repo: "owner/repository", json: true });
        for (const removed of ["verbose", "quiet"]) {
            expect(() =>
                parseCliArgs(["owner/repository", "--output", removed]),
            ).toThrow();
        }
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
            "agent_end",
        ]);
        expect(records.every((record) => record.type === "agent_event")).toBe(
            true,
        );
        expect(harness.output).not.toContain("│  › ");
        expect(harness.output).not.toContain("╭─");
    });
});