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
    type IssueExecutionContext,
    IssueExecutionOutcomeKind,
    type IssueExecutionOutcome,
} from "./issues/execution.ts";
import { NeedsAttentionReason } from "./issues/decisions.ts";
import {
    IssueArtifactKind,
    type IssueArtifactStore,
    type PullRequestDeliveryStateArtifact,
} from "./issues/artifacts.ts";
import {
    createIssueQueue,
    IssueQueueState,
    toQueuedIssues,
} from "./issues/queue.ts";
import type { OpenCodeRuntime } from "./opencode/server.ts";
import { validateModelVariants } from "./opencode/variants.ts";
import type {
    GitHubPullRequest,
    PullRequestMergeProof,
    PullRequestSnapshot,
} from "./github/pull-requests.ts";
import type {
    PullRequestReviewCoordinatorResult,
    PullRequestReviewDeliveryEvent,
    PullRequestReviewLifecycleEvent,
} from "./issues/pull-request-review-coordinator.ts";
import type {
    PullRequestRevisionIntent,
    PullRequestReviewAttempt,
} from "./issues/pull-request-review.ts";
import type {
    PipelineObservationOutcome,
    PipelineObservationResult,
    PipelineObservationTransition,
    PipelineSnapshot,
} from "./github/pipeline-observation.ts";
import {
    type ProgressReporterService,
    type ProgressStage,
    type ProgressStatus,
    type ProgressUpdate,
} from "./progress/progress.ts";
import { reconcileRunState } from "./run/reconciliation.ts";
import {
    RUN_STATE_VERSION,
    type RunState,
    RunStateStatus,
    type PrClosureGateStatus,
} from "./run/state.ts";
import {
    isNeedsAttentionStop,
    NeedsAttentionStop,
} from "./process/exit-code.ts";
import { RalphieError } from "./shared/error.ts";
import { resolveWorkspacePath } from "./workspace/workspace.ts";
import {
    DEFAULT_NEEDS_ATTENTION_POLICY,
    DEFAULT_ISSUE_FAILURE_POLICY,
    DEFAULT_MAX_DECOMPOSITION_DEPTH,
    DEFAULT_WORKFLOW_MODE,
    NeedsAttentionPolicy,
    IssueFailurePolicy,
    WorkflowMode,
} from "./options.ts";
import type { RalphieRuntime } from "./runtime.ts";

const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

type PersistedPrGateSnapshot = NonNullable<RunState["prClosure"]>["snapshot"];

const preservedPrGateSnapshot = (
    previous: RunState["prClosure"],
    observedHeadSha: string,
    snapshot: PersistedPrGateSnapshot | undefined,
): PersistedPrGateSnapshot | undefined => {
    if (snapshot !== undefined) return snapshot;
    if (
        previous === undefined ||
        previous.observedHeadSha.toLowerCase() !== observedHeadSha.toLowerCase()
    ) {
        return undefined;
    }
    return previous.snapshot;
};

const optionalPrReviewField = <Key extends string, Value>(
    key: Key,
    value: Value | undefined,
): Partial<Record<Key, Value>> =>
    value === undefined ? {} : ({ [key]: value } as Record<Key, Value>);

type WorkflowPrClosure = NonNullable<RunState["prClosure"]>;
type WorkflowPrReview = NonNullable<WorkflowPrClosure["review"]>;
type ApprovedReviewEvidence = NonNullable<PullRequestMergeProof["review"]>;
type PostPrReviewFailureResult = Exclude<
    PullRequestReviewCoordinatorResult,
    Extract<PullRequestReviewCoordinatorResult, { status: "approved" }>
>;

const postPrReviewFailureDetailsFor = (
    result: PostPrReviewFailureResult,
    priorReview: WorkflowPrReview | undefined,
): {
    readonly status: WorkflowPrReview["status"];
    readonly stage: NonNullable<WorkflowPrReview["stage"]>;
    readonly revisionIntent?: PullRequestRevisionIntent;
} => {
    const status = (() => {
        switch (result.status) {
            case "pr-review-exhausted":
                return "pr-review-exhausted";
            case "needs-attention":
                return "needs-attention";
            case "head-moved":
                return "stale";
            case "delivery-recoverable":
                return "delivery-recoverable";
            case "review-failed":
            case "revision-failed":
                return "failed";
        }
    })() satisfies WorkflowPrReview["status"];
    const revisionIntent =
        result.status === "revision-failed" ||
        result.status === "delivery-recoverable"
            ? priorReview?.revisionIntent
            : undefined;
    const stage =
        result.status === "delivery-recoverable" || revisionIntent !== undefined
            ? "revision-delivery"
            : result.status === "needs-attention" && result.phase !== "review"
              ? "revision-fix"
              : "review";
    return {
        status,
        stage,
        ...optionalPrReviewField("revisionIntent", revisionIntent),
    };
};

/** Bounds and confirmation policy for the PR delivery check gate. */
const PR_GATE_OBSERVATION_OPTIONS = {
    registrationGraceMs: 30_000,
    deadlineMs: 30 * 60_000,
    initialBackoffMs: 5_000,
    maxBackoffMs: 60_000,
    backoffFactor: 2,
    rateLimitRetries: 3,
    maxRateLimitDelayMs: 30_000,
    stableTerminalConfirmations: 2,
} as const;

/** Durable boundary reached after core needs-attention work was saved. */
export class NeedsAttentionNotificationRecoveryBoundaryError extends RalphieError {
    override readonly _tag =
        "NeedsAttentionNotificationRecoveryBoundaryError" as const;
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

const issueFeatureBranch = (issueNumber: number): string =>
    `ralphie/issue-${issueNumber}`;

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
        ...(outcome.policy === undefined ? {} : { policy: outcome.policy }),
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
    readonly policy?: NeedsAttentionPolicy;
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
    readonly policy: NeedsAttentionPolicy;
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
    policy: input.policy,
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
    readonly stateStore: RalphieRuntime["runStateStore"];
    readonly statePath: string;
    readonly queue: ReturnType<typeof createIssueQueue>;
    readonly activeQueueIssues: ReadonlyMap<number, GitHubIssue>;
    readonly actualRunId: string;
    readonly repository: string;
    readonly branch: string;
    readonly workflowMode: WorkflowMode;
    readonly onNeedsAttention: NeedsAttentionPolicy;
    readonly issueFailurePolicy: IssueFailurePolicy;
    readonly dryRun: boolean;
    readonly notificationsEnabled: boolean;
    readonly needsAttentionLabel?: string;
    readonly pendingNotification?: RunState["pendingNotification"];
    readonly prClosure?: RunState["prClosure"];
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
        workflow: input.workflowMode,
        onNeedsAttention: input.onNeedsAttention,
        onIssueFailure: input.issueFailurePolicy,
        maxDecompositionDepth: input.maxDecompositionDepth,
        dryRun: input.dryRun,
        notificationsEnabled: input.notificationsEnabled,
        ...(input.needsAttentionLabel === undefined
            ? {}
            : { needsAttentionLabel: input.needsAttentionLabel }),
        ...(input.pendingNotification === undefined
            ? {}
            : { pendingNotification: input.pendingNotification }),
        ...(input.prClosure === undefined
            ? {}
            : { prClosure: input.prClosure }),
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
    readonly featureBranch: string;
    readonly issueBaseCheckout: WorkflowCheckout;
    readonly issueRepositories: ReadonlyArray<RepositoryCheckout>;
    readonly resumedClosureOutcome?: IssueExecutionOutcome;
};

/**
 * Dependency-blocked issues are never handed to the executor, so no agent
 * session can report them. Surface them explicitly as needs-attention
 * outcomes: evidence naming each open dependency, and the halt/continue
 * policy, instead of failing the run with a bare "blocked by open
 * dependencies" error. Blocked issues stay pending in the persisted queue
 * and become ready when their dependencies complete. Returns whether any
 * blocked issue was recorded.
 */
type DependencyBlockedHandlers = {
    readonly queue: ReturnType<typeof createIssueQueue>;
    readonly onNeedsAttention: NeedsAttentionPolicy;
    readonly recordIssueOutcome: (
        issueNumber: number,
        outcome: IssueExecutionOutcome,
    ) => void;
    readonly emitNeedsAttentionEvent: (
        issueContext: Pick<WorkflowIssueContext, "issue" | "current" | "total">,
        outcome: NeedsAttentionOutcome,
    ) => Promise<void>;
    readonly emitHandledNeedsAttention: (
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
        | "onNeedsAttention"
        | "recordIssueOutcome"
        | "emitNeedsAttentionEvent"
        | "emitHandledNeedsAttention"
        | "persistState"
    > & {
        readonly issue: GitHubIssue;
        readonly openDependencies: ReadonlyArray<number>;
        readonly current: number;
        readonly total: number;
    },
): Promise<void> => {
    const {
        onNeedsAttention,
        recordIssueOutcome,
        emitNeedsAttentionEvent,
        emitHandledNeedsAttention,
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
        policy: onNeedsAttention,
        route: "needs-attention",
    };
    recordIssueOutcome(issue.number, outcome);
    const issueContext = { issue, current, total };
    await emitNeedsAttentionEvent(issueContext, outcome);
    if (onNeedsAttention !== NeedsAttentionPolicy.Halt) return;
    await persistState(RunStateStatus.Active, {
        issueNumber: issue.number,
        stage: "grounding",
    });
    await emitHandledNeedsAttention(issueContext, outcome);
    throw new NeedsAttentionStop({
        issueNumber: issue.number,
        summary: outcome.summary,
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
 * persisted queue, the halt/continue policy still governs the run, and the
 * fail-closed error is thrown only when the blocked state is spurious (no
 * pending entry has an unmet dependency).
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
    readonly workflow?: WorkflowMode;
    readonly repo: string;
    readonly branch?: string;
    readonly maxIssues?: number;
    readonly maxDecompositionDepth?: number;
    readonly issueFilters: IssueFilters;
    readonly agent: string;
    readonly model?: AgentModel;
    readonly modelVariant?: string;
    readonly agentStageVariants?: IssueExecutionContext["agentStageVariants"];
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
    readonly issueFailurePolicy?: IssueFailurePolicy;
    readonly onNeedsAttention?: NeedsAttentionPolicy;
    /** Publish needs-attention outcomes through the runtime notifier. */
    readonly notificationsEnabled?: boolean;
    /** Optional additive label applied with a needs-attention notification. */
    readonly needsAttentionLabel?: string;
    readonly dryRun?: boolean;
};

type WorkflowConfiguration = {
    readonly requestedWorkflow: WorkflowMode;
    readonly repo: string;
    readonly requestedBranch?: string;
    readonly maxIssues?: number;
    readonly maxDecompositionDepth: number;
    readonly issueFilters: IssueFilters;
    readonly agent: string;
    readonly model?: AgentModel;
    readonly modelVariant?: string;
    readonly agentStageVariants?: IssueExecutionContext["agentStageVariants"];
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
    readonly issueFailurePolicy: IssueFailurePolicy;
    readonly onNeedsAttention: NeedsAttentionPolicy;
    readonly notificationsEnabled: boolean;
    readonly needsAttentionLabel?: string;
    readonly dryRun: boolean;
    readonly actualRunId: string;
    readonly effectiveDryRun: boolean;
    readonly workflowMode: WorkflowMode;
    readonly usesPullRequests: boolean;
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
        workflow: requestedWorkflow = DEFAULT_WORKFLOW_MODE,
        repo,
        branch: requestedBranch,
        maxIssues,
        maxDecompositionDepth = DEFAULT_MAX_DECOMPOSITION_DEPTH,
        issueFilters,
        agent,
        model,
        modelVariant,
        agentStageVariants,
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
        issueFailurePolicy = DEFAULT_ISSUE_FAILURE_POLICY,
        onNeedsAttention = DEFAULT_NEEDS_ATTENTION_POLICY,
        notificationsEnabled = false,
        needsAttentionLabel,
        dryRun = false,
    } = options;
    const actualRunId = resumeState?.runId ?? runId;
    const effectiveOnNeedsAttention =
        resumeState?.onNeedsAttention ?? onNeedsAttention;
    const effectiveNotificationsEnabled =
        resumeState?.notificationsEnabled ?? notificationsEnabled;
    const effectiveNeedsAttentionLabel =
        resumeState?.needsAttentionLabel ?? needsAttentionLabel;
    const effectiveDryRun = resumeState?.dryRun ?? dryRun;
    const workflowMode = resumeState?.workflow ?? requestedWorkflow;
    const usesPullRequests = workflowMode === WorkflowMode.Pr;
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
        requestedWorkflow,
        repo,
        requestedBranch,
        maxIssues,
        maxDecompositionDepth:
            resumeState?.maxDecompositionDepth ?? maxDecompositionDepth,
        issueFilters,
        agent,
        model,
        modelVariant,
        agentStageVariants,
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
        issueFailurePolicy,
        onNeedsAttention: effectiveOnNeedsAttention,
        notificationsEnabled: effectiveNotificationsEnabled,
        ...(effectiveNeedsAttentionLabel === undefined
            ? {}
            : { needsAttentionLabel: effectiveNeedsAttentionLabel }),
        dryRun,
        actualRunId,
        effectiveDryRun,
        workflowMode,
        usesPullRequests,
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
                : "OpenCode default",
            variant: config.modelVariant ?? "OpenCode default",
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
            workflow: config.workflowMode,
            notificationsEnabled: config.notificationsEnabled,
            ...(config.needsAttentionLabel === undefined
                ? {}
                : { needsAttentionLabel: config.needsAttentionLabel }),
            policy: config.onNeedsAttention,
            onNeedsAttention: config.onNeedsAttention,
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
            workflow: config.workflowMode,
            counts: summary.counts,
            routes: routeSummary(summary.outcomes),
            statePath: config.statePath,
            policy: config.onNeedsAttention,
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
            workflow: config.workflowMode,
            statePath: config.statePath,
        },
    });
};

const validateRuntimeModelVariants = async (
    server: OpenCodeRuntime,
    config: WorkflowConfiguration,
    directory: string,
): Promise<void> => {
    if (server.modelList === undefined) return;
    try {
        const [models, defaultModel] = await Promise.all([
            server.modelList({ directory }),
            server.modelDefault?.({ directory }),
        ]);
        validateModelVariants({
            models,
            defaultModel,
            primaryModel: config.model,
            fallbackModel: config.implementationFallbackModel,
            defaultVariant: config.modelVariant,
            stageVariants: config.agentStageVariants,
        });
    } catch (cause) {
        if (cause instanceof RalphieError) throw cause;
    }
};

/** Run Ralphie using an explicit dependency object. */
export const workflow = async (
    options: WorkflowOptions,
    runtime: RalphieRuntime,
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
        issueFailurePolicy,
        onNeedsAttention,
        notificationsEnabled,
        needsAttentionLabel,
        actualRunId,
        effectiveDryRun,
        workflowMode,
        usesPullRequests,
        statePath,
    } = config;
    const {
        progress,
        runStateStore: stateStore,
        workspace: workspaceService,
        githubClient,
        githubIssues,
        githubIssueMutations: issueMutations,
        githubPullRequests,
        githubNeedsAttentionNotification: needsAttentionNotification,
        gitRepository: repository,
        gitRepositoryInvariant: invariantService,
        gitIssueCheckpoint: checkpoints,
        gitIssueOperations: issueOperations,
        parentCompletion,
        issueArtifactStore: artifactStores,
        pullRequestReviewCoordinator,
        pipelineObservation,
        issueExecutor: normalIssueExecutor,
        dryRunIssueExecutor,
        opencode,
    } = runtime;

    await emitRunStarted(progress, config);

    let activeIssue: RunState["activeIssue"] | undefined;
    let pendingNotification: RunState["pendingNotification"] =
        resumeState?.pendingNotification;
    let prClosure: RunState["prClosure"] = resumeState?.prClosure;
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
                        workflowMode,
                        onNeedsAttention,
                        issueFailurePolicy,
                        dryRun: effectiveDryRun,
                        notificationsEnabled,
                        needsAttentionLabel,
                        pendingNotification,
                        prClosure,
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

        const prepareIssueBranch = async (
            issueRepositories: ReadonlyArray<RepositoryCheckout>,
            featureBranch: string,
            issueBaseCheckout: WorkflowCheckout,
            resumedClosureOutcome: IssueExecutionOutcome | undefined,
        ): Promise<void> => {
            if (
                !usesPullRequests ||
                effectiveDryRun ||
                (resumedClosureOutcome?.kind ===
                    IssueExecutionOutcomeKind.Completed &&
                    resumedClosureOutcome.completion === "already-resolved")
            ) {
                return;
            }
            await Promise.all(
                issueRepositories.map((issueRepository) =>
                    issueOperations.createOrCheckoutFeatureBranch(
                        issueRepository.repositoryPath,
                        featureBranch,
                        issueRepository.branch,
                        issueBaseCheckout.head,
                    ),
                ),
            );
        };

        const deliverIssueBranch = async (
            issueContext: WorkflowIssueContext,
            outcome: IssueExecutionOutcome,
        ): Promise<void> => {
            if (
                !usesPullRequests ||
                effectiveDryRun ||
                issueContext.resumedClosureOutcome !== undefined ||
                outcome.kind !== IssueExecutionOutcomeKind.Completed ||
                outcome.completion !== "pushed-commit"
            ) {
                return;
            }
            await Promise.all(
                issueContext.issueRepositories.map((issueRepository) =>
                    issueOperations.push(
                        issueRepository.repositoryPath,
                        issueContext.featureBranch,
                        outcome.commitSha,
                    ),
                ),
            );
        };

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
            if (
                usesPullRequests &&
                !effectiveDryRun &&
                issueContext.resumedClosureOutcome === undefined
            ) {
                await Promise.all(
                    issueContext.issueRepositories.map((issueRepository) =>
                        issueOperations.restoreBaseCheckout(
                            issueRepository.repositoryPath,
                            issueRepository.branch,
                        ),
                    ),
                );
            }
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
            const featureBranch = issueFeatureBranch(issue.number);
            const issueRepositories = repositoryCheckouts;
            await prepareIssueBranch(
                issueRepositories,
                featureBranch,
                issueBaseCheckout,
                resumedClosureOutcome,
            );
            restoreCancellationCheckout = effectiveDryRun
                ? undefined
                : restoreIssueCheckout(issueBaseCheckout);
            await persistState(RunStateStatus.Active, activeIssue);
            return {
                issue,
                current,
                total,
                featureBranch,
                issueBaseCheckout,
                issueRepositories,
                resumedClosureOutcome,
            };
        };

        const executeIssue = async (
            issueContext: WorkflowIssueContext,
            server: OpenCodeRuntime,
        ): Promise<IssueExecutionOutcome> => {
            if (issueContext.resumedClosureOutcome !== undefined) {
                return issueContext.resumedClosureOutcome;
            }
            const repositoryPath =
                issueContext.issueRepositories.find(
                    ({ repository }) =>
                        repository.toLowerCase() === repo.toLowerCase(),
                )?.repositoryPath ?? prepared.path;
            return await track(
                progress,
                "issue-execution",
                `Executing #${issueContext.issue.number} ${issueContext.issue.title}...`,
                () =>
                    issueExecutor.execute({
                        issue: issueContext.issue,
                        repository: repo,
                        repositoryPath,
                        targetBranch:
                            usesPullRequests && !effectiveDryRun
                                ? issueContext.featureBranch
                                : branch,
                        allowMissingRemoteBranch:
                            usesPullRequests && !effectiveDryRun,
                        workspace,
                        runId: actualRunId,
                        octokit,
                        agent: server.client,
                        agentSelection: selection,
                        agentStageVariants: config.agentStageVariants,
                        agentDiagnostics: diagnostics,
                        repositoryInvariant: invariantService,
                        verificationCommands: config.verificationCommands,
                        implementationAttempts: config.implementationAttempts,
                        implementationFallbackModel:
                            config.implementationFallbackModel,
                        signal,
                        needsAttentionPolicy: onNeedsAttention,
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

        const sameSha = (left: string, right: string): boolean =>
            left.toLowerCase() === right.toLowerCase();

        const nowIso = (): string => new Date().toISOString();

        const prGateIssue = (
            issueContext: WorkflowIssueContext,
        ): ProgressUpdate["issue"] => ({
            number: issueContext.issue.number,
            title: issueContext.issue.title,
        });

        /** Emit a typed `pr-gate` progress event for the active PR gate. */
        const emitPrGate = async (
            issueContext: WorkflowIssueContext,
            status: ProgressStatus,
            message: string,
            details?: Readonly<Record<string, unknown>>,
        ): Promise<void> => {
            await progress.emit({
                stage: "pr-gate",
                status,
                message,
                issue: prGateIssue(issueContext),
                current: issueContext.current,
                total: issueContext.total,
                ...(details === undefined ? {} : { details }),
            });
        };

        /** Render a normalized item key as a human-readable provider/name. */
        const itemLabel = (key: string): string => {
            const [source, provider, name] = key.split("\u0000");
            return source === undefined ||
                provider === undefined ||
                name === undefined
                ? key
                : `${provider}/${name}`;
        };

        const itemLabels = (keys: ReadonlyArray<string>): string =>
            keys.map(itemLabel).join(", ");

        /** Poll progress is emitted only for meaningful state transitions. */
        const transitionMessage = (
            pullRequestNumber: number,
            headSha: string,
            transition: PipelineObservationTransition,
        ): string => {
            const prefix = `PR #${pullRequestNumber} head ${headSha}`;
            switch (transition.kind) {
                case "registration":
                    return `${prefix}: no checks visible; waiting for registration.`;
                case "registered":
                    return `${prefix}: ${transition.itemCount} check${transition.itemCount === 1 ? "" : "s"} registered.`;
                case "checked-in":
                    return `${prefix}: new checks registered: ${itemLabels(transition.items)}.`;
                case "disappeared":
                    return `${prefix}: checks disappeared: ${itemLabels(transition.items)}.`;
                case "status-changed":
                    return `${prefix}: ${itemLabel(transition.item)} changed ${transition.from} -> ${transition.to}.`;
            }
        };

        /** Compact human summary of a normalized check snapshot. */
        const checkSummaryFor = (
            snapshot: PipelineSnapshot | undefined,
        ): string => {
            if (snapshot === undefined) return "no snapshot";
            if (snapshot.state === "empty")
                return `${snapshot.reason} (no checks)`;
            const counts = new Map<string, number>();
            for (const item of snapshot.items)
                counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
            const statuses = [...counts.entries()]
                .map(([status, count]) =>
                    count === 1 ? status : `${status} x${count}`,
                )
                .join(", ");
            return `${snapshot.reason} (${statuses})`;
        };

        /** Terminal gate message with PR number, exact SHA, and reason. */
        const observationTerminalMessage = (
            pullRequest: GitHubPullRequest,
            outcome: PipelineObservationOutcome,
        ): string => {
            const head = pullRequest.headSha;
            switch (outcome.kind) {
                case "green":
                    return `Checks passed for PR #${pullRequest.number} head ${head} in ${outcome.elapsedMs}ms (${outcome.polls} polls): ${checkSummaryFor(outcome.snapshot)}.`;
                case "failed":
                    if (outcome.reason === "failing")
                        return `Checks are failing for PR #${pullRequest.number} head ${head}: ${checkSummaryFor(outcome.snapshot)}.`;
                    if (outcome.reason === "cancelled")
                        return `Checks were cancelled for PR #${pullRequest.number} head ${head}: ${checkSummaryFor(outcome.snapshot)}.`;
                    return `Check observation failed for PR #${pullRequest.number} head ${head}: ${outcome.message ?? "no message"}.`;
                case "no-pipelines-discovered":
                    return `No pipelines registered for PR #${pullRequest.number} head ${head} within ${outcome.elapsedMs}ms.`;
                case "timeout":
                    return `Check observation timed out for PR #${pullRequest.number} head ${head} after ${outcome.elapsedMs}ms (${outcome.polls} polls).`;
                case "aborted":
                    return `Check observation cancelled for PR #${pullRequest.number} head ${head}.`;
                case "stale":
                    return `Branch head invalidated while observing PR #${pullRequest.number} head ${outcome.observedSha}: ${outcome.headBefore} -> ${outcome.headAfter}.`;
            }
        };

        /** Terminal gate event carrying the structured snapshot and timestamps. */
        const emitPrGateObservationTerminal = async (
            issueContext: WorkflowIssueContext,
            pullRequest: GitHubPullRequest,
            result: PipelineObservationResult,
        ): Promise<void> => {
            const outcome = result.outcome;
            const status = gateStatusForObservation(outcome);
            const snapshot = snapshotForObservation(outcome);
            await emitPrGate(
                issueContext,
                status === "green" ? "succeeded" : "failed",
                observationTerminalMessage(pullRequest, outcome),
                {
                    pullRequestNumber: pullRequest.number,
                    observedHeadSha: pullRequest.headSha,
                    gate: status,
                    elapsedMs: outcome.elapsedMs,
                    polls: outcome.polls,
                    terminalReason: terminalReasonForObservation(outcome),
                    ...(snapshot === undefined ? {} : { snapshot }),
                },
            );
        };

        /** Atomically replace the persisted PR closure gate for the issue. */
        const setPrClosure = async (
            issueContext: WorkflowIssueContext,
            update: {
                readonly pullRequestNumber: number;
                readonly baseSha?: string;
                readonly observedHeadSha: string;
                readonly gate: PrClosureGateStatus;
                readonly snapshot?: WorkflowPrClosure["snapshot"];
                readonly terminalReason?: string;
                /** `null` explicitly invalidates review evidence on a head move. */
                readonly review?: WorkflowPrClosure["review"] | null;
            },
        ): Promise<void> => {
            const { review: reviewUpdate, baseSha, ...closureUpdate } = update;
            const nextReview =
                reviewUpdate === null
                    ? undefined
                    : (reviewUpdate ?? prClosure?.review);
            const nextBaseSha = baseSha ?? prClosure?.baseSha;
            const nextSnapshot = preservedPrGateSnapshot(
                prClosure,
                update.observedHeadSha,
                update.snapshot,
            );
            prClosure = {
                startedAt: prClosure?.startedAt ?? nowIso(),
                ...closureUpdate,
                ...optionalPrReviewField("baseSha", nextBaseSha),
                ...optionalPrReviewField("snapshot", nextSnapshot),
                ...optionalPrReviewField("review", nextReview),
                updatedAt: nowIso(),
            };
            await persistState(RunStateStatus.Active, {
                issueNumber: issueContext.issue.number,
                stage: "issue-closure",
            });
        };

        const recordPrLifecycleArtifact = async (input: {
            readonly issueContext: WorkflowIssueContext;
            readonly pullRequestNumber: number;
            readonly baseSha: string | undefined;
            readonly headSha: string;
            readonly stage: "checks" | "merge";
            readonly status:
                | "green"
                | "merged"
                | "failed"
                | "stale"
                | "delivery-recoverable";
            readonly terminalReason?: string;
        }): Promise<void> => {
            if (input.baseSha === undefined) return;
            const artifacts = await artifactStores.forIssue(
                input.issueContext.issue.number,
                { workspace, runId: actualRunId, repository: repo },
                signal,
            );
            await artifacts.recordPullRequestDeliveryState({
                pullRequestNumber: input.pullRequestNumber,
                baseSha: input.baseSha,
                headSha: input.headSha,
                stage: input.stage,
                status: input.status,
                reviewAttempts: prClosure?.review?.attempts?.length ?? 0,
                revisionCount: prClosure?.review?.revisionCount ?? 0,
                ...optionalPrReviewField(
                    "terminalReason",
                    input.terminalReason,
                ),
                updatedAt: nowIso(),
            });
        };

        const recordMergedPrClosure = async (
            issueContext: WorkflowIssueContext,
            pullRequest: GitHubPullRequest,
            terminalReason?: string,
        ): Promise<void> => {
            await setPrClosure(issueContext, {
                pullRequestNumber: pullRequest.number,
                observedHeadSha: pullRequest.headSha,
                gate: "merged",
                // Retain the green observation snapshot as merge evidence.
                ...(prClosure?.snapshot === undefined
                    ? {}
                    : { snapshot: prClosure.snapshot }),
                ...(terminalReason === undefined ? {} : { terminalReason }),
            });
            await recordPrLifecycleArtifact({
                issueContext,
                pullRequestNumber: pullRequest.number,
                baseSha: prClosure?.baseSha,
                headSha: pullRequest.headSha,
                stage: "merge",
                status: "merged",
                terminalReason,
            });
        };

        const recordClosedPrClosure = async (
            issueContext: WorkflowIssueContext,
            pullRequest: GitHubPullRequest,
            terminalReason: string,
        ): Promise<void> => {
            await setPrClosure(issueContext, {
                pullRequestNumber: pullRequest.number,
                observedHeadSha: pullRequest.headSha,
                gate: "closed",
                terminalReason,
            });
            await recordPrLifecycleArtifact({
                issueContext,
                pullRequestNumber: pullRequest.number,
                baseSha: prClosure?.baseSha,
                headSha: pullRequest.headSha,
                stage: "merge",
                status: "failed",
                terminalReason,
            });
        };

        const recordStalePrClosure = async (
            issueContext: WorkflowIssueContext,
            pullRequest: GitHubPullRequest,
            terminalReason: string,
        ): Promise<void> => {
            await setPrClosure(issueContext, {
                pullRequestNumber: pullRequest.number,
                observedHeadSha: pullRequest.headSha,
                gate: "stale",
                terminalReason,
                review:
                    prClosure?.review === undefined
                        ? null
                        : {
                              status: "stale",
                              currentHeadSha: pullRequest.headSha,
                              revisionCount: prClosure.review.revisionCount,
                              terminalReason,
                          },
            });
            await recordPrLifecycleArtifact({
                issueContext,
                pullRequestNumber: pullRequest.number,
                baseSha: prClosure?.baseSha,
                headSha: pullRequest.headSha,
                stage: "merge",
                status: "stale",
                terminalReason,
            });
        };

        const observePullRequestGate = async (
            issueContext: WorkflowIssueContext,
            pullRequest: GitHubPullRequest,
        ): Promise<PipelineObservationResult> => {
            return await pipelineObservation.observe({
                client: octokit,
                request: {
                    repository: repo,
                    branch: issueContext.featureBranch,
                    commitSha: pullRequest.headSha,
                },
                options: PR_GATE_OBSERVATION_OPTIONS,
                signal,
                onTransition: (transition) => {
                    void emitPrGate(
                        issueContext,
                        "info",
                        transitionMessage(
                            pullRequest.number,
                            pullRequest.headSha,
                            transition,
                        ),
                        {
                            pullRequestNumber: pullRequest.number,
                            observedHeadSha: pullRequest.headSha,
                            transition,
                        },
                    ).catch(() => undefined);
                },
            });
        };

        const gateStatusForObservation = (
            outcome: PipelineObservationResult["outcome"],
        ): PrClosureGateStatus => {
            switch (outcome.kind) {
                case "green":
                    return "green";
                case "no-pipelines-discovered":
                    return "no-pipelines";
                case "timeout":
                    return "timeout";
                case "aborted":
                    return "aborted";
                case "stale":
                    return "stale";
                case "failed":
                    if (outcome.reason === "cancelled") return "cancelled";
                    if (outcome.reason === "failing") return "failed";
                    return "unknown";
            }
        };

        const snapshotForObservation = (
            outcome: PipelineObservationResult["outcome"],
        ): PipelineSnapshot | undefined => {
            switch (outcome.kind) {
                case "green":
                    return outcome.snapshot;
                case "failed":
                    return outcome.snapshot;
                case "stale":
                    return outcome.snapshot;
                case "timeout":
                    return outcome.lastSnapshot;
                default:
                    return undefined;
            }
        };

        const failedObservationReason = (
            outcome: Extract<
                PipelineObservationResult["outcome"],
                { readonly kind: "failed" }
            >,
        ): string => {
            if (outcome.reason === "failing")
                return `Checks are failing for ${outcome.observedSha}.`;
            if (outcome.reason === "cancelled")
                return `Checks were cancelled for ${outcome.observedSha}.`;
            return `Check observation failed for ${outcome.observedSha}: ${outcome.message ?? "no message"}.`;
        };

        const terminalReasonForObservation = (
            outcome: PipelineObservationResult["outcome"],
        ): string => {
            switch (outcome.kind) {
                case "green":
                    return `Checks passed for ${outcome.observedSha} in ${outcome.elapsedMs}ms (${outcome.polls} polls).`;
                case "failed":
                    return failedObservationReason(outcome);
                case "no-pipelines-discovered":
                    return `No pipelines were discovered for ${outcome.observedSha} within ${outcome.elapsedMs}ms.`;
                case "timeout":
                    return `Observation timed out for ${outcome.observedSha} after ${outcome.elapsedMs}ms.`;
                case "aborted":
                    return `Observation aborted for ${outcome.observedSha} (${String(outcome.reason ?? "caller cancelled")}).`;
                case "stale":
                    return `Branch head advanced from ${outcome.headBefore} to ${outcome.headAfter} while observing ${outcome.observedSha}.`;
            }
        };

        /** Snapshot plus terminal reason persisted with an observation result. */
        const observationEvidence = (
            outcome: PipelineObservationResult["outcome"],
            status: PrClosureGateStatus,
        ): {
            readonly snapshot?: WorkflowPrClosure["snapshot"];
            readonly terminalReason?: string;
        } => {
            const snapshot = snapshotForObservation(outcome);
            return {
                ...(snapshot === undefined ? {} : { snapshot }),
                ...(status === "green"
                    ? {}
                    : {
                          terminalReason: terminalReasonForObservation(outcome),
                      }),
            };
        };

        const prCheckArtifactFieldsFor = (
            status: PrClosureGateStatus,
            snapshot: PipelineSnapshot | undefined,
            outcome: PipelineObservationResult["outcome"],
        ): {
            readonly status: "green" | "failed";
            readonly checkStatus: "green" | "failed";
            readonly checkFingerprint?: string;
            readonly terminalReason?: string;
        } => {
            const green = status === "green";
            return {
                status: green ? "green" : "failed",
                checkStatus: green ? "green" : "failed",
                ...optionalPrReviewField(
                    "checkFingerprint",
                    snapshot?.fingerprint,
                ),
                ...optionalPrReviewField(
                    "terminalReason",
                    green ? undefined : terminalReasonForObservation(outcome),
                ),
            };
        };

        const recordPrCheckArtifact = async (
            issueContext: WorkflowIssueContext,
            pullRequest: GitHubPullRequest,
            outcome: PipelineObservationResult["outcome"],
            status: PrClosureGateStatus,
        ): Promise<void> => {
            const baseSha = prClosure?.baseSha;
            if (baseSha === undefined) return;
            const artifacts = await artifactStores.forIssue(
                issueContext.issue.number,
                { workspace, runId: actualRunId, repository: repo },
                signal,
            );
            const snapshot = snapshotForObservation(outcome);
            const checkFields = prCheckArtifactFieldsFor(
                status,
                snapshot,
                outcome,
            );
            await artifacts.recordPullRequestDeliveryState({
                pullRequestNumber: pullRequest.number,
                baseSha,
                headSha: pullRequest.headSha,
                stage: "checks",
                status: checkFields.status,
                reviewAttempts: prClosure?.review?.attempts?.length ?? 0,
                revisionCount: prClosure?.review?.revisionCount ?? 0,
                checkHeadSha: pullRequest.headSha,
                checkStatus: checkFields.checkStatus,
                ...optionalPrReviewField(
                    "checkFingerprint",
                    checkFields.checkFingerprint,
                ),
                ...optionalPrReviewField(
                    "terminalReason",
                    checkFields.terminalReason,
                ),
                updatedAt: nowIso(),
            });
        };

        const applyPrGateObservation = async (
            issueContext: WorkflowIssueContext,
            pullRequest: GitHubPullRequest,
            result: PipelineObservationResult,
        ): Promise<void> => {
            const outcome = result.outcome;
            const status = gateStatusForObservation(outcome);
            await setPrClosure(issueContext, {
                pullRequestNumber: pullRequest.number,
                observedHeadSha: pullRequest.headSha,
                gate: status,
                ...observationEvidence(outcome, status),
            });
            await recordPrCheckArtifact(
                issueContext,
                pullRequest,
                outcome,
                status,
            );
            await emitPrGateObservationTerminal(
                issueContext,
                pullRequest,
                result,
            );
            if (status === "green") return;
            if (status === "aborted" && signal?.aborted === true) {
                checkCancellation(signal);
            }
            throw new RalphieError({
                message: `PR gate did not pass for issue #${issueContext.issue.number} on ${pullRequest.headSha}: ${terminalReasonForObservation(outcome)}.`,
            });
        };

        const resolvePullRequestForGate = async (
            issueContext: WorkflowIssueContext,
        ): Promise<GitHubPullRequest> => {
            try {
                if (prClosure !== undefined) {
                    return await githubPullRequests.read(
                        octokit,
                        repo,
                        prClosure.pullRequestNumber,
                    );
                }
                return await githubPullRequests.createOrFind(octokit, repo, {
                    title: `Fix #${issueContext.issue.number}: ${issueContext.issue.title}`,
                    issueNumber: issueContext.issue.number,
                    closesIssue: true,
                    head: issueContext.featureBranch,
                    base: branch,
                });
            } catch (cause) {
                if (prClosure !== undefined) {
                    await setPrClosure(issueContext, {
                        pullRequestNumber: prClosure.pullRequestNumber,
                        observedHeadSha: prClosure.observedHeadSha,
                        gate: "unknown",
                        terminalReason: `Pull request #${prClosure.pullRequestNumber} could not be re-read: ${errorMessage(cause)}.`,
                    });
                }
                throw new RalphieError({
                    message: `Failed to locate the pull request for issue #${issueContext.issue.number}: ${errorMessage(cause)}.`,
                    cause,
                });
            }
        };

        /**
         * Persist the pending gate and publish review evidence, returning
         * whether the exact-head observer must run. A matching saved green gate
         * skips the observation but is re-verified by the merge re-read.
         */
        const publishStoredPreCommitReviews = async (
            issueContext: WorkflowIssueContext,
            pullRequest: GitHubPullRequest,
        ): Promise<void> => {
            const artifacts = await artifactStores.forIssue(
                issueContext.issue.number,
                { workspace, runId: actualRunId, repository: repo },
                signal,
            );
            const reviews = artifacts.has(IssueArtifactKind.ReviewAttempts)
                ? await artifacts.read(IssueArtifactKind.ReviewAttempts)
                : [];
            await githubPullRequests.publishReviewAttempts(
                octokit,
                repo,
                pullRequest.number,
                reviews,
            );
        };

        const markPrReviewChecksStage = async (
            issueContext: WorkflowIssueContext,
            pullRequest: GitHubPullRequest,
        ): Promise<void> => {
            if (prClosure?.review === undefined) return;
            await setPrClosure(issueContext, {
                pullRequestNumber: pullRequest.number,
                observedHeadSha: pullRequest.headSha,
                gate: prClosure.gate,
                review: { ...prClosure.review, stage: "checks" },
            });
        };

        const preparePrGateObservation = async (
            issueContext: WorkflowIssueContext,
            pullRequest: GitHubPullRequest,
            publishPreCommitReviews = true,
        ): Promise<boolean> => {
            const headChanged =
                prClosure === undefined ||
                !sameSha(prClosure.observedHeadSha, pullRequest.headSha);
            if (headChanged) {
                await setPrClosure(issueContext, {
                    pullRequestNumber: pullRequest.number,
                    observedHeadSha: pullRequest.headSha,
                    gate: "pending",
                    review: null,
                });
            } else await markPrReviewChecksStage(issueContext, pullRequest);
            if (publishPreCommitReviews)
                await publishStoredPreCommitReviews(issueContext, pullRequest);
            return headChanged || (prClosure?.gate ?? "pending") !== "green";
        };

        /**
         * Gate a PR for delivery: persist its number and head SHA, publish the
         * review evidence, then wait for the exact-head check observer to reach
         * its green state. A failed, cancelled, timed-out, absent, unknown,
         * closed, or already-merged gate never merges or closes the issue.
         */
        /** Record and report an already-merged PR gate without a new merge call. */
        const recordMergedGateEvent = async (
            issueContext: WorkflowIssueContext,
            pullRequest: GitHubPullRequest,
            message: string,
            terminalReason?: string,
        ): Promise<void> => {
            await recordMergedPrClosure(
                issueContext,
                pullRequest,
                terminalReason,
            );
            await emitPrGate(issueContext, "succeeded", message, {
                pullRequestNumber: pullRequest.number,
                observedHeadSha: pullRequest.headSha,
                gate: "merged",
            });
        };

        /** Record and report a closed-without-merge PR gate. */
        const recordClosedGateEvent = async (
            issueContext: WorkflowIssueContext,
            pullRequest: GitHubPullRequest,
            message: string,
            terminalReason: string,
        ): Promise<void> => {
            await recordClosedPrClosure(
                issueContext,
                pullRequest,
                terminalReason,
            );
            await emitPrGate(issueContext, "failed", message, {
                pullRequestNumber: pullRequest.number,
                observedHeadSha: pullRequest.headSha,
                gate: "closed",
                terminalReason,
            });
        };

        const gatePullRequest = async (
            issueContext: WorkflowIssueContext,
            pullRequest: GitHubPullRequest,
            publishPreCommitReviews = true,
        ): Promise<"reconciled" | undefined> => {
            if (pullRequest.merged) {
                await recordMergedGateEvent(
                    issueContext,
                    pullRequest,
                    `PR #${pullRequest.number} (head ${pullRequest.headSha}) was already merged; reconciled without a new merge call.`,
                    "Pull request was already merged; no merge call was made.",
                );
                return "reconciled";
            }
            if (pullRequest.state === "closed") {
                await recordClosedGateEvent(
                    issueContext,
                    pullRequest,
                    `PR #${pullRequest.number} (head ${pullRequest.headSha}) is closed without merging; issue #${issueContext.issue.number} stays open.`,
                    "Pull request is closed without merging.",
                );
                throw new RalphieError({
                    message: `Pull request #${pullRequest.number} is closed without merging for issue #${issueContext.issue.number}.`,
                });
            }
            const needsObservation = await preparePrGateObservation(
                issueContext,
                pullRequest,
                publishPreCommitReviews,
            );
            if (!needsObservation) return undefined;
            const result = await observePullRequestGate(
                issueContext,
                pullRequest,
            );
            await applyPrGateObservation(issueContext, pullRequest, result);
            return undefined;
        };

        const readPostPrReviewArtifacts = async (
            issueContext: WorkflowIssueContext,
        ) => {
            const artifacts = await artifactStores.forIssue(
                issueContext.issue.number,
                { workspace, runId: actualRunId, repository: repo },
                signal,
            );
            const attempts = artifacts.has(
                IssueArtifactKind.PullRequestReviewAttempts,
            )
                ? await artifacts.read(
                      IssueArtifactKind.PullRequestReviewAttempts,
                  )
                : [];
            const approved = artifacts.has(
                IssueArtifactKind.ApprovedPullRequestReviewEvidence,
            )
                ? await artifacts.read(
                      IssueArtifactKind.ApprovedPullRequestReviewEvidence,
                  )
                : undefined;
            const deliveryState = artifacts.has(
                IssueArtifactKind.PullRequestDeliveryState,
            )
                ? await artifacts.read(
                      IssueArtifactKind.PullRequestDeliveryState,
                  )
                : undefined;
            return { artifacts, attempts, approved, deliveryState };
        };

        const postPrReviewEventMessage = (
            issueNumber: number,
            result: PullRequestReviewCoordinatorResult,
        ): string => {
            switch (result.status) {
                case "approved":
                    return `Structured PR review approved PR #${result.snapshot.number} at head ${result.snapshot.headSha}.`;
                case "pr-review-exhausted":
                    return `PR review budget exhausted for PR #${result.snapshot.number} at head ${result.snapshot.headSha}; the issue and pull request remain open.`;
                case "needs-attention":
                    return `PR review needs attention for issue #${issueNumber} at head ${result.snapshot.headSha}: ${result.request.message}`;
                case "review-failed":
                    return `PR review failed for PR #${result.snapshot.number} at attempt ${result.attempt}: ${result.message}`;
                case "head-moved":
                    return `PR head moved during ${result.phase} for PR #${result.snapshot.number}; approval evidence is stale.`;
                case "delivery-recoverable":
                    return `PR revision delivery needs reconciliation for PR #${result.snapshot.number}: ${result.delivery.status}.`;
                case "revision-failed":
                    return `PR revision failed for PR #${result.snapshot.number}: ${result.message}`;
            }
        };

        const throwPostPrReviewFailure = async (
            issueContext: WorkflowIssueContext,
            result: PostPrReviewFailureResult,
            artifacts: IssueArtifactStore,
            attempts: ReadonlyArray<PullRequestReviewAttempt>,
            delivery?: PullRequestDeliveryStateArtifact["delivery"],
        ): Promise<never> => {
            const { status, stage, revisionIntent } =
                postPrReviewFailureDetailsFor(result, prClosure?.review);
            await setPrClosure(issueContext, {
                pullRequestNumber: result.snapshot.number,
                baseSha: result.snapshot.baseSha,
                observedHeadSha: result.snapshot.headSha,
                gate: "pending",
                review: {
                    status,
                    stage,
                    attempts: [...attempts],
                    ...optionalPrReviewField("revisionIntent", revisionIntent),
                    currentHeadSha: result.snapshot.headSha,
                    revisionCount: prClosure?.review?.revisionCount ?? 0,
                    terminalReason: postPrReviewEventMessage(
                        issueContext.issue.number,
                        result,
                    ),
                },
                terminalReason: postPrReviewEventMessage(
                    issueContext.issue.number,
                    result,
                ),
            });
            await artifacts.recordPullRequestDeliveryState({
                pullRequestNumber: result.snapshot.number,
                baseSha: result.snapshot.baseSha,
                headSha: result.snapshot.headSha,
                stage,
                status:
                    status === "pr-review-exhausted"
                        ? "exhausted"
                        : status === "needs-attention"
                          ? "failed"
                          : status,
                reviewAttempts: attempts.length,
                revisionCount: prClosure?.review?.revisionCount ?? 0,
                ...optionalPrReviewField("revisionIntent", revisionIntent),
                ...optionalPrReviewField("delivery", delivery),
                terminalReason: postPrReviewEventMessage(
                    issueContext.issue.number,
                    result,
                ),
                updatedAt: nowIso(),
            });
            await emitPrGate(
                issueContext,
                "failed",
                postPrReviewEventMessage(issueContext.issue.number, result),
                {
                    pullRequestNumber: result.snapshot.number,
                    observedHeadSha: result.snapshot.headSha,
                    gate: status,
                    reviewStatus: status,
                    attempts: attempts.length,
                },
            );
            throw new RalphieError({
                message: `Post-PR review did not pass for issue #${issueContext.issue.number}: ${postPrReviewEventMessage(issueContext.issue.number, result)}`,
            });
        };

        const postPrArtifactStatusFor = (
            status: WorkflowPrReview["status"],
        ):
            | "pending"
            | "approved"
            | "failed"
            | "stale"
            | "delivery-recoverable" =>
            status === "pr-review-exhausted"
                ? "failed"
                : status === "needs-attention"
                  ? "failed"
                  : status;

        const persistPostPrReviewStage = async (input: {
            readonly issueContext: WorkflowIssueContext;
            readonly snapshot: PullRequestSnapshot;
            readonly artifacts?: IssueArtifactStore;
            readonly status: WorkflowPrReview["status"];
            readonly gate?: PrClosureGateStatus;
            readonly attempts: Awaited<
                ReturnType<typeof readPostPrReviewArtifacts>
            >["attempts"];
            readonly stage?: WorkflowPrReview["stage"];
            readonly approved?: ApprovedReviewEvidence;
            readonly revisionIntent?: PullRequestRevisionIntent;
            readonly delivery?: PullRequestDeliveryStateArtifact["delivery"];
            readonly revisionCount: number;
            readonly terminalReason?: string;
        }): Promise<void> => {
            await setPrClosure(input.issueContext, {
                pullRequestNumber: input.snapshot.number,
                baseSha: input.snapshot.baseSha,
                observedHeadSha: input.snapshot.headSha,
                gate: input.gate ?? "pending",
                review: {
                    status: input.status,
                    ...optionalPrReviewField("stage", input.stage),
                    attempts: [...input.attempts],
                    ...optionalPrReviewField("approved", input.approved),
                    ...optionalPrReviewField(
                        "revisionIntent",
                        input.revisionIntent,
                    ),
                    currentHeadSha: input.snapshot.headSha,
                    revisionCount: input.revisionCount,
                    ...optionalPrReviewField(
                        "terminalReason",
                        input.terminalReason,
                    ),
                },
            });
            if (input.artifacts === undefined) return;
            await input.artifacts.recordPullRequestDeliveryState({
                pullRequestNumber: input.snapshot.number,
                baseSha: input.snapshot.baseSha,
                headSha: input.snapshot.headSha,
                stage: input.stage ?? "review",
                status: postPrArtifactStatusFor(input.status),
                reviewAttempts: input.attempts.length,
                revisionCount: input.revisionCount,
                ...optionalPrReviewField(
                    "revisionIntent",
                    input.revisionIntent,
                ),
                ...optionalPrReviewField("delivery", input.delivery),
                ...optionalPrReviewField(
                    "terminalReason",
                    input.terminalReason,
                ),
                updatedAt: nowIso(),
            });
        };

        const persistCoordinatorStage = async (
            issueContext: WorkflowIssueContext,
            event: PullRequestReviewLifecycleEvent,
        ): Promise<void> => {
            const { artifacts, attempts } =
                await readPostPrReviewArtifacts(issueContext);
            await persistPostPrReviewStage({
                issueContext,
                snapshot: event.snapshot,
                status: "pending",
                stage: event.stage,
                artifacts,
                attempts,
                revisionIntent: event.revisionIntent,
                revisionCount: prClosure?.review?.revisionCount ?? 0,
            });
        };

        const deliveryArtifactFor = (
            delivery: PullRequestReviewDeliveryEvent["delivery"],
        ): NonNullable<PullRequestDeliveryStateArtifact["delivery"]> => ({
            status: delivery.status,
            headSha: delivery.headSha,
            parentSha: delivery.parentSha,
            ...(delivery.status === "confirmed"
                ? {
                      remoteSha: delivery.remoteSha,
                      pushResponseLost: delivery.pushResponseLost,
                  }
                : delivery.actualRemoteSha.length === 0
                  ? {}
                  : { remoteSha: delivery.actualRemoteSha }),
        });

        const persistCoordinatorDelivery = async (
            issueContext: WorkflowIssueContext,
            event: PullRequestReviewDeliveryEvent,
        ): Promise<void> => {
            const { artifacts, attempts } =
                await readPostPrReviewArtifacts(issueContext);
            const confirmed = event.delivery.status === "confirmed";
            await persistPostPrReviewStage({
                issueContext,
                snapshot: confirmed
                    ? { ...event.snapshot, headSha: event.delivery.headSha }
                    : event.snapshot,
                status: "pending",
                stage: "revision-delivery",
                gate: "pending",
                artifacts,
                attempts,
                ...optionalPrReviewField(
                    "revisionIntent",
                    confirmed ? undefined : event.revisionIntent,
                ),
                delivery: deliveryArtifactFor(event.delivery),
                revisionCount: (prClosure?.review?.revisionCount ?? 0) + 1,
            });
        };

        const failIfPostPrReviewAlreadyExhausted = async (
            issueContext: WorkflowIssueContext,
            priorReview: WorkflowPrReview | undefined,
            snapshot: PullRequestSnapshot,
        ): Promise<void> => {
            if (
                priorReview?.status !== "pr-review-exhausted" ||
                priorReview.currentHeadSha === undefined ||
                !sameSha(priorReview.currentHeadSha, snapshot.headSha)
            ) {
                return;
            }
            const { artifacts, attempts } =
                await readPostPrReviewArtifacts(issueContext);
            await throwPostPrReviewFailure(
                issueContext,
                {
                    reviews: [],
                    revisions: [],
                    status: "pr-review-exhausted",
                    snapshot,
                    reason: "review-attempt-budget-exhausted",
                },
                artifacts,
                attempts,
            );
        };

        const uniquePullRequestReviewAttempts = (
            attempts: ReadonlyArray<PullRequestReviewAttempt>,
        ): ReadonlyArray<PullRequestReviewAttempt> => {
            const seen = new Set<string>();
            return attempts.filter((attempt) => {
                const key = [
                    attempt.pullRequestNumber,
                    attempt.baseSha.toLowerCase(),
                    attempt.reviewedHeadSha.toLowerCase(),
                    attempt.attempt,
                    attempt.sessionID,
                ].join("\u0000");
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
        };

        const completePostPrReview = async (
            issueContext: WorkflowIssueContext,
            pullRequest: GitHubPullRequest,
            result: Extract<
                PullRequestReviewCoordinatorResult,
                { readonly status: "approved" }
            >,
            priorReview: WorkflowPrReview | undefined,
            finalArtifacts: Awaited<
                ReturnType<typeof readPostPrReviewArtifacts>
            >,
        ): Promise<{
            readonly pullRequest: GitHubPullRequest;
            readonly review: ApprovedReviewEvidence;
        }> => {
            const resultApproval = result.review
                .attempt as ApprovedReviewEvidence;
            const storedApproval = finalArtifacts.approved;
            const approval =
                storedApproval !== undefined &&
                storedApproval.pullRequestNumber === result.snapshot.number &&
                sameSha(storedApproval.baseSha, result.snapshot.baseSha) &&
                sameSha(storedApproval.reviewedHeadSha, result.snapshot.headSha)
                    ? storedApproval
                    : resultApproval;
            const attempts = uniquePullRequestReviewAttempts([
                ...finalArtifacts.attempts,
                ...result.reviews.map(({ attempt }) => attempt),
                result.review.attempt,
            ]);
            const revisionCount =
                (priorReview?.revisionCount ?? 0) + result.revisions.length;
            const savedGreenGate =
                prClosure?.gate === "green" &&
                sameSha(prClosure.observedHeadSha, result.snapshot.headSha)
                    ? "green"
                    : "pending";
            await persistPostPrReviewStage({
                issueContext,
                snapshot: result.snapshot,
                status: "pending",
                gate: savedGreenGate,
                stage: "publication",
                artifacts: finalArtifacts.artifacts,
                attempts,
                approved: approval,
                revisionCount,
            });
            await githubPullRequests.publishPullRequestReviewAttempts(
                octokit,
                repo,
                attempts,
            );
            await persistPostPrReviewStage({
                issueContext,
                snapshot: result.snapshot,
                status: "approved",
                gate: savedGreenGate,
                artifacts: finalArtifacts.artifacts,
                attempts,
                approved: approval,
                revisionCount,
            });
            await emitPrGate(
                issueContext,
                "info",
                postPrReviewEventMessage(issueContext.issue.number, result),
                {
                    pullRequestNumber: result.snapshot.number,
                    observedHeadSha: result.snapshot.headSha,
                    reviewStatus: "approved",
                    reviewAttempts: attempts.length,
                    revisions: revisionCount,
                },
            );
            return {
                pullRequest: {
                    ...pullRequest,
                    headSha: result.snapshot.headSha,
                },
                review: approval,
            };
        };

        const persistPostPrReviewStart = async (
            issueContext: WorkflowIssueContext,
            snapshot: PullRequestSnapshot,
            priorReview: WorkflowPrReview | undefined,
            initialArtifacts: Awaited<
                ReturnType<typeof readPostPrReviewArtifacts>
            >,
        ): Promise<PullRequestRevisionIntent | undefined> => {
            // The state write replaces the nested review object, so capture
            // the intent before persisting the new review boundary.
            const resumeRevision =
                priorReview?.revisionIntent ??
                initialArtifacts.deliveryState?.revisionIntent;
            const savedGreenGate =
                priorReview?.status === "approved" &&
                prClosure?.gate === "green" &&
                sameSha(prClosure.observedHeadSha, snapshot.headSha)
                    ? "green"
                    : "pending";
            await persistPostPrReviewStage({
                issueContext,
                snapshot,
                status: "pending",
                stage: "review",
                artifacts: initialArtifacts.artifacts,
                gate: savedGreenGate,
                attempts: initialArtifacts.attempts,
                revisionIntent: resumeRevision,
                revisionCount: priorReview?.revisionCount ?? 0,
            });
            return resumeRevision;
        };

        /**
         * Run the post-creation review/revision coordinator when the runtime
         * supplies the production service. Small legacy fakes intentionally
         * omit it and continue through the original check-gate path.
         */
        const runPostPrReview = async (
            issueContext: WorkflowIssueContext,
            pullRequest: GitHubPullRequest,
            server: OpenCodeRuntime,
        ): Promise<
            | {
                  readonly pullRequest: GitHubPullRequest;
                  readonly review: ApprovedReviewEvidence;
              }
            | undefined
        > => {
            const review = pullRequestReviewCoordinator?.review;
            if (typeof review !== "function") return undefined;

            const currentSnapshot = await githubPullRequests.readSnapshot(
                octokit,
                repo,
                pullRequest.number,
            );
            const priorReview = prClosure?.review;
            await failIfPostPrReviewAlreadyExhausted(
                issueContext,
                priorReview,
                currentSnapshot,
            );

            const initialArtifacts =
                await readPostPrReviewArtifacts(issueContext);
            const resumeRevision = await persistPostPrReviewStart(
                issueContext,
                currentSnapshot,
                priorReview,
                initialArtifacts,
            );

            const result = await review({
                client: octokit,
                repository: repo,
                repositoryPath:
                    issueContext.issueRepositories[0]!.repositoryPath,
                branch: issueContext.featureBranch,
                targetBranch: branch,
                issue: issueContext.issue,
                snapshot: currentSnapshot,
                agent: server.client,
                agentSelection: selection,
                artifacts: initialArtifacts.artifacts,
                verificationCommands: config.verificationCommands,
                runId: actualRunId,
                diagnostics,
                signal,
                resumeRevision,
                onStage: (event) =>
                    persistCoordinatorStage(issueContext, event),
                onRevisionDelivery: (event) =>
                    persistCoordinatorDelivery(issueContext, event),
            });
            const finalArtifacts =
                await readPostPrReviewArtifacts(issueContext);
            if (result.status !== "approved") {
                await throwPostPrReviewFailure(
                    issueContext,
                    result,
                    finalArtifacts.artifacts,
                    finalArtifacts.attempts,
                    result.status === "delivery-recoverable"
                        ? finalArtifacts.deliveryState?.delivery
                        : undefined,
                );
                return undefined;
            }
            return await completePostPrReview(
                issueContext,
                pullRequest,
                result,
                priorReview,
                finalArtifacts,
            );
        };

        const mergeFailureGate = (
            current: GitHubPullRequest,
            observedHeadSha: string,
            cause: unknown,
        ): PrClosureGateStatus => {
            if (!sameSha(current.headSha, observedHeadSha)) return "stale";
            if (current.state === "closed") return "closed";
            if (errorMessage(cause).includes("not definitively mergeable")) {
                return "unmergeable";
            }
            return "unknown";
        };

        const staleReviewUpdateForMergeFailure = (
            gate: PrClosureGateStatus,
            reconciled: GitHubPullRequest,
            cause: unknown,
        ): Pick<NonNullable<RunState["prClosure"]>, "review"> =>
            gate === "stale" && prClosure?.review !== undefined
                ? {
                      review: {
                          status: "stale",
                          currentHeadSha: reconciled.headSha,
                          revisionCount: prClosure.review.revisionCount,
                          terminalReason: `Merge rejected: ${errorMessage(cause)}.`,
                      },
                  }
                : {};

        const mergeArtifactStatusFor = (
            gate: PrClosureGateStatus,
        ): "failed" | "stale" | "delivery-recoverable" =>
            gate === "stale"
                ? "stale"
                : gate === "unknown" || gate === "unmergeable"
                  ? "delivery-recoverable"
                  : "failed";

        const resolveMergeFailure = async (
            issueContext: WorkflowIssueContext,
            current: GitHubPullRequest,
            observedHeadSha: string,
            cause: unknown,
        ): Promise<GitHubPullRequest> => {
            const reconciled = await githubPullRequests.read(
                octokit,
                repo,
                current.number,
            );
            if (reconciled.merged) {
                await recordMergedGateEvent(
                    issueContext,
                    reconciled,
                    `Merge response was lost but PR #${reconciled.number} is merged at head ${reconciled.headSha}; reconciled without a new merge call.`,
                    `Merge response was lost but pull request #${reconciled.number} is merged.`,
                );
                return reconciled;
            }
            const gate = mergeFailureGate(reconciled, observedHeadSha, cause);
            await setPrClosure(issueContext, {
                pullRequestNumber: reconciled.number,
                observedHeadSha:
                    gate === "stale" ? reconciled.headSha : observedHeadSha,
                gate,
                terminalReason: `Merge rejected: ${errorMessage(cause)}.`,
                ...staleReviewUpdateForMergeFailure(gate, reconciled, cause),
            });
            await recordPrLifecycleArtifact({
                issueContext,
                pullRequestNumber: reconciled.number,
                baseSha: prClosure?.baseSha,
                headSha:
                    gate === "stale" ? reconciled.headSha : observedHeadSha,
                stage: "merge",
                status: mergeArtifactStatusFor(gate),
                terminalReason: `Merge rejected: ${errorMessage(cause)}.`,
            });
            await emitPrGate(
                issueContext,
                "failed",
                `Merge rejected for PR #${current.number} (issue #${issueContext.issue.number} stays open): ${errorMessage(cause)}; gate ${gate}.`,
                {
                    pullRequestNumber: reconciled.number,
                    observedHeadSha:
                        gate === "stale" ? reconciled.headSha : observedHeadSha,
                    gate,
                },
            );
            throw new RalphieError({
                message: `Failed to merge pull request #${current.number} for issue #${issueContext.issue.number}: ${errorMessage(cause)}.`,
                cause,
            });
        };

        /** Expected-head merge with authoritative merged-state reconciliation. */
        const attemptPrMerge = async (
            issueContext: WorkflowIssueContext,
            current: GitHubPullRequest,
            observedHeadSha: string,
            approvedReview?: ApprovedReviewEvidence,
        ): Promise<GitHubPullRequest> => {
            try {
                if (approvedReview !== undefined) {
                    const mergeWithProof = githubPullRequests.mergeWithProof;
                    const observedChecks = prClosure?.snapshot;
                    if (
                        typeof mergeWithProof !== "function" ||
                        prClosure?.gate !== "green" ||
                        observedChecks === undefined ||
                        observedChecks.commitSha.length === 0 ||
                        !sameSha(observedChecks.commitSha, observedHeadSha)
                    ) {
                        throw new RalphieError({
                            message: `PR #${current.number} is missing a green-check proof for head ${observedHeadSha}.`,
                        });
                    }
                    const proof: PullRequestMergeProof = {
                        pullRequestNumber: current.number,
                        baseSha: approvedReview.baseSha,
                        headSha: observedHeadSha,
                        review: approvedReview,
                        checks: {
                            pullRequestNumber: current.number,
                            headSha: observedHeadSha,
                            status: "green",
                        },
                    };
                    return await mergeWithProof(octokit, repo, proof);
                }
                return await githubPullRequests.merge(
                    octokit,
                    repo,
                    current.number,
                    observedHeadSha,
                );
            } catch (cause) {
                return await resolveMergeFailure(
                    issueContext,
                    current,
                    observedHeadSha,
                    cause,
                );
            }
        };

        /** Record and halt on an expected-head mismatch at the final gate. */
        const recordStaleGateEvent = async (
            issueContext: WorkflowIssueContext,
            current: GitHubPullRequest,
            observedHeadSha: string,
        ): Promise<never> => {
            await recordStalePrClosure(
                issueContext,
                current,
                `Pull request head changed from ${observedHeadSha} to ${current.headSha} after a green observation; the saved decision was discarded.`,
            );
            await emitPrGate(
                issueContext,
                "failed",
                `Expected-head mismatch for PR #${current.number} (issue #${issueContext.issue.number}): observed ${observedHeadSha} but the current head is ${current.headSha}; the saved green decision was invalidated.`,
                {
                    pullRequestNumber: current.number,
                    observedHeadSha,
                    expectedHeadSha: observedHeadSha,
                    actualHeadSha: current.headSha,
                    gate: "stale",
                },
            );
            throw new RalphieError({
                message: `Pull request #${current.number} head changed from ${observedHeadSha} to ${current.headSha} for issue #${issueContext.issue.number}; not merging.`,
            });
        };

        /**
         * Reconcile an already-merged or closed-without-merge PR read before
         * merging; returns whether the gate is settled and needs no merge.
         */
        const reconcileMergedOrClosedGate = async (
            issueContext: WorkflowIssueContext,
            current: GitHubPullRequest,
        ): Promise<boolean> => {
            if (current.merged) {
                await recordMergedGateEvent(
                    issueContext,
                    current,
                    `PR #${current.number} (head ${current.headSha}) was already merged; reconciled without a new merge call.`,
                    "Pull request was already merged; no merge call was made.",
                );
                return true;
            }
            if (current.state === "closed") {
                await recordClosedGateEvent(
                    issueContext,
                    current,
                    `PR #${current.number} (head ${current.headSha}) closed without merging before the gate could merge it; issue #${issueContext.issue.number} stays open.`,
                    "Pull request closed without merging before the gate could merge it.",
                );
                throw new RalphieError({
                    message: `Pull request #${current.number} closed without merging for issue #${issueContext.issue.number}.`,
                });
            }
            return false;
        };

        const persistMergeStage = async (
            issueContext: WorkflowIssueContext,
            pullRequest: GitHubPullRequest,
            observedHeadSha: string,
            approvedReview: ApprovedReviewEvidence,
        ): Promise<void> => {
            const { artifacts, attempts } =
                await readPostPrReviewArtifacts(issueContext);
            await persistPostPrReviewStage({
                issueContext,
                snapshot: {
                    number: pullRequest.number,
                    url: pullRequest.url,
                    baseSha: approvedReview.baseSha,
                    headSha: observedHeadSha,
                },
                status: "approved",
                gate: "green",
                stage: "merge",
                artifacts,
                attempts,
                approved: approvedReview,
                revisionCount: prClosure?.review?.revisionCount ?? 0,
            });
        };

        const ensureMergeHeadIsCurrent = async (
            issueContext: WorkflowIssueContext,
            current: GitHubPullRequest,
            observedHeadSha: string,
        ): Promise<void> => {
            if (sameSha(current.headSha, observedHeadSha)) return;
            await recordStaleGateEvent(issueContext, current, observedHeadSha);
        };

        /**
         * Re-read the PR immediately before merging. A moved head invalidates
         * the saved green decision; a merged or closed PR is reconciled.
         */
        const mergeGatedPullRequest = async (
            issueContext: WorkflowIssueContext,
            pullRequest: GitHubPullRequest,
            approvedReview?: ApprovedReviewEvidence,
        ): Promise<void> => {
            const current = await githubPullRequests.read(
                octokit,
                repo,
                pullRequest.number,
            );
            if (await reconcileMergedOrClosedGate(issueContext, current)) {
                return;
            }
            const observedHeadSha =
                prClosure?.observedHeadSha ?? pullRequest.headSha;
            await ensureMergeHeadIsCurrent(
                issueContext,
                current,
                observedHeadSha,
            );
            if (approvedReview !== undefined) {
                await persistMergeStage(
                    issueContext,
                    current,
                    observedHeadSha,
                    approvedReview,
                );
            }
            const merged = await attemptPrMerge(
                issueContext,
                current,
                observedHeadSha,
                approvedReview,
            );
            await recordMergedPrClosure(issueContext, merged);
            const mergedHeadSha = merged.headSha;
            const mergedSnapshot = prClosure?.snapshot;
            await emitPrGate(
                issueContext,
                "succeeded",
                `PR #${merged.number} merged at head ${mergedHeadSha}.`,
                {
                    pullRequestNumber: merged.number,
                    observedHeadSha: mergedHeadSha,
                    gate: "merged",
                    ...(mergedSnapshot === undefined
                        ? {}
                        : { snapshot: mergedSnapshot }),
                },
            );
        };

        const restorePrCheckoutAfterFailure = async (
            issueContext: WorkflowIssueContext,
            checkoutRestored: boolean,
        ): Promise<void> => {
            if (checkoutRestored) return;
            await issueOperations
                .restoreBaseCheckout(
                    issueContext.issueRepositories[0]!.repositoryPath,
                    branch,
                )
                .catch(() => undefined);
        };

        const deliverPullRequest = async (
            issueContext: WorkflowIssueContext,
            server: OpenCodeRuntime,
        ): Promise<void> => {
            let checkoutRestored = false;
            try {
                const pullRequest =
                    await resolvePullRequestForGate(issueContext);
                if (
                    await reconcileMergedOrClosedGate(issueContext, pullRequest)
                ) {
                    await issueOperations.restoreBaseCheckout(
                        issueContext.issueRepositories[0]!.repositoryPath,
                        branch,
                    );
                    checkoutRestored = true;
                    return;
                }
                await emitPrGate(
                    issueContext,
                    "started",
                    `Registering delivery check gate for PR #${pullRequest.number} head ${pullRequest.headSha}...`,
                    {
                        pullRequestNumber: pullRequest.number,
                        observedHeadSha: pullRequest.headSha,
                        registration: true,
                    },
                );
                const postPrReview = await runPostPrReview(
                    issueContext,
                    pullRequest,
                    server,
                );
                const currentPullRequest =
                    postPrReview === undefined
                        ? pullRequest
                        : postPrReview.pullRequest;
                const reconciled = await gatePullRequest(
                    issueContext,
                    currentPullRequest,
                    postPrReview === undefined,
                );
                if (reconciled !== "reconciled") {
                    await mergeGatedPullRequest(
                        issueContext,
                        currentPullRequest,
                        postPrReview?.review,
                    );
                }
                const issueRepository = issueContext.issueRepositories[0]!;
                await issueOperations.restoreBaseCheckout(
                    issueRepository.repositoryPath,
                    branch,
                );
                checkoutRestored = true;
            } finally {
                await restorePrCheckoutAfterFailure(
                    issueContext,
                    checkoutRestored,
                );
            }
        };

        const closeCompletedIssue = async (
            issueContext: WorkflowIssueContext,
            outcome: Extract<
                IssueExecutionOutcome,
                { readonly kind: IssueExecutionOutcomeKind.Completed }
            >,
            server: OpenCodeRuntime,
        ): Promise<void> => {
            if (effectiveDryRun) return;
            if (usesPullRequests && outcome.completion === "pushed-commit") {
                await track(
                    progress,
                    "issue-closure",
                    `Gating pull request delivery for issue #${issueContext.issue.number}...`,
                    () => deliverPullRequest(issueContext, server),
                    "Pull request merged; GitHub will close the issue.",
                    {
                        issue: {
                            number: issueContext.issue.number,
                            title: issueContext.issue.title,
                        },
                        details: { completion: outcome.completion },
                    },
                );
                return;
            }
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
            server: OpenCodeRuntime,
        ): Promise<void> => {
            if (outcome.kind !== IssueExecutionOutcomeKind.Completed) return;
            checkout = await captureCheckout();
            await deliverIssueBranch(issueContext, outcome);
            activeIssue = {
                issueNumber: issueContext.issue.number,
                stage: "issue-closure",
            };
            await persistState(RunStateStatus.Active, activeIssue);
            await closeCompletedIssue(issueContext, outcome, server);
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
            const policy = outcome.policy ?? onNeedsAttention;
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
                    policy,
                    dryRun: effectiveDryRun,
                    current: issueContext.current,
                    budget: resumeState?.maxIssues ?? maxIssues,
                }),
            });
        };

        const emitHandledNeedsAttention = async (
            issueContext: Pick<
                WorkflowIssueContext,
                "issue" | "current" | "total"
            >,
            outcome: NeedsAttentionOutcome,
        ): Promise<void> => {
            const { issue, current, total } = issueContext;
            const summary = summarize(actualRunId, outcomes);
            const policy = outcome.policy ?? onNeedsAttention;
            await progress.emit({
                stage: "run",
                status: "needs-attention",
                issue: { number: issue.number, title: issue.title },
                current,
                total,
                message: summaryMessage(
                    `Run halted after issue #${issue.number} needs attention`,
                    summary.counts,
                ),
                details: {
                    runId: summary.runId,
                    workflow: workflowMode,
                    counts: summary.counts,
                    routes: routeSummary(summary.outcomes),
                    statePath,
                    issueNumber: issue.number,
                    issueTitle: issue.title,
                    queuePosition: current,
                    queueTotal: total,
                    ...needsAttentionProgressDetails({
                        outcome,
                        policy,
                        dryRun: effectiveDryRun,
                        current,
                        budget: resumeState?.maxIssues ?? maxIssues,
                    }),
                    handled: true,
                },
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

        const clearHaltedNeedsAttention = async (
            issueNumber: number,
        ): Promise<void> => {
            // Clear only the notification intent. Keep the open issue in the
            // persisted queue without marking it completed, so resume can
            // retry the issue after its needs-attention condition changes.
            activeIssue = {
                issueNumber,
                stage: "grounding",
            };
            await persistState(RunStateStatus.Active, activeIssue);
        };

        const handleFailedIssue = async (
            issueContext: WorkflowIssueContext,
            outcome: Extract<
                IssueExecutionOutcome,
                { readonly kind: IssueExecutionOutcomeKind.Failed }
            >,
        ): Promise<void> => {
            checkout = await captureCheckout();
            await persistState(RunStateStatus.Active, {
                issueNumber: issueContext.issue.number,
                stage: "issue-execution",
            });
            if (issueFailurePolicy === IssueFailurePolicy.Halt) {
                throw new RalphieError({
                    message: `Issue #${issueContext.issue.number} failed: ${outcome.message}`,
                });
            }
            await restoreCancellationCheckout?.();
            activeQueueIssues.delete(issueContext.issue.number);
            activeIssue = undefined;
            prClosure = undefined;
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
            const policy = outcome.policy ?? onNeedsAttention;
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
            if (policy !== NeedsAttentionPolicy.Halt) return;
            if (notificationEnabled) {
                await clearHaltedNeedsAttention(issueContext.issue.number);
            } else {
                await persistState(RunStateStatus.Active, {
                    issueNumber: issueContext.issue.number,
                    stage: "grounding",
                });
            }
            await emitHandledNeedsAttention(issueContext, outcome);
            throw new NeedsAttentionStop({
                issueNumber: issueContext.issue.number,
                summary: outcome.summary,
            });
        };

        const finishSuccessfulIssue = async (
            issueContext: WorkflowIssueContext,
        ): Promise<void> => {
            activeIssue = undefined;
            activeQueueIssues.delete(issueContext.issue.number);
            prClosure = undefined;
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
            server: OpenCodeRuntime,
        ): Promise<void> => {
            if (issueContext.resumedClosureOutcome === undefined) {
                recordIssueOutcome(issueContext.issue.number, outcome);
            }
            if (outcome.kind === IssueExecutionOutcomeKind.Failed) {
                await handleFailedIssue(issueContext, outcome);
                return;
            }
            if (outcome.kind === IssueExecutionOutcomeKind.NeedsAttention) {
                await handleNeedsAttentionIssue(issueContext, outcome);
                await finishSuccessfulIssue(issueContext);
                return;
            }
            await completeIssue(issueContext, outcome, server);
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
            if (onNeedsAttention === NeedsAttentionPolicy.Halt) {
                await clearHaltedNeedsAttention(issue.number);
                const current = queue.processedCount();
                await emitHandledNeedsAttention(
                    {
                        issue,
                        current,
                        total: queueTotalFor(current),
                    },
                    pending.outcome,
                );
                throw new NeedsAttentionStop({
                    issueNumber: issue.number,
                    summary: pending.outcome.summary,
                });
            }
            activeQueueIssues.delete(issue.number);
            activeIssue = undefined;
            restoreCancellationCheckout = undefined;
            checkout = await captureCheckout();
            await persistState(RunStateStatus.Active);
        };

        const processNextIssue = async (
            server: OpenCodeRuntime,
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
                prClosure = undefined;
                restoreCancellationCheckout = undefined;
                await persistState(RunStateStatus.Active);
                return true;
            }
            activeQueueIssues.set(issue.number, issue);
            const issueContext = await prepareIssue(issue);
            const outcome = await executeIssue(issueContext, server);
            await finalizeIssue(issueContext, outcome, server);
            return true;
        };

        const processQueue = async (server: OpenCodeRuntime): Promise<void> => {
            const worker = async (): Promise<void> => {
                while (queue.state() === IssueQueueState.Ready) {
                    if (!(await processNextIssue(server))) break;
                }
            };
            await worker();
        };

        await recoverPendingNotification();

        let server: OpenCodeRuntime | undefined;
        try {
            const startedServer = await track(
                progress,
                "opencode-runtime",
                "Starting OpenCode runtime...",
                async () => {
                    const started = await opencode.start();
                    server = started;
                    await validateRuntimeModelVariants(
                        started,
                        config,
                        prepared.path,
                    );
                    return started;
                },
                "OpenCode runtime ready.",
            );
            await processQueue(startedServer);
        } finally {
            await server?.close();
        }

        if (queue.state() === IssueQueueState.DependencyBlocked) {
            await handleDependencyBlockedQueue({
                queue,
                onNeedsAttention,
                recordIssueOutcome,
                emitNeedsAttentionEvent,
                emitHandledNeedsAttention,
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
            !isNeedsAttentionStop(finalError) &&
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