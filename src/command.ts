import { parseArgs } from "node:util";
import { dirname, join } from "node:path";
import { z } from "zod";

import {
    type CleanWhen,
    DEFAULT_EXECUTION_MODE,
    DuplicateAction,
    ExecutionMode,
    IssueFailurePolicy,
    NeedsAttentionPolicy,
    parsePipelineTimeout,
    type ResolvedRalphieConfig,
    resolveRalphieConfig,
    type IssueRalphieConfig,
    type MaintainIssuesRalphieConfig,
    type GetPipelinesGreenRalphieConfig,
    validateExplicitRalphieCliOptions,
    validateRalphieCliOptions,
    WorkflowMode,
    DEFAULT_MAX_DECOMPOSITION_DEPTH,
} from "./options.ts";
import { IssueOrder, IssueSort } from "./github/issues.ts";
import { agentModelSchema, agentModelVariantSchema } from "./agent/model.ts";
import {
    makeProgressCoordinator,
    type ProgressCoordinator,
    type ProgressCoordinatorOptions,
} from "./progress/coordinator.ts";
import { type ProgressRenderMode } from "./progress/progress.ts";
import { type OpenCodeProviderConfig } from "./opencode/config.ts";
import { makeOpenCodeService } from "./opencode/server.ts";
import { makeLiveRuntime, type RalphieRuntime } from "./runtime.ts";
import type { OpenCodeService } from "./opencode/server.ts";
import type { AgentEventListener } from "./opencode/client.ts";
import {
    exitCodeForError,
    isNeedsAttentionStop,
    RalphieExitCode,
} from "./process/exit-code.ts";
import { workflow } from "./workflow.ts";
import {
    maintainIssues,
    type MaintainIssuesOptions,
} from "./maintain-issues.ts";
import { BUILD_INFO } from "./build-info.ts";
import { type RunState, RunStateStoreLive } from "./run/state.ts";
import {
    loadMaintenanceRunState,
    type MaintenanceRunState,
} from "./maintain-issues-state.ts";
import {
    loadPipelineRunState,
    type PipelineRunState,
} from "./run/pipeline-state.ts";
import { reconcileRunState } from "./run/reconciliation.ts";
import { resolveWorkspacePath } from "./workspace/workspace.ts";
import { RalphieError } from "./shared/error.ts";
import {
    getPipelinesGreen,
    type GetPipelinesGreenOptions,
} from "./get-pipelines-green.ts";

const cliOptions = {
    mode: { type: "string" },
    branch: { type: "string", short: "b" },
    workflow: { type: "string" },
    "on-needs-attention": { type: "string" },
    "on-issue-failure": { type: "string" },
    "notify-needs-attention": { type: "boolean" },
    "needs-attention-label": { type: "string" },
    "duplicate-action": { type: "string" },
    "max-issues": { type: "string" },
    "max-decomposition-depth": { type: "string" },
    "issue-label": { type: "string", multiple: true },
    "issue-sort": { type: "string" },
    "verify-command": { type: "string", multiple: true },
    "max-attempts": { type: "string" },
    "pipeline-timeout": { type: "string" },
    model: { type: "string" },
    thinking: { type: "string" },
    "grounding-thinking": { type: "string" },
    "implementation-thinking": { type: "string" },
    "implementation-attempts": { type: "string" },
    "implementation-fallback-model": { type: "string" },
    "complexity-thinking": { type: "string" },
    "review-thinking": { type: "string" },
    "commit-thinking": { type: "string" },
    "opencode-url": { type: "string" },
    "opencode-token": { type: "string" },
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
    /** Undefined when --duplicate-action was not present on the command line. */
    readonly explicitDuplicateAction?: DuplicateAction;
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
    return value === undefined
        ? undefined
        : agentModelVariantSchema.parse(value);
};

const parseNeedsAttentionPolicy = (
    values: Record<string, unknown>,
): NeedsAttentionPolicy | undefined => {
    const value = asNonEmptyString(values, "on-needs-attention");
    return value === undefined
        ? undefined
        : z.enum(NeedsAttentionPolicy).parse(value);
};

const parseIssueFailurePolicy = (
    values: Record<string, unknown>,
): IssueFailurePolicy | undefined => {
    const value = asNonEmptyString(values, "on-issue-failure");
    return value === undefined
        ? undefined
        : z.enum(IssueFailurePolicy).parse(value);
};

const parseModel = (values: Record<string, unknown>, name: string) => {
    const value = asNonEmptyString(values, name);
    return value === undefined ? undefined : agentModelSchema.parse(value);
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
    const modeValue = asNonEmptyString(values, "mode");
    const mode =
        modeValue === undefined
            ? DEFAULT_EXECUTION_MODE
            : z.enum(ExecutionMode).parse(modeValue);
    validateExplicitRalphieCliOptions(values, mode);

    const onNeedsAttention = parseNeedsAttentionPolicy(values);
    const notificationOptions = parseNotificationOptions(values);
    const duplicateActionValue = asNonEmptyString(values, "duplicate-action");
    const duplicateAction =
        duplicateActionValue === undefined
            ? mode === ExecutionMode.MaintainIssues
                ? DuplicateAction.Link
                : undefined
            : z.enum(DuplicateAction).parse(duplicateActionValue);
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
        onNeedsAttention,
        onIssueFailure: parseIssueFailurePolicy(values),
        ...notificationOptions,
        ...(duplicateAction === undefined ? {} : { duplicateAction }),
        maxIssues: asNumber(values, "max-issues"),
        maxDecompositionDepth: asNumber(values, "max-decomposition-depth"),
        issueLabels: parseIssueLabels(values),
        verificationCommands: parseRepeatedStrings(values, "verify-command"),
        ...(issueSortValue === undefined ? {} : parseIssueSort(issueSortValue)),
        maxAttempts: asNumber(values, "max-attempts"),
        pipelineTimeout:
            pipelineTimeoutValue === undefined
                ? undefined
                : parsePipelineTimeout(pipelineTimeoutValue),
        model: parseModel(values, "model"),
        thinking:
            thinkingValue === undefined
                ? undefined
                : agentModelVariantSchema.parse(thinkingValue),
        groundingThinking: parseThinking(values, "grounding-thinking"),
        implementationThinking: parseThinking(
            values,
            "implementation-thinking",
        ),
        implementationAttempts: asNumber(values, "implementation-attempts"),
        implementationFallbackModel: parseModel(
            values,
            "implementation-fallback-model",
        ),
        complexityThinking: parseThinking(values, "complexity-thinking"),
        reviewThinking: parseThinking(values, "review-thinking"),
        commitThinking: parseThinking(values, "commit-thinking"),
        opencodeUrl: asNonEmptyString(values, "opencode-url"),
        opencodeToken: asNonEmptyString(values, "opencode-token"),
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
        ...(values["duplicate-action"] === undefined ||
        options.duplicateAction === undefined
            ? {}
            : { explicitDuplicateAction: options.duplicateAction }),
    };
};

const resolveOpenCodeConfig = (
    config: ResolvedRalphieConfig,
): OpenCodeProviderConfig => ({
    workspace: config.workspace,
    baseUrl: config.opencodeUrl,
    token: config.opencodeToken,
    model: config.model,
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

Run an issue queue, maintain issues, or get-pipelines-green through OpenCode.

Options:
  -b, --branch <name>          Branch to operate on
      --mode <mode>            issues (default), maintain-issues, or get-pipelines-green
      --workflow <mode>        Issue workflow: lgtm or pr (issues mode only)
      --on-needs-attention <halt|continue>
                               Needs-attention policy (default halt; issues mode only)
      --on-issue-failure <halt|continue>
                               Ordinary issue failure policy (default halt; issues mode only)
      --notify-needs-attention Enable needs-attention GitHub notifications (default disabled)
      --needs-attention-label <name>
                               Add this label to notifications (requires the opt-in flag)
      --duplicate-action <link|close>
                               Duplicate handling in maintain-issues mode (default link)
      --max-issues <n>         Maximum issues to process
      --max-decomposition-depth <n>
                               Maximum recursive decomposition depth (default 3)
      --issue-label <label>    Include only issues with this label (repeatable)
      --issue-sort <sort>      created, updated, or comments, optionally :asc or :desc
      --verify-command <cmd>   Deterministic pre-commit gate (repeatable)
      --max-attempts <n>       Pipeline attempts (positive; default 3)
      --pipeline-timeout <t>  Pipeline timeout: e.g. 30s, 10m, or 2h
      --model <provider/model> OpenCode model selection
      --thinking <variant>     OpenCode model variant (for example low, medium, high)
      --grounding-thinking <variant> Readiness reasoning (default low)
      --implementation-thinking <variant> Implementation reasoning (default high)
      --implementation-attempts <n> Empty implementation retries (default 3)
      --implementation-fallback-model <provider/model>
                               Model used after the first empty implementation
      --complexity-thinking <variant> Complexity reasoning (default medium)
      --review-thinking <variant> Review reasoning (default high)
      --commit-thinking <variant> Commit-message reasoning (default low)
      --opencode-url <url>     OpenCode server URL (defaults to discovered background service)
      --opencode-token <token> OpenCode server token (defaults to service auth)
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
  OPENCODE_URL                 OpenCode server URL (used when --opencode-url is absent)
  OPENCODE_TOKEN               OpenCode server token (environment only)
`;

export type CommandRuntime = RalphieRuntime & {
    readonly dispose?: () => Promise<void>;
};

export type CommandFactories = {
    readonly makeCoordinator?: (
        options: ProgressCoordinatorOptions,
    ) => ProgressCoordinator;
    readonly makeOpenCode?: (
        config: OpenCodeProviderConfig,
        listener: AgentEventListener,
    ) => OpenCodeService;
    readonly makeRuntime?: (input: {
        readonly opencode: OpenCodeService;
        readonly progress: ProgressCoordinator["progress"];
    }) => CommandRuntime;
    readonly runWorkflow?: typeof workflow;
    readonly runMaintenance?: typeof maintainIssues;
    readonly runPipelinesGreen?: typeof getPipelinesGreen;
};

type CommandResumeState = RunState | MaintenanceRunState | PipelineRunState;

const isPipelineResumeState = (
    state: CommandResumeState | undefined,
): state is PipelineRunState =>
    state !== undefined &&
    "mode" in state &&
    state.mode === "get-pipelines-green";

const isMaintenanceResumeState = (
    state: CommandResumeState | undefined,
): state is MaintenanceRunState =>
    state !== undefined && "mode" in state && state.mode === "maintain-issues";

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
    makeOpenCode: factories.makeOpenCode ?? makeOpenCodeService,
    makeRuntime: factories.makeRuntime ?? makeLiveRuntime,
    runWorkflow: factories.runWorkflow ?? workflow,
    runMaintenance: factories.runMaintenance ?? maintainIssues,
    runPipelinesGreen: factories.runPipelinesGreen ?? getPipelinesGreen,
});

const loadResumeState = async (
    config: ResolvedRalphieConfig,
    explicitPolicy?: NeedsAttentionPolicy,
    explicitMaxDecompositionDepth?: number,
): Promise<RunState | undefined> => {
    if (config.resume === undefined) return undefined;

    const resumeState = await RunStateStoreLive.load(config.resume);
    if (
        explicitPolicy !== undefined &&
        explicitPolicy !== resumeState.onNeedsAttention
    ) {
        throw new RalphieError({
            message:
                `Cannot resume run ${resumeState.runId}: saved on-needs-attention policy is ` +
                `${resumeState.onNeedsAttention}, but requested policy is ${explicitPolicy}.`,
        });
    }
    if (
        explicitMaxDecompositionDepth !== undefined &&
        explicitMaxDecompositionDepth !==
            (resumeState.maxDecompositionDepth ??
                DEFAULT_MAX_DECOMPOSITION_DEPTH)
    ) {
        throw new RalphieError({
            message:
                `Cannot resume run ${resumeState.runId}: saved maximum decomposition depth is ` +
                `${resumeState.maxDecompositionDepth ?? DEFAULT_MAX_DECOMPOSITION_DEPTH}, but requested maximum is ${explicitMaxDecompositionDepth}.`,
        });
    }
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
): string | undefined =>
    config.mode === ExecutionMode.MaintainIssues && config.dryRun
        ? undefined
        : config.resume === undefined
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
        resize: (listener) => {
            process.stderr.on("resize", listener);
            return () => process.stderr.removeListener("resize", listener);
        },
        write: config.json ? output.stdout : output.stderr,
        colors: terminal.isInteractive && !terminal.isCI,
        runId,
        eventLogPath: eventLogPathFor(config, runId),
    });

const resumeStateForConfig = async (
    config: ResolvedRalphieConfig,
    explicitPolicy?: NeedsAttentionPolicy,
    explicitMaxDecompositionDepth?: number,
    explicitDuplicateAction?: DuplicateAction,
    explicitWorkspace?: string,
): Promise<CommandResumeState | undefined> => {
    if (config.mode === ExecutionMode.Issues) {
        return await loadResumeState(
            config,
            explicitPolicy,
            explicitMaxDecompositionDepth,
        );
    }
    if (
        config.mode !== ExecutionMode.MaintainIssues ||
        config.resume === undefined
    ) {
        if (
            config.mode !== ExecutionMode.GetPipelinesGreen ||
            config.resume === undefined
        ) {
            return undefined;
        }
        return await loadPipelineRunState(config.resume, {
            repository: config.repo,
            ...(config.branch === undefined ? {} : { branch: config.branch }),
            ...(explicitWorkspace === undefined
                ? {}
                : { workspace: config.workspace }),
        });
    }
    return await loadMaintenanceRunState(config.resume, {
        repository: config.repo,
        branch: config.branch,
        duplicateAction: explicitDuplicateAction,
        dryRun: config.dryRun,
    });
};

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
    maxDecompositionDepth:
        resumeState?.maxDecompositionDepth ?? config.maxDecompositionDepth,
    issueFilters: {
        labels: config.issueLabels,
        sort: config.issueSort,
        order: config.issueOrder,
    },
    model: config.model,
    modelVariant: config.thinking,
    agentStageVariants: {
        grounding: config.groundingThinking ?? "low",
        implementation: config.implementationThinking ?? "high",
        complexity: config.complexityThinking ?? "medium",
        review: config.reviewThinking ?? "high",
        commitMessage: config.commitThinking ?? "low",
    },
    verificationCommands: config.verificationCommands,
    implementationAttempts: config.implementationAttempts,
    implementationFallbackModel: config.implementationFallbackModel,
    agent: config.agent,
    workspace: config.workspace,
    cleanup: config.cleanEnd,
    startClean: config.cleanStart,
    signal: input.signal,
    runId,
    resumeState,
    resumePath: config.resume,
    dryRun: config.dryRun,
    onNeedsAttention: resumeState?.onNeedsAttention ?? config.onNeedsAttention,
    issueFailurePolicy: resumeState?.onIssueFailure ?? config.onIssueFailure,
    notificationsEnabled:
        resumeState?.notificationsEnabled ?? config.notificationsEnabled,
    needsAttentionLabel:
        resumeState?.needsAttentionLabel ?? config.needsAttentionLabel,
});

/** Execute one Ralphie command. */
const dispatchCommand = async (
    config:
        | IssueRalphieConfig
        | MaintainIssuesRalphieConfig
        | GetPipelinesGreenRalphieConfig,
    input: RunCommandInput,
    runId: string,
    resumeState: CommandResumeState | undefined,
    explicitDuplicateAction: DuplicateAction | undefined,
    runtime: CommandRuntime,
    factories: Required<CommandFactories>,
): Promise<void> => {
    if (config.mode === ExecutionMode.GetPipelinesGreen) {
        const pipelineResumeState = isPipelineResumeState(resumeState)
            ? resumeState
            : undefined;
        const pipelineOptions: GetPipelinesGreenOptions = {
            config,
            runId,
            signal: input.signal,
            ...(pipelineResumeState === undefined
                ? {}
                : { resumeState: pipelineResumeState }),
        };
        await factories.runPipelinesGreen(pipelineOptions, runtime);
        return;
    }
    if (config.mode === ExecutionMode.Issues) {
        const issueResumeState =
            resumeState === undefined || !("mode" in resumeState)
                ? resumeState
                : undefined;
        await factories.runWorkflow(
            workflowOptionsFor(config, input, runId, issueResumeState),
            runtime,
        );
        return;
    }
    await factories.runMaintenance(
        {
            config,
            runId,
            signal: input.signal,
            ...(explicitDuplicateAction === undefined
                ? {}
                : { explicitDuplicateAction }),
            ...(isMaintenanceResumeState(resumeState) ? { resumeState } : {}),
        } satisfies MaintainIssuesOptions,
        runtime,
    );
};

const commandErrorFor = (
    error: unknown,
    signal: AbortSignal,
): Error | undefined => {
    if (isNeedsAttentionStop(error)) {
        process.exitCode = signal.aborted
            ? RalphieExitCode.Cancelled
            : RalphieExitCode.NeedsAttention;
        return undefined;
    }
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
    const resumeState = await resumeStateForConfig(
        config,
        parsed.options.onNeedsAttention,
        parsed.options.maxDecompositionDepth,
        parsed.explicitDuplicateAction,
        parsed.options.workspace,
    );

    const terminal = input.terminal ?? terminalInfo();
    const runId = resumeState?.runId ?? crypto.randomUUID();
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
        );
        const opencode = factories.makeOpenCode(
            resolveOpenCodeConfig(config),
            coordinator.piListener,
        );
        runtime = factories.makeRuntime({
            opencode,
            progress: coordinator.progress,
        });
        await dispatchCommand(
            config,
            input,
            runId,
            resumeState,
            parsed.explicitDuplicateAction,
            runtime,
            factories,
        );
        process.exitCode = RalphieExitCode.Success;
    } catch (error) {
        const commandFailure = commandErrorFor(
            error,
            input.signal ?? new AbortController().signal,
        );
        if (commandFailure === undefined) return;
        commandError = commandFailure;
        throw commandFailure;
    } finally {
        await disposeCommandResources(runtime, coordinator, commandError);
    }
};

export default runCommand;