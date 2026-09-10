import type { Octokit } from "octokit";

import type { AgentSelection } from "../agent/model.ts";
import type { AgentSessionDiagnostics } from "../agent/task-session.ts";
import type { GitIssueOperationsService } from "../git/issue-operations.ts";
import type { GitHubIssue } from "../github/issues.ts";
import type {
    GitHubPullRequest,
    GitHubPullRequestService,
    PullRequestMergeProof,
    PullRequestSnapshot,
} from "../github/pull-requests.ts";
import type {
    PipelineObservationOutcome,
    PipelineObservationResult,
    PipelineObservationService,
    PipelineObservationTransition,
    PipelineSnapshot,
} from "../github/pipeline-observation.ts";
import type { AgentClient } from "../agent/contracts.ts";
import type {
    ProgressReporterService,
    ProgressStatus,
} from "../progress/progress.ts";
import type { PrClosureGateStatus, RunState } from "../run/state.ts";
import { RalphieError } from "../shared/error.ts";

import {
    IssueArtifactKind,
    type IssueArtifactStore,
    type IssueArtifactStoreService,
    type PullRequestDeliveryStateArtifact,
} from "./artifacts.ts";
import type {
    PullRequestReviewCoordinatorResult,
    PullRequestReviewCoordinatorService,
    PullRequestReviewDeliveryEvent,
    PullRequestReviewLifecycleEvent,
} from "./pull-request-review-coordinator.ts";
import type {
    PullRequestRevisionIntent,
    PullRequestReviewAttempt,
} from "./pull-request-review.ts";

export type PullRequestClosure = NonNullable<RunState["prClosure"]>;
export type PullRequestClosureReview = NonNullable<
    PullRequestClosure["review"]
>;
export type ApprovedClosureReview = NonNullable<
    PullRequestMergeProof["review"]
>;
type PostPrReviewFailureResult = Exclude<
    PullRequestReviewCoordinatorResult,
    Extract<PullRequestReviewCoordinatorResult, { status: "approved" }>
>;

type PersistedGateSnapshot = PullRequestClosure["snapshot"];

const preservedGateSnapshot = (
    previous: RunState["prClosure"],
    observedHeadSha: string,
    snapshot: PersistedGateSnapshot | undefined,
): PersistedGateSnapshot | undefined => {
    if (snapshot !== undefined) return snapshot;
    if (
        previous === undefined ||
        previous.observedHeadSha.toLowerCase() !== observedHeadSha.toLowerCase()
    ) {
        return undefined;
    }
    return previous.snapshot;
};

const optionalField = <Key extends string, Value>(
    key: Key,
    value: Value | undefined,
): Partial<Record<Key, Value>> =>
    value === undefined ? {} : ({ [key]: value } as Record<Key, Value>);

const sameSha = (left: string, right: string): boolean =>
    left.toLowerCase() === right.toLowerCase();

const nowIso = (): string => new Date().toISOString();

const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

/** Bounds and confirmation policy for the PR delivery check gate. */
export const PR_CLOSURE_OBSERVATION_OPTIONS = {
    registrationGraceMs: 30_000,
    deadlineMs: 30 * 60_000,
    initialBackoffMs: 5_000,
    maxBackoffMs: 60_000,
    backoffFactor: 2,
    rateLimitRetries: 3,
    maxRateLimitDelayMs: 30_000,
    stableTerminalConfirmations: 2,
} as const;

export type PullRequestClosureDependencies = {
    readonly pullRequests: GitHubPullRequestService;
    /** Absent only for small legacy fakes that exercise the check-gate path. */
    readonly reviewCoordinator?: PullRequestReviewCoordinatorService;
    readonly observation: Pick<PipelineObservationService, "observe">;
    readonly artifacts: IssueArtifactStoreService;
    readonly issueOperations: Pick<
        GitIssueOperationsService,
        "restoreBaseCheckout"
    >;
};

export type PullRequestClosureInput = {
    readonly client: Octokit;
    readonly repository: string;
    /** Base branch the PR targets. */
    readonly branch: string;
    /** Managed feature branch carrying the PR. */
    readonly featureBranch: string;
    readonly issue: GitHubIssue;
    readonly repositoryPath: string;
    readonly agent: AgentClient;
    readonly agentSelection: AgentSelection;
    /** Empty commands use the repository's discoverable `check` script. */
    readonly verificationCommands?: ReadonlyArray<string>;
    readonly runId?: string;
    readonly workspace: string;
    readonly diagnostics?: AgentSessionDiagnostics;
    readonly signal?: AbortSignal;
    /** Resumed durable closure state, if any. */
    readonly initialClosure?: RunState["prClosure"];
    readonly progress: ProgressReporterService;
    readonly current?: number;
    readonly total?: number;
    /** Persist the next durable closure; the service calls this atomically with every update. */
    readonly onClosure: (next: RunState["prClosure"]) => Promise<void>;
};

export type PullRequestClosureOutcome = {
    readonly pullRequest: GitHubPullRequest;
    readonly closure: RunState["prClosure"];
    readonly review?: ApprovedClosureReview;
};

export type PullRequestClosureService = {
    readonly close: (
        input: PullRequestClosureInput,
    ) => Promise<PullRequestClosureOutcome>;
};

const postPrReviewFailureDetailsFor = (
    result: PostPrReviewFailureResult,
    priorReview: PullRequestClosureReview | undefined,
): {
    readonly status: PullRequestClosureReview["status"];
    readonly stage: NonNullable<PullRequestClosureReview["stage"]>;
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
    })() satisfies PullRequestClosureReview["status"];
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
        ...optionalField("revisionIntent", revisionIntent),
    };
};

type ClosureContext = {
    readonly dependencies: PullRequestClosureDependencies;
    readonly input: PullRequestClosureInput;
    prClosure: RunState["prClosure"];
};

const prGateIssue = (
    input: PullRequestClosureInput,
): { readonly number: number; readonly title: string } => ({
    number: input.issue.number,
    title: input.issue.title,
});

const emitPrGate = async (
    context: ClosureContext,
    status: ProgressStatus,
    message: string,
    details?: Readonly<Record<string, unknown>>,
): Promise<void> => {
    await context.input.progress.emit({
        stage: "pr-gate",
        status,
        message,
        issue: prGateIssue(context.input),
        ...(context.input.current === undefined
            ? {}
            : { current: context.input.current }),
        ...(context.input.total === undefined
            ? {}
            : { total: context.input.total }),
        ...(details === undefined ? {} : { details }),
    });
};

const itemLabel = (key: string): string => {
    const [source, provider, name] = key.split("\u0000");
    return source === undefined || provider === undefined || name === undefined
        ? key
        : `${provider}/${name}`;
};

const itemLabels = (keys: ReadonlyArray<string>): string =>
    keys.map(itemLabel).join(", ");

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

const checkSummaryFor = (snapshot: PipelineSnapshot | undefined): string => {
    if (snapshot === undefined) return "no snapshot";
    if (snapshot.state === "empty") return `${snapshot.reason} (no checks)`;
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

const observationEvidence = (
    outcome: PipelineObservationResult["outcome"],
    status: PrClosureGateStatus,
): {
    readonly snapshot?: PullRequestClosure["snapshot"];
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

const setPrClosure = async (
    context: ClosureContext,
    update: {
        readonly pullRequestNumber: number;
        readonly baseSha?: string;
        readonly observedHeadSha: string;
        readonly gate: PrClosureGateStatus;
        readonly snapshot?: PullRequestClosure["snapshot"];
        readonly terminalReason?: string;
        /** `null` explicitly invalidates review evidence on a head move. */
        readonly review?: PullRequestClosure["review"] | null;
    },
): Promise<void> => {
    const { review: reviewUpdate, baseSha, ...closureUpdate } = update;
    const nextReview =
        reviewUpdate === null
            ? undefined
            : (reviewUpdate ?? context.prClosure?.review);
    const nextBaseSha = baseSha ?? context.prClosure?.baseSha;
    const nextSnapshot = preservedGateSnapshot(
        context.prClosure,
        update.observedHeadSha,
        update.snapshot,
    );
    context.prClosure = {
        startedAt: context.prClosure?.startedAt ?? nowIso(),
        ...closureUpdate,
        ...optionalField("baseSha", nextBaseSha),
        ...optionalField("snapshot", nextSnapshot),
        ...optionalField("review", nextReview),
        updatedAt: nowIso(),
    };
    await context.input.onClosure(context.prClosure);
};

const readPostPrReviewArtifacts = async (context: ClosureContext) => {
    const { dependencies, input } = context;
    const artifacts = await dependencies.artifacts.forIssue(
        input.issue.number,
        {
            workspace: input.workspace,
            runId: input.runId ?? "",
            repository: input.repository,
        },
        input.signal,
    );
    const attempts = artifacts.has(IssueArtifactKind.PullRequestReviewAttempts)
        ? await artifacts.read(IssueArtifactKind.PullRequestReviewAttempts)
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
        ? await artifacts.read(IssueArtifactKind.PullRequestDeliveryState)
        : undefined;
    return { artifacts, attempts, approved, deliveryState };
};

const recordPrLifecycleArtifact = async (
    context: ClosureContext,
    input: {
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
    },
): Promise<void> => {
    if (input.baseSha === undefined) return;
    const artifacts = await context.dependencies.artifacts.forIssue(
        context.input.issue.number,
        {
            workspace: context.input.workspace,
            runId: context.input.runId ?? "",
            repository: context.input.repository,
        },
        context.input.signal,
    );
    await artifacts.recordPullRequestDeliveryState({
        pullRequestNumber: input.pullRequestNumber,
        baseSha: input.baseSha,
        headSha: input.headSha,
        stage: input.stage,
        status: input.status,
        reviewAttempts: context.prClosure?.review?.attempts?.length ?? 0,
        revisionCount: context.prClosure?.review?.revisionCount ?? 0,
        ...optionalField("terminalReason", input.terminalReason),
        updatedAt: nowIso(),
    });
};

const recordMergedPrClosure = async (
    context: ClosureContext,
    pullRequest: GitHubPullRequest,
    terminalReason?: string,
): Promise<void> => {
    await setPrClosure(context, {
        pullRequestNumber: pullRequest.number,
        observedHeadSha: pullRequest.headSha,
        gate: "merged",
        ...(context.prClosure?.snapshot === undefined
            ? {}
            : { snapshot: context.prClosure.snapshot }),
        ...(terminalReason === undefined ? {} : { terminalReason }),
    });
    await recordPrLifecycleArtifact(context, {
        pullRequestNumber: pullRequest.number,
        baseSha: context.prClosure?.baseSha,
        headSha: pullRequest.headSha,
        stage: "merge",
        status: "merged",
        terminalReason,
    });
};

const recordClosedPrClosure = async (
    context: ClosureContext,
    pullRequest: GitHubPullRequest,
    terminalReason: string,
): Promise<void> => {
    await setPrClosure(context, {
        pullRequestNumber: pullRequest.number,
        observedHeadSha: pullRequest.headSha,
        gate: "closed",
        terminalReason,
    });
    await recordPrLifecycleArtifact(context, {
        pullRequestNumber: pullRequest.number,
        baseSha: context.prClosure?.baseSha,
        headSha: pullRequest.headSha,
        stage: "merge",
        status: "failed",
        terminalReason,
    });
};

const recordStalePrClosure = async (
    context: ClosureContext,
    pullRequest: GitHubPullRequest,
    terminalReason: string,
): Promise<void> => {
    await setPrClosure(context, {
        pullRequestNumber: pullRequest.number,
        observedHeadSha: pullRequest.headSha,
        gate: "stale",
        terminalReason,
        review:
            context.prClosure?.review === undefined
                ? null
                : {
                      status: "stale",
                      currentHeadSha: pullRequest.headSha,
                      revisionCount: context.prClosure.review.revisionCount,
                      terminalReason,
                  },
    });
    await recordPrLifecycleArtifact(context, {
        pullRequestNumber: pullRequest.number,
        baseSha: context.prClosure?.baseSha,
        headSha: pullRequest.headSha,
        stage: "merge",
        status: "stale",
        terminalReason,
    });
};

const emitPrGateObservationTerminal = async (
    context: ClosureContext,
    pullRequest: GitHubPullRequest,
    result: PipelineObservationResult,
): Promise<void> => {
    const outcome = result.outcome;
    const status = gateStatusForObservation(outcome);
    const snapshot = snapshotForObservation(outcome);
    await emitPrGate(
        context,
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
        ...optionalField("checkFingerprint", snapshot?.fingerprint),
        ...optionalField(
            "terminalReason",
            green ? undefined : terminalReasonForObservation(outcome),
        ),
    };
};

const recordPrCheckArtifact = async (
    context: ClosureContext,
    pullRequest: GitHubPullRequest,
    outcome: PipelineObservationResult["outcome"],
    status: PrClosureGateStatus,
): Promise<void> => {
    const baseSha = context.prClosure?.baseSha;
    if (baseSha === undefined) return;
    const artifacts = await context.dependencies.artifacts.forIssue(
        context.input.issue.number,
        {
            workspace: context.input.workspace,
            runId: context.input.runId ?? "",
            repository: context.input.repository,
        },
        context.input.signal,
    );
    const snapshot = snapshotForObservation(outcome);
    const checkFields = prCheckArtifactFieldsFor(status, snapshot, outcome);
    await artifacts.recordPullRequestDeliveryState({
        pullRequestNumber: pullRequest.number,
        baseSha,
        headSha: pullRequest.headSha,
        stage: "checks",
        status: checkFields.status,
        reviewAttempts: context.prClosure?.review?.attempts?.length ?? 0,
        revisionCount: context.prClosure?.review?.revisionCount ?? 0,
        checkHeadSha: pullRequest.headSha,
        checkStatus: checkFields.checkStatus,
        ...optionalField("checkFingerprint", checkFields.checkFingerprint),
        ...optionalField("terminalReason", checkFields.terminalReason),
        updatedAt: nowIso(),
    });
};

const observePullRequestGate = async (
    context: ClosureContext,
    pullRequest: GitHubPullRequest,
): Promise<PipelineObservationResult> => {
    const { dependencies, input } = context;
    return await dependencies.observation.observe({
        client: input.client,
        request: {
            repository: input.repository,
            branch: input.featureBranch,
            commitSha: pullRequest.headSha,
        },
        options: PR_CLOSURE_OBSERVATION_OPTIONS,
        signal: input.signal,
        onTransition: (transition) => {
            void emitPrGate(
                context,
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

const applyPrGateObservation = async (
    context: ClosureContext,
    pullRequest: GitHubPullRequest,
    result: PipelineObservationResult,
): Promise<void> => {
    const outcome = result.outcome;
    const status = gateStatusForObservation(outcome);
    await setPrClosure(context, {
        pullRequestNumber: pullRequest.number,
        observedHeadSha: pullRequest.headSha,
        gate: status,
        ...observationEvidence(outcome, status),
    });
    await recordPrCheckArtifact(context, pullRequest, outcome, status);
    await emitPrGateObservationTerminal(context, pullRequest, result);
    if (status === "green") return;
    if (status === "aborted" && context.input.signal?.aborted === true) {
        checkCancellation(context.input.signal);
    }
    throw new RalphieError({
        message: `PR gate did not pass for issue #${context.input.issue.number} on ${pullRequest.headSha}: ${terminalReasonForObservation(outcome)}.`,
    });
};

const resolvePullRequestForGate = async (
    context: ClosureContext,
): Promise<GitHubPullRequest> => {
    const { dependencies, input } = context;
    try {
        if (context.prClosure !== undefined) {
            return await dependencies.pullRequests.read(
                input.client,
                input.repository,
                context.prClosure.pullRequestNumber,
            );
        }
        return await dependencies.pullRequests.createOrFind(
            input.client,
            input.repository,
            {
                title: `Fix #${input.issue.number}: ${input.issue.title}`,
                issueNumber: input.issue.number,
                closesIssue: true,
                head: input.featureBranch,
                base: input.branch,
            },
        );
    } catch (cause) {
        if (context.prClosure !== undefined) {
            await setPrClosure(context, {
                pullRequestNumber: context.prClosure.pullRequestNumber,
                observedHeadSha: context.prClosure.observedHeadSha,
                gate: "unknown",
                terminalReason: `Pull request #${context.prClosure.pullRequestNumber} could not be re-read: ${errorMessage(cause)}.`,
            });
        }
        throw new RalphieError({
            message: `Failed to locate the pull request for issue #${input.issue.number}: ${errorMessage(cause)}.`,
            cause,
        });
    }
};

const publishStoredPreCommitReviews = async (
    context: ClosureContext,
    pullRequest: GitHubPullRequest,
): Promise<void> => {
    const { dependencies, input } = context;
    const artifacts = await dependencies.artifacts.forIssue(
        input.issue.number,
        {
            workspace: input.workspace,
            runId: input.runId ?? "",
            repository: input.repository,
        },
        input.signal,
    );
    const reviews = artifacts.has(IssueArtifactKind.ReviewAttempts)
        ? await artifacts.read(IssueArtifactKind.ReviewAttempts)
        : [];
    await dependencies.pullRequests.publishReviewAttempts(
        input.client,
        input.repository,
        pullRequest.number,
        reviews,
    );
};

const markPrReviewChecksStage = async (
    context: ClosureContext,
    pullRequest: GitHubPullRequest,
): Promise<void> => {
    if (context.prClosure?.review === undefined) return;
    await setPrClosure(context, {
        pullRequestNumber: pullRequest.number,
        observedHeadSha: pullRequest.headSha,
        gate: context.prClosure.gate,
        review: { ...context.prClosure.review, stage: "checks" },
    });
};

const preparePrGateObservation = async (
    context: ClosureContext,
    pullRequest: GitHubPullRequest,
    publishPreCommitReviews = true,
): Promise<boolean> => {
    const headChanged =
        context.prClosure === undefined ||
        !sameSha(context.prClosure.observedHeadSha, pullRequest.headSha);
    if (headChanged) {
        await setPrClosure(context, {
            pullRequestNumber: pullRequest.number,
            observedHeadSha: pullRequest.headSha,
            gate: "pending",
            review: null,
        });
    } else await markPrReviewChecksStage(context, pullRequest);
    if (publishPreCommitReviews)
        await publishStoredPreCommitReviews(context, pullRequest);
    return headChanged || (context.prClosure?.gate ?? "pending") !== "green";
};

const recordMergedGateEvent = async (
    context: ClosureContext,
    pullRequest: GitHubPullRequest,
    message: string,
    terminalReason?: string,
): Promise<void> => {
    await recordMergedPrClosure(context, pullRequest, terminalReason);
    await emitPrGate(context, "succeeded", message, {
        pullRequestNumber: pullRequest.number,
        observedHeadSha: pullRequest.headSha,
        gate: "merged",
    });
};

const recordClosedGateEvent = async (
    context: ClosureContext,
    pullRequest: GitHubPullRequest,
    message: string,
    terminalReason: string,
): Promise<void> => {
    await recordClosedPrClosure(context, pullRequest, terminalReason);
    await emitPrGate(context, "failed", message, {
        pullRequestNumber: pullRequest.number,
        observedHeadSha: pullRequest.headSha,
        gate: "closed",
        terminalReason,
    });
};

const gatePullRequest = async (
    context: ClosureContext,
    pullRequest: GitHubPullRequest,
    publishPreCommitReviews = true,
): Promise<"reconciled" | undefined> => {
    if (pullRequest.merged) {
        await recordMergedGateEvent(
            context,
            pullRequest,
            `PR #${pullRequest.number} (head ${pullRequest.headSha}) was already merged; reconciled without a new merge call.`,
            "Pull request was already merged; no merge call was made.",
        );
        return "reconciled";
    }
    if (pullRequest.state === "closed") {
        await recordClosedGateEvent(
            context,
            pullRequest,
            `PR #${pullRequest.number} (head ${pullRequest.headSha}) is closed without merging; issue #${context.input.issue.number} stays open.`,
            "Pull request is closed without merging.",
        );
        throw new RalphieError({
            message: `Pull request #${pullRequest.number} is closed without merging for issue #${context.input.issue.number}.`,
        });
    }
    const needsObservation = await preparePrGateObservation(
        context,
        pullRequest,
        publishPreCommitReviews,
    );
    if (!needsObservation) return undefined;
    const result = await observePullRequestGate(context, pullRequest);
    await applyPrGateObservation(context, pullRequest, result);
    return undefined;
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
    context: ClosureContext,
    result: PostPrReviewFailureResult,
    artifacts: IssueArtifactStore,
    attempts: ReadonlyArray<PullRequestReviewAttempt>,
    delivery?: PullRequestDeliveryStateArtifact["delivery"],
): Promise<never> => {
    const { status, stage, revisionIntent } = postPrReviewFailureDetailsFor(
        result,
        context.prClosure?.review,
    );
    await setPrClosure(context, {
        pullRequestNumber: result.snapshot.number,
        baseSha: result.snapshot.baseSha,
        observedHeadSha: result.snapshot.headSha,
        gate: "pending",
        review: {
            status,
            stage,
            attempts: [...attempts],
            ...optionalField("revisionIntent", revisionIntent),
            currentHeadSha: result.snapshot.headSha,
            revisionCount: context.prClosure?.review?.revisionCount ?? 0,
            terminalReason: postPrReviewEventMessage(
                context.input.issue.number,
                result,
            ),
        },
        terminalReason: postPrReviewEventMessage(
            context.input.issue.number,
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
        revisionCount: context.prClosure?.review?.revisionCount ?? 0,
        ...optionalField("revisionIntent", revisionIntent),
        ...optionalField("delivery", delivery),
        terminalReason: postPrReviewEventMessage(
            context.input.issue.number,
            result,
        ),
        updatedAt: nowIso(),
    });
    await emitPrGate(
        context,
        "failed",
        postPrReviewEventMessage(context.input.issue.number, result),
        {
            pullRequestNumber: result.snapshot.number,
            observedHeadSha: result.snapshot.headSha,
            gate: status,
            reviewStatus: status,
            attempts: attempts.length,
        },
    );
    throw new RalphieError({
        message: `Post-PR review did not pass for issue #${context.input.issue.number}: ${postPrReviewEventMessage(context.input.issue.number, result)}`,
    });
};

const postPrArtifactStatusFor = (
    status: PullRequestClosureReview["status"],
): "pending" | "approved" | "failed" | "stale" | "delivery-recoverable" =>
    status === "pr-review-exhausted"
        ? "failed"
        : status === "needs-attention"
          ? "failed"
          : status;

const persistPostPrReviewStage = async (
    context: ClosureContext,
    input: {
        readonly snapshot: PullRequestSnapshot;
        readonly artifacts?: IssueArtifactStore;
        readonly status: PullRequestClosureReview["status"];
        readonly gate?: PrClosureGateStatus;
        readonly attempts: Awaited<
            ReturnType<typeof readPostPrReviewArtifacts>
        >["attempts"];
        readonly stage?: PullRequestClosureReview["stage"];
        readonly approved?: ApprovedClosureReview;
        readonly revisionIntent?: PullRequestRevisionIntent;
        readonly delivery?: PullRequestDeliveryStateArtifact["delivery"];
        readonly revisionCount: number;
        readonly terminalReason?: string;
    },
): Promise<void> => {
    await setPrClosure(context, {
        pullRequestNumber: input.snapshot.number,
        baseSha: input.snapshot.baseSha,
        observedHeadSha: input.snapshot.headSha,
        gate: input.gate ?? "pending",
        review: {
            status: input.status,
            ...optionalField("stage", input.stage),
            attempts: [...input.attempts],
            ...optionalField("approved", input.approved),
            ...optionalField("revisionIntent", input.revisionIntent),
            currentHeadSha: input.snapshot.headSha,
            revisionCount: input.revisionCount,
            ...optionalField("terminalReason", input.terminalReason),
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
        ...optionalField("revisionIntent", input.revisionIntent),
        ...optionalField("delivery", input.delivery),
        ...optionalField("terminalReason", input.terminalReason),
        updatedAt: nowIso(),
    });
};

const persistCoordinatorStage = async (
    context: ClosureContext,
    event: PullRequestReviewLifecycleEvent,
): Promise<void> => {
    const { artifacts, attempts } = await readPostPrReviewArtifacts(context);
    await persistPostPrReviewStage(context, {
        snapshot: event.snapshot,
        status: "pending",
        stage: event.stage,
        artifacts,
        attempts,
        revisionIntent: event.revisionIntent,
        revisionCount: context.prClosure?.review?.revisionCount ?? 0,
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
    context: ClosureContext,
    event: PullRequestReviewDeliveryEvent,
): Promise<void> => {
    const { artifacts, attempts } = await readPostPrReviewArtifacts(context);
    const confirmed = event.delivery.status === "confirmed";
    await persistPostPrReviewStage(context, {
        snapshot: confirmed
            ? { ...event.snapshot, headSha: event.delivery.headSha }
            : event.snapshot,
        status: "pending",
        stage: "revision-delivery",
        gate: "pending",
        artifacts,
        attempts,
        ...optionalField(
            "revisionIntent",
            confirmed ? undefined : event.revisionIntent,
        ),
        delivery: deliveryArtifactFor(event.delivery),
        revisionCount: (context.prClosure?.review?.revisionCount ?? 0) + 1,
    });
};

const failIfPostPrReviewAlreadyExhausted = async (
    context: ClosureContext,
    priorReview: PullRequestClosureReview | undefined,
    snapshot: PullRequestSnapshot,
): Promise<void> => {
    if (
        priorReview?.status !== "pr-review-exhausted" ||
        priorReview.currentHeadSha === undefined ||
        !sameSha(priorReview.currentHeadSha, snapshot.headSha)
    ) {
        return;
    }
    const { artifacts, attempts } = await readPostPrReviewArtifacts(context);
    await throwPostPrReviewFailure(
        context,
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
    context: ClosureContext,
    pullRequest: GitHubPullRequest,
    result: Extract<
        PullRequestReviewCoordinatorResult,
        { readonly status: "approved" }
    >,
    priorReview: PullRequestClosureReview | undefined,
    finalArtifacts: Awaited<ReturnType<typeof readPostPrReviewArtifacts>>,
): Promise<{
    readonly pullRequest: GitHubPullRequest;
    readonly review: ApprovedClosureReview;
}> => {
    const { dependencies, input } = context;
    const resultApproval = result.review.attempt as ApprovedClosureReview;
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
        context.prClosure?.gate === "green" &&
        sameSha(context.prClosure.observedHeadSha, result.snapshot.headSha)
            ? "green"
            : "pending";
    await persistPostPrReviewStage(context, {
        snapshot: result.snapshot,
        status: "pending",
        gate: savedGreenGate,
        stage: "publication",
        artifacts: finalArtifacts.artifacts,
        attempts,
        approved: approval,
        revisionCount,
    });
    await dependencies.pullRequests.publishPullRequestReviewAttempts(
        input.client,
        input.repository,
        attempts,
    );
    await persistPostPrReviewStage(context, {
        snapshot: result.snapshot,
        status: "approved",
        gate: savedGreenGate,
        artifacts: finalArtifacts.artifacts,
        attempts,
        approved: approval,
        revisionCount,
    });
    await emitPrGate(
        context,
        "info",
        postPrReviewEventMessage(input.issue.number, result),
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
    context: ClosureContext,
    snapshot: PullRequestSnapshot,
    priorReview: PullRequestClosureReview | undefined,
    initialArtifacts: Awaited<ReturnType<typeof readPostPrReviewArtifacts>>,
): Promise<PullRequestRevisionIntent | undefined> => {
    const resumeRevision =
        priorReview?.revisionIntent ??
        initialArtifacts.deliveryState?.revisionIntent;
    const savedGreenGate =
        priorReview?.status === "approved" &&
        context.prClosure?.gate === "green" &&
        sameSha(context.prClosure.observedHeadSha, snapshot.headSha)
            ? "green"
            : "pending";
    await persistPostPrReviewStage(context, {
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
    context: ClosureContext,
    pullRequest: GitHubPullRequest,
): Promise<
    | {
          readonly pullRequest: GitHubPullRequest;
          readonly review: ApprovedClosureReview;
      }
    | undefined
> => {
    const { dependencies, input } = context;
    const review = dependencies.reviewCoordinator?.review;
    if (typeof review !== "function") return undefined;

    const currentSnapshot = await dependencies.pullRequests.readSnapshot(
        input.client,
        input.repository,
        pullRequest.number,
    );
    const priorReview = context.prClosure?.review;
    await failIfPostPrReviewAlreadyExhausted(
        context,
        priorReview,
        currentSnapshot,
    );

    const initialArtifacts = await readPostPrReviewArtifacts(context);
    const resumeRevision = await persistPostPrReviewStart(
        context,
        currentSnapshot,
        priorReview,
        initialArtifacts,
    );

    const result = await review({
        client: input.client,
        repository: input.repository,
        repositoryPath: input.repositoryPath,
        branch: input.featureBranch,
        targetBranch: input.branch,
        issue: input.issue,
        snapshot: currentSnapshot,
        agent: input.agent,
        agentSelection: input.agentSelection,
        artifacts: initialArtifacts.artifacts,
        verificationCommands: input.verificationCommands,
        runId: input.runId,
        diagnostics: input.diagnostics,
        signal: input.signal,
        resumeRevision,
        onStage: (event) => persistCoordinatorStage(context, event),
        onRevisionDelivery: (event) =>
            persistCoordinatorDelivery(context, event),
    });
    const finalArtifacts = await readPostPrReviewArtifacts(context);
    if (result.status !== "approved") {
        await throwPostPrReviewFailure(
            context,
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
        context,
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
    context: ClosureContext,
    gate: PrClosureGateStatus,
    reconciled: GitHubPullRequest,
    cause: unknown,
): Pick<NonNullable<RunState["prClosure"]>, "review"> =>
    gate === "stale" && context.prClosure?.review !== undefined
        ? {
              review: {
                  status: "stale",
                  currentHeadSha: reconciled.headSha,
                  revisionCount: context.prClosure.review.revisionCount,
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
    context: ClosureContext,
    current: GitHubPullRequest,
    observedHeadSha: string,
    cause: unknown,
): Promise<GitHubPullRequest> => {
    const { dependencies, input } = context;
    const reconciled = await dependencies.pullRequests.read(
        input.client,
        input.repository,
        current.number,
    );
    if (reconciled.merged) {
        await recordMergedGateEvent(
            context,
            reconciled,
            `Merge response was lost but PR #${reconciled.number} is merged at head ${reconciled.headSha}; reconciled without a new merge call.`,
            `Merge response was lost but pull request #${reconciled.number} is merged.`,
        );
        return reconciled;
    }
    const gate = mergeFailureGate(reconciled, observedHeadSha, cause);
    await setPrClosure(context, {
        pullRequestNumber: reconciled.number,
        observedHeadSha:
            gate === "stale" ? reconciled.headSha : observedHeadSha,
        gate,
        terminalReason: `Merge rejected: ${errorMessage(cause)}.`,
        ...staleReviewUpdateForMergeFailure(context, gate, reconciled, cause),
    });
    await recordPrLifecycleArtifact(context, {
        pullRequestNumber: reconciled.number,
        baseSha: context.prClosure?.baseSha,
        headSha: gate === "stale" ? reconciled.headSha : observedHeadSha,
        stage: "merge",
        status: mergeArtifactStatusFor(gate),
        terminalReason: `Merge rejected: ${errorMessage(cause)}.`,
    });
    await emitPrGate(
        context,
        "failed",
        `Merge rejected for PR #${current.number} (issue #${input.issue.number} stays open): ${errorMessage(cause)}; gate ${gate}.`,
        {
            pullRequestNumber: reconciled.number,
            observedHeadSha:
                gate === "stale" ? reconciled.headSha : observedHeadSha,
            gate,
        },
    );
    throw new RalphieError({
        message: `Failed to merge pull request #${current.number} for issue #${input.issue.number}: ${errorMessage(cause)}.`,
        cause,
    });
};

/** Expected-head merge with authoritative merged-state reconciliation. */
const attemptPrMerge = async (
    context: ClosureContext,
    current: GitHubPullRequest,
    observedHeadSha: string,
    approvedReview?: ApprovedClosureReview,
): Promise<GitHubPullRequest> => {
    const { dependencies, input } = context;
    try {
        if (approvedReview !== undefined) {
            const mergeWithProof = dependencies.pullRequests.mergeWithProof;
            const observedChecks = context.prClosure?.snapshot;
            if (
                typeof mergeWithProof !== "function" ||
                context.prClosure?.gate !== "green" ||
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
            return await mergeWithProof(input.client, input.repository, proof);
        }
        return await dependencies.pullRequests.merge(
            input.client,
            input.repository,
            current.number,
            observedHeadSha,
        );
    } catch (cause) {
        return await resolveMergeFailure(
            context,
            current,
            observedHeadSha,
            cause,
        );
    }
};

/** Record and halt on an expected-head mismatch at the final gate. */
const recordStaleGateEvent = async (
    context: ClosureContext,
    current: GitHubPullRequest,
    observedHeadSha: string,
): Promise<never> => {
    await recordStalePrClosure(
        context,
        current,
        `Pull request head changed from ${observedHeadSha} to ${current.headSha} after a green observation; the saved decision was discarded.`,
    );
    await emitPrGate(
        context,
        "failed",
        `Expected-head mismatch for PR #${current.number} (issue #${context.input.issue.number}): observed ${observedHeadSha} but the current head is ${current.headSha}; the saved green decision was invalidated.`,
        {
            pullRequestNumber: current.number,
            observedHeadSha,
            expectedHeadSha: observedHeadSha,
            actualHeadSha: current.headSha,
            gate: "stale",
        },
    );
    throw new RalphieError({
        message: `Pull request #${current.number} head changed from ${observedHeadSha} to ${current.headSha} for issue #${context.input.issue.number}; not merging.`,
    });
};

/**
 * Reconcile an already-merged or closed-without-merge PR read before
 * merging; returns whether the gate is settled and needs no merge.
 */
const reconcileMergedOrClosedGate = async (
    context: ClosureContext,
    current: GitHubPullRequest,
): Promise<boolean> => {
    if (current.merged) {
        await recordMergedGateEvent(
            context,
            current,
            `PR #${current.number} (head ${current.headSha}) was already merged; reconciled without a new merge call.`,
            "Pull request was already merged; no merge call was made.",
        );
        return true;
    }
    if (current.state === "closed") {
        await recordClosedGateEvent(
            context,
            current,
            `PR #${current.number} (head ${current.headSha}) closed without merging before the gate could merge it; issue #${context.input.issue.number} stays open.`,
            "Pull request closed without merging before the gate could merge it.",
        );
        throw new RalphieError({
            message: `Pull request #${current.number} closed without merging for issue #${context.input.issue.number}.`,
        });
    }
    return false;
};

const persistMergeStage = async (
    context: ClosureContext,
    pullRequest: GitHubPullRequest,
    observedHeadSha: string,
    approvedReview: ApprovedClosureReview,
): Promise<void> => {
    const { artifacts, attempts } = await readPostPrReviewArtifacts(context);
    await persistPostPrReviewStage(context, {
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
        revisionCount: context.prClosure?.review?.revisionCount ?? 0,
    });
};

const ensureMergeHeadIsCurrent = async (
    context: ClosureContext,
    current: GitHubPullRequest,
    observedHeadSha: string,
): Promise<void> => {
    if (sameSha(current.headSha, observedHeadSha)) return;
    await recordStaleGateEvent(context, current, observedHeadSha);
};

/**
 * Re-read the PR immediately before merging. A moved head invalidates
 * the saved green decision; a merged or closed PR is reconciled.
 */
const mergeGatedPullRequest = async (
    context: ClosureContext,
    pullRequest: GitHubPullRequest,
    approvedReview?: ApprovedClosureReview,
): Promise<void> => {
    const { dependencies, input } = context;
    const current = await dependencies.pullRequests.read(
        input.client,
        input.repository,
        pullRequest.number,
    );
    if (await reconcileMergedOrClosedGate(context, current)) {
        return;
    }
    const observedHeadSha =
        context.prClosure?.observedHeadSha ?? pullRequest.headSha;
    await ensureMergeHeadIsCurrent(context, current, observedHeadSha);
    if (approvedReview !== undefined) {
        await persistMergeStage(
            context,
            current,
            observedHeadSha,
            approvedReview,
        );
    }
    const merged = await attemptPrMerge(
        context,
        current,
        observedHeadSha,
        approvedReview,
    );
    await recordMergedPrClosure(context, merged);
    const mergedHeadSha = merged.headSha;
    const mergedSnapshot = context.prClosure?.snapshot;
    await emitPrGate(
        context,
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
    context: ClosureContext,
    checkoutRestored: boolean,
): Promise<void> => {
    if (checkoutRestored) return;
    await context.dependencies.issueOperations
        .restoreBaseCheckout(context.input.repositoryPath, context.input.branch)
        .catch(() => undefined);
};

/**
 * Coordinate durable post-PR closure behind a focused seam. The review
 * coordinator remains the sole owner of review and revision decisions;
 * this service owns closure projection, terminal reasons, merge-proof
 * outcomes, artifact status, and checkout restoration.
 */
export const makePullRequestClosureService = (
    dependencies: PullRequestClosureDependencies,
): PullRequestClosureService => {
    const close = async (
        input: PullRequestClosureInput,
    ): Promise<PullRequestClosureOutcome> => {
        const context: ClosureContext = {
            dependencies,
            input,
            prClosure: input.initialClosure,
        };
        let checkoutRestored = false;
        try {
            const pullRequest = await resolvePullRequestForGate(context);
            if (await reconcileMergedOrClosedGate(context, pullRequest)) {
                await dependencies.issueOperations.restoreBaseCheckout(
                    input.repositoryPath,
                    input.branch,
                );
                checkoutRestored = true;
                return {
                    pullRequest,
                    closure: context.prClosure,
                };
            }
            await emitPrGate(
                context,
                "started",
                `Registering delivery check gate for PR #${pullRequest.number} head ${pullRequest.headSha}...`,
                {
                    pullRequestNumber: pullRequest.number,
                    observedHeadSha: pullRequest.headSha,
                    registration: true,
                },
            );
            const postPrReview = await runPostPrReview(context, pullRequest);
            const currentPullRequest =
                postPrReview === undefined
                    ? pullRequest
                    : postPrReview.pullRequest;
            const reconciled = await gatePullRequest(
                context,
                currentPullRequest,
                postPrReview === undefined,
            );
            if (reconciled !== "reconciled") {
                await mergeGatedPullRequest(
                    context,
                    currentPullRequest,
                    postPrReview?.review,
                );
            }
            await dependencies.issueOperations.restoreBaseCheckout(
                input.repositoryPath,
                input.branch,
            );
            checkoutRestored = true;
            return {
                pullRequest: currentPullRequest,
                closure: context.prClosure,
                ...(postPrReview?.review === undefined
                    ? {}
                    : { review: postPrReview.review }),
            };
        } finally {
            await restorePrCheckoutAfterFailure(context, checkoutRestored);
        }
    };

    return { close };
};