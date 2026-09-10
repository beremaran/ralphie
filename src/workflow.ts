import { join } from "node:path";

import { makeAgentSessionDiagnostics } from "./agent/task-session.ts";
import type { AgentModel, AgentSelection } from "./agent/model.ts";
import {
    GitHubNeedsAttentionNotificationRecoveryError,
    type NeedsAttentionNotificationInput,
} from "./github/needs-attention.ts";
import {
    isIssueEligible,
    type GitHubIssue,
    type IssueFilters,
} from "./github/issues.ts";
import { isDecomposedParent } from "./github/decomposition-markdown.ts";
import {
    IssueExecutionOutcomeKind,
    type IssueExecutionOutcome,
} from "./issues/execution.ts";
import { NeedsAttentionReason } from "./issues/decisions.ts";
import {
    createIssueQueue,
    IssueQueueState,
    toQueuedIssues,
} from "./issues/queue.ts";
import type { PiAgentRuntime } from "./pi/runtime.ts";
import { validateModelVariants } from "./pi/variants.ts";
import {
    type ProgressReporterService,
    type ProgressStage,
    type ProgressUpdate,
} from "./progress/progress.ts";
import { reconcileRunState } from "./run/reconciliation.ts";
import {
    RUN_STATE_VERSION,
    type RunState,
    RunStateStatus,
} from "./run/state.ts";
import { RalphieError } from "./shared/error.ts";
import { resolveWorkspacePath } from "./workspace/workspace.ts";
import { DEFAULT_MAX_DECOMPOSITION_DEPTH } from "./options.ts";
import type { IssueWorkflowRuntime } from "./runtime.ts";

const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

/** Durable boundary reached after core needs-attention work was saved. */
export class NeedsAttentionNotificationRecoveryBoundaryError extends RalphieError {
    readonly issueNumber: number;

    constructor(input: {
        readonly issueNumber: number;
        readonly cause: unknown;
    }) {
        super({
            message: `Needs-attention notification recovery is required for issue #${input.issueNumber}.`,
            cause: input.cause,
        });
        this.name = "NeedsAttentionNotificationRecoveryBoundaryError";
        this.issueNumber = input.issueNumber;
    }
}

const unreachableOutcome = (outcome: never): never => {
    throw new RalphieError({
        message: `Unsupported issue execution outcome: ${String(outcome)}.`,
    });
};

const checkCancellation = (signal: AbortSignal | undefined): void => {
    try {
        signal?.throwIfAborted();
    } catch (cause) {
        throw new RalphieError({
            message: "Run cancelled before the next operation started.",
            cause,
        });
    }
};

const outcomeMessage = (
    issueNumber: number,
    outcome: IssueExecutionOutcome,
): string => {
    switch (outcome.kind) {
        case IssueExecutionOutcomeKind.Completed:
            return outcome.completion === "already-resolved"
                ? `Issue #${issueNumber} was already resolved.`
                : `Issue #${issueNumber} implemented and pushed.`;
        case IssueExecutionOutcomeKind.Decomposed:
            return `Issue #${issueNumber} decomposed into ${outcome.childIssueNumbers.length} child issues.`;
        case IssueExecutionOutcomeKind.NeedsAttention:
            return `Issue #${issueNumber} needs attention: ${outcome.summary}`;
        case IssueExecutionOutcomeKind.Escalated:
            return `Issue #${issueNumber} escalated: ${outcome.reason}`;
        case IssueExecutionOutcomeKind.Failed:
            return `Issue #${issueNumber} failed: ${outcome.message}`;
        case IssueExecutionOutcomeKind.Skipped:
            return `Issue #${issueNumber} skipped: ${outcome.reason}`;
    }
};

type RunStateOutcome = RunState["outcomes"][number]["outcome"];
type RunStateNeedsAttentionOutcome = Extract<
    RunStateOutcome,
    { readonly kind: IssueExecutionOutcomeKind.NeedsAttention }
>;

const copyNeedsAttentionOutcome = (
    outcome: NeedsAttentionOutcome,
): RunStateNeedsAttentionOutcome => {
    const details = {
        kind: outcome.kind,
        reason: outcome.reason,
        summary: outcome.summary,
        evidence: [...outcome.evidence],
        questions: [...outcome.questions],
        ...(outcome.route === undefined ? {} : { route: outcome.route }),
    };
    if (outcome.artifactPath !== undefined) {
        return { ...details, artifactPath: outcome.artifactPath };
    }
    if (outcome.diagnosticsPath !== undefined) {
        return { ...details, diagnosticsPath: outcome.diagnosticsPath };
    }
    if (outcome.route !== "needs-attention") {
        throw new RalphieError({
            message:
                "Needs-attention outcome is missing its persisted location.",
        });
    }
    return { ...details, route: outcome.route };
};

const copySkippedOutcome = (
    outcome: Extract<
        IssueExecutionOutcome,
        { readonly kind: IssueExecutionOutcomeKind.Skipped }
    >,
): RunStateOutcome => ({
    kind: outcome.kind,
    reason: outcome.reason,
    ...(outcome.route === undefined ? {} : { route: outcome.route }),
});

const copyOutcome = (outcome: IssueExecutionOutcome): RunStateOutcome => {
    switch (outcome.kind) {
        case IssueExecutionOutcomeKind.Completed:
            return outcome.completion === "already-resolved"
                ? {
                      kind: outcome.kind,
                      completion: outcome.completion,
                      resolutionSummary: outcome.resolutionSummary,
                      evidence: [...outcome.evidence],
                  }
                : {
                      kind: outcome.kind,
                      completion: outcome.completion,
                      commitSha: outcome.commitSha,
                      ...(outcome.reviewCount === undefined
                          ? {}
                          : { reviewCount: outcome.reviewCount }),
                  };
        case IssueExecutionOutcomeKind.Decomposed:
            return {
                kind: outcome.kind,
                childIssueNumbers: [...outcome.childIssueNumbers],
            };
        case IssueExecutionOutcomeKind.NeedsAttention:
            return copyNeedsAttentionOutcome(outcome);
        case IssueExecutionOutcomeKind.Escalated:
            return {
                kind: outcome.kind,
                diagnosticsPath: outcome.diagnosticsPath,
                reason: outcome.reason,
                ...(outcome.childIssueNumbers === undefined
                    ? {}
                    : { childIssueNumbers: [...outcome.childIssueNumbers] }),
            };
        case IssueExecutionOutcomeKind.Skipped:
            return copySkippedOutcome(outcome);
        case IssueExecutionOutcomeKind.Failed:
            return {
                kind: outcome.kind,
                message: outcome.message,
            };
    }
    return unreachableOutcome(outcome);
};

type NeedsAttentionOutcome = Extract<
    IssueExecutionOutcome,
    { readonly kind: IssueExecutionOutcomeKind.NeedsAttention }
> & {
    readonly route?: "needs-attention";
    readonly artifactPath?: string;
    readonly diagnosticsPath?: string;
};

const needsAttentionNotificationInput = (
    outcome: NeedsAttentionOutcome,
): NeedsAttentionNotificationInput => ({
    reason: outcome.reason,
    summary: outcome.summary,
    evidence: [...outcome.evidence],
    questions: [...outcome.questions],
});

const needsAttentionArtifactDetails = (
    outcome: NeedsAttentionOutcome,
): Readonly<Record<string, unknown>> =>
    outcome.artifactPath === undefined
        ? outcome.diagnosticsPath === undefined
            ? {}
            : { diagnosticsPath: outcome.diagnosticsPath }
        : { artifactPath: outcome.artifactPath };

const needsAttentionProgressMessage = (
    issueNumber: number,
    outcome: NeedsAttentionOutcome,
    dryRun: boolean,
): string =>
    dryRun
        ? `Dry run would route #${issueNumber} to needs-attention ` +
          `(${outcome.reason}): ${outcome.summary}`
        : `Issue #${issueNumber} needs attention ` +
          `(${outcome.reason}): ${outcome.summary}`;

const needsAttentionProgressDetails = (input: {
    readonly outcome: NeedsAttentionOutcome;
    readonly dryRun: boolean;
    readonly current: number;
    readonly budget?: number;
}): Readonly<Record<string, unknown>> => ({
    reason: input.outcome.reason,
    summary: input.outcome.summary,
    evidence: [...input.outcome.evidence],
    questions: [...input.outcome.questions],
    ...(input.outcome.route === undefined
        ? input.dryRun
            ? { route: "needs-attention" }
            : {}
        : { route: input.outcome.route }),
    ...needsAttentionArtifactDetails(input.outcome),
    dryRun: input.dryRun,
    queuePosition: input.current,
    budget: input.budget ?? "unlimited",
});

type ProgressContext = Omit<ProgressUpdate, "stage" | "status" | "message">;

const track = async <Result>(
    progress: ProgressReporterService,
    stage: ProgressStage,
    startedMessage: string,
    operation: () => Promise<Result>,
    succeededMessage: string | ((result: Result) => string),
    context: ProgressContext = {},
): Promise<Result> => {
    await progress.emit({
        ...context,
        stage,
        status: "started",
        message: startedMessage,
    });
    try {
        const result = await operation();
        await progress.emit({
            ...context,
            stage,
            status: "succeeded",
            message:
                typeof succeededMessage === "function"
                    ? succeededMessage(result)
                    : succeededMessage,
        });
        return result;
    } catch (error) {
        await progress.emit({
            ...context,
            stage,
            status: "failed",
            message: `${startedMessage.replace(/\.{3}$/, "")} failed: ${errorMessage(error)}`,
        });
        throw error;
    }
};

export type WorkflowSummary = {
    readonly runId: string;
    readonly outcomes: ReadonlyArray<{
        readonly issueNumber: number;
        readonly outcome: IssueExecutionOutcome;
    }>;
    readonly counts: Readonly<Record<IssueExecutionOutcomeKind, number>>;
};

const summarize = (
    runId: string,
    outcomes: WorkflowSummary["outcomes"],
): WorkflowSummary => {
    const counts = Object.fromEntries(
        Object.values(IssueExecutionOutcomeKind).map((kind) => [kind, 0]),
    ) as Record<IssueExecutionOutcomeKind, number>;
    for (const { outcome } of outcomes) counts[outcome.kind] += 1;
    return { runId, outcomes, counts };
};

const routeSummary = (
    outcomes: WorkflowSummary["outcomes"],
): ReadonlyArray<{ readonly issueNumber: number; readonly route: string }> =>
    outcomes.flatMap(({ issueNumber, outcome }) => {
        const route =
            outcome.kind === IssueExecutionOutcomeKind.NeedsAttention
                ? "needs-attention"
                : outcome.kind === IssueExecutionOutcomeKind.Skipped
                  ? outcome.route
                  : undefined;
        return route === undefined ? [] : [{ issueNumber, route }];
    });

type WorkflowCheckout = NonNullable<RunState["checkout"]>;
type WorkflowOutcomeEntry = WorkflowSummary["outcomes"][number];

type PersistWorkflowStateInput = {
    readonly stateStore: IssueWorkflowRuntime["runStateStore"];
    readonly statePath: string;
    readonly queue: ReturnType<typeof createIssueQueue>;
    readonly activeQueueIssues: ReadonlyMap<number, GitHubIssue>;
    readonly actualRunId: string;
    readonly repository: string;
    readonly branch: string;
    readonly dryRun: boolean;
    readonly notificationsEnabled: boolean;
    readonly needsAttentionLabel?: string;
    readonly pendingNotification?: RunState["pendingNotification"];
    readonly selection: AgentSelection;
    readonly issueLimit?: number;
    readonly maxDecompositionDepth: number;
    readonly outcomes: ReadonlyArray<WorkflowOutcomeEntry>;
    readonly checkout: WorkflowCheckout;
};

const persistWorkflowState = async (
    input: PersistWorkflowStateInput,
    status: RunStateStatus,
    currentIssue?: RunState["activeIssue"],
): Promise<void> => {
    const snapshot = input.queue.snapshot();
    const pending = snapshot.pending.map(({ issue }) => ({
        ...issue,
        labels: [...issue.labels],
        ...(issue.comments === undefined
            ? {}
            : {
                  comments: issue.comments.map((comment) => ({
                      ...comment,
                  })),
              }),
    }));
    for (const issue of input.activeQueueIssues.values()) {
        if (!pending.some(({ number }) => number === issue.number)) {
            pending.unshift({
                ...issue,
                labels: [...issue.labels],
                ...(issue.comments === undefined
                    ? {}
                    : {
                          comments: issue.comments.map((comment) => ({
                              ...comment,
                          })),
                      }),
            });
        }
    }
    const processedCount =
        input.activeQueueIssues.size > 0
            ? Math.max(
                  0,
                  snapshot.processedCount - input.activeQueueIssues.size,
              )
            : snapshot.processedCount;
    await input.stateStore.save(input.statePath, {
        version: RUN_STATE_VERSION,
        status,
        runId: input.actualRunId,
        repository: input.repository,
        branch: input.branch,
        maxDecompositionDepth: input.maxDecompositionDepth,
        dryRun: input.dryRun,
        notificationsEnabled: input.notificationsEnabled,
        ...(input.needsAttentionLabel === undefined
            ? {}
            : { needsAttentionLabel: input.needsAttentionLabel }),
        ...(input.pendingNotification === undefined
            ? {}
            : { pendingNotification: input.pendingNotification }),
        selection: input.selection,
        ...(input.issueLimit === undefined
            ? {}
            : { maxIssues: input.issueLimit }),
        queue: {
            pending,
            completedIssueNumbers: [...snapshot.completedIssueNumbers],
            processedCount,
        },
        outcomes: input.outcomes.map(({ issueNumber, outcome }) => ({
            issueNumber,
            outcome: copyOutcome(outcome),
        })),
        ...(currentIssue === undefined ? {} : { activeIssue: currentIssue }),
        checkout: input.checkout,
        updatedAt: new Date().toISOString(),
    });
};

type WorkflowIssueContext = {
    readonly issue: GitHubIssue;
    readonly current: number;
    readonly total: number;
    readonly issueBaseCheckout: WorkflowCheckout;
    readonly resumedClosureOutcome?: IssueExecutionOutcome;
};

/**
 * Dependency-blocked issues are never handed to the executor, so no agent
 * session can report them. Surface them explicitly as needs-attention
 * outcomes: evidence naming each open dependency instead of failing the run
 * with a bare "blocked by open dependencies" error. Blocked issues stay
 * pending in the persisted queue and become ready when their dependencies
 * complete.
 */
type DependencyBlockedHandlers = {
    readonly queue: ReturnType<typeof createIssueQueue>;
    readonly recordIssueOutcome: (
        issueNumber: number,
        outcome: IssueExecutionOutcome,
    ) => void;
    readonly emitNeedsAttentionEvent: (
        issueContext: Pick<WorkflowIssueContext, "issue" | "current" | "total">,
        outcome: NeedsAttentionOutcome,
    ) => Promise<void>;
    readonly persistState: (
        status: RunStateStatus,
        currentIssue?: RunState["activeIssue"],
    ) => Promise<void>;
    readonly queueTotalFor: (current: number) => number;
};

const emitDependencyBlockedIssue = async (
    handlers: Pick<
        DependencyBlockedHandlers,
        "recordIssueOutcome" | "emitNeedsAttentionEvent" | "persistState"
    > & {
        readonly issue: GitHubIssue;
        readonly openDependencies: ReadonlyArray<number>;
        readonly current: number;
        readonly total: number;
    },
): Promise<void> => {
    const {
        recordIssueOutcome,
        emitNeedsAttentionEvent,
        persistState,
        issue,
        openDependencies,
        current,
        total,
    } = handlers;
    const dependencyList = openDependencies
        .map((number) => `#${number}`)
        .join(", ");
    const outcome: NeedsAttentionOutcome = {
        kind: IssueExecutionOutcomeKind.NeedsAttention,
        reason: NeedsAttentionReason.ExternalDependency,
        summary: `Issue #${issue.number} cannot start: open ${openDependencies.length === 1 ? "dependency" : "dependencies"} ${dependencyList} must complete first.`,
        evidence: openDependencies.map(
            (dependency) =>
                `Dependency #${dependency} is open and was not completed in this run.`,
        ),
        questions: [
            `Complete ${dependencyList} before this issue can be queued, or confirm the dependencies should be treated as satisfied.`,
        ],
        route: "needs-attention",
    };
    recordIssueOutcome(issue.number, outcome);
    await emitNeedsAttentionEvent({ issue, current, total }, outcome);
    await persistState(RunStateStatus.Active, {
        issueNumber: issue.number,
        stage: "grounding",
    });
};

/**
 * Dependency-blocked issues are never handed to the executor, so no agent
 * session can report them. Surface them explicitly as needs-attention
 * outcomes with evidence naming each open dependency, instead of
 * failing the run with a bare "blocked by open dependencies" error. This
 * deterministic queue-order block never publishes a needs-attention
 * notification or label: an issue waiting on open queue items resolves by
 * queue completion, not by human attention, so the opt-in notifier is
 * reserved for agent-reported blockers. Blocked issues stay pending in the
 * persisted queue, and the fail-closed error is thrown only when the blocked
 * state is spurious (no pending entry has an unmet dependency).
 */
const handleDependencyBlockedQueue = async (
    handlers: DependencyBlockedHandlers,
): Promise<void> => {
    const { queue } = handlers;
    const { pending, completedIssueNumbers } = queue.snapshot();
    const completedSet = new Set(completedIssueNumbers);
    let recorded = 0;
    for (const { issue, dependsOn = [] } of pending) {
        const openDependencies = [
            ...new Set(
                dependsOn.filter((dependency) => !completedSet.has(dependency)),
            ),
        ];
        if (openDependencies.length === 0) continue;
        const current = queue.processedCount() + recorded;
        recorded += 1;
        await emitDependencyBlockedIssue({
            ...handlers,
            issue,
            openDependencies,
            current,
            total: handlers.queueTotalFor(current),
        });
    }
    if (recorded === 0) {
        throw new RalphieError({
            message: `${queue.pendingCount()} pending issues are blocked by open dependencies.`,
        });
    }
};

type RepositoryCheckout = {
    readonly repository: string;
    readonly repositoryPath: string;
    readonly branch: string;
};

/**
 * When a run stopped after a completed issue's commit was pushed but before
 * the issue was closed, resume must finish the closure instead of rerunning
 * implementation.
 */
const resumedClosureOutcomeFor = (
    resumeState: RunState | undefined,
    issueNumber: number,
    outcomes: ReadonlyArray<WorkflowOutcomeEntry>,
): IssueExecutionOutcome | undefined => {
    if (
        resumeState?.activeIssue?.issueNumber !== issueNumber ||
        resumeState.activeIssue.stage !== "issue-closure"
    ) {
        return undefined;
    }
    return outcomes.find(
        (entry) =>
            entry.issueNumber === issueNumber &&
            entry.outcome.kind === IssueExecutionOutcomeKind.Completed,
    )?.outcome;
};

export type WorkflowOptions = {
    readonly repo: string;
    readonly branch?: string;
    readonly maxIssues?: number;
    readonly maxDecompositionDepth?: number;
    readonly issueFilters: IssueFilters;
    readonly agent: string;
    readonly model?: AgentModel;
    readonly modelVariant?: string;
    readonly verificationCommands?: ReadonlyArray<string>;
    readonly implementationAttempts?: number;
    readonly implementationFallbackModel?: AgentModel;
    readonly workspace: string;
    readonly cleanup: boolean;
    readonly startClean: boolean;
    readonly signal?: AbortSignal;
    readonly runId?: string;
    readonly resumeState?: RunState;
    readonly resumePath?: string;
    /** Publish needs-attention outcomes through the runtime notifier. */
    readonly notificationsEnabled?: boolean;
    /** Optional additive label applied with a needs-attention notification. */
    readonly needsAttentionLabel?: string;
    readonly dryRun?: boolean;
};

type WorkflowConfiguration = {
    readonly repo: string;
    readonly requestedBranch?: string;
    readonly maxIssues?: number;
    readonly maxDecompositionDepth: number;
    readonly issueFilters: IssueFilters;
    readonly agent: string;
    readonly model?: AgentModel;
    readonly modelVariant?: string;
    readonly verificationCommands: ReadonlyArray<string>;
    readonly implementationAttempts?: number;
    readonly implementationFallbackModel?: AgentModel;
    readonly workspace: string;
    readonly cleanup: boolean;
    readonly startClean: boolean;
    readonly signal?: AbortSignal;
    readonly runId: string;
    readonly resumeState?: RunState;
    readonly resumePath?: string;
    readonly notificationsEnabled: boolean;
    readonly needsAttentionLabel?: string;
    readonly dryRun: boolean;
    readonly actualRunId: string;
    readonly effectiveDryRun: boolean;
    readonly statePath: string;
};

type WorkflowLifecycle = {
    activeIssue?: RunState["activeIssue"];
    readonly activeQueueIssues: Map<number, GitHubIssue>;
    persistCancellationState?: () => Promise<void>;
    restoreCancellationCheckout?: () => Promise<void>;
};

const makeWorkflowConfiguration = (
    options: WorkflowOptions,
): WorkflowConfiguration => {
    const {
        repo,
        branch: requestedBranch,
        maxIssues,
        maxDecompositionDepth = DEFAULT_MAX_DECOMPOSITION_DEPTH,
        issueFilters,
        agent,
        model,
        modelVariant,
        verificationCommands = [],
        implementationAttempts,
        implementationFallbackModel,
        workspace,
        cleanup,
        startClean,
        signal,
        runId = crypto.randomUUID(),
        resumeState,
        resumePath,
        notificationsEnabled = false,
        needsAttentionLabel,
        dryRun = false,
    } = options;
    const actualRunId = resumeState?.runId ?? runId;
    const effectiveNotificationsEnabled =
        resumeState?.notificationsEnabled ?? notificationsEnabled;
    const effectiveNeedsAttentionLabel =
        resumeState?.needsAttentionLabel ?? needsAttentionLabel;
    const effectiveDryRun = resumeState?.dryRun ?? dryRun;
    const statePath =
        resumePath ??
        join(
            resolveWorkspacePath(workspace),
            ".ralphie",
            "runs",
            actualRunId,
            "state.json",
        );
    return {
        repo,
        requestedBranch,
        maxIssues,
        maxDecompositionDepth:
            resumeState?.maxDecompositionDepth ?? maxDecompositionDepth,
        issueFilters,
        agent,
        model,
        modelVariant,
        verificationCommands,
        implementationAttempts,
        implementationFallbackModel,
        workspace,
        cleanup,
        startClean,
        signal,
        runId,
        resumeState,
        resumePath,
        notificationsEnabled: effectiveNotificationsEnabled,
        ...(effectiveNeedsAttentionLabel === undefined
            ? {}
            : { needsAttentionLabel: effectiveNeedsAttentionLabel }),
        dryRun,
        actualRunId,
        effectiveDryRun,
        statePath,
    };
};

const summaryMessage = (
    prefix: string,
    counts: Readonly<Record<IssueExecutionOutcomeKind, number>>,
): string =>
    `${prefix}: ${counts.completed} completed, ` +
    `${counts.decomposed} decomposed, ` +
    `${counts.escalated} escalated, ` +
    `${counts[IssueExecutionOutcomeKind.NeedsAttention]} needs-attention, ` +
    `${counts.skipped} skipped, ${counts.failed} failed.`;

const emitRunStarted = async (
    progress: ProgressReporterService,
    config: WorkflowConfiguration,
): Promise<void> => {
    await progress.emit({
        stage: "run",
        status: "info",
        message: `Ralphie started for ${config.repo} on ${config.requestedBranch ?? "default branch"}.`,
        details: {
            repository: config.repo,
            ...(config.requestedBranch === undefined
                ? {}
                : { branch: config.requestedBranch }),
            workspace: config.workspace,
            model: config.model
                ? `${config.model.providerID}/${config.model.modelID}`
                : "pi default",
            variant: config.modelVariant ?? "pi default",
            agent: config.agent,
            issueLimit:
                config.resumeState?.maxIssues ??
                config.maxIssues ??
                "unlimited",
            budget:
                config.resumeState?.maxIssues ??
                config.maxIssues ??
                "unlimited",
            maxDecompositionDepth: config.maxDecompositionDepth,
            runId: config.actualRunId,
            dryRun: config.effectiveDryRun,
            notificationsEnabled: config.notificationsEnabled,
            ...(config.needsAttentionLabel === undefined
                ? {}
                : { needsAttentionLabel: config.needsAttentionLabel }),
            ...(config.resumeState === undefined
                ? {}
                : { resumed: true, statePath: config.statePath }),
        },
    });
};

const emitRunSucceeded = async (
    progress: ProgressReporterService,
    config: WorkflowConfiguration,
    summary: WorkflowSummary,
): Promise<void> => {
    await progress.emit({
        stage: "run",
        status: "succeeded",
        message: summaryMessage("Run completed", summary.counts),
        details: {
            runId: summary.runId,
            counts: summary.counts,
            routes: routeSummary(summary.outcomes),
            statePath: config.statePath,
            budget:
                config.resumeState?.maxIssues ??
                config.maxIssues ??
                "unlimited",
        },
    });
};

const cancellationError = async (
    error: unknown,
    config: WorkflowConfiguration,
    lifecycle: WorkflowLifecycle,
): Promise<unknown> => {
    if (!config.signal?.aborted) return error;
    let restoreError: unknown;
    if (
        lifecycle.activeIssue !== undefined &&
        lifecycle.restoreCancellationCheckout !== undefined
    ) {
        try {
            await lifecycle.restoreCancellationCheckout();
        } catch (failure) {
            restoreError = failure;
        }
    }
    if (lifecycle.persistCancellationState !== undefined) {
        await lifecycle.persistCancellationState();
    }
    return new RalphieError({
        message:
            restoreError === undefined
                ? "Run cancelled; active checkout was preserved and resumable state was saved."
                : "Run cancelled; resumable state was saved but active checkout restoration failed.",
        cause: restoreError ?? error,
    });
};

const emitRunFailed = async (
    progress: ProgressReporterService,
    config: WorkflowConfiguration,
    error: unknown,
): Promise<void> => {
    await progress.emit({
        stage: "run",
        status: "failed",
        message: `Run failed: ${errorMessage(error)}`,
        details: {
            runId: config.actualRunId,
            statePath: config.statePath,
        },
    });
};

const validateRuntimeModelVariants = (
    runtime: PiAgentRuntime,
    config: WorkflowConfiguration,
): void => {
    validateModelVariants({
        models: runtime.catalog,
        ...(runtime.defaultModel === undefined
            ? {}
            : { defaultModel: runtime.defaultModel }),
        ...(config.model === undefined ? {} : { primaryModel: config.model }),
        ...(config.implementationFallbackModel === undefined
            ? {}
            : { fallbackModel: config.implementationFallbackModel }),
        ...(config.modelVariant === undefined
            ? {}
            : { variant: config.modelVariant }),
    });
};

/** Run Ralphie using an explicit dependency object. */
export const workflow = async (
    options: WorkflowOptions,
    runtime: IssueWorkflowRuntime,
): Promise<WorkflowSummary> => {
    const config = makeWorkflowConfiguration(options);
    const {
        repo,
        requestedBranch,
        maxIssues,
        maxDecompositionDepth,
        issueFilters,
        agent,
        model,
        modelVariant,
        workspace,
        cleanup,
        startClean,
        signal,
        resumeState,
        notificationsEnabled,
        needsAttentionLabel,
        actualRunId,
        effectiveDryRun,
        statePath,
    } = config;
    const {
        progress,
        runStateStore: stateStore,
        workspace: workspaceService,
        githubClient,
        githubIssues,
        githubIssueMutations: issueMutations,
        githubNeedsAttentionNotification: needsAttentionNotification,
        gitRepository: repository,
        gitRepositoryInvariant: invariantService,
        gitIssueCheckpoint: checkpoints,
        parentCompletion,
        issueExecutor: normalIssueExecutor,
        dryRunIssueExecutor,
        agentRuntime,
    } = runtime;

    await emitRunStarted(progress, config);

    let activeIssue: RunState["activeIssue"] | undefined;
    let pendingNotification: RunState["pendingNotification"] =
        resumeState?.pendingNotification;
    const activeQueueIssues = new Map<number, GitHubIssue>();
    let persistCancellationState: (() => Promise<void>) | undefined;
    let restoreCancellationCheckout: (() => Promise<void>) | undefined;

    const run = async (): Promise<WorkflowSummary> => {
        checkCancellation(signal);
        let checkout: WorkflowCheckout;

        const prepareWorkspaceAndIssues = async () => {
            if (startClean) {
                await track(
                    progress,
                    "workspace-cleanup",
                    `Removing existing workspace ${workspace}...`,
                    () => workspaceService.remove(workspace),
                    `Existing workspace removed: ${workspace}.`,
                );
            }

            await track(
                progress,
                "workspace-preparation",
                `Preparing workspace ${workspace}...`,
                () => workspaceService.prepare(workspace),
                `Workspace ready: ${workspace}.`,
            );

            const octokit = await track(
                progress,
                "github-authentication",
                "Checking GitHub authentication...",
                () => githubClient.initialize(),
                "GitHub authentication verified and Octokit initialized.",
            );
            checkCancellation(signal);

            await track(
                progress,
                "git-verification",
                "Checking Git installation...",
                () => repository.verifyInstalled(),
                "Git installation verified.",
            );
            checkCancellation(signal);

            const prepared = await track(
                progress,
                "repository-preparation",
                `Preparing ${repo} on ${requestedBranch ?? "main/master"}...`,
                () =>
                    repository.prepare(
                        repo,
                        requestedBranch,
                        workspace,
                        undefined,
                        signal,
                    ),
                (result) => `Repository ready: ${result.path}.`,
                {
                    details: {
                        repository: repo,
                        ...(requestedBranch === undefined
                            ? {}
                            : { branch: requestedBranch }),
                        workspace,
                    },
                },
            );
            checkCancellation(signal);

            const discoveredIssues = await track(
                progress,
                "issue-discovery",
                "Fetching matching open issues...",
                () => githubIssues.listOpen(octokit, repo, issueFilters),
                (result) =>
                    result.length === 0
                        ? "No open issues match the current filters."
                        : `Found ${result.length} matching open issues.`,
                { details: { filters: issueFilters } },
            );
            checkCancellation(signal);

            return {
                octokit,
                prepared,
                branch: prepared.branch,
                discoveredIssues,
            };
        };

        const verifyResumeState = (
            branch: string,
            checkout: WorkflowCheckout,
            discoveredIssues: ReadonlyArray<GitHubIssue>,
        ): void => {
            if (resumeState === undefined) return;
            const reconciliation = reconcileRunState(resumeState, {
                repository: repo,
                branch,
                git: checkout,
                github: {
                    openIssueNumbers: discoveredIssues.map(
                        ({ number }) => number,
                    ),
                },
            });
            if (!reconciliation.compatible) {
                throw new RalphieError({
                    message: `Cannot resume run ${resumeState.runId}: ${reconciliation.reasons.join("; ")}.`,
                });
            }
        };

        const makeQueue = (initialIssues: ReadonlyArray<GitHubIssue>) =>
            createIssueQueue(
                toQueuedIssues(initialIssues),
                resumeState?.maxIssues ?? maxIssues,
                resumeState === undefined
                    ? undefined
                    : {
                          completedIssueNumbers:
                              resumeState.queue.completedIssueNumbers,
                          processedCount: resumeState.queue.processedCount,
                      },
            );

        const refreshedResumeIssues = (
            discoveredIssues: ReadonlyArray<GitHubIssue>,
        ): ReadonlyArray<GitHubIssue> => {
            if (resumeState === undefined) return discoveredIssues;
            const liveIssues = new Map(
                discoveredIssues.map((issue) => [issue.number, issue]),
            );
            return resumeState.queue.pending.map(
                (savedIssue) => liveIssues.get(savedIssue.number) ?? savedIssue,
            );
        };

        const prepareRunState = async (input: {
            readonly prepared: Awaited<ReturnType<typeof repository.prepare>>;
            readonly branch: string;
            readonly discoveredIssues: ReadonlyArray<GitHubIssue>;
        }) => {
            const { prepared, branch, discoveredIssues } = input;
            const repositoryCheckouts: ReadonlyArray<RepositoryCheckout> = [
                {
                    repository: repo,
                    repositoryPath: prepared.path,
                    branch: prepared.branch,
                },
            ];
            const captureCheckout = () =>
                invariantService.capture(prepared.path, signal);
            checkout = await captureCheckout();
            verifyResumeState(branch, checkout, discoveredIssues);
            const initialIssues = refreshedResumeIssues(discoveredIssues);
            const queue = makeQueue(initialIssues);
            return { repositoryCheckouts, captureCheckout, queue };
        };

        const prepareWorkflow = async () => {
            const preparedInput = await prepareWorkspaceAndIssues();
            const { repositoryCheckouts, captureCheckout, queue } =
                await prepareRunState(preparedInput);
            const { octokit, prepared, branch } = preparedInput;
            const outcomes: Array<WorkflowOutcomeEntry> = [
                ...(resumeState?.outcomes ?? []),
            ];
            const selection: AgentSelection = {
                agent,
                model,
                variant: modelVariant,
            };

            const persistState = (
                status: RunStateStatus,
                currentIssue?: RunState["activeIssue"],
            ): Promise<void> =>
                persistWorkflowState(
                    {
                        stateStore,
                        statePath,
                        queue,
                        activeQueueIssues,
                        actualRunId,
                        repository: repo,
                        branch,
                        dryRun: effectiveDryRun,
                        notificationsEnabled,
                        needsAttentionLabel,
                        pendingNotification,
                        selection,
                        issueLimit: resumeState?.maxIssues ?? maxIssues,
                        maxDecompositionDepth,
                        outcomes,
                        checkout,
                    },
                    status,
                    currentIssue,
                );

            persistCancellationState = () =>
                persistState(RunStateStatus.Active, activeIssue);
            await persistState(RunStateStatus.Active);
            const issueExecutor = effectiveDryRun
                ? dryRunIssueExecutor
                : normalIssueExecutor;
            const diagnostics = makeAgentSessionDiagnostics();
            return {
                octokit,
                prepared,
                branch,
                repositoryCheckouts,
                captureCheckout,
                queue,
                outcomes,
                selection,
                persistState,
                issueExecutor,
                diagnostics,
                discoveredIssues: preparedInput.discoveredIssues,
            };
        };

        const {
            octokit,
            prepared,
            branch,
            repositoryCheckouts,
            captureCheckout,
            queue,
            outcomes,
            selection,
            persistState,
            issueExecutor,
            diagnostics,
            discoveredIssues,
        } = await prepareWorkflow();

        const restoreIssueCheckout =
            (issueBaseCheckout: WorkflowCheckout): (() => Promise<void>) =>
            async () => {
                await Promise.all(
                    repositoryCheckouts.map((issueRepository) =>
                        checkpoints.restore(issueRepository.repositoryPath, {
                            branch: issueBaseCheckout.branch,
                            sha: issueBaseCheckout.head,
                        }),
                    ),
                );
            };

        /**
         * Complete any decomposed tracking parent whose sub-issues are all
         * closed. Runs against issues the run already discovered or
         * refreshed, so a parent whose final child closed in a previous run
         * is completed on the next run without extra discovery reads.
         */
        const reconcileDiscoveredParents = async (
            issues: ReadonlyArray<GitHubIssue>,
        ): Promise<void> => {
            if (effectiveDryRun) return;
            for (const parent of issues.filter(isDecomposedParent)) {
                await track(
                    progress,
                    "issue-closure",
                    `Checking whether parent issue #${parent.number} is complete...`,
                    () =>
                        parentCompletion.reconcileParent(
                            octokit,
                            repo,
                            parent.number,
                        ),
                    (completed) =>
                        completed
                            ? `Parent issue #${parent.number} completed; every sub-issue is closed.`
                            : `Parent issue #${parent.number} stays open; some sub-issues are not closed yet.`,
                    {
                        issue: {
                            number: parent.number,
                            title: parent.title,
                        },
                    },
                );
            }
        };

        /** Reconcile the tracking parent of a just-completed child issue. */
        const reconcileParentOfCompletedChild = async (
            issueContext: WorkflowIssueContext,
        ): Promise<void> => {
            if (effectiveDryRun) return;
            await track(
                progress,
                "issue-closure",
                `Checking whether the parent of #${issueContext.issue.number} is complete...`,
                () =>
                    parentCompletion.reconcileAfterChildCompletion(
                        octokit,
                        repo,
                        issueContext.issue.number,
                        issueContext.issue.body,
                    ),
                (completed) =>
                    completed
                        ? `Parent of #${issueContext.issue.number} completed; every sub-issue is closed.`
                        : `Parent of #${issueContext.issue.number} remains open.`,
                {
                    issue: {
                        number: issueContext.issue.number,
                        title: issueContext.issue.title,
                    },
                },
            );
        };

        await reconcileDiscoveredParents(discoveredIssues);

        const captureNeedsAttentionCheckout = async (
            issueContext: WorkflowIssueContext,
        ): Promise<WorkflowCheckout> => {
            void issueContext;
            return await captureCheckout();
        };

        const queueTotalFor = (current: number): number =>
            resumeState?.maxIssues ??
            maxIssues ??
            current + queue.pendingCount();

        const prepareIssue = async (
            issue: GitHubIssue,
        ): Promise<WorkflowIssueContext> => {
            const current = queue.processedCount();
            const total = queueTotalFor(current);
            const resumedClosureOutcome = resumedClosureOutcomeFor(
                resumeState,
                issue.number,
                outcomes,
            );
            activeQueueIssues.set(issue.number, issue);
            activeIssue = {
                issueNumber: issue.number,
                stage:
                    resumedClosureOutcome === undefined
                        ? "grounding"
                        : "issue-closure",
            };
            const issueBaseCheckout = { ...checkout };
            restoreCancellationCheckout = effectiveDryRun
                ? undefined
                : restoreIssueCheckout(issueBaseCheckout);
            await persistState(RunStateStatus.Active, activeIssue);
            return {
                issue,
                current,
                total,
                issueBaseCheckout,
                ...(resumedClosureOutcome === undefined
                    ? {}
                    : { resumedClosureOutcome }),
            };
        };

        const executeIssue = async (
            issueContext: WorkflowIssueContext,
            server: PiAgentRuntime,
        ): Promise<IssueExecutionOutcome> => {
            if (issueContext.resumedClosureOutcome !== undefined) {
                return issueContext.resumedClosureOutcome;
            }
            return await track(
                progress,
                "issue-execution",
                `Executing #${issueContext.issue.number} ${issueContext.issue.title}...`,
                () =>
                    issueExecutor.execute({
                        issue: issueContext.issue,
                        repository: repo,
                        repositoryPath: prepared.path,
                        targetBranch: branch,
                        workspace,
                        runId: actualRunId,
                        octokit,
                        agent: server.client,
                        agentSelection: selection,
                        agentDiagnostics: diagnostics,
                        repositoryInvariant: invariantService,
                        verificationCommands: config.verificationCommands,
                        implementationAttempts: config.implementationAttempts,
                        implementationFallbackModel:
                            config.implementationFallbackModel,
                        signal,
                        maxDecompositionDepth,
                    }),
                (result) => outcomeMessage(issueContext.issue.number, result),
                {
                    issue: {
                        number: issueContext.issue.number,
                        title: issueContext.issue.title,
                    },
                    current: issueContext.current,
                    total: issueContext.total,
                },
            );
        };

        const closeCompletedIssue = async (
            issueContext: WorkflowIssueContext,
            outcome: Extract<
                IssueExecutionOutcome,
                { readonly kind: IssueExecutionOutcomeKind.Completed }
            >,
        ): Promise<void> => {
            if (effectiveDryRun) return;
            await track(
                progress,
                "issue-closure",
                `Closing issue #${issueContext.issue.number} as completed...`,
                () =>
                    issueMutations.close(
                        octokit,
                        repo,
                        issueContext.issue.number,
                        "completed",
                    ),
                `Issue #${issueContext.issue.number} closed as completed.`,
                {
                    issue: {
                        number: issueContext.issue.number,
                        title: issueContext.issue.title,
                    },
                    details: { completion: outcome.completion },
                },
            );
        };

        const completeIssue = async (
            issueContext: WorkflowIssueContext,
            outcome: IssueExecutionOutcome,
        ): Promise<void> => {
            if (outcome.kind !== IssueExecutionOutcomeKind.Completed) return;
            checkout = await captureCheckout();
            activeIssue = {
                issueNumber: issueContext.issue.number,
                stage: "issue-closure",
            };
            await persistState(RunStateStatus.Active, activeIssue);
            await closeCompletedIssue(issueContext, outcome);
            await reconcileParentOfCompletedChild(issueContext);
        };

        const completeQueueItem = (
            issueNumber: number,
            outcome: IssueExecutionOutcome,
        ): void => {
            if (
                outcome.kind === IssueExecutionOutcomeKind.Completed ||
                outcome.kind === IssueExecutionOutcomeKind.Decomposed ||
                outcome.kind === IssueExecutionOutcomeKind.Escalated
            ) {
                queue.complete(issueNumber);
            }
        };

        const emitNeedsAttentionEvent = async (
            issueContext: Pick<
                WorkflowIssueContext,
                "issue" | "current" | "total"
            >,
            outcome: NeedsAttentionOutcome,
        ): Promise<void> => {
            await progress.emit({
                issue: {
                    number: issueContext.issue.number,
                    title: issueContext.issue.title,
                },
                current: issueContext.current,
                total: issueContext.total,
                stage: "grounding",
                status: "needs-attention",
                message: needsAttentionProgressMessage(
                    issueContext.issue.number,
                    outcome,
                    effectiveDryRun,
                ),
                details: needsAttentionProgressDetails({
                    outcome,
                    dryRun: effectiveDryRun,
                    current: issueContext.current,
                    budget: resumeState?.maxIssues ?? maxIssues,
                }),
            });
        };

        const publishNeedsAttentionNotification = async (
            issueNumber: number,
            outcome: NeedsAttentionOutcome,
            labelName: string | undefined,
            force = false,
        ): Promise<void> => {
            if ((!notificationsEnabled && !force) || effectiveDryRun) return;
            if (needsAttentionNotification === undefined) {
                throw new NeedsAttentionNotificationRecoveryBoundaryError({
                    issueNumber,
                    cause: new RalphieError({
                        message:
                            "Needs-attention notifications are enabled, but no notification service is available.",
                    }),
                });
            }
            await track(
                progress,
                "notification-recovery",
                `Publishing needs-attention notification for issue #${issueNumber}...`,
                () =>
                    needsAttentionNotification.notify(
                        octokit,
                        repo,
                        issueNumber,
                        needsAttentionNotificationInput(outcome),
                        labelName,
                    ),
                (result) =>
                    `Needs-attention notification published for issue #${issueNumber} (${result.comment} comment, ${result.label} label).`,
                { issue: { number: issueNumber, title: "Needs attention" } },
            );
        };

        const savePendingNotification = async (
            issueNumber: number,
            outcome: NeedsAttentionOutcome,
        ): Promise<NonNullable<RunState["pendingNotification"]>> => {
            const intent: NonNullable<RunState["pendingNotification"]> = {
                issueNumber,
                outcome: copyNeedsAttentionOutcome(outcome),
                ...(needsAttentionLabel === undefined
                    ? {}
                    : { labelName: needsAttentionLabel }),
            };
            pendingNotification = intent;
            activeIssue = {
                issueNumber,
                stage: "notification-recovery",
            };
            // The outcome and its notification intent are durable before any
            // GitHub comment or label mutation is attempted.
            await persistState(RunStateStatus.Active, activeIssue);
            return intent;
        };

        const publishPendingNotification = async (
            issueNumber: number,
            intent: NonNullable<RunState["pendingNotification"]>,
        ): Promise<void> => {
            try {
                await publishNeedsAttentionNotification(
                    issueNumber,
                    intent.outcome as NeedsAttentionOutcome,
                    intent.labelName,
                    true,
                );
            } catch (cause) {
                if (
                    cause instanceof
                        NeedsAttentionNotificationRecoveryBoundaryError ||
                    cause instanceof
                        GitHubNeedsAttentionNotificationRecoveryError
                ) {
                    throw cause;
                }
                throw new NeedsAttentionNotificationRecoveryBoundaryError({
                    issueNumber,
                    cause,
                });
            }
            pendingNotification = undefined;
        };

        const handleFailedIssue = async (
            issueContext: WorkflowIssueContext,
        ): Promise<void> => {
            checkout = await captureCheckout();
            await persistState(RunStateStatus.Active, {
                issueNumber: issueContext.issue.number,
                stage: "issue-execution",
            });
            await restoreCancellationCheckout?.();
            activeQueueIssues.delete(issueContext.issue.number);
            activeIssue = undefined;
            restoreCancellationCheckout = undefined;
            checkout = await captureCheckout();
            await persistState(RunStateStatus.Active);
        };

        const handleNeedsAttentionIssue = async (
            issueContext: WorkflowIssueContext,
            outcome: Extract<
                IssueExecutionOutcome,
                { readonly kind: IssueExecutionOutcomeKind.NeedsAttention }
            >,
        ): Promise<void> => {
            checkout = await captureNeedsAttentionCheckout(issueContext);
            await emitNeedsAttentionEvent(issueContext, outcome);
            const notificationEnabled =
                notificationsEnabled && !effectiveDryRun;
            if (notificationEnabled) {
                const intent = await savePendingNotification(
                    issueContext.issue.number,
                    outcome,
                );
                await publishPendingNotification(
                    issueContext.issue.number,
                    intent,
                );
            }
            await persistState(RunStateStatus.Active, {
                issueNumber: issueContext.issue.number,
                stage: "grounding",
            });
        };

        const finishSuccessfulIssue = async (
            issueContext: WorkflowIssueContext,
        ): Promise<void> => {
            activeIssue = undefined;
            activeQueueIssues.delete(issueContext.issue.number);
            restoreCancellationCheckout = undefined;
            checkout = await captureCheckout();
            await persistState(RunStateStatus.Active);
        };

        const refreshAfterDecomposition = async (
            outcome: IssueExecutionOutcome,
        ): Promise<void> => {
            if (
                outcome.kind !== IssueExecutionOutcomeKind.Decomposed &&
                outcome.kind !== IssueExecutionOutcomeKind.Escalated
            ) {
                return;
            }
            const refreshed = await track(
                progress,
                "issue-discovery",
                "Refreshing issue list...",
                () => githubIssues.listOpen(octokit, repo, issueFilters),
                (result) => `Refreshed ${result.length} matching open issues.`,
            );
            const added = queue.refresh(toQueuedIssues(refreshed));
            await progress.emit({
                stage: "issue-queue",
                status: "info",
                message: `Issue queue refreshed; added ${added} new issues.`,
                details: { added, pending: queue.pendingCount() },
            });
            await reconcileDiscoveredParents(refreshed);
            await persistState(RunStateStatus.Active);
        };

        const recordIssueOutcome = (
            issueNumber: number,
            outcome: IssueExecutionOutcome,
        ): void => {
            const entry = { issueNumber, outcome };
            const existingIndex = outcomes.findIndex(
                (existing) => existing.issueNumber === issueNumber,
            );
            if (existingIndex === -1) {
                outcomes.push(entry);
                return;
            }
            outcomes.splice(existingIndex, 1, entry);
        };

        const finalizeIssue = async (
            issueContext: WorkflowIssueContext,
            outcome: IssueExecutionOutcome,
        ): Promise<void> => {
            if (issueContext.resumedClosureOutcome === undefined) {
                recordIssueOutcome(issueContext.issue.number, outcome);
            }
            if (outcome.kind === IssueExecutionOutcomeKind.Failed) {
                await handleFailedIssue(issueContext);
                return;
            }
            if (outcome.kind === IssueExecutionOutcomeKind.NeedsAttention) {
                await handleNeedsAttentionIssue(issueContext, outcome);
                await finishSuccessfulIssue(issueContext);
                return;
            }
            await completeIssue(issueContext, outcome);
            completeQueueItem(issueContext.issue.number, outcome);
            await finishSuccessfulIssue(issueContext);
            await refreshAfterDecomposition(outcome);
        };

        const throwPendingNotificationBoundary = (
            issueNumber: number,
            message: string,
        ): never => {
            throw new NeedsAttentionNotificationRecoveryBoundaryError({
                issueNumber,
                cause: new RalphieError({ message }),
            });
        };

        const selectPendingNotificationIssue = (
            pending: NonNullable<RunState["pendingNotification"]>,
        ): GitHubIssue => {
            const savedIssue = queue
                .snapshot()
                .pending.find(
                    ({ issue }) => issue.number === pending.issueNumber,
                )?.issue;
            if (savedIssue === undefined) {
                return throwPendingNotificationBoundary(
                    pending.issueNumber,
                    "The issue for the pending needs-attention notification is not in the saved queue.",
                );
            }
            const issue = queue.next();
            if (issue?.number !== pending.issueNumber) {
                return throwPendingNotificationBoundary(
                    pending.issueNumber,
                    "The pending needs-attention issue could not be selected without changing queue order.",
                );
            }
            return issue;
        };

        const recoverPendingNotification = async (): Promise<void> => {
            const pending = pendingNotification;
            if (pending === undefined) return;
            if (!notificationsEnabled) {
                return throwPendingNotificationBoundary(
                    pending.issueNumber,
                    "A pending needs-attention notification cannot be reconciled when notifications are disabled.",
                );
            }
            if (effectiveDryRun) {
                return throwPendingNotificationBoundary(
                    pending.issueNumber,
                    "A pending needs-attention notification cannot be reconciled during a dry run.",
                );
            }
            const issue = selectPendingNotificationIssue(pending);
            activeQueueIssues.set(issue.number, issue);
            activeIssue = {
                issueNumber: issue.number,
                stage: "notification-recovery",
            };
            await persistState(RunStateStatus.Active, activeIssue);
            await publishPendingNotification(issue.number, pending);
            activeQueueIssues.delete(issue.number);
            activeIssue = undefined;
            restoreCancellationCheckout = undefined;
            checkout = await captureCheckout();
            await persistState(RunStateStatus.Active);
        };

        const processNextIssue = async (
            server: PiAgentRuntime,
        ): Promise<boolean> => {
            checkCancellation(signal);
            const queuedIssue = queue.next();
            if (queuedIssue === undefined) return false;
            const issue = await githubIssues.refresh(
                octokit,
                repo,
                queuedIssue.number,
            );
            if (!isIssueEligible(issue, issueFilters)) {
                const reason =
                    issue.state !== "open"
                        ? "Live reconciliation found that the issue is no longer open."
                        : "Live reconciliation found that the issue no longer has every required label.";
                const outcome = {
                    kind: IssueExecutionOutcomeKind.Skipped,
                    reason,
                } as const;
                outcomes.push({ issueNumber: issue.number, outcome });
                queue.skip(issue.number);
                activeQueueIssues.delete(issue.number);
                activeIssue = undefined;
                restoreCancellationCheckout = undefined;
                await persistState(RunStateStatus.Active);
                return true;
            }
            activeQueueIssues.set(issue.number, issue);
            const issueContext = await prepareIssue(issue);
            const outcome = await executeIssue(issueContext, server);
            await finalizeIssue(issueContext, outcome);
            return true;
        };

        const processQueue = async (server: PiAgentRuntime): Promise<void> => {
            const worker = async (): Promise<void> => {
                while (queue.state() === IssueQueueState.Ready) {
                    if (!(await processNextIssue(server))) break;
                }
            };
            await worker();
        };

        await recoverPendingNotification();

        let server: PiAgentRuntime | undefined;
        try {
            const startedAgent = await track(
                progress,
                "agent-runtime",
                "Starting pi agent runtime...",
                async () => {
                    const started = await agentRuntime.start();
                    server = started;
                    validateRuntimeModelVariants(started, config);
                    return started;
                },
                "Pi agent runtime ready.",
            );
            await processQueue(startedAgent);
        } finally {
            await server?.close();
        }

        if (queue.state() === IssueQueueState.DependencyBlocked) {
            await handleDependencyBlockedQueue({
                queue,
                recordIssueOutcome,
                emitNeedsAttentionEvent,
                persistState,
                queueTotalFor,
            });
        }

        await persistState(RunStateStatus.Complete);
        activeIssue = undefined;
        activeQueueIssues.clear();
        restoreCancellationCheckout = undefined;
        const summary = summarize(actualRunId, outcomes);
        if (summary.counts.failed > 0) {
            throw new RalphieError({
                message: summaryMessage(
                    "Run drained with issue failures",
                    summary.counts,
                ),
            });
        }
        if (cleanup) {
            const startedMessage = `Removing workspace ${workspace}...`;
            await progress.emit({
                stage: "workspace-cleanup",
                status: "started",
                message: startedMessage,
            });
            try {
                await workspaceService.remove(workspace);
            } catch (error) {
                await progress.emit({
                    stage: "workspace-cleanup",
                    status: "failed",
                    message: `${startedMessage.replace(/\.{3}$/, "")} failed: ${errorMessage(error)}`,
                });
                throw error;
            }
            // The event log lives inside the workspace. Disable durable writes after
            // removal so cleanup-success and run-success events cannot recreate it.
            await progress.stopPersisting();
            await progress.emit({
                stage: "workspace-cleanup",
                status: "succeeded",
                message: `Workspace removed: ${workspace}.`,
            });
        }
        return summary;
    };

    try {
        const summary = await run();
        await emitRunSucceeded(progress, config, summary);
        return summary;
    } catch (error) {
        const finalError = await cancellationError(error, config, {
            activeIssue,
            activeQueueIssues,
            persistCancellationState,
            restoreCancellationCheckout,
        });
        if (
            !(
                finalError instanceof
                    NeedsAttentionNotificationRecoveryBoundaryError ||
                finalError instanceof
                    GitHubNeedsAttentionNotificationRecoveryError
            )
        ) {
            await emitRunFailed(progress, config, finalError);
        }
        throw finalError;
    }
};