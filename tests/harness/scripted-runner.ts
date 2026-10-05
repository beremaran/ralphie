import type {
    CommandRunOptions,
    CommandRunnerService,
} from "../../src/process/ports.ts";

/** What a scripted process does when the adapter spawns it. */
export type ProcessScript =
    | {
          readonly stdout: string;
          readonly stderr?: string;
          readonly exitCode?: number;
      }
    | { readonly throws: Error };

export type RecordedInvocation = {
    readonly command: string;
    readonly args: readonly string[];
    readonly options: CommandRunOptions;
};

/**
 * Process port that replays recorded output instead of spawning anything.
 *
 * Each call consumes the next script and reports its stdout line by line to
 * `onStdoutLine`, as the live runner does.
 */
export const makeScriptedRunner = (
    scripts: readonly ProcessScript[],
): {
    readonly runner: CommandRunnerService;
    readonly invocations: RecordedInvocation[];
} => {
    const invocations: RecordedInvocation[] = [];
    let next = 0;
    const runner: CommandRunnerService = {
        run: async (command, args, options = {}) => {
            invocations.push({ command, args: [...args], options });
            const script = scripts[next];
            next += 1;
            if (script === undefined) {
                throw new Error(
                    `No scripted process for call ${next}: ${command}`,
                );
            }
            if ("throws" in script) throw script.throws;
            const lines = script.stdout.split("\n");
            for (const [index, line] of lines.entries()) {
                const last = index === lines.length - 1;
                if (last && line === "") continue;
                options.onStdoutLine?.(line);
            }
            return {
                exitCode: script.exitCode ?? 0,
                stdout: script.stdout,
                stderr: script.stderr ?? "",
            };
        },
    };
    return { runner, invocations };
};