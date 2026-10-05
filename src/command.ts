import { parseArgs } from "node:util";

import { z } from "zod";

import {
    type RalphieCliOptions,
    type ResolvedRalphieConfig,
    resolveRalphieConfig,
    type IssueRalphieConfig,
    validateRalphieCliOptions,
} from "./options.ts";
import { parseSetOverride, type SetOverride } from "./config/resolve.ts";
import type {
    ConfigSourceService,
    GitHubLoginService,
} from "./config/ports.ts";
import { makeFileConfigSource } from "./config/adapters/file-source.ts";
import { makeGitHubLoginService } from "./github/adapters/login.ts";
import { CommandRunnerLive } from "./process/adapters/command-runner.ts";
import { RalphieError } from "./shared/error.ts";
import { agentModelSchema, agentModelVariantSchema } from "./agent/model.ts";
import {
    makeProgressCoordinator,
    type ProgressCoordinator,
    type ProgressCoordinatorOptions,
} from "./progress/adapters/coordinator.ts";
import { type ProgressRenderMode } from "./progress/adapters/progress.ts";
import { makePiAgentService } from "./pi/adapters/runtime.ts";
import { type PiAgentService } from "./pi/ports.ts";
import { type PiAgentConfig } from "./pi/ports.ts";
import { makeLiveRuntime, type IssueWorkflowRuntime } from "./runtime.ts";
import type { AgentEventListener } from "./agent/ports.ts";
import { exitCodeForError, RalphieExitCode } from "./workflow/exit-code.ts";
import { issueWorkflow } from "./workflow/workflow.ts";
import type { IssueWorkflow } from "./workflow/ports.ts";
import { BUILD_INFO } from "./build-info.ts";
import { makeRunEventLog } from "./run/adapters/event-log.ts";
import type { RunControl, RunEventLog, RunLayout } from "./run/ports.ts";
import { makeRunLayout } from "./run/adapters/layout.ts";

const cliOptions = {
    config: { type: "string" },
    set: { type: "string", multiple: true },
    "notify-needs-attention": { type: "boolean" },
    "needs-attention-label": { type: "string" },
    model: { type: "string" },
    thinking: { type: "string" },
    output: { type: "string" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
    // Removed flags stay declared only so they can name their replacement.
    branch: { type: "string", short: "b" },
    "max-decomposition-depth": { type: "string" },
    "issue-label": { type: "string", multiple: true },
    "issue-sort": { type: "string" },
    "verify-command": { type: "string", multiple: true },
    "implementation-attempts": { type: "string" },
    workspace: { type: "string" },
} as const;

/** Each removed flag and the configuration key that replaces it. */
const REMOVED_FLAGS: Readonly<Record<string, string>> = {
    branch: 'repos."owner/repo".branch',
    "max-decomposition-depth": "limits.maxDecompositionDepth",
    "issue-label": "intake.requireLabels",
    "issue-sort": "intake.sort",
    "verify-command": 'repos."owner/repo".verify',
    "implementation-attempts": "limits.implementationAttempts",
    workspace: "workspace",
};

type ParsedCli = {
    readonly help: boolean;
    readonly version: boolean;
    readonly options: RalphieCliOptions;
};

const rejectRemovedFlags = (values: Record<string, unknown>): void => {
    for (const [flag, key] of Object.entries(REMOVED_FLAGS)) {
        if (values[flag] !== undefined) {
            throw new RalphieError({
                message: `Option --${flag} was removed. Set ${key} in the configuration file, or pass --set ${key}=<value> for one run.`,
            });
        }
    }
};

const asString = (
    values: Record<string, unknown>,
    name: string,
): string | undefined => {
    const value = values[name];
    if (value === undefined) return undefined;
    if (typeof value !== "string") {
        throw new Error(`Option --${name} requires a string value.`);
    }
    return value;
};

const asNonEmptyString = (
    values: Record<string, unknown>,
    name: string,
): string | undefined => {
    const value = asString(values, name);
    return value === undefined
        ? undefined
        : z.string().trim().min(1).parse(value);
};

const asBoolean = (values: Record<string, unknown>, name: string): boolean =>
    values[name] === true;

const parseModel = (values: Record<string, unknown>, name: string) => {
    const value = asNonEmptyString(values, name);
    return value === undefined ? undefined : agentModelSchema.parse(value);
};

const outputModeSchema = z.enum(["default", "json"]);

const parseOverrides = (
    values: Record<string, unknown>,
): ReadonlyArray<SetOverride> => {
    const raw = values.set;
    if (raw === undefined) return [];
    return (Array.isArray(raw) ? raw : [raw]).map((entry) =>
        parseSetOverride(String(entry)),
    );
};

const parseNotificationOptions = (values: Record<string, unknown>) => ({
    ...(values["notify-needs-attention"] === undefined
        ? {}
        : {
              notifyNeedsAttention: asBoolean(values, "notify-needs-attention"),
          }),
    needsAttentionLabel: asNonEmptyString(values, "needs-attention-label"),
});

const parseCliOptions = (
    values: Record<string, unknown>,
    repo: string | undefined,
): RalphieCliOptions => {
    const thinkingValue = asNonEmptyString(values, "thinking");
    const rawOutput = asNonEmptyString(values, "output");
    const outputValue =
        rawOutput === undefined ? undefined : outputModeSchema.parse(rawOutput);

    return {
        repo,
        configPath: asNonEmptyString(values, "config"),
        overrides: parseOverrides(values),
        ...parseNotificationOptions(values),
        model: parseModel(values, "model"),
        thinking:
            thinkingValue === undefined
                ? undefined
                : agentModelVariantSchema.parse(thinkingValue),
        json: outputValue === "json",
    };
};

/** Parse the public `ralphie <repository> [options]` command line. */
export const parseCliArgs = (args: ReadonlyArray<string>): ParsedCli => {
    const parsed = parseArgs({
        args: [...args],
        options: cliOptions,
        allowPositionals: true,
        strict: true,
    });
    if (parsed.positionals.length > 1) {
        throw new Error(`Unexpected argument: ${parsed.positionals[1]}`);
    }

    if (parsed.positionals[0] === "init") {
        throw new RalphieError({
            message:
                "`ralphie init` is not available yet. To target a repository named init, pass owner/init.",
        });
    }

    const values = parsed.values as Record<string, unknown>;
    rejectRemovedFlags(values);
    const options = parseCliOptions(values, parsed.positionals[0]);
    validateRalphieCliOptions(options);
    return {
        help: asBoolean(values, "help"),
        version: asBoolean(values, "version"),
        options,
    };
};

const resolvePiAgentConfig = (
    config: ResolvedRalphieConfig,
): PiAgentConfig => ({
    ...(config.model === undefined ? {} : { model: config.model }),
});

export type CliTerminalInfo = {
    readonly isInteractive: boolean;
    readonly isCI: boolean;
    readonly width: number;
};

export const terminalInfo = (): CliTerminalInfo => ({
    isInteractive:
        process.stdin.isTTY === true && process.stderr.isTTY === true,
    isCI: process.env.CI === "true" || process.env.CI === "1",
    width: process.stderr.columns ?? 80,
});

const resolveProgressMode = (
    config: ResolvedRalphieConfig,
    terminal: CliTerminalInfo,
): ProgressRenderMode => {
    if (config.json) return "json";
    if (terminal.isInteractive && !terminal.isCI && process.stderr.isTTY) {
        return "interactive";
    }
    return "plain";
};

export const HELP_TEXT = `Usage: ralphie <[owner/]repository | clone-url> [options]

Turn open GitHub issues into reviewed commits through pi.

All settings live in $XDG_CONFIG_HOME/ralphie/config.yaml (default
~/.config/ralphie/config.yaml); see docs/configuration.md.

Options:
      --config <path>          Load this configuration file instead of the default
      --set <path=value>       Override a configuration key for this run (repeatable),
                               e.g. --set limits.reviewRounds=3
                               or   --set 'repos."owner/repo".branch=develop'
      --notify-needs-attention Enable needs-attention GitHub notifications (default disabled)
      --needs-attention-label <name>
                               Add this label to notifications (requires the opt-in flag)
      --model <provider/model> Pi model selection (defaults to pi settings)
      --thinking <level>       Thinking level for every session: off, minimal, low, medium, high, xhigh, or max (default medium)
      --output <mode>          Output: default (TUI on a terminal, plain when piped) or json
  -h, --help                   Show this help
  -v, --version                Show version (use --output json for build metadata)

A bare repository name gets defaultOwner from the configuration, else the
authenticated gh user. The repository is never inferred from the current directory.

Environment:
  GH_TOKEN                     GitHub.com token for gh (preferred)
  GITHUB_TOKEN                 Fallback GitHub.com token alias for gh
                               Interactive \`gh auth login\` or a mounted GitHub CLI profile is not required
  PI_CODING_AGENT_DIR          Pi config directory (default ~/.pi/agent)
  ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, ...
                               Provider credentials; a stored pi auth.json credential wins
`;

export type CommandRuntime = IssueWorkflowRuntime & {
    readonly dispose?: () => Promise<void>;
};

export type CommandFactories = {
    readonly configSource?: ConfigSourceService;
    readonly githubLogin?: GitHubLoginService;
    readonly makeCoordinator?: (
        options: ProgressCoordinatorOptions,
    ) => ProgressCoordinator;
    readonly makeAgentRuntime?: (
        config: PiAgentConfig,
        listener: AgentEventListener,
    ) => PiAgentService;
    readonly makeRuntime?: (input: {
        readonly agentRuntime: PiAgentService;
        readonly progress: ProgressCoordinator["progress"];
        readonly runEventLog: RunEventLog;
        readonly layout: RunLayout;
    }) => CommandRuntime;
    readonly runWorkflow?: IssueWorkflow["run"];
};

export type CommandOutput = {
    readonly stdout: (text: string) => void;
    readonly stderr: (text: string) => void;
};

export type RunCommandInput = {
    readonly signal?: AbortSignal;
    readonly terminal?: CliTerminalInfo;
    /** Explicit test seams; production callers should use the defaults. */
    readonly factories?: CommandFactories;
    readonly output?: CommandOutput;
};

const commandOutput = (output?: CommandOutput): CommandOutput =>
    output ?? {
        stdout: (text) => process.stdout.write(text),
        stderr: (text) => process.stderr.write(text),
    };

const resolveCommandFactories = (
    factories: CommandFactories = {},
): Required<CommandFactories> => ({
    configSource: factories.configSource ?? makeFileConfigSource(),
    githubLogin:
        factories.githubLogin ?? makeGitHubLoginService(CommandRunnerLive),
    makeCoordinator: factories.makeCoordinator ?? makeProgressCoordinator,
    makeAgentRuntime: factories.makeAgentRuntime ?? makePiAgentService,
    makeRuntime: factories.makeRuntime ?? makeLiveRuntime,
    runWorkflow: factories.runWorkflow ?? issueWorkflow.run,
});

const eventLogFor = (layout: RunLayout): RunEventLog =>
    makeRunEventLog({ path: layout.eventLogPath });

const makeCommandCoordinator = (
    config: ResolvedRalphieConfig,
    terminal: CliTerminalInfo,
    runId: string,
    factory: NonNullable<CommandFactories["makeCoordinator"]>,
    output: CommandOutput,
    eventLog: RunEventLog,
): ProgressCoordinator =>
    factory({
        mode: resolveProgressMode(config, terminal),
        width: () => process.stderr.columns ?? terminal.width,
        write: config.json ? output.stdout : output.stderr,
        colors: terminal.isInteractive && !terminal.isCI,
        runId,
        eventLog,
    });

const workflowOptionsFor = (
    config: IssueRalphieConfig,
    input: RunCommandInput,
    runId: string,
    control?: RunControl,
) => ({
    repo: config.repo,
    branch: config.branch,
    maxDecompositionDepth: config.maxDecompositionDepth,
    issueFilters: {
        labels: config.issueLabels,
        sort: config.issueSort,
        order: config.issueOrder,
    },
    model: config.model,
    modelVariant: config.thinking,
    verificationCommands: config.verificationCommands,
    implementationAttempts: config.implementationAttempts,
    agent: config.agent,
    workspace: config.workspace,
    signal: input.signal,
    ...(control === undefined ? {} : { control }),
    runId,
    notificationsEnabled: config.notificationsEnabled,
    needsAttentionLabel: config.needsAttentionLabel,
});

const commandErrorFor = (error: unknown, signal: AbortSignal): Error => {
    const message = error instanceof Error ? error.message : String(error);
    process.exitCode = exitCodeForError(error, signal);
    return new Error(message, { cause: error });
};

const disposeCommandResources = async (
    runtime: CommandRuntime | undefined,
    coordinator: ProgressCoordinator | undefined,
    commandError: Error | undefined,
): Promise<void> => {
    let cleanupError: unknown;
    try {
        await runtime?.dispose?.();
    } catch (error) {
        cleanupError = error;
    }
    try {
        await coordinator?.dispose();
    } catch (error) {
        cleanupError ??= error;
    }
    if (commandError === undefined && cleanupError !== undefined) {
        throw cleanupError;
    }
};

export const runCommand = async (
    args: ReadonlyArray<string> = Bun.argv.slice(2),
    input: RunCommandInput = {},
): Promise<void> => {
    const output = commandOutput(input.output);
    const parsed = parseCliArgs(args);
    if (parsed.help) {
        output.stdout(HELP_TEXT);
        return;
    }
    if (parsed.version) {
        output.stdout(
            parsed.options.json
                ? `${JSON.stringify(BUILD_INFO)}\n`
                : `${BUILD_INFO.version}\n`,
        );
        return;
    }

    const factories = resolveCommandFactories(input.factories);
    const file = await factories.configSource.load(parsed.options.configPath);
    const config = await resolveRalphieConfig({
        options: parsed.options,
        file,
        login: factories.githubLogin.currentLogin,
    });

    const terminal = input.terminal ?? terminalInfo();
    const runId = crypto.randomUUID();
    const layout = makeRunLayout(config.workspace, runId);
    const runEventLog = eventLogFor(layout);
    let coordinator: ProgressCoordinator | undefined;
    let runtime: CommandRuntime | undefined;
    let commandError: Error | undefined;

    try {
        coordinator = makeCommandCoordinator(
            config,
            terminal,
            runId,
            factories.makeCoordinator,
            output,
            runEventLog,
        );
        const agentRuntime = factories.makeAgentRuntime(
            {
                ...resolvePiAgentConfig(config),
                liveSelection: () => coordinator?.control?.issueSelection?.(),
            },
            coordinator.piListener,
        );
        runtime = factories.makeRuntime({
            agentRuntime,
            progress: coordinator.progress,
            runEventLog,
            layout,
        });
        await factories.runWorkflow(
            workflowOptionsFor(config, input, runId, coordinator.control),
            runtime,
        );
        process.exitCode = RalphieExitCode.Success;
    } catch (error) {
        commandError = commandErrorFor(
            error,
            input.signal ?? new AbortController().signal,
        );
        throw commandError;
    } finally {
        await disposeCommandResources(runtime, coordinator, commandError);
    }
};