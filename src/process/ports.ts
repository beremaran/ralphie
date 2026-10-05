import { RalphieError } from "../shared/error.ts";

/**
 * Hard deadline for any process Ralphie spawns on its own account. Without a
 * bound, a hung `git fetch` or `gh` call would stall the whole run
 * indefinitely; with it, the child is killed and the failure is reported.
 */
export const DEFAULT_PROCESS_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

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
    /** Text written to the child's standard input, which is then closed. */
    readonly stdin?: string;
    /**
     * Called with each complete line the child writes to standard output as
     * it arrives, without the line terminator. Lines split only on `\n`
     * (never U+2028 or U+2029) and a final unterminated line is delivered
     * when the stream ends. The full output is still returned in `stdout`.
     */
    readonly onStdoutLine?: (line: string) => void;
    /**
     * Run the command as the leader of its own process group, and send
     * termination signals (timeout, abort) to the whole group so descendants
     * the command started die with it.
     */
    readonly processGroup?: boolean;
};

/** Outbound port for spawning bounded external commands. */
export type CommandRunnerService = {
    readonly run: (
        command: string,
        args: ReadonlyArray<string>,
        options?: CommandRunOptions,
    ) => Promise<CommandResult>;
};

/** The spawned command exceeded its deadline and was killed by the runner. */
export class CommandTimeoutError extends RalphieError {
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