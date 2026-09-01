import {
    CommandRunnerLive,
    type CommandRunnerService,
} from "../process/command-runner.ts";
import { RalphieError } from "../shared/error.ts";
import {
    makeCodexClient,
    type CodexClient,
    type CodexEventListener,
} from "./client.ts";

export type CodexProviderConfig = {
    readonly workspace?: string;
    readonly modelBaseUrl?: string;
    readonly modelApiKey?: string;
    readonly model?: unknown;
    readonly agentDir?: string;
    readonly command?: string;
    readonly docker?: boolean;
};
export type CodexRuntime = {
    readonly url: string;
    readonly client: CodexClient;
    readonly close: () => Promise<void>;
};
export type CodexService = { readonly start: () => Promise<CodexRuntime> };

const REQUIRED_FLAGS = [
    "exec",
    "--json",
    "--output-schema",
    "--ignore-user-config",
    "--sandbox",
];

export const verifyCodexCli = async (
    runner: CommandRunnerService,
    command: string,
): Promise<void> => {
    const result = await runner.run(command, ["exec", "--help"], {
        trimStdout: false,
    });
    const help = `${result.stdout}\n${result.stderr}`;
    if (
        result.exitCode !== 0 ||
        REQUIRED_FLAGS.some((flag) => !help.includes(flag))
    ) {
        throw new RalphieError({
            message: `Codex CLI is unavailable or does not support required automation flags (${REQUIRED_FLAGS.join(", ")}).`,
        });
    }
};

/** Every task runs in a new ephemeral external Codex process. */
export const makeCodexService = (
    config: CodexProviderConfig = {},
    eventListener?: CodexEventListener,
    runner: CommandRunnerService = CommandRunnerLive,
): CodexService => ({
    start: async () => {
        const command = config.command ?? "codex";
        await verifyCodexCli(runner, command);
        return {
            url: `process://${command}`,
            client: makeCodexClient({
                command,
                eventListener,
                docker: config.docker,
            }),
            close: async () => undefined,
        };
    },
});

export const CodexLive = makeCodexService;