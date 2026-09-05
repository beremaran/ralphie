import type { AgentSelection } from "../agent/model.ts";
import {
    buildPipelineRepairPrompt,
    buildPipelineRepairReviewFixPrompt,
    buildPipelineRepairReviewPrompt,
} from "../agent/prompts.ts";
import {
    requestStructuredOutput,
    type StructuredOutputResult,
} from "../agent/structured-output.ts";
import {
    runAgentTask,
    type AgentSessionDiagnostics,
} from "../agent/task-session.ts";
import type {
    PipelineDiagnosticsBoundary,
    RepairDiagnostics,
} from "../github/pipeline-diagnostics-boundary.ts";
import type { PipelineSnapshot } from "../github/pipeline-snapshot.ts";
import type {
    GitIssueCheckpointService,
    IssueCheckpoint,
} from "../git/issue-checkpoint.ts";
import type { GitIssueOperationsService } from "../git/issue-operations.ts";
import type { GitRepositoryInvariantService } from "../git/repository-invariant.ts";
import type { IssueVerificationService } from "./verification.ts";
import { AgentSessionProfile, type AgentClient } from "../opencode/client.ts";
import {
    ReviewVerdict,
    reviewDecisionSchema,
    type ReviewDecision,
} from "./decisions.ts";
import { REVIEW_ITERATION_LIMIT } from "./stage.ts";
import type {
    ProgressIssue,
    ProgressReporterService,
} from "../progress/progress.ts";
import { RalphieError } from "../shared/error.ts";

/** The existing review budget is the default pipeline repair bound. */
export const PIPELINE_REPAIR_REVIEW_BUDGET = REVIEW_ITERATION_LIMIT;

const FULL_GIT_OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

export type PipelineRepairExecutorInput = {
    /** Selected GitHub repository slug, for example `owner/repository`. */
    readonly repository: string;
    /** Prepared clean checkout used for this one repair attempt. */
    readonly repositoryPath: string;
    /** Workspace identity used by the outer run and its recovery state. */
    readonly workspace: string;
    readonly branch: string;
    /** Exact remote branch HEAD whose failed pipeline was observed. */
    readonly failingHeadSha: string;
    /** Normalized, non-green observation for exactly `failingHeadSha`. */
    readonly snapshot: PipelineSnapshot;
    /** Bounded prompt-safe diagnostics for the same observation. */
    readonly diagnostics: PipelineDiagnosticsBoundary;
    readonly runId: string;
    readonly agent: AgentClient;
    readonly agentSelection: AgentSelection;
    readonly repositoryInvariant: GitRepositoryInvariantService;
    readonly agentDiagnostics?: AgentSessionDiagnostics;
    readonly signal?: AbortSignal;
    readonly progress?: ProgressReporterService;
    /** Optional issue-shaped progress identity for shared renderers. */
    readonly progressIssue?: ProgressIssue;
    /** Optional path to the persisted diagnostics artifact. */
    readonly diagnosticsPath?: string;
    /** Defaults to `PIPELINE_REPAIR_REVIEW_BUDGET`. */
    readonly reviewBudget?: number;
};

export type PipelineRepairReviewAttempt = {
    readonly attempt: number;
    readonly sessionID: string;
    readonly stagedDiff: string;
    readonly decision: ReviewDecision;
};

type PipelineRepairHistory = {
    readonly reviews: ReadonlyArray<PipelineRepairReviewAttempt>;
};

export type PipelineRepairOutcome = PipelineRepairHistory & {
    readonly failureFingerprint: string;
    /** The same bounded evidence supplied to every repair/review session. */
    readonly diagnostics: PipelineDiagnosticsBoundary;
    readonly diagnosticsPath?: string;
} & (
        | {
              readonly status: "approved";
              /** Exact staged patch that the delivery lifecycle may commit. */
              readonly stagedDiff: string;
              /** Available when the caller supplied a staged-tree reader. */
              readonly stagedTreeSha?: string;
          }
        | {
              readonly status: "no-change";
              readonly reason: "agent-no-change" | "review-fix-no-change";
              /** Patch captured before restoring the exact failing checkpoint. */
              readonly patch: string;
              readonly restored: true;
          }
        | {
              readonly status: "review-exhausted";
              /** Patch captured before restoring the exact failing checkpoint. */
              readonly patch: string;
              readonly restored: true;
              readonly reviewBudget: number;
          }
    );

export type PipelineRepairExecutorDependencies = {
    readonly issueOperations: Pick<
        GitIssueOperationsService,
        "stageAll" | "hasStagedChanges" | "readStagedBinaryDiff"
    >;
    readonly checkpoint: Pick<
        GitIssueCheckpointService,
        "createPatch" | "restore"
    >;
    /** Optional clean-checkpoint assertion for production and temp-checkout tests. */
    readonly captureCheckpoint?: GitIssueCheckpointService["capture"];
    /** Read the exact index tree for the outer deterministic delivery lifecycle. */
    readonly stagedTreeSha?: Pick<
        IssueVerificationService,
        "stagedTreeSha"
    >["stagedTreeSha"];
};

export type PipelineRepairExecutorService = {
    readonly execute: (
        input: PipelineRepairExecutorInput,
    ) => Promise<PipelineRepairOutcome>;
};

export class PipelineRepairExecutorError extends RalphieError {
    override readonly _tag = "PipelineRepairExecutorError" as const;
    readonly kind: "invalid-input" | "repository-invariant" | "cleanup-failed";

    constructor(input: {
        readonly kind:
            | "invalid-input"
            | "repository-invariant"
            | "cleanup-failed";
        readonly message: string;
        readonly cause?: unknown;
    }) {
        super(input);
        this.name = "PipelineRepairExecutorError";
        this.kind = input.kind;
    }
}

const messageOf = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

const sameSha = (left: string, right: string): boolean =>
    left.toLowerCase() === right.toLowerCase();

const nonBlank = (value: string): boolean => value.trim().length > 0;

const checkSignal = (signal: AbortSignal | undefined): void => {
    signal?.throwIfAborted();
};

const repairFailureFingerprint = (snapshot: PipelineSnapshot): string => {
    if (!nonBlank(snapshot.fingerprint)) {
        throw new PipelineRepairExecutorError({
            kind: "invalid-input",
            message: "A failing pipeline snapshot must include a fingerprint.",
        });
    }
    return snapshot.fingerprint;
};

const assertSnapshotMatchesInput = (
    input: PipelineRepairExecutorInput,
): void => {
    if (
        !nonBlank(input.repository) ||
        !nonBlank(input.repositoryPath) ||
        !nonBlank(input.workspace) ||
        !nonBlank(input.branch) ||
        !nonBlank(input.runId)
    ) {
        throw new PipelineRepairExecutorError({
            kind: "invalid-input",
            message:
                "Pipeline repair requires non-empty repository, checkout, workspace, branch, and run identifiers.",
        });
    }
    if (!FULL_GIT_OBJECT_ID.test(input.failingHeadSha)) {
        throw new PipelineRepairExecutorError({
            kind: "invalid-input",
            message: `Pipeline repair requires a full failing remote SHA: ${input.failingHeadSha}.`,
        });
    }
    const snapshot = input.snapshot;
    if (
        snapshot.repository !== input.repository ||
        snapshot.branch !== input.branch ||
        !sameSha(snapshot.commitSha, input.failingHeadSha)
    ) {
        throw new PipelineRepairExecutorError({
            kind: "invalid-input",
            message:
                "The normalized failing pipeline snapshot does not match the selected repository, branch, and exact failing SHA.",
        });
    }
    if (snapshot.greenCandidate || snapshot.reason === "success") {
        throw new PipelineRepairExecutorError({
            kind: "invalid-input",
            message:
                "Pipeline repair requires a non-green failing snapshot; green observations are never repaired.",
        });
    }
    const diagnosticRequest = input.diagnostics.structured.request;
    if (
        diagnosticRequest.repository !== input.repository ||
        diagnosticRequest.branch !== input.branch ||
        !sameSha(diagnosticRequest.commitSha, input.failingHeadSha)
    ) {
        throw new PipelineRepairExecutorError({
            kind: "invalid-input",
            message:
                "Bounded pipeline diagnostics do not match the selected repository, branch, and exact failing SHA.",
        });
    }
    repairFailureFingerprint(snapshot);
};

const assertInvariant = (
    actual: { readonly branch: string; readonly head: string },
    expected: { readonly branch: string; readonly head: string },
): void => {
    if (actual.branch !== expected.branch) {
        throw new PipelineRepairExecutorError({
            kind: "repository-invariant",
            message: `Pipeline repair repository invariant moved: checkout branch changed from ${expected.branch} to ${actual.branch}.`,
        });
    }
    if (!sameSha(actual.head, expected.head)) {
        throw new PipelineRepairExecutorError({
            kind: "repository-invariant",
            message: `Pipeline repair repository invariant moved: checkout HEAD changed from ${expected.head} to ${actual.head}.`,
        });
    }
};

const expectedCheckpointFor = (
    input: PipelineRepairExecutorInput,
): IssueCheckpoint => ({
    branch: input.branch,
    sha: input.failingHeadSha,
});

const invariantFor = (
    checkpoint: IssueCheckpoint,
): { readonly branch: string; readonly head: string } => ({
    branch: checkpoint.branch,
    head: checkpoint.sha,
});

const emit = async (
    input: PipelineRepairExecutorInput,
    update: Parameters<ProgressReporterService["emit"]>[0],
): Promise<void> => {
    if (input.progress === undefined) return;
    await input.progress.emit({
        ...update,
        ...(input.progressIssue === undefined
            ? {}
            : { issue: input.progressIssue }),
    });
};

const reviewDecision = (
    result: StructuredOutputResult<ReviewDecision>,
): ReviewDecision => result.output;

const readStagedDiff = async (
    dependencies: PipelineRepairExecutorDependencies,
    input: PipelineRepairExecutorInput,
): Promise<string> => {
    checkSignal(input.signal);
    const diff = await dependencies.issueOperations.readStagedBinaryDiff(
        input.repositoryPath,
    );
    checkSignal(input.signal);
    return diff;
};

const preserveAndRestore = async (
    dependencies: PipelineRepairExecutorDependencies,
    input: PipelineRepairExecutorInput,
    checkpoint: IssueCheckpoint,
): Promise<string> => {
    /*
     * A branch or HEAD movement is an external event. Never use restore to
     * erase it: first prove that the checkout is still the exact local
     * checkpoint. The patch is captured before reset/clean so review
     * exhaustion remains recoverable without an issue artifact.
     */
    const current = await input.repositoryInvariant.capture(
        input.repositoryPath,
    );
    assertInvariant(current, invariantFor(checkpoint));
    const patch = await dependencies.checkpoint.createPatch(
        input.repositoryPath,
    );
    await dependencies.checkpoint.restore(input.repositoryPath, checkpoint);
    const restored = await input.repositoryInvariant.capture(
        input.repositoryPath,
    );
    assertInvariant(restored, invariantFor(checkpoint));
    return patch;
};

const restoreAfterFailure = async (
    dependencies: PipelineRepairExecutorDependencies,
    input: PipelineRepairExecutorInput,
    checkpoint: IssueCheckpoint,
): Promise<void> => {
    try {
        await preserveAndRestore(dependencies, input, checkpoint);
    } catch (cleanupError) {
        throw new PipelineRepairExecutorError({
            kind: "cleanup-failed",
            message: `Pipeline repair failed and its exact-SHA cleanup could not be completed: ${messageOf(cleanupError)}`,
            cause: cleanupError,
        });
    }
};

const ensureUnchangedAfterReview = async (
    dependencies: PipelineRepairExecutorDependencies,
    input: PipelineRepairExecutorInput,
    expectedDiff: string,
): Promise<void> => {
    await input.repositoryInvariant.verify(
        input.repositoryPath,
        { branch: input.branch, head: input.failingHeadSha },
        input.signal,
    );
    const actualDiff = await readStagedDiff(dependencies, input);
    if (actualDiff !== expectedDiff) {
        throw new PipelineRepairExecutorError({
            kind: "repository-invariant",
            message:
                "The staged pipeline repair changed while a read-only review was running; refusing to accept the review.",
        });
    }
};

const reviewAttempt = async (
    dependencies: PipelineRepairExecutorDependencies,
    input: PipelineRepairExecutorInput,
    snapshot: PipelineSnapshot,
    failureFingerprint: string,
    stagedDiff: string,
    attempt: number,
    previousReviews: ReadonlyArray<PipelineRepairReviewAttempt>,
): Promise<PipelineRepairReviewAttempt> => {
    await emit(input, {
        stage: "review",
        status: "started",
        attempt,
        maxAttempts: input.reviewBudget ?? PIPELINE_REPAIR_REVIEW_BUDGET,
        message: `Reviewing staged pipeline repair (${attempt}/${input.reviewBudget ?? PIPELINE_REPAIR_REVIEW_BUDGET})...`,
    });
    try {
        const result = await requestStructuredOutput(input.agent, {
            directory: input.repositoryPath,
            title: `Review pipeline repair for ${input.repository} (attempt ${attempt})`,
            prompt: buildPipelineRepairReviewPrompt({
                repository: input.repository,
                repositoryPath: input.repositoryPath,
                targetBranch: input.branch,
                commitSha: input.failingHeadSha,
                snapshot,
                diagnostics: input.diagnostics,
                failureFingerprint,
                attempt,
                stagedDiff,
                previousReviews: previousReviews.map(
                    ({ decision }) => decision,
                ),
            }),
            schema: reviewDecisionSchema,
            profile: AgentSessionProfile.Review,
            agent: input.agentSelection.agent,
            model: input.agentSelection.model,
            variant: input.agentSelection.variant,
            runId: input.runId,
            diagnostics: input.agentDiagnostics,
            repositoryInvariant: {
                branch: input.branch,
                head: input.failingHeadSha,
            },
            verifyRepositoryInvariant: input.repositoryInvariant.verify,
            progress: input.progress,
            progressStage: "review",
            progressIssue: input.progressIssue,
            signal: input.signal,
        });
        checkSignal(input.signal);
        if (result.needsAttention !== undefined) {
            throw new RalphieError({
                message:
                    "Pipeline repair review requested attention; it cannot be treated as approval.",
            });
        }
        await ensureUnchangedAfterReview(dependencies, input, stagedDiff);
        const decision = reviewDecision(result);
        await emit(input, {
            stage: "review",
            status: "succeeded",
            attempt,
            maxAttempts: input.reviewBudget ?? PIPELINE_REPAIR_REVIEW_BUDGET,
            message: `Pipeline repair review ${attempt} returned ${decision.verdict}.`,
        });
        return {
            attempt,
            sessionID: result.sessionID,
            stagedDiff,
            decision,
        };
    } catch (error) {
        await emit(input, {
            stage: "review",
            status: "failed",
            attempt,
            maxAttempts: input.reviewBudget ?? PIPELINE_REPAIR_REVIEW_BUDGET,
            message: `Pipeline repair review ${attempt} failed: ${messageOf(error)}`,
        });
        throw error;
    }
};

const applyReviewFix = async (
    dependencies: PipelineRepairExecutorDependencies,
    input: PipelineRepairExecutorInput,
    snapshot: PipelineSnapshot,
    failureFingerprint: string,
    review: PipelineRepairReviewAttempt,
    attempt: number,
    previousReviews: ReadonlyArray<PipelineRepairReviewAttempt>,
): Promise<"changed" | "no-change"> => {
    await emit(input, {
        stage: "review-fix",
        status: "started",
        attempt,
        maxAttempts: input.reviewBudget ?? PIPELINE_REPAIR_REVIEW_BUDGET,
        message: `Addressing pipeline review findings (attempt ${attempt})...`,
    });
    try {
        const result = await runAgentTask(input.agent, {
            directory: input.repositoryPath,
            title: `Address pipeline repair review for ${input.repository} (attempt ${attempt})`,
            selection: input.agentSelection,
            prompt: buildPipelineRepairReviewFixPrompt({
                repository: input.repository,
                repositoryPath: input.repositoryPath,
                targetBranch: input.branch,
                commitSha: input.failingHeadSha,
                snapshot,
                diagnostics: input.diagnostics,
                failureFingerprint,
                attempt,
                stagedDiff: review.stagedDiff,
                review: review.decision,
                previousReviews: previousReviews.map(
                    ({ decision }) => decision,
                ),
            }),
            runId: input.runId,
            diagnostics: input.agentDiagnostics,
            repositoryInvariant: {
                branch: input.branch,
                head: input.failingHeadSha,
            },
            verifyRepositoryInvariant: input.repositoryInvariant.verify,
            progress: input.progress,
            progressStage: "review-fix",
            progressIssue: input.progressIssue,
            signal: input.signal,
        });
        checkSignal(input.signal);
        if (result.needsAttention !== undefined) {
            throw new RalphieError({
                message:
                    "Pipeline repair fix requested attention; no implicit approval is possible.",
            });
        }
        await input.repositoryInvariant.verify(
            input.repositoryPath,
            { branch: input.branch, head: input.failingHeadSha },
            input.signal,
        );
        await dependencies.issueOperations.stageAll(input.repositoryPath);
        checkSignal(input.signal);
        const changed = await dependencies.issueOperations.hasStagedChanges(
            input.repositoryPath,
        );
        await emit(input, {
            stage: "review-fix",
            status: "succeeded",
            attempt,
            maxAttempts: input.reviewBudget ?? PIPELINE_REPAIR_REVIEW_BUDGET,
            message: changed
                ? "Pipeline review-fix changes staged."
                : "Pipeline review-fix produced no staged changes.",
        });
        return changed ? "changed" : "no-change";
    } catch (error) {
        await emit(input, {
            stage: "review-fix",
            status: "failed",
            attempt,
            maxAttempts: input.reviewBudget ?? PIPELINE_REPAIR_REVIEW_BUDGET,
            message: `Pipeline review-fix failed: ${messageOf(error)}`,
        });
        throw error;
    }
};

const reviewBudgetFor = (input: PipelineRepairExecutorInput): number => {
    const budget = input.reviewBudget ?? PIPELINE_REPAIR_REVIEW_BUDGET;
    if (!Number.isSafeInteger(budget) || budget <= 0) {
        throw new PipelineRepairExecutorError({
            kind: "invalid-input",
            message:
                "Pipeline repair review budget must be a positive integer.",
        });
    }
    return budget;
};

type RepairContext = {
    readonly checkpoint: IssueCheckpoint;
    readonly failureFingerprint: string;
    readonly reviewBudget: number;
};

type StagingResult =
    | {
          readonly status: "no-change";
          readonly outcome: Extract<
              PipelineRepairOutcome,
              { status: "no-change" }
          >;
      }
    | { readonly status: "changed"; readonly stagedDiff: string };

const diagnosticsPathFor = (
    input: PipelineRepairExecutorInput,
): { readonly diagnosticsPath?: string } =>
    input.diagnosticsPath === undefined
        ? {}
        : { diagnosticsPath: input.diagnosticsPath };

const noChangeOutcome = async (
    dependencies: PipelineRepairExecutorDependencies,
    input: PipelineRepairExecutorInput,
    context: RepairContext,
    reviews: ReadonlyArray<PipelineRepairReviewAttempt>,
    reason: "agent-no-change" | "review-fix-no-change",
): Promise<Extract<PipelineRepairOutcome, { status: "no-change" }>> => ({
    status: "no-change",
    reason,
    failureFingerprint: context.failureFingerprint,
    diagnostics: input.diagnostics,
    ...diagnosticsPathFor(input),
    patch: await preserveAndRestore(dependencies, input, context.checkpoint),
    restored: true,
    reviews,
});

const initializeRepair = async (
    dependencies: PipelineRepairExecutorDependencies,
    input: PipelineRepairExecutorInput,
    checkpoint: IssueCheckpoint,
): Promise<void> => {
    if (dependencies.captureCheckpoint !== undefined) {
        const captured = await dependencies.captureCheckpoint(
            input.repositoryPath,
            input.branch,
        );
        if (
            captured.branch !== checkpoint.branch ||
            !sameSha(captured.sha, checkpoint.sha)
        ) {
            throw new PipelineRepairExecutorError({
                kind: "repository-invariant",
                message:
                    "The prepared pipeline checkout does not match the exact failing checkpoint.",
            });
        }
    }
    const before = await input.repositoryInvariant.capture(
        input.repositoryPath,
        input.signal,
    );
    assertInvariant(before, invariantFor(checkpoint));
    await input.repositoryInvariant.verify(
        input.repositoryPath,
        invariantFor(checkpoint),
        input.signal,
    );
};

const runRepairAgentAndStage = async (
    dependencies: PipelineRepairExecutorDependencies,
    input: PipelineRepairExecutorInput,
    context: RepairContext,
): Promise<StagingResult> => {
    await emit(input, {
        stage: "implementation",
        status: "started",
        message: "Repairing the failing pipeline...",
    });
    const result = await runAgentTask(input.agent, {
        directory: input.repositoryPath,
        title: `Repair pipeline for ${input.repository} at ${input.failingHeadSha}`,
        selection: input.agentSelection,
        prompt: buildPipelineRepairPrompt({
            repository: input.repository,
            repositoryPath: input.repositoryPath,
            targetBranch: input.branch,
            commitSha: input.failingHeadSha,
            snapshot: input.snapshot,
            diagnostics: input.diagnostics,
            failureFingerprint: context.failureFingerprint,
            attempt: 1,
        }),
        runId: input.runId,
        diagnostics: input.agentDiagnostics,
        repositoryInvariant: invariantFor(context.checkpoint),
        verifyRepositoryInvariant: input.repositoryInvariant.verify,
        progress: input.progress,
        progressStage: "implementation",
        progressIssue: input.progressIssue,
        signal: input.signal,
    });
    checkSignal(input.signal);
    if (result.needsAttention !== undefined) {
        throw new RalphieError({
            message:
                "Pipeline repair requested attention; no repair outcome can be inferred from that request.",
        });
    }
    await input.repositoryInvariant.verify(
        input.repositoryPath,
        invariantFor(context.checkpoint),
        input.signal,
    );
    await emit(input, {
        stage: "implementation",
        status: "succeeded",
        message: "Pipeline repair session finished.",
    });
    await emit(input, {
        stage: "change-staging",
        status: "started",
        message: "Staging pipeline repair changes...",
    });
    await dependencies.issueOperations.stageAll(input.repositoryPath);
    checkSignal(input.signal);
    await input.repositoryInvariant.verify(
        input.repositoryPath,
        invariantFor(context.checkpoint),
        input.signal,
    );
    const hasChanges = await dependencies.issueOperations.hasStagedChanges(
        input.repositoryPath,
    );
    await emit(input, {
        stage: "change-staging",
        status: "succeeded",
        message: hasChanges
            ? "Pipeline repair changes staged."
            : "Pipeline repair produced no changes.",
    });
    if (!hasChanges) {
        return {
            status: "no-change",
            outcome: await noChangeOutcome(
                dependencies,
                input,
                context,
                [],
                "agent-no-change",
            ),
        };
    }
    return {
        status: "changed",
        stagedDiff: await readStagedDiff(dependencies, input),
    };
};

const approvedOutcome = async (
    dependencies: PipelineRepairExecutorDependencies,
    input: PipelineRepairExecutorInput,
    context: RepairContext,
    stagedDiff: string,
    reviews: ReadonlyArray<PipelineRepairReviewAttempt>,
): Promise<Extract<PipelineRepairOutcome, { status: "approved" }>> => {
    const finalDiff = await readStagedDiff(dependencies, input);
    if (finalDiff !== stagedDiff) {
        throw new PipelineRepairExecutorError({
            kind: "repository-invariant",
            message:
                "The staged pipeline repair changed after approval; refusing to return approval.",
        });
    }
    const stagedTreeSha =
        dependencies.stagedTreeSha === undefined
            ? undefined
            : await dependencies.stagedTreeSha(
                  input.repositoryPath,
                  input.signal,
              );
    return {
        status: "approved",
        failureFingerprint: context.failureFingerprint,
        diagnostics: input.diagnostics,
        ...diagnosticsPathFor(input),
        stagedDiff,
        ...(stagedTreeSha === undefined ? {} : { stagedTreeSha }),
        reviews,
    };
};

const exhaustedOutcome = async (
    dependencies: PipelineRepairExecutorDependencies,
    input: PipelineRepairExecutorInput,
    context: RepairContext,
    reviews: ReadonlyArray<PipelineRepairReviewAttempt>,
): Promise<Extract<PipelineRepairOutcome, { status: "review-exhausted" }>> => {
    await emit(input, {
        stage: "review-exhaustion",
        status: "started",
        message: `Pipeline repair review exhausted after ${context.reviewBudget} attempts; preserving the patch and restoring the exact failing checkpoint.`,
        attempt: context.reviewBudget,
        maxAttempts: context.reviewBudget,
    });
    const patch = await preserveAndRestore(
        dependencies,
        input,
        context.checkpoint,
    );
    await emit(input, {
        stage: "review-exhaustion",
        status: "succeeded",
        message:
            "Pipeline repair patch preserved and exact failing checkpoint restored.",
        attempt: context.reviewBudget,
        maxAttempts: context.reviewBudget,
    });
    return {
        status: "review-exhausted",
        failureFingerprint: context.failureFingerprint,
        diagnostics: input.diagnostics,
        ...diagnosticsPathFor(input),
        patch,
        restored: true,
        reviewBudget: context.reviewBudget,
        reviews,
    };
};

const runReviewLoop = async (
    dependencies: PipelineRepairExecutorDependencies,
    input: PipelineRepairExecutorInput,
    context: RepairContext,
    initialDiff: string,
): Promise<PipelineRepairOutcome> => {
    let stagedDiff = initialDiff;
    const reviews: PipelineRepairReviewAttempt[] = [];
    for (let attempt = 1; attempt <= context.reviewBudget; attempt += 1) {
        checkSignal(input.signal);
        const review = await reviewAttempt(
            dependencies,
            input,
            input.snapshot,
            context.failureFingerprint,
            stagedDiff,
            attempt,
            reviews,
        );
        reviews.push(review);
        if (review.decision.verdict === ReviewVerdict.Approved) {
            return await approvedOutcome(
                dependencies,
                input,
                context,
                stagedDiff,
                reviews,
            );
        }
        if (attempt === context.reviewBudget) {
            return await exhaustedOutcome(
                dependencies,
                input,
                context,
                reviews,
            );
        }
        const fixResult = await applyReviewFix(
            dependencies,
            input,
            input.snapshot,
            context.failureFingerprint,
            review,
            attempt,
            reviews,
        );
        if (fixResult === "no-change") {
            return await noChangeOutcome(
                dependencies,
                input,
                context,
                reviews,
                "review-fix-no-change",
            );
        }
        stagedDiff = await readStagedDiff(dependencies, input);
    }
    throw new RalphieError({
        message: "Pipeline repair review loop ended unexpectedly.",
    });
};

const cleanupAfterFailure = async (
    dependencies: PipelineRepairExecutorDependencies,
    input: PipelineRepairExecutorInput,
    checkpoint: IssueCheckpoint,
): Promise<void> => {
    try {
        await restoreAfterFailure(dependencies, input, checkpoint);
    } catch (cleanupError) {
        if (cleanupError instanceof PipelineRepairExecutorError)
            throw cleanupError;
        throw new PipelineRepairExecutorError({
            kind: "cleanup-failed",
            message: `Pipeline repair cleanup failed: ${messageOf(cleanupError)}`,
            cause: cleanupError,
        });
    }
};

const failureAfterCleanup = async (
    dependencies: PipelineRepairExecutorDependencies,
    input: PipelineRepairExecutorInput,
    checkpoint: IssueCheckpoint,
    initialized: boolean,
    error: unknown,
): Promise<never> => {
    if (initialized) await cleanupAfterFailure(dependencies, input, checkpoint);
    if (input.signal?.aborted === true) {
        const reason = input.signal.reason;
        throw new RalphieError({
            message:
                reason instanceof Error
                    ? reason.message
                    : "Pipeline repair was cancelled.",
            cause: error,
        });
    }
    throw error;
};

/**
 * Assemble the pipeline-only diagnose/edit/review boundary.
 *
 * This service deliberately has no GitHub client and no commit/push methods in
 * its dependency surface. The Pipeline delivery lifecycle receives only an
 * approved staged patch (or a recoverable, restored outcome).
 */
export const makePipelineRepairExecutorService = (
    dependencies: PipelineRepairExecutorDependencies,
): PipelineRepairExecutorService => {
    const execute = async (
        input: PipelineRepairExecutorInput,
    ): Promise<PipelineRepairOutcome> => {
        checkSignal(input.signal);
        assertSnapshotMatchesInput(input);
        const reviewBudget = reviewBudgetFor(input);
        const failureFingerprint = repairFailureFingerprint(input.snapshot);
        const checkpoint = expectedCheckpointFor(input);
        let initialized = false;

        try {
            await initializeRepair(dependencies, input, checkpoint);
            initialized = true;
            const context: RepairContext = {
                checkpoint,
                failureFingerprint,
                reviewBudget,
            };
            const staged = await runRepairAgentAndStage(
                dependencies,
                input,
                context,
            );
            if (staged.status === "no-change") return staged.outcome;
            return await runReviewLoop(
                dependencies,
                input,
                context,
                staged.stagedDiff,
            );
        } catch (error) {
            return await failureAfterCleanup(
                dependencies,
                input,
                checkpoint,
                initialized,
                error,
            );
        }
    };

    return { execute };
};

export const makePipelineRepairExecutor = makePipelineRepairExecutorService;

/** Type-only helper for callers that need the bounded projection explicitly. */
export type PipelineRepairDiagnostics = RepairDiagnostics;