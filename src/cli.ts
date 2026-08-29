import { runCommand } from "./command.ts";
import { exitCodeForError, isNeedsAttentionStop } from "./process/exit-code.ts";
import { redactSensitiveText } from "./shared/redaction.ts";

/** Start the CLI with a native AbortSignal rather than a framework context. */
export const runCli = async (
    args: ReadonlyArray<string> = Bun.argv.slice(2),
): Promise<void> => {
    const controller = new AbortController();
    const onInterrupt = () => controller.abort();
    process.once("SIGINT", onInterrupt);
    try {
        await runCommand(args, { signal: controller.signal });
    } catch (error) {
        process.exitCode = exitCodeForError(error, controller.signal);
        if (isNeedsAttentionStop(error)) return;
        const message =
            error instanceof Error
                ? error.message
                : redactSensitiveText(String(error));
        process.stderr.write(`${redactSensitiveText(message)}\n`);
    } finally {
        process.removeListener("SIGINT", onInterrupt);
    }
};

export default runCli;