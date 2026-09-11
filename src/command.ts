import { parseArgs } from "node:util";

import { z } from "zod";

import {
    type ResolvedRalphieConfig,
    resolveRalphieConfig,
    type IssueRalphieConfig,
    validateRalphieCliOptions,
} from "./options.ts";
import { IssueOrder, IssueSort } from "./github/domain.ts";
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
import { workflow } from "./workflow/workflow.ts";
import { BUILD_INFO } from "./build-info.ts";
import { makeRunEventLog } from "./run/adapters/event-log.ts";
import type { RunEventLog, RunLayout } from "./run/ports.ts";
import { makeRunLayout } from "./run/adapters/layout.ts";

const cliOptions = {
    branch: { type: "string", short: "b" },
    "notify-needs-attention": { type: "boolean" },
    "needs-attention-label": { type: "string" },
    "max-decomposition-depth": { type: "string" },
    "issue-label": { type: "string", multiple: true },
    "issue-sort": { type: "string" },
    "verify-command": { type: "string", multiple: true },
    model: { type: "string" },
    thinking: { type: "string" },
    "implementation-attempts": { type: "string" },
    workspace: { type: "string" },
    output: { type: "string" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
} as const;

type ParsedCli = {
    readonly help: boolean;
    readonly version: boolean;
    readonly options: Parameters<typeof resolveRalphieConfig>[0];
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

const asNumber = (
    values: Record<string, unknown>,
    name: string,
): number | undefined => {
    const value = asString(values, name);
    return value === undefined
        ? undefined
        : z.coerce.number().int().positive().parse(value);
};

const asBoolean = (values: Record<string, unknown>, name: string): boolean =>
    values[name] === true;

const parseModel = (values: Record<string, unknown>, name: string) => {
    const value = asNonEmptyString(values, name);
    return value === undefined ? undefined : agentModelSchema.parse(value);
};

const outputModeSchema = z.enum(["default", "json"]);

const parseIssueSort = (
    value: string,
): {
    readonly issueSort: IssueSort;
    readonly issueOrder: IssueOrder;
} => {
    const parts = value.split(":");
    if (parts.length > 2) {
        throw new Error(
            "Option --issue-sort requires <created|updated|comments> with an optional :asc or :desc.",
        );
    }
    const sort = z.enum(IssueSort).parse(parts[0] ?? "");
    const order =
        parts[1] === undefined
            ? IssueOrder.Ascending
            : z.enum(IssueOrder).parse(parts[1]);
    return { issueSort: sort, issueOrder: order };
};

const parseIssueLabels = (
    values: Record<string, unknown>,
): ReadonlyArray<string> | undefined => {
    const labels = values["issue-label"];
    if (labels === undefined) return undefined;
    if (!Array.isArray(labels) && typeof labels !== "string") {
        throw new Error("Option --issue-label requires a value.");
    }
    return (Array.isArray(labels) ? labels : [labels]).map((label) =>
        z.string().trim().min(1).parse(label),
    );
};

const parseRepeatedStrings = (
    values: Record<string, unknown>,
    name: string,
): ReadonlyArray<string> | undefined => {
    const raw = values[name];
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw) && typeof raw !== "string") {
        throw new Error(`Option --${name} requires a value.`);
    }
    return (Array.isArray(raw) ? raw : [raw]).map((value) =>
        z.string().trim().min(1).parse(value),
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
): Parameters<typeof resolveRalphieConfig>[0] => {
    const notificationOptions = parseNotificationOptions(values);
    const issueSortValue = asNonEmptyString(values, "issue-sort");
    const thinkingValue = asNonEmptyString(values, "thinking");
    const rawOutput = asNonEmptyString(values, "output");
    const outputValue =
        rawOutput === undefined ? undefined : outputModeSchema.parse(rawOutput);

    return {
        repo,
        branch: asString(values, "branch"),
        ...notificationOptions,
        maxDecompositionDepth: asNumber(values, "max-decomposition-depth"),
        issueLabels: parseIssueLabels(values),
        verificationCommands: parseRepeatedStrings(values, "verify-command"),
        ...(issueSortValue === undefined ? {} : parseIssueSort(issueSortValue)),
        model: parseModel(values, "model"),
        thinking:
            thinkingValue === undefined
                ? undefined
                : agentModelVariantSchema.parse(thinkingValue),
        implementationAttempts: asNumber(values, "implementation-attempts"),
        workspace: asNonEmptyString(values, "workspace"),
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

    const values = parsed.values as Record<string, unknown>;
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

export const HELP_TEXT = `Usage: ralphie <owner/repository> [options]

Turn open GitHub issues into reviewed commits through pi.

Options:
  -b, --branch <name>          Base branch to operate on
      --notify-needs-attention Enable needs-attention GitHub notifications (default disabled)
      --needs-attention-label <name>
                               Add this label to notifications (requires the opt-in flag)
      --max-decomposition-depth <n>
                               Maximum recursive decomposition depth (default 3)
      --issue-label <label>    Include only issues with this label (repeatable)
      --issue-sort <sort>      created, updated, or comments, optionally :asc or :desc
      --verify-command <cmd>   Optional deterministic gate (repeatable; skipped when omitted)
      --model <provider/model> Pi model selection (defaults to pi settings)
      --thinking <level>       Thinking level for every session: off, minimal, low, medium, high, xhigh, or max (default medium)
      --implementation-attempts <n> Empty implementation retries (default 3)
      --workspace <path>       Workspace directory (removed at start and after success)
      --output <mode>          Output: default live transcript/progress or json
  -h, --help                   Show this help
  -v, --version                Show version (use --output json for build metadata)

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
    readonly runWorkflow?: typeof workflow;
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
    makeCoordinator: factories.makeCoordinator ?? makeProgressCoordinator,
    makeAgentRuntime: factories.makeAgentRuntime ?? makePiAgentService,
    makeRuntime: factories.makeRuntime ?? makeLiveRuntime,
    runWorkflow: factories.runWorkflow ?? workflow,
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
        resize: {
            subscribe: (listener) => {
                process.stderr.on("resize", listener);
                return () => process.stderr.removeListener("resize", listener);
            },
        },
        write: config.json ? output.stdout : output.stderr,
        colors: terminal.isInteractive && !terminal.isCI,
        runId,
        eventLog,
    });

const workflowOptionsFor = (
    config: IssueRalphieConfig,
    input: RunCommandInput,
    runId: string,
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

    const config = resolveRalphieConfig(parsed.options);

    const terminal = input.terminal ?? terminalInfo();
    const runId = crypto.randomUUID();
    const layout = makeRunLayout(config.workspace, runId);
    const runEventLog = eventLogFor(layout);
    let coordinator: ProgressCoordinator | undefined;
    let runtime: CommandRuntime | undefined;
    let commandError: Error | undefined;

    try {
        const factories = resolveCommandFactories(input.factories);
        coordinator = makeCommandCoordinator(
            config,
            terminal,
            runId,
            factories.makeCoordinator,
            output,
            runEventLog,
        );
        const agentRuntime = factories.makeAgentRuntime(
            resolvePiAgentConfig(config),
            coordinator.piListener,
        );
        runtime = factories.makeRuntime({
            agentRuntime,
            progress: coordinator.progress,
            runEventLog,
            layout,
        });
        await factories.runWorkflow(
            workflowOptionsFor(config, input, runId),
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