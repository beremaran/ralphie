import { RalphieError } from "../shared/error.ts";
import { redactSensitiveText } from "../shared/redaction.ts";

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
};

export type CommandRunnerService = {
    readonly run: (
        command: string,
        args: ReadonlyArray<string>,
        options?: CommandRunOptions,
    ) => Promise<CommandResult>;
};

export const CommandRunnerLive: CommandRunnerService = {
    run: async (command, args, options) => {
        try {
            const result = Bun.spawnSync([command, ...args], {
                cwd: options?.cwd,
                env:
                    options?.env === undefined
                        ? undefined
                        : { ...process.env, ...options.env },
                stdout: "pipe",
                stderr: "pipe",
            });

            return {
                exitCode: result.exitCode,
                stdout:
                    options?.trimStdout === false
                        ? result.stdout.toString()
                        : result.stdout.toString().trim(),
                stderr: result.stderr.toString().trim(),
            };
        } catch (cause) {
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
        const detail = result.stderr
            ? `\n${redactSensitiveText(result.stderr)}`
            : "";
        throw new RalphieError({
            message: `${failureMessage}${detail}`,
        });
    }

    return result;
};