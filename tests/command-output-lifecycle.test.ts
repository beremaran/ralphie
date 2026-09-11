import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type {
    AgentEventContext,
    AgentEventListener,
} from "../src/agent/ports.ts";
import {
    runCommand,
    type CliTerminalInfo,
    type CommandFactories,
    type CommandOutput,
    type CommandRuntime,
    type RunCommandInput,
} from "../src/command.ts";
import type { ProgressCoordinator } from "../src/progress/adapters/coordinator.ts";
import { makeProgressCoordinator } from "../src/progress/adapters/coordinator.ts";
import { RalphieExitCode } from "../src/workflow/exit-code.ts";

const context: AgentEventContext = {
    sessionID: "command-lifecycle-session",
    directory: "/workspace/owner/repository",
    title: "Command lifecycle",
};

const NONINTERACTIVE_TERMINAL: CliTerminalInfo = {
    isInteractive: false,
    isCI: true,
    width: 80,
};

const FIXED_NOW = () => new Date("2026-09-09T00:00:00.000Z");

type OutputMode = "plain" | "json";
type Outcome = "success" | "abort" | "failure";

type Capture = CommandOutput & {
    readonly stdoutBytes: () => string;
    readonly stderrBytes: () => string;
};

const makeCapture = (): Capture => {
    let stdout = "";
    let stderr = "";
    return {
        stdout: (text) => {
            stdout += text;
        },
        stderr: (text) => {
            stderr += text;
        },
        stdoutBytes: () => stdout,
        stderrBytes: () => stderr,
    };
};

const textEvent = (type: string, delta?: string) => ({
    type: "message_update",
    assistantMessageEvent: {
        type,
        contentIndex: 0,
        ...(delta === undefined ? {} : { delta }),
    },
});

const runNoninteractiveCase = async (
    mode: OutputMode,
    outcome: Outcome,
): Promise<{
    readonly capture: Capture;
    readonly exitCode: number | string | null;
    readonly error: unknown;
    readonly coordinator: ProgressCoordinator | undefined;
    readonly runtimeDisposeCalls: () => number;
    readonly coordinatorDisposeCalls: () => number;
    readonly cleanupOrder: readonly string[];
    readonly signal: AbortSignal;
}> => {
    const workspace = await mkdtemp(
        join(tmpdir(), "ralphie-command-contract-"),
    );
    const capture = makeCapture();
    const abortController = new AbortController();
    let coordinator: ProgressCoordinator | undefined;
    let listener: AgentEventListener | undefined;
    let runtimeDisposeCount = 0;
    let coordinatorDisposeCount = 0;
    const cleanupOrder: string[] = [];
    const failure = new Error("un-aborted command failure");

    const factories: CommandFactories = {
        makeCoordinator: (options) => {
            const made = makeProgressCoordinator({
                ...options,
                now: FIXED_NOW,
                runId: "command-contract-run",
            });
            coordinator = {
                ...made,
                dispose: async () => {
                    coordinatorDisposeCount += 1;
                    cleanupOrder.push("coordinator");
                    await made.dispose();
                },
            };
            return coordinator;
        },
        makeAgentRuntime: (_config, eventListener) => {
            listener = eventListener;
            return { start: async () => undefined as never };
        },
        makeRuntime: ({ agentRuntime, progress }) =>
            ({
                agentRuntime,
                progress,
                dispose: async () => {
                    runtimeDisposeCount += 1;
                    cleanupOrder.push("runtime");
                },
            }) as unknown as CommandRuntime,
        runWorkflow: async (_options, runtime) => {
            await runtime.progress.emit({
                stage: "run",
                status: "started",
                message: "command-started",
            });
            listener?.({ type: "agent_start" }, context);
            listener?.(textEvent("text_start"), context);
            listener?.(textEvent("text_delta", "command-output"), context);

            if (outcome === "abort") {
                abortController.abort();
                abortController.signal.throwIfAborted();
            }
            if (outcome === "failure") throw failure;

            listener?.(textEvent("text_end"), context);
            await runtime.progress.emit({
                stage: "run",
                status: "succeeded",
                message: "command-succeeded",
            });
            return {} as never;
        },
    };
    const args = [
        "owner/repository",
        "--workspace",
        workspace,
        ...(mode === "plain" ? [] : ["--output", mode]),
    ];
    let error: unknown;
    process.exitCode = 0;
    try {
        await runCommand(args, {
            terminal: NONINTERACTIVE_TERMINAL,
            output: capture,
            factories,
            signal: abortController.signal,
        } satisfies RunCommandInput);
    } catch (caught) {
        error = caught;
    }
    const exitCode = process.exitCode;
    try {
        return {
            capture,
            exitCode,
            error,
            coordinator,
            runtimeDisposeCalls: () => runtimeDisposeCount,
            coordinatorDisposeCalls: () => coordinatorDisposeCount,
            cleanupOrder,
            signal: abortController.signal,
        };
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
};

describe("runCommand outcome and quiescence contracts", () => {
    for (const mode of ["plain", "json"] as const) {
        for (const outcome of ["success", "abort", "failure"] as const) {
            test(`${mode}/${outcome} disposes exactly once and stays quiescent`, async () => {
                const result = await runNoninteractiveCase(mode, outcome);
                if (outcome === "success") {
                    expect(result.error).toBeUndefined();
                    expect(result.exitCode).toBe(RalphieExitCode.Success);
                    expect(result.signal.aborted).toBe(false);
                } else if (outcome === "abort") {
                    expect(result.error).toBeInstanceOf(Error);
                    expect((result.error as Error).message).toContain(
                        "aborted",
                    );
                    expect(result.exitCode).toBe(RalphieExitCode.Cancelled);
                    expect(result.signal.aborted).toBe(true);
                } else {
                    expect(result.error).toBeInstanceOf(Error);
                    expect((result.error as Error).message).toBe(
                        "un-aborted command failure",
                    );
                    expect(result.exitCode).toBe(RalphieExitCode.Failure);
                    expect(result.signal.aborted).toBe(false);
                }

                expect(result.runtimeDisposeCalls()).toBe(1);
                expect(result.coordinatorDisposeCalls()).toBe(1);
                expect(result.cleanupOrder).toEqual(["runtime", "coordinator"]);

                const stdoutBefore = result.capture.stdoutBytes();
                const stderrBefore = result.capture.stderrBytes();
                await Bun.sleep(40);
                await result.coordinator?.dispose();
                expect(result.capture.stdoutBytes()).toBe(stdoutBefore);
                expect(result.capture.stderrBytes()).toBe(stderrBefore);
                process.exitCode = 0;
            });
        }
    }
});