import { describe, expect, test } from "bun:test";

import type {
    CodexEventContext,
    CodexSessionEvent,
} from "../../src/codex/client.ts";
import {
    makeCommandRuntimeHarness,
    type CommandRuntimeHarnessStep,
} from "./command-runtime-harness.ts";

const SECRET = "github_pat_pi_stream_contract_secret";
const REPOSITORY = `owner/repository?token=${SECRET}`;
const ISSUE = {
    number: 191,
    title: `Implement the Codex stream contract ${SECRET}`,
};
const firstContext: CodexEventContext = {
    sessionID: "codex-stream-first-session",
    directory: `/tmp/codex-stream/${SECRET}`,
    title: `First Codex context ${SECRET}`,
};
const secondContext: CodexEventContext = {
    sessionID: "codex-stream-retry-session",
    directory: `/tmp/codex-stream-retry/${SECRET}`,
    title: `Retry Codex context ${SECRET}`,
};

const codex = (event: object): CodexSessionEvent =>
    event as unknown as CodexSessionEvent;

const codexStep = (
    event: object,
    context: CodexEventContext = firstContext,
): CommandRuntimeHarnessStep => ({
    kind: "codex",
    event: codex(event),
    context,
});

const progressStep = (
    status: "started" | "info",
    message: string,
): CommandRuntimeHarnessStep => ({
    kind: "progress",
    event: {
        stage: "implementation",
        status,
        message,
        repository: REPOSITORY,
        issue: ISSUE,
        current: 1,
        total: 1,
        details: {
            repository: REPOSITORY,
            issueTitle: ISSUE.title,
            secret: SECRET,
        },
    },
});

const lifecycleSteps = (): ReadonlyArray<CommandRuntimeHarnessStep> => {
    const cumulativeToolOutput =
        `CUMULATIVE-TOOL-CHUNK ${SECRET}\n` + "x".repeat(2_500);
    return [
        progressStep("started", `Implementing ${SECRET}`),
        codexStep({ type: "agent_start" }),
        codexStep({
            type: "message_update",
            assistantMessageEvent: { type: "thinking_start" },
        }),
        codexStep({
            type: "message_update",
            assistantMessageEvent: {
                type: "thinking_delta",
                delta: `thinking ${SECRET}`,
            },
        }),
        codexStep({
            type: "message_update",
            assistantMessageEvent: { type: "thinking_end" },
        }),
        codexStep({
            type: "message_update",
            assistantMessageEvent: { type: "text_start" },
        }),
        codexStep({
            type: "message_update",
            assistantMessageEvent: {
                type: "text_delta",
                delta: "partial transcript",
            },
        }),
        progressStep("info", `progress interrupts ${SECRET}`),
        codexStep({
            type: "message_update",
            assistantMessageEvent: {
                type: "text_delta",
                delta: " resumed\nthreshold row 1\nthreshold row 2",
            },
        }),
        codexStep({
            type: "message_update",
            assistantMessageEvent: { type: "text_end" },
        }),
        codexStep({
            type: "tool_execution_start",
            toolCallId: "codex-stream-tool",
            toolName: "read",
            args: { path: `/tmp/${SECRET}` },
        }),
        codexStep({
            type: "tool_execution_update",
            toolCallId: "codex-stream-tool",
            toolName: "read",
            partialResult: {
                content: `CUMULATIVE-TOOL-CHUNK ${SECRET}`,
            },
        }),
        codexStep({
            type: "tool_execution_update",
            toolCallId: "codex-stream-tool",
            toolName: "read",
            partialResult: {
                content: `CUMULATIVE-TOOL-CHUNK ${SECRET}`,
            },
        }),
        codexStep({
            type: "tool_execution_update",
            toolCallId: "codex-stream-tool",
            toolName: "read",
            partialResult: { content: cumulativeToolOutput },
        }),
        codexStep({
            type: "tool_execution_end",
            toolCallId: "codex-stream-tool",
            toolName: "read",
            result: { content: cumulativeToolOutput },
            isError: false,
        }),
        codexStep({ type: "compaction_start", reason: `threshold ${SECRET}` }),
        codexStep({
            type: "compaction_end",
            aborted: false,
            errorMessage: undefined,
        }),
        codexStep({
            type: "summarization_retry_scheduled",
            attempt: 1,
            maxAttempts: 2,
            delayMs: 0,
        }),
        codexStep({
            type: "summarization_retry_attempt_start",
            attempt: 1,
            maxAttempts: 2,
        }),
        codexStep({ type: "summarization_retry_finished" }),
        codexStep({ type: "agent_end", messages: [], willRetry: true }),
        codexStep({
            type: "auto_retry_start",
            attempt: 2,
            maxAttempts: 3,
            delayMs: 0,
            errorMessage: `retrying ${SECRET}`,
        }),
        codexStep({ type: "auto_retry_end", attempt: 2, success: true }),
        codexStep({ type: "agent_start" }, secondContext),
        codexStep(
            {
                type: "message_update",
                assistantMessageEvent: {
                    type: "thinking_delta",
                    delta: "retry completed",
                },
            },
            secondContext,
        ),
        codexStep(
            { type: "agent_end", messages: [], willRetry: false },
            secondContext,
        ),
        codexStep({ type: "agent_settled" }, secondContext),
    ];
};

const parseJsonLines = (text: string): Array<Record<string, unknown>> =>
    text
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);

const occurrences = (text: string, value: string): number =>
    text.split(value).length - 1;

const expectInOrder = (text: string, markers: ReadonlyArray<string>): void => {
    let previous = -1;
    for (const marker of markers) {
        const position = text.indexOf(marker);
        expect(position).toBeGreaterThan(previous);
        previous = position;
    }
};

const breadcrumbLabels = (text: string): Array<string> =>
    text
        .trimEnd()
        .split("\n")
        .filter((line) => line.includes(" › "))
        .map((line) => line.slice(line.lastIndexOf(" › ") + 3));

const thresholdBoundarySteps = (): ReadonlyArray<CommandRuntimeHarnessStep> => [
    codexStep({ type: "agent_start" }),
    codexStep({
        type: "message_update",
        assistantMessageEvent: { type: "text_start" },
    }),
    codexStep({
        type: "message_update",
        assistantMessageEvent: {
            type: "text_delta",
            delta: "boundary one\nboundary two",
        },
    }),
    codexStep({
        type: "message_update",
        assistantMessageEvent: { type: "text_end" },
    }),
    codexStep({ type: "compaction_start", reason: "boundary" }),
    codexStep({ type: "agent_settled" }),
];

const displayAtThreshold = async (
    threshold: number,
    steps: ReadonlyArray<CommandRuntimeHarnessStep> = lifecycleSteps(),
    terminalWidth = 48,
): Promise<string> => {
    const harness = makeCommandRuntimeHarness({
        steps,
        renderedLineThreshold: threshold,
        terminalWidth,
    });
    try {
        await harness.runMode("default");
        return harness.runCaptures[0]?.stderr.join("") ?? "";
    } finally {
        await harness.cleanup();
    }
};

describe("Codex stream lifecycle command/runtime contract", () => {
    test("renders and persists a successful retrying Codex stream end to end", async () => {
        const previousExitCode = process.exitCode;
        const harness = makeCommandRuntimeHarness({
            steps: lifecycleSteps(),
            renderedLineThreshold: 4,
            terminalWidth: 48,
        });
        try {
            await harness.runMode("default");
            await harness.runMode("json");

            const plain = harness.runCaptures[0];
            const json = harness.runCaptures[1];
            expect(plain).toBeDefined();
            expect(json).toBeDefined();
            if (plain === undefined || json === undefined) return;

            const display = plain.stderr.join("");
            const structured = json.stdout.join("");
            expect(plain.stdout).toEqual([]);
            expect(display).toEndWith("\n");
            expect(structured).toEndWith("\n");
            expect(json.stderr).toEqual([]);
            expect(display).not.toContain(SECRET);
            expect(structured).not.toContain(SECRET);

            const firstHeader =
                "╭─ Codex · First Codex context [REDACTED] · codex-stream-first-session · " +
                "owner/repository?token=[REDACTED] · issue 1/1 · #191 · Implementing changes\n";
            const retryHeader =
                "╭─ Codex · Retry Codex context [REDACTED] · codex-stream-retry-session · " +
                "owner/repository?token=[REDACTED] · issue 1/1 · #191 · Implementing changes\n";
            expect(display).toContain(firstHeader);
            expect(display).toContain(retryHeader);
            expectInOrder(display, [
                firstHeader,
                "│    partial transcript\n",
                "• [owner/repository?token=[REDACTED]",
                "│     resumed\n",
                "CUMULATIVE-TOOL-CHUNK [REDACTED]",
                "✓ read done · 2 lines · truncated\n",
                "↻ compacting context · threshold [REDACTED]\n",
                "↻ context compaction done\n",
                "↻ retrying context summary · attempt 1/2\n",
                "↻ retrying context summary\n",
                "↻ context summary finished\n",
                "╰─ retrying…\n",
                "↻ retrying Codex request · attempt 2/3\n",
                "↻ Codex retry succeeded\n",
                "╰─ interrupted\n",
                retryHeader,
                "╰─ done\n",
            ]);
            expect(occurrences(display, "CUMULATIVE-TOOL-CHUNK")).toBe(1);
            expect(occurrences(display, "· truncated")).toBe(1);
            const respondingBreadcrumb =
                "› Implementing changes › Responding\n";
            const toolBreadcrumb = "› Implementing changes › Using read\n";
            expect(occurrences(display, respondingBreadcrumb)).toBe(1);
            expect(occurrences(display, toolBreadcrumb)).toBe(1);
            expect(breadcrumbLabels(display)).toEqual([
                "Responding",
                "Using read",
                "Waiting",
                "Retrying",
            ]);
            const highThresholdDisplay = await displayAtThreshold(100);
            expect(breadcrumbLabels(highThresholdDisplay)).toEqual([]);

            const boundaryDisplay = await displayAtThreshold(
                5,
                thresholdBoundarySteps(),
                200,
            );
            const aboveBoundaryDisplay = await displayAtThreshold(
                6,
                thresholdBoundarySteps(),
                200,
            );
            const boundaryLines = boundaryDisplay.trimEnd().split("\n");
            const boundaryHeaderEnd = boundaryLines.indexOf("│");
            const boundaryCompaction = boundaryLines.indexOf(
                "│  ↻ compacting context · boundary",
            );
            expect(boundaryHeaderEnd).toBeGreaterThanOrEqual(0);
            expect(boundaryCompaction).toBeGreaterThan(boundaryHeaderEnd);
            expect(boundaryCompaction - boundaryHeaderEnd).toBe(5);
            expect(boundaryLines[boundaryCompaction + 1]).toBe(
                "│  › Compacting context",
            );
            expect(breadcrumbLabels(boundaryDisplay)).toEqual([
                "Compacting context",
            ]);

            const aboveBoundaryLines = aboveBoundaryDisplay
                .trimEnd()
                .split("\n");
            const aboveBoundaryHeaderEnd = aboveBoundaryLines.indexOf("│");
            const aboveBoundaryCompaction = aboveBoundaryLines.indexOf(
                "│  ↻ compacting context · boundary",
            );
            expect(aboveBoundaryCompaction - aboveBoundaryHeaderEnd).toBe(5);
            expect(breadcrumbLabels(aboveBoundaryDisplay)).toEqual([]);

            const activityStates = plain.displayStates.map(
                (state) => `${state.activity}:${state.activityLabel}`,
            );
            expect(activityStates).toEqual([
                "waiting:Waiting",
                "waiting:Waiting",
                "thinking:Thinking",
                "thinking:Thinking",
                "thinking:Thinking",
                "thinking:Thinking",
                "responding:Responding",
                "responding:Responding",
                "waiting:Waiting",
                "responding:Responding",
                "responding:Responding",
                "tool:Using read",
                "tool:Using read",
                "tool:Using read",
                "tool:Using read",
                "waiting:Waiting",
                "compacting:Compacting context",
                "waiting:Waiting",
                "retrying:Retrying",
                "retrying:Retrying",
                "waiting:Waiting",
                "retrying:Retrying",
                "retrying:Retrying",
                "waiting:Waiting",
                "thinking:Thinking",
                "thinking:Thinking",
                "waiting:Waiting",
                "waiting:Waiting",
            ]);

            const structuredRecords = parseJsonLines(structured);
            const codexRecords = structuredRecords.filter(
                (record) => record.type === "codex_event",
            );
            expect(structuredRecords).toHaveLength(lifecycleSteps().length);
            expect(codexRecords).toHaveLength(25);
            expect(
                codexRecords.map(
                    (record) => (record.event as { type?: string }).type,
                ),
            ).toEqual([
                "agent_start",
                "message_update",
                "message_update",
                "message_update",
                "message_update",
                "message_update",
                "message_update",
                "message_update",
                "tool_execution_start",
                "tool_execution_update",
                "tool_execution_update",
                "tool_execution_update",
                "tool_execution_end",
                "compaction_start",
                "compaction_end",
                "summarization_retry_scheduled",
                "summarization_retry_attempt_start",
                "summarization_retry_finished",
                "agent_end",
                "auto_retry_start",
                "auto_retry_end",
                "agent_start",
                "message_update",
                "agent_end",
                "agent_settled",
            ]);
            expect(structuredRecords[0]).toMatchObject({
                repository: "owner/repository?token=[REDACTED]",
                issue: {
                    title: "Implement the Codex stream contract [REDACTED]",
                },
                details: {
                    repository: "owner/repository?token=[REDACTED]",
                    issueTitle:
                        "Implement the Codex stream contract [REDACTED]",
                    secret: "[REDACTED]",
                },
            });
            const thinkingRecord = codexRecords.find(
                (record) =>
                    (
                        record.event as {
                            assistantMessageEvent?: { type?: string };
                        }
                    ).assistantMessageEvent?.type === "thinking_start",
            );
            expect(thinkingRecord).toMatchObject({
                sessionID: firstContext.sessionID,
                directory: "/tmp/codex-stream/[REDACTED]",
                title: "First Codex context [REDACTED]",
                event: {
                    assistantMessageEvent: {
                        type: "thinking_start",
                    },
                },
            });
            const thinkingDeltaRecord = codexRecords.find(
                (record) =>
                    (record.event as { type?: string }).type ===
                        "message_update" &&
                    (
                        record.event as {
                            assistantMessageEvent?: { type?: string };
                        }
                    ).assistantMessageEvent?.type === "thinking_delta",
            );
            expect(thinkingDeltaRecord).toMatchObject({
                event: {
                    assistantMessageEvent: {
                        delta: "thinking [REDACTED]",
                    },
                },
            });
            const toolRecord = codexRecords.find(
                (record) =>
                    (record.event as { type?: string }).type ===
                    "tool_execution_start",
            );
            expect(toolRecord).toMatchObject({
                directory: "/tmp/codex-stream/[REDACTED]",
                event: {
                    args: { path: "/tmp/[REDACTED]" },
                },
            });
            const toolUpdateRecord = codexRecords.find(
                (record) =>
                    (record.event as { type?: string }).type ===
                        "tool_execution_update" &&
                    JSON.stringify(record).includes("CUMULATIVE-TOOL-CHUNK"),
            );
            expect(toolUpdateRecord).toMatchObject({
                event: {
                    partialResult: {
                        content: "CUMULATIVE-TOOL-CHUNK [REDACTED]",
                    },
                },
            });
            expect(codexRecords.map((record) => record.event)).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ type: "agent_end" }),
                    expect.objectContaining({ type: "auto_retry_start" }),
                    expect.objectContaining({ type: "auto_retry_end" }),
                ]),
            );
            const retryRecord = codexRecords.find(
                (record) =>
                    (record as { sessionID?: unknown }).sessionID ===
                    secondContext.sessionID,
            );
            expect(retryRecord).toMatchObject({
                directory: "/tmp/codex-stream-retry/[REDACTED]",
                title: "Retry Codex context [REDACTED]",
            });
            for (const record of codexRecords) {
                expect(record).not.toHaveProperty(
                    "directory",
                    secondContext.directory,
                );
                expect(JSON.stringify(record)).not.toContain(SECRET);
            }

            const durableLog = plain.eventLogContents ?? "";
            expect(durableLog).toEndWith("\n");
            expect(durableLog).not.toContain(SECRET);
            const durableRecords = parseJsonLines(durableLog);
            expect(durableRecords).toHaveLength(2);
            expect(durableRecords[0]).toMatchObject({
                repository: "owner/repository?token=[REDACTED]",
                issue: {
                    number: 191,
                    title: "Implement the Codex stream contract [REDACTED]",
                },
                details: {
                    repository: "owner/repository?token=[REDACTED]",
                    issueTitle:
                        "Implement the Codex stream contract [REDACTED]",
                    secret: "[REDACTED]",
                },
            });
            expect(durableRecords[1]).toMatchObject({
                repository: "owner/repository?token=[REDACTED]",
                issue: {
                    title: "Implement the Codex stream contract [REDACTED]",
                },
                details: {
                    repository: "owner/repository?token=[REDACTED]",
                    issueTitle:
                        "Implement the Codex stream contract [REDACTED]",
                    secret: "[REDACTED]",
                },
                message: "progress interrupts [REDACTED]",
            });
        } finally {
            await harness.cleanup();
            process.exitCode = previousExitCode ?? 0;
        }
    });
});