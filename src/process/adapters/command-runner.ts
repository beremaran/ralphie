import type { Subprocess } from "bun";

import { RalphieError } from "../../shared/error.ts";
import {
    CommandAbortedError,
    CommandTimeoutError,
    DEFAULT_PROCESS_COMMAND_TIMEOUT_MS,
    type CommandResult,
    type CommandRunnerService,
} from "../ports.ts";

/**
 * Grace period between the first termination signal on an aborted or
 * timed-out child and the SIGKILL escalation. The prompt SIGTERM gives
 * well-behaved children a chance to clean up; the escalation guarantees the
 * child dies even if it ignores or mishandles the polite signal.
 */
export const PROCESS_TERMINATION_ESCALATION_MS = 2_000;

const terminateChild = (
    child: Subprocess,
    signal: "SIGTERM" | "SIGKILL",
): void => {
    try {
        child.kill(signal);
    } catch {
        // The child may already have exited.
    }
};

const readCaptured = async (stream: unknown): Promise<string> => {
    if (typeof stream !== "object" || stream === null) return "";
    return await new Response(stream as ReadableStream<Uint8Array>).text();
};

/** Decide the outcome after the child has exited, honoring any termination. */
const settleRun = (input: {
    readonly termination: "timeout" | "abort" | undefined;
    readonly summary: string;
    readonly timeoutMs: number;
    readonly signal: AbortSignal | undefined;
    readonly trimStdout: boolean;
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
}): CommandResult => {
    if (input.termination === "abort") {
        throw new CommandAbortedError({
            command: input.summary,
            cause: input.signal?.reason,
        });
    }
    if (input.termination === "timeout") {
        throw new CommandTimeoutError({
            command: input.summary,
            timeoutMs: input.timeoutMs,
        });
    }
    return {
        exitCode: input.exitCode,
        stdout: input.trimStdout ? input.stdout.trim() : input.stdout,
        stderr: input.stderr.trim(),
    };
};

export const CommandRunnerLive: CommandRunnerService = {
    run: async (command, args, options) => {
        const timeoutMs =
            options?.timeoutMs ?? DEFAULT_PROCESS_COMMAND_TIMEOUT_MS;
        const signal = options?.signal;
        const summary = [command, ...args].join(" ");

        // Read through a function so TypeScript keeps the signal observable:
        // CFA would otherwise treat the readonly `aborted` flag as constant
        // for this call, while it can in fact flip on another task.
        const rejectIfAborted = (): void => {
            if (signal?.aborted === true) {
                throw new CommandAbortedError({
                    command: summary,
                    cause: signal.reason,
                });
            }
        };
        rejectIfAborted();

        let child: Subprocess;
        try {
            child = Bun.spawn([command, ...args], {
                cwd: options?.cwd,
                env:
                    options?.env === undefined
                        ? undefined
                        : { ...process.env, ...options.env },
                stdout: "pipe",
                stderr: "pipe",
            });
        } catch (cause) {
            throw new RalphieError({
                message: `Could not execute ${command}. Is it installed and available on PATH?`,
                cause,
            });
        }

        /** Why the runner terminated the child; wins over the actual exit. */
        let termination: "timeout" | "abort" | undefined;
        let escalationTimer: ReturnType<typeof setTimeout> | undefined;
        const escalate = () => terminateChild(child, "SIGKILL");
        const terminateAndEscalate = () => {
            terminateChild(child, "SIGTERM");
            escalationTimer ??= setTimeout(
                escalate,
                PROCESS_TERMINATION_ESCALATION_MS,
            );
        };
        const onAbort = () => {
            if (termination !== undefined) return;
            termination = "abort";
            terminateAndEscalate();
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        // Close the race between the pre-spawn check and listener registration.
        if (signal?.aborted === true) onAbort();
        const timeoutTimer = setTimeout(() => {
            if (termination !== undefined) return;
            termination = "timeout";
            terminateAndEscalate();
        }, timeoutMs);

        try {
            const exitCode = await child.exited;
            const stdout = await readCaptured(child.stdout);
            const stderr = await readCaptured(child.stderr);
            return settleRun({
                termination,
                summary,
                timeoutMs,
                signal,
                trimStdout: options?.trimStdout !== false,
                exitCode,
                stdout,
                stderr,
            });
        } catch (cause) {
            if (cause instanceof CommandAbortedError) throw cause;
            if (cause instanceof CommandTimeoutError) throw cause;
            throw new RalphieError({
                message: `Could not execute ${command}. Is it installed and available on PATH?`,
                cause,
            });
        } finally {
            clearTimeout(timeoutTimer);
            if (escalationTimer !== undefined) clearTimeout(escalationTimer);
            signal?.removeEventListener("abort", onAbort);
        }
    },
};