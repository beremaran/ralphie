import type { Subprocess } from "bun";

import { RalphieError } from "../../shared/error.ts";
import {
    CommandAbortedError,
    CommandTimeoutError,
    DEFAULT_PROCESS_COMMAND_TIMEOUT_MS,
    type CommandResult,
    type CommandRunOptions,
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
    processGroup: boolean,
): void => {
    try {
        // A negative pid addresses the group the detached child leads.
        if (processGroup) process.kill(-child.pid, signal);
        else child.kill(signal);
    } catch {
        // The child may already have exited.
    }
};

/** Read a child stream to its end, reporting each `\n`-terminated line. */
const readCaptured = async (
    stream: unknown,
    onLine?: (line: string) => void,
): Promise<string> => {
    if (typeof stream !== "object" || stream === null) return "";
    if (onLine === undefined) {
        return await new Response(stream as ReadableStream<Uint8Array>).text();
    }
    const decoder = new TextDecoder();
    let captured = "";
    let pending = "";
    const consume = (text: string): void => {
        captured += text;
        pending += text;
        let newline = pending.indexOf("\n");
        while (newline !== -1) {
            onLine(pending.slice(0, newline));
            pending = pending.slice(newline + 1);
            newline = pending.indexOf("\n");
        }
    };
    for await (const chunk of stream as ReadableStream<Uint8Array>) {
        consume(decoder.decode(chunk, { stream: true }));
    }
    consume(decoder.decode());
    if (pending !== "") onLine(pending);
    return captured;
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

/** Start the child, reporting a missing executable as a RalphieError. */
const spawnChild = (
    command: string,
    args: ReadonlyArray<string>,
    options: CommandRunOptions | undefined,
): Subprocess => {
    try {
        return Bun.spawn([command, ...args], {
            cwd: options?.cwd,
            env:
                options?.env === undefined
                    ? undefined
                    : { ...process.env, ...options.env },
            ...(options?.stdin === undefined
                ? {}
                : { stdin: new TextEncoder().encode(options.stdin) }),
            stdout: "pipe",
            stderr: "pipe",
            ...(options?.processGroup === true ? { detached: true } : {}),
        });
    } catch (cause) {
        throw new RalphieError({
            message: `Could not execute ${command}. Is it installed and available on PATH?`,
            cause,
        });
    }
};

export const CommandRunnerLive: CommandRunnerService = {
    run: async (command, args, options) => {
        const timeoutMs =
            options?.timeoutMs ?? DEFAULT_PROCESS_COMMAND_TIMEOUT_MS;
        const signal = options?.signal;
        const summary = [command, ...args].join(" ");
        const processGroup = options?.processGroup === true;

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

        const child = spawnChild(command, args, options);

        /** Why the runner terminated the child; wins over the actual exit. */
        let termination: "timeout" | "abort" | undefined;
        let escalationTimer: ReturnType<typeof setTimeout> | undefined;
        const escalate = () => terminateChild(child, "SIGKILL", processGroup);
        const terminateAndEscalate = () => {
            terminateChild(child, "SIGTERM", processGroup);
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

        // Drain both pipes while the child runs so a chatty child never
        // blocks on a full pipe and line callbacks see output live.
        const capturedStdout = readCaptured(
            child.stdout,
            options?.onStdoutLine,
        );
        const capturedStderr = readCaptured(child.stderr);
        try {
            const exitCode = await child.exited;
            const stdout = await capturedStdout;
            const stderr = await capturedStderr;
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