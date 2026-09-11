import { RalphieError } from "../shared/error.ts";
import type {
    CommandResult,
    CommandRunOptions,
    CommandRunnerService,
} from "./ports.ts";

export const requireSuccess = async (
    runner: CommandRunnerService,
    command: string,
    args: ReadonlyArray<string>,
    failureMessage: string,
    options?: CommandRunOptions,
): Promise<CommandResult> => {
    const result = await runner.run(command, args, options);
    if (result.exitCode !== 0) {
        const detail = result.stderr ? `\n${result.stderr}` : "";
        throw new RalphieError({
            message: `${failureMessage}${detail}`,
        });
    }

    return result;
};