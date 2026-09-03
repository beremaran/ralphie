import type { Subprocess } from "bun";

import { RalphieError } from "../shared/error.ts";

/**
 * Hard deadline for any process Ralphie spawns on its own account. Without a
 * bound, a hung `git fetch` or `gh` call would stall the whole run
 * indefinitely; with it, the child is killed and the failure is reported.
 */
export const DEFAULT_PROCESS_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Grace period between the first termination signal on an aborted or
 * timed-out child and the SIGKILL escalation. The prompt SIGTERM gives
 * well-behaved children a chance to clean up; the escalation guarantees the
 * child dies even when it ignores or mishandles the polite signal.
 */
export const PROCESS_TERMINATION_ESCALATION_MS = 2_000;

export type CommandResult = {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
};

export type CommandRunOptions = {
    readonly trimStdout?: boolean;
    readonly cwd?: string;
    /** Environment values overlaid on the live parent environment. */
    readonly env?: Readonly<Record<string, string | undefined>>;
    /**
     * Hard deadline for the spawned command in milliseconds. Omitted calls
     * use {@link DEFAULT_PROCESS_COMMAND_TIMEOUT_MS}.
     */
    readonly timeoutMs?: number;
    /**
     * Caller cancellation. When the signal aborts while the command is in
     * flight (or before it starts), the run fails with
     * {@link CommandAbortedError} so callers can distinguish an aborted run
     * from a failed one.
     */
    readonly signal?: AbortSignal;
};

export type CommandRunnerService = {
    readonly run: (
        command: string,
        args: ReadonlyArray<string>,
        options?: CommandRunOptions,
    ) => Promise<CommandResult>;
};

/** The spawned command exceeded its deadline and was killed by the runner. */
export class CommandTimeoutError extends RalphieError {
    override readonly _tag = "CommandTimeoutError" as const;
    readonly timeoutMs: number;

    constructor(input: {
        readonly command: string;
        readonly timeoutMs: number;
    }) {
        super({
            message: `Command timed out after ${input.timeoutMs / 1000}s and was terminated: ${input.command}`,
        });
        this.name = "CommandTimeoutError";
        this.timeoutMs = input.timeoutMs;
    }
}

/**
 * The caller aborted the run while the command was in flight (or before it
 * started). Distinct from a command failure or a timeout so an aborted run is
 * reported as cancellation instead of a defect.
 */
export class CommandAbortedError extends RalphieError {
    override readonly _tag = "CommandAbortedError" as const;

    constructor(input: {
        readonly command: string;
        readonly cause?: unknown;
    }) {
        super({
            message: `Command was aborted and terminated: ${input.command}`,
            ...(input.cause === undefined ? {} : { cause: input.cause }),
        });
        this.name = "CommandAbortedError";
    }
}

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

export const requireSuccess = async (
    runner: CommandRunnerService,
    command: string,
    args: ReadonlyArray<string>,
    failureMessage: string,
    options?: CommandRunOptions,
): Promise<CommandResult> => {
    const result =
        options === undefined
            ? await runner.run(command, args)
            : await runner.run(command, args, options);
    if (result.exitCode !== 0) {
        const detail = result.stderr ? `\n${result.stderr}` : "";
        throw new RalphieError({
            message: `${failureMessage}${detail}`,
        });
    }

    return result;
};