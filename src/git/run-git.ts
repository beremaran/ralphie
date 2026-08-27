import type { CommandRunnerService } from "../process/command-runner.ts";
import { RalphieError } from "../shared/error.ts";

export const runGit = async (
    runner: CommandRunnerService,
    repositoryPath: string,
    args: ReadonlyArray<string>,
    failureMessage: string,
    trimStdout = true,
): Promise<string> => {
    const result = await runner.run("git", ["-C", repositoryPath, ...args], {
        trimStdout,
    });
    if (result.exitCode !== 0) {
        const detail = result.stderr ? ` ${result.stderr}` : "";
        throw new RalphieError({
            message: `${failureMessage}.${detail}`,
        });
    }

    return result.stdout;
};