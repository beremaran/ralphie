import { describe, expect, test } from "bun:test";

import { RalphieExitCode } from "../../src/process/exit-code.ts";
import type { PiEventContext, PiSessionEvent } from "../../src/pi/client.ts";
import {
    makeCommandRuntimeHarness,
    type CommandRuntimeHarnessStep,
    type RuntimeScenarioPiEvent,
} from "./command-runtime-harness.ts";

const context: PiEventContext = {
    sessionID: "failure-matrix-session",
    directory: "/fake/workspace",
    title: "Failure matrix",
};

const pi = (event: object): PiSessionEvent =>
    event as unknown as PiSessionEvent;

const piStep = (event: object): RuntimeScenarioPiEvent => ({
    kind: "pi",
    event: pi(event),
    context,
});

const progressStep = (message: string): CommandRuntimeHarnessStep => ({
    kind: "progress",
    event: {
        stage: "implementation",
        status: "started",
        message,
        repository: "owner/repository",
        issue: { number: 192, title: "Failure cleanup matrix" },
    },
});

const agentStart = piStep({ type: "agent_start" });
const assistantStart = piStep({
    type: "message_update",
    assistantMessageEvent: { type: "text_start" },
});
const assistantDelta = (text: string): CommandRuntimeHarnessStep =>
    piStep({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: text },
    });

const scenarios = [
    {
        name: "normal completion",
        expectedExitCode: RalphieExitCode.Success,
        expectedOutput: "completed transcript",
        steps: [
            progressStep("progress before normal completion"),
            agentStart,
            assistantStart,
            assistantDelta("completed transcript"),
            piStep({
                type: "message_update",
                assistantMessageEvent: { type: "text_end" },
            }),
            piStep({ type: "agent_end", messages: [], willRetry: false }),
            piStep({ type: "agent_settled" }),
        ],
    },
    {
        name: "Pi failure",
        expectedExitCode: RalphieExitCode.Failure,
        error: "Pi operation failed",
        expectedOutput: "Pi provider failed",
        steps: [
            progressStep("progress before Pi failure"),
            agentStart,
            assistantStart,
            assistantDelta("partial assistant output"),
            piStep({
                type: "message_update",
                assistantMessageEvent: {
                    type: "error",
                    reason: "provider failure",
                    error: { errorMessage: "Pi provider failed" },
                },
            }),
            { kind: "failure", error: new Error("Pi operation failed") },
        ],
    },
    {
        name: "tool failure",
        expectedExitCode: RalphieExitCode.Failure,
        error: "tool operation failed",
        expectedOutput: "read failed",
        steps: [
            progressStep("progress before tool failure"),
            agentStart,
            piStep({
                type: "tool_execution_start",
                toolCallId: "failure-matrix-tool",
                toolName: "read",
                args: { path: "missing.txt" },
            }),
            piStep({
                type: "tool_execution_end",
                toolCallId: "failure-matrix-tool",
                toolName: "read",
                result: { content: "read failed" },
                isError: true,
            }),
            { kind: "failure", error: new Error("tool operation failed") },
        ],
    },
    {
        name: "workflow failure",
        expectedExitCode: RalphieExitCode.Failure,
        error: "workflow failed",
        expectedOutput: "unfinished workflow transcript",
        steps: [
            progressStep("progress before workflow failure"),
            agentStart,
            assistantStart,
            assistantDelta("unfinished workflow transcript"),
            { kind: "failure", error: new Error("workflow failed") },
        ],
    },
    {
        name: "AbortSignal cancellation",
        expectedExitCode: RalphieExitCode.Cancelled,
        expectedOutput: "unfinished tool output",
        steps: [
            progressStep("progress before cancellation"),
            agentStart,
            piStep({
                type: "tool_execution_start",
                toolCallId: "cancellation-tool",
                toolName: "read",
                args: { path: "still-reading.txt" },
            }),
            piStep({
                type: "tool_execution_update",
                toolCallId: "cancellation-tool",
                toolName: "read",
                partialResult: { content: "unfinished tool output" },
            }),
            { kind: "wait-for-signal" },
        ],
    },
] satisfies ReadonlyArray<{
    readonly name: string;
    readonly expectedExitCode: RalphieExitCode;
    readonly expectedOutput: string;
    readonly error?: string;
    readonly steps: ReadonlyArray<CommandRuntimeHarnessStep>;
}>;

const jsonLines = (text: string): Array<Record<string, unknown>> =>
    text
        .trimEnd()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);

const expectDisposedExactlyOnce = (
    harness: ReturnType<typeof makeCommandRuntimeHarness>,
): void => {
    expect(harness.disposalCalls).toEqual({
        runtime: 1,
        coordinator: 1,
        piRuntime: 1,
        output: 1,
    });
    expect(
        harness.lifecycle.filter((call) => call === "pi.runtime.close"),
    ).toHaveLength(1);
    expect(
        harness.lifecycle.filter((call) => call === "output.dispose"),
    ).toHaveLength(1);
    expect(harness.lifecycle.slice(-5)).toEqual([
        "pi.runtime.close",
        "pi.client.close",
        "runtime.dispose",
        "coordinator.dispose",
        "output.dispose",
    ]);
};

const expectDurableProgress = (log: string, message: string): void => {
    expect(log).toEndWith("\n");
    expect(jsonLines(log)).toEqual([
        expect.objectContaining({
            stage: "implementation",
            status: "started",
            message,
        }),
    ]);
};

const expectStableAfterCleanup = async (
    harness: ReturnType<typeof makeCommandRuntimeHarness>,
    capture: NonNullable<
        ReturnType<typeof makeCommandRuntimeHarness>["runCaptures"][number]
    >,
): Promise<void> => {
    const snapshot = {
        stdout: [...capture.stdout],
        stderr: [...capture.stderr],
        durableLog: capture.eventLogContents ?? "",
    };

    harness.emitPi(
        piStep({
            type: "message_update",
            assistantMessageEvent: {
                type: "text_delta",
                delta: "after cleanup",
            },
        }).event,
        context,
    );
    await harness.emitProgress({
        stage: "implementation",
        status: "info",
        message: "progress after cleanup",
    });
    harness.writeDirectOutput("direct output after cleanup\n");

    expect(capture.stdout).toEqual(snapshot.stdout);
    expect(capture.stderr).toEqual(snapshot.stderr);
    expect(capture.eventLogContents).toBe(snapshot.durableLog);
    expect(await harness.readEventLog(capture.eventLogPath)).toBe(
        snapshot.durableLog,
    );
};

describe("Pi stream failure and cleanup lifecycle matrix", () => {
    test.each(scenarios)("$name", async (scenario) => {
        const previousExitCode = process.exitCode;
        const harness = makeCommandRuntimeHarness({ steps: scenario.steps });
        try {
            if (scenario.name === "AbortSignal cancellation") {
                const pending = harness.run();
                await harness.waitForSignalEntered;
                expect(harness.workflowSignals).toEqual([
                    harness.abortController.signal,
                ]);
                harness.abortController.abort();
                await expect(pending).rejects.toThrow("operation was aborted");
            } else if (scenario.error === undefined) {
                await harness.run();
            } else {
                await expect(harness.run()).rejects.toThrow(scenario.error);
            }

            expect(process.exitCode).toBe(scenario.expectedExitCode);
            expect(harness.runCaptures).toHaveLength(1);
            const capture = harness.runCaptures[0];
            if (capture === undefined) {
                throw new Error("Lifecycle scenario did not capture its run.");
            }
            expect(capture.stdout).toEqual([]);
            expect(capture.stderr.join("")).toContain(scenario.expectedOutput);
            expect(capture.stderr.join("")).toEndWith("\n");
            expectDurableProgress(
                capture.eventLogContents ?? "",
                scenario.steps[0]?.kind === "progress"
                    ? scenario.steps[0].event.message
                    : "",
            );
            expectDisposedExactlyOnce(harness);
            await expectStableAfterCleanup(harness, capture);
            expect(harness.writesAfterCleanup).toEqual(
                expect.arrayContaining([
                    expect.stringContaining("progress after cleanup"),
                    "direct output after cleanup\n",
                ]),
            );
        } finally {
            await harness.cleanup();
            process.exitCode = previousExitCode ?? 0;
        }
    });
});
