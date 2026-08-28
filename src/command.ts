import { parseArgs } from "node:util";
import { dirname, join } from "node:path";
import { z } from "zod";

import {
    type CleanWhen,
    DEFAULT_EXECUTION_MODE,
    ExecutionMode,
    parsePipelineTimeout,
    type ResolvedRalphieConfig,
    resolveRalphieConfig,
    type IssueRalphieConfig,
    validateRalphieCliOptions,
    WorkflowMode,
} from "./options.ts";
import { IssueOrder, IssueSort } from "./github/issues.ts";
import { piModelSchema, piModelVariantSchema } from "./agent/model.ts";
import {
    makeProgressCoordinator,
    type ProgressCoordinator,
    type ProgressCoordinatorOptions,
} from "./progress/coordinator.ts";
import { type ProgressRenderMode } from "./progress/progress.ts";
import { type PiProviderConfig } from "./pi/config.ts";
import { makePiService } from "./pi/server.ts";
import { makeLiveRuntime, type RalphieRuntime } from "./runtime.ts";
import type { PiService } from "./pi/server.ts";
import type { PiEventListener } from "./pi/client.ts";
import { exitCodeForFailure } from "./process/exit-code.ts";
import { workflow } from "./workflow.ts";
import { redactSensitiveText } from "./shared/redaction.ts";
import { BUILD_INFO } from "./build-info.ts";
import { type RunState, RunStateStoreLive } from "./run/state.ts";
import { reconcileRunState } from "./run/reconciliation.ts";
import { resolveWorkspacePath } from "./workspace/workspace.ts";

const cliOptions = {
    mode: { type: "string" },
    branch: { type: "string", short: "b" },
    workflow: { type: "string" },
    "max-issues": { type: "string" },
    "issue-label": { type: "string", multiple: true },
    "issue-sort": { type: "string" },
    "verify-command": { type: "string", multiple: true },
    "max-attempts": { type: "string" },
    "pipeline-timeout": { type: "string" },
    model: { type: "string" },
    thinking: { type: "string" },
    "grounding-thinking": { type: "string" },
    "complexity-thinking": { type: "string" },
    "review-thinking": { type: "string" },
    "commit-thinking": { type: "string" },
    "pi-dir": { type: "string" },
    workspace: { type: "string" },
    "dry-run": { type: "boolean" },
    clean: { type: "string" },
    resume: { type: "string" },
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

const parseThinking = (
    values: Record<string, unknown>,
    name: string,
): string | undefined => {
    const value = asNonEmptyString(values, name);
    return value === undefined ? undefined : piModelVariantSchema.parse(value);
};

const cleanWhenSchema = z.enum(["start", "end", "both"]);
const outputModeSchema = z.enum(["default", "verbose", "quiet", "json"]);

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

const validateExplicitModeOptions = (
    values: Record<string, unknown>,
    mode: ExecutionMode,
): void => {
    if (mode === ExecutionMode.GetPipelinesGreen) {
        validateRalphieCliOptions({
            mode,
            maxIssues: values["max-issues"] === undefined ? undefined : 1,
            issueLabels: values["issue-label"] === undefined ? undefined : [],
            issueSort:
                values["issue-sort"] === undefined
                    ? undefined
                    : IssueSort.Created,
            workflow:
                values.workflow === undefined ? undefined : WorkflowMode.Lgtm,
        });
        return;
    }

    validateRalphieCliOptions({
        mode,
        maxAttempts: values["max-attempts"] === undefined ? undefined : 1,
        pipelineTimeout:
            values["pipeline-timeout"] === undefined
                ? undefined
                : { value: 1, unit: "seconds" },
    });
};

const parseCliOptions = (
    values: Record<string, unknown>,
    repo: string | undefined,
): Parameters<typeof resolveRalphieConfig>[0] => {
    const modeValue = asNonEmptyString(values, "mode");
    const mode =
        modeValue === undefined
            ? DEFAULT_EXECUTION_MODE
            : z.enum(ExecutionMode).parse(modeValue);
    validateExplicitModeOptions(values, mode);

    const modelValue = asString(values, "model");
    const issueSortValue = asNonEmptyString(values, "issue-sort");
    const thinkingValue = asNonEmptyString(values, "thinking");
    const pipelineTimeoutValue = asString(values, "pipeline-timeout");
    const cleanValue = asNonEmptyString(values, "clean");
    const rawOutput = asNonEmptyString(values, "output");
    const outputValue =
        rawOutput === undefined ? undefined : outputModeSchema.parse(rawOutput);

    return {
        repo,
        mode,
        branch: asString(values, "branch"),
        workflow:
            asString(values, "workflow") === undefined
                ? undefined
                : z.enum(WorkflowMode).parse(asString(values, "workflow")),
        maxIssues: asNumber(values, "max-issues"),
        issueLabels: parseIssueLabels(values),
        verificationCommands: parseRepeatedStrings(values, "verify-command"),
        ...(issueSortValue === undefined ? {} : parseIssueSort(issueSortValue)),
        maxAttempts: asNumber(values, "max-attempts"),
        pipelineTimeout:
            pipelineTimeoutValue === undefined
                ? undefined
                : parsePipelineTimeout(pipelineTimeoutValue),
        model:
            modelValue === undefined
                ? undefined
                : piModelSchema.parse(modelValue),
        thinking:
            thinkingValue === undefined
                ? undefined
                : piModelVariantSchema.parse(thinkingValue),
        groundingThinking: parseThinking(values, "grounding-thinking"),
        complexityThinking: parseThinking(values, "complexity-thinking"),
        reviewThinking: parseThinking(values, "review-thinking"),
        commitThinking: parseThinking(values, "commit-thinking"),
        piDir: asNonEmptyString(values, "pi-dir"),
        workspace: asNonEmptyString(values, "workspace"),
        clean:
            cleanValue === undefined
                ? undefined
                : cleanWhenSchema.parse(cleanValue),
        dryRun: asBoolean(values, "dry-run"),
        resume: asNonEmptyString(values, "resume"),
        verbose: outputValue === "verbose",
        json: outputValue === "json",
        quiet: outputValue === "quiet",
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

const resolvePiConfig = (config: ResolvedRalphieConfig): PiProviderConfig => ({
    workspace: config.workspace,
    modelBaseUrl: config.modelBaseUrl,
    modelApiKey: config.modelApiKey,
    model: config.model,
    agentDir: config.piDir,
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
    if (config.quiet) return "quiet";
    if (terminal.isInteractive && !terminal.isCI && process.stderr.isTTY) {
        return "interactive";
    }
    return "plain";
};

export const HELP_TEXT = `Usage: ralphie <owner/repository> [options]

Run an issue queue or get-pipelines-green through Pi.

Options:
  -b, --branch <name>          Branch to operate on
      --mode <mode>            issues (default) or get-pipelines-green
      --workflow <mode>        Issue workflow: lgtm or pr
      --max-issues <n>         Maximum issues to process
      --issue-label <label>    Include only issues with this label (repeatable)
      --issue-sort <sort>      created, updated, or comments, optionally :asc or :desc
      --verify-command <cmd>   Deterministic pre-commit gate (repeatable)
      --max-attempts <n>       Pipeline attempts (positive; default 3)
      --pipeline-timeout <t>  Pipeline timeout: e.g. 30s, 10m, or 2h
      --model <provider/model> Pi model selection
      --thinking <level>       Pi thinking level: off, minimal, low, medium, high, xhigh, or max
      --grounding-thinking <level> Readiness reasoning (default low)
      --complexity-thinking <level> Complexity reasoning (default medium)
      --review-thinking <level> Review reasoning (default high)
      --commit-thinking <level> Commit-message reasoning (default low)
      --pi-dir <path>          Operator-owned Pi directory outside workspace
      --workspace <path>       Workspace directory
      --dry-run                Assess without mutations
      --resume <path>          Resume saved run state
      --clean <when>           Remove the workspace at start, end, or both
      --output <mode>          Output: live transcript/progress, verbose, quiet, or json
  -h, --help                   Show this help
  -v, --version                Show version (use --output json for build metadata)

Environment:
  GH_TOKEN                     GitHub.com token for gh (preferred)
  GITHUB_TOKEN                 Fallback GitHub.com token alias for gh
                               Interactive \`gh auth login\` or a mounted GitHub CLI profile is not required
  RALPHIE_MODEL_BASE_URL       OpenAI-compatible URL; uses private temporary config
  RALPHIE_MODEL_API_KEY        Model API key (environment only)
`;

export type CommandRuntime = RalphieRuntime & {
    readonly dispose?: () => Promise<void>;
};

export type CommandFactories = {
    readonly makeCoordinator?: (
        options: ProgressCoordinatorOptions,
    ) => ProgressCoordinator;
    readonly makePi?: (
        config: PiProviderConfig,
        listener: PiEventListener,
    ) => PiService;
    readonly makeRuntime?: (input: {
        readonly pi: PiService;
        readonly progress: ProgressCoordinator["progress"];
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
    makePi: factories.makePi ?? makePiService,
    makeRuntime: factories.makeRuntime ?? makeLiveRuntime,
    runWorkflow: factories.runWorkflow ?? workflow,
});

const loadResumeState = async (
    config: ResolvedRalphieConfig,
): Promise<RunState | undefined> => {
    if (config.resume === undefined) return undefined;

    const resumeState = await RunStateStoreLive.load(config.resume);
    if (config.branch === undefined) return resumeState;

    const reconciliation = reconcileRunState(resumeState, {
        repository: config.repo,
        branch: config.branch,
    });
    if (!reconciliation.compatible) {
        throw new Error(
            `Cannot resume run ${resumeState.runId}: ${reconciliation.reasons.join("; ")}.`,
        );
    }
    return resumeState;
};

const eventLogPathFor = (
    config: ResolvedRalphieConfig,
    runId: string,
): string =>
    config.resume === undefined
        ? join(
              resolveWorkspacePath(config.workspace),
              ".ralphie",
              "runs",
              runId,
              "events.jsonl",
          )
        : join(dirname(config.resume), "events.jsonl");

const makeCommandCoordinator = (
    config: ResolvedRalphieConfig,
    terminal: CliTerminalInfo,
    runId: string,
    factory: NonNullable<CommandFactories["makeCoordinator"]>,
    output: CommandOutput,
): ProgressCoordinator =>
    factory({
        mode: resolveProgressMode(config, terminal),
        verbose: config.verbose,
        width: () => process.stderr.columns ?? terminal.width,
        write: config.json ? output.stdout : output.stderr,
        colors: terminal.isInteractive && !terminal.isCI,
        runId,
        eventLogPath: eventLogPathFor(config, runId),
    });

const workflowOptionsFor = (
    config: IssueRalphieConfig,
    input: RunCommandInput,
    runId: string,
    resumeState: RunState | undefined,
) => ({
    workflow: config.workflow,
    repo: config.repo,
    branch: config.branch,
    maxIssues: config.maxIssues,
    issueFilters: {
        labels: config.issueLabels,
        sort: config.issueSort,
        order: config.issueOrder,
    },
    model: config.model,
    modelVariant: config.thinking,
    piStageVariants: {
        grounding: config.groundingThinking ?? "low",
        complexity: config.complexityThinking ?? "medium",
        review: config.reviewThinking ?? "high",
        commitMessage: config.commitThinking ?? "low",
    },
    verificationCommands: config.verificationCommands,
    agent: config.agent,
    workspace: config.workspace,
    cleanup: config.cleanEnd,
    startClean: config.cleanStart,
    signal: input.signal,
    runId,
    resumeState,
    resumePath: config.resume,
    dryRun: config.dryRun,
});

/** Execute one Ralphie command. */
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
    if (config.mode === ExecutionMode.GetPipelinesGreen) {
        throw new Error(
            "The get-pipelines-green execution mode is not implemented yet.",
        );
    }
    const issueConfig: IssueRalphieConfig = config;
    const resumeState = await loadResumeState(issueConfig);

    const terminal = input.terminal ?? terminalInfo();
    const runId = resumeState?.runId ?? crypto.randomUUID();
    let coordinator: ProgressCoordinator | undefined;
    let runtime: CommandRuntime | undefined;
    let commandError: Error | undefined;

    try {
        const factories = resolveCommandFactories(input.factories);
        coordinator = makeCommandCoordinator(
            issueConfig,
            terminal,
            runId,
            factories.makeCoordinator,
            output,
        );
        const pi = factories.makePi(
            resolvePiConfig(issueConfig),
            coordinator.piListener,
        );
        runtime = factories.makeRuntime({
            pi,
            progress: coordinator.progress,
        });
        await factories.runWorkflow(
            workflowOptionsFor(issueConfig, input, runId, resumeState),
            runtime,
        );
    } catch (error) {
        const message =
            error instanceof Error
                ? redactSensitiveText(error.message)
                : String(error);
        process.exitCode = exitCodeForFailure(
            input.signal ?? new AbortController().signal,
        );
        commandError = new Error(message, { cause: error });
        throw commandError;
    } finally {
        await disposeCommandResources(runtime, coordinator, commandError);
    }
};

export default runCommand;