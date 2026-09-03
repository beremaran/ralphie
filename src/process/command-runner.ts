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

export const CommandRunnerLive: CommandRunnerService = {
    run: async (command, args, options) => {
        const timeoutMs =
            options?.timeoutMs ?? DEFAULT_PROCESS_COMMAND_TIMEOUT_MS;
        try {
            const result = Bun.spawnSync([command, ...args], {
                cwd: options?.cwd,
                env:
                    options?.env === undefined
                        ? undefined
                        : { ...process.env, ...options.env },
                stdout: "pipe",
                stderr: "pipe",
                timeout: timeoutMs,
            });

            if (result.exitCode === null) {
                throw new CommandTimeoutError({
                    command: [command, ...args].join(" "),
                    timeoutMs,
                });
            }

            return {
                exitCode: result.exitCode,
                stdout:
                    options?.trimStdout === false
                        ? result.stdout.toString()
                        : result.stdout.toString().trim(),
                stderr: result.stderr.toString().trim(),
            };
        } catch (cause) {
            if (cause instanceof CommandTimeoutError) {
                throw cause;
            }
            throw new RalphieError({
                message: `Could not execute ${command}. Is it installed and available on PATH?`,
                cause,
            });
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