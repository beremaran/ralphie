import {
    type GitIssueOperationError,
    type GitIssueOperationsService,
} from "../git/issue-operations.ts";
import type { GitIssuePreparationService } from "../git/issue-preparation.ts";
import {
    type GitPushMode,
    type GitRemoteSafetyService,
} from "../git/remote-safety.ts";
import {
    buildCommitMessagePrompt,
    buildImplementationPrompt,
    buildResolutionVerificationPrompt,
    buildReviewFixPrompt,
    buildReviewPrompt,
} from "../agent/prompts.ts";
import { requestStructuredOutput } from "../agent/structured-output.ts";
import { runPiTask } from "../agent/task-session.ts";
import {
    type ProgressStage,
    type ProgressStatus,
    type ProgressReporterService,
} from "../progress/progress.ts";
import { RalphieError } from "../shared/error.ts";
import type {
    WorkflowExecutorInput,
    WorkflowExecutorResult,
} from "./workflow-executor-input.ts";
import { IssueArtifactKind } from "./artifacts.ts";
import {
    commitMessageDecisionSchema,
    issueResolutionDecisionSchema,
    type IssueResolutionDecision,
    IssueResolutionStatus,
    reviewDecisionSchema,
    ReviewVerdict,
} from "./decisions.ts";
import {
    type IssueCompletionKind,
    IssueExecutionOutcomeKind,
} from "./execution.ts";
import { type IssueRecoveryService, type ReviewAttempt } from "./recovery.ts";
import { REVIEW_ITERATION_LIMIT } from "./stage.ts";

/** The implementation workflow for issues with complexity 0 through 3. */
export type ImplementationExecutorService = {
    readonly execute: (
        input: WorkflowExecutorInput,
    ) => Promise<WorkflowExecutorResult>;
};

const asRalphieError = (error: unknown): RalphieError => {
    if (error instanceof RalphieError) return error;
    return new RalphieError({
        message: error instanceof Error ? error.message : String(error),
        cause: error,
    });
};

const issueProgress = (input: WorkflowExecutorInput) => ({
    issue: {
        number: input.context.issue.number,
        title: input.context.issue.title,
    },
});

const checkSignal = (signal: AbortSignal | undefined): void => {
    try {
        signal?.throwIfAborted();
    } catch (cause) {
        throw new RalphieError({
            message: "Issue execution was aborted.",
            cause,
        });
    }
};

const stage = async <A>(
    progress: ProgressReporterService,
    input: WorkflowExecutorInput,
    progressStage: ProgressStage,
    startedMessage: string,
    operation: () => Promise<A>,
    succeededMessage: string | ((value: A) => string),
    details?: Readonly<Record<string, unknown>>,
    attempt?: number,
): Promise<A> => {
    const base = {
        ...issueProgress(input),
        stage: progressStage,
        ...(attempt === undefined
            ? {}
            : { attempt, maxAttempts: REVIEW_ITERATION_LIMIT }),
        ...(details === undefined ? {} : { details }),
    };
    await progress.emit({
        ...base,
        status: "started",
        message: startedMessage,
    });
    try {
        const value = await operation();
        await progress.emit({
            ...base,
            status: "succeeded",
            message:
                typeof succeededMessage === "function"
                    ? succeededMessage(value)
                    : succeededMessage,
        });
        return value;
    } catch (error) {
        await progress.emit({
            ...base,
            status: "failed",
            message: `${startedMessage.replace(/\.{3}$/, "")} failed: ${
                error instanceof Error ? error.message : String(error)
            }`,
        });
        throw error;
    }
};

const readCheckpoint = async (
    preparation: GitIssuePreparationService,
    input: WorkflowExecutorInput,
) =>
    preparation.prepare({
        issueNumber: input.context.issue.number,
        repositoryPath: input.context.repositoryPath,
        branch: input.context.targetBranch,
    });

export const makeImplementationExecutorService = (
    preparation: GitIssuePreparationService,
    operations: GitIssueOperationsService,
    remoteSafety: GitRemoteSafetyService,
    recovery: IssueRecoveryService,
    progress: ProgressReporterService,
): ImplementationExecutorService => {
    const resolutionOutcome = (
        resolution: IssueResolutionDecision,
    ): WorkflowExecutorResult =>
        resolution.status === IssueResolutionStatus.Resolved
            ? {
                  kind: IssueExecutionOutcomeKind.Completed,
                  completion: "already-resolved",
                  resolutionSummary: resolution.summary,
                  evidence: resolution.evidence,
              }
            : {
                  kind: IssueExecutionOutcomeKind.Failed,
                  message: resolution.summary,
              };

    const recoverCommittedAttempt = async (
        input: WorkflowExecutorInput,
    ): Promise<WorkflowExecutorResult | undefined> => {
        const { context, artifacts } = input;
        if (
            !artifacts.has(IssueArtifactKind.IssueCheckpoint) ||
            !artifacts.has(IssueArtifactKind.CreatedCommit)
        ) {
            return undefined;
        }

        const storedCheckpoint = await artifacts.read(
            IssueArtifactKind.IssueCheckpoint,
        );
        const createdCommit = await artifacts.read(
            IssueArtifactKind.CreatedCommit,
        );
        const actual = await context.repositoryInvariant.capture(
            context.repositoryPath,
        );
        if (actual.head.toLowerCase() === createdCommit.sha.toLowerCase()) {
            await remoteSafety.verifyDirectPush({
                repository: context.repository,
                repositoryPath: context.repositoryPath,
                branch: context.targetBranch,
                intendedBaseSha: storedCheckpoint.sha,
                expectedCommitSha: createdCommit.sha,
                pushMode: "non-force",
            });
            await operations.push(
                context.repositoryPath,
                context.targetBranch,
                createdCommit.sha,
            );
            const savedReviews = artifacts.has(IssueArtifactKind.ReviewAttempts)
                ? await artifacts.read(IssueArtifactKind.ReviewAttempts)
                : [];
            return {
                kind: IssueExecutionOutcomeKind.Completed,
                completion: "pushed-commit",
                commitSha: createdCommit.sha,
                reviewCount: savedReviews.length,
            } as const;
        }
        if (actual.head.toLowerCase() !== storedCheckpoint.sha.toLowerCase()) {
            throw new RalphieError({
                message: `Cannot recover issue #${context.issue.number}: checkout HEAD ${actual.head} matches neither checkpoint ${storedCheckpoint.sha} nor created commit ${createdCommit.sha}.`,
            });
        }
        return undefined;
    };

    const prepareAttempt = async (input: WorkflowExecutorInput) => {
        const { context, artifacts } = input;
        const checkpoint = await readCheckpoint(preparation, input);
        if (
            artifacts.has(IssueArtifactKind.ReviewAttempts) ||
            artifacts.has(IssueArtifactKind.CommitMessageDecision)
        ) {
            await artifacts.resetImplementationAttempt();
        }
        const invariant = {
            branch: checkpoint.branch,
            head: checkpoint.sha,
        };
        await context.repositoryInvariant.verify(
            context.repositoryPath,
            invariant,
        );
        await stage(
            progress,
            input,
            "remote-safety",
            "Checking repository push safety...",
            () =>
                remoteSafety.verifyDirectPush({
                    repository: context.repository,
                    repositoryPath: context.repositoryPath,
                    branch: context.targetBranch,
                    intendedBaseSha: checkpoint.sha,
                    pushMode: "non-force",
                }),
            "Repository push safety checks passed.",
        );
        return { checkpoint, invariant };
    };

    const runImplementation = async (
        input: WorkflowExecutorInput,
        invariant: { readonly branch: string; readonly head: string },
    ): Promise<void> => {
        const { context } = input;
        await stage(
            progress,
            input,
            "implementation",
            `Implementing #${context.issue.number}...`,
            () =>
                runPiTask(context.pi, {
                    directory: context.repositoryPath,
                    title: `Implement issue #${context.issue.number}`,
                    selection: context.piSelection,
                    prompt: buildImplementationPrompt({
                        issue: context.issue,
                        repositoryPath: context.repositoryPath,
                        targetBranch: context.targetBranch,
                    }),
                    runId: context.runId,
                    diagnostics: context.piDiagnostics,
                    repositoryInvariant: invariant,
                    verifyRepositoryInvariant:
                        context.repositoryInvariant.verify,
                    progress,
                    progressStage: "implementation",
                    progressIssue: issueProgress(input).issue,
                    signal: context.signal,
                }),
            "Implementation completed.",
        );
    };

    const verifyNoChangeResolution = async (
        input: WorkflowExecutorInput,
        invariant: { readonly branch: string; readonly head: string },
    ): Promise<WorkflowExecutorResult> => {
        const { context, artifacts } = input;
        const resolution = await stage(
            progress,
            input,
            "resolution-verification",
            "Verifying whether the issue is already resolved...",
            () =>
                requestStructuredOutput(context.pi, {
                    directory: context.repositoryPath,
                    title: `Verify resolution of issue #${context.issue.number}`,
                    prompt: buildResolutionVerificationPrompt({
                        issue: context.issue,
                        repositoryPath: context.repositoryPath,
                        targetBranch: context.targetBranch,
                    }),
                    schema: issueResolutionDecisionSchema,
                    agent: context.piSelection.agent,
                    model: context.piSelection.model,
                    variant: context.piSelection.variant,
                    runId: context.runId,
                    diagnostics: context.piDiagnostics,
                    repositoryInvariant: invariant,
                    verifyRepositoryInvariant:
                        context.repositoryInvariant.verify,
                    progress,
                    progressStage: "resolution-verification",
                    progressIssue: issueProgress(input).issue,
                    signal: context.signal,
                }),
            ({ output }) =>
                output.status === IssueResolutionStatus.Resolved
                    ? "Issue is already resolved in the current checkout."
                    : "Issue remains unresolved in the current checkout.",
        );
        await artifacts.write(
            IssueArtifactKind.IssueResolutionDecision,
            resolution.output,
        );
        const outcome = resolutionOutcome(resolution.output);
        return outcome.kind === IssueExecutionOutcomeKind.Failed
            ? {
                  ...outcome,
                  message: `Issue remains unresolved after a no-change implementation: ${outcome.message}`,
              }
            : outcome;
    };

    const runReviewAttempt = async (
        input: WorkflowExecutorInput,
        invariant: { readonly branch: string; readonly head: string },
        attempt: number,
    ): Promise<ReviewAttempt> => {
        const { context } = input;
        const stagedDiff = await operations.readStagedBinaryDiff(
            context.repositoryPath,
        );
        const reviewResult = await stage(
            progress,
            input,
            "review",
            `Reviewing staged changes (attempt ${attempt}/${REVIEW_ITERATION_LIMIT})...`,
            () =>
                requestStructuredOutput(context.pi, {
                    directory: context.repositoryPath,
                    title: `Review issue #${context.issue.number} (attempt ${attempt})`,
                    prompt: buildReviewPrompt({
                        issue: context.issue,
                        repositoryPath: context.repositoryPath,
                        targetBranch: context.targetBranch,
                        stagedDiff,
                    }),
                    schema: reviewDecisionSchema,
                    agent: context.piSelection.agent,
                    model: context.piSelection.model,
                    variant: context.piSelection.variant,
                    runId: context.runId,
                    diagnostics: context.piDiagnostics,
                    repositoryInvariant: invariant,
                    verifyRepositoryInvariant:
                        context.repositoryInvariant.verify,
                    progress,
                    progressStage: "review",
                    progressIssue: issueProgress(input).issue,
                    signal: context.signal,
                }),
            ({ output }) =>
                `Review ${attempt}/${REVIEW_ITERATION_LIMIT}: ${output.verdict}.`,
            undefined,
            attempt,
        );
        return {
            attempt,
            sessionID: reviewResult.sessionID,
            decision: reviewResult.output,
        };
    };

    const commitApprovedReview = async (
        input: WorkflowExecutorInput,
        invariant: { readonly branch: string; readonly head: string },
        checkpoint: Awaited<ReturnType<typeof readCheckpoint>>,
        reviewCount: number,
    ): Promise<WorkflowExecutorResult> => {
        const { context, artifacts } = input;
        const finalDiff = await operations.readStagedBinaryDiff(
            context.repositoryPath,
        );
        const commitMessage = await stage(
            progress,
            input,
            "commit-message",
            "Generating a commit message...",
            () =>
                requestStructuredOutput(context.pi, {
                    directory: context.repositoryPath,
                    title: `Generate commit message for issue #${context.issue.number}`,
                    prompt: buildCommitMessagePrompt({
                        issue: context.issue,
                        repositoryPath: context.repositoryPath,
                        targetBranch: context.targetBranch,
                        stagedDiff: finalDiff,
                    }),
                    schema: commitMessageDecisionSchema,
                    agent: context.piSelection.agent,
                    model: context.piSelection.model,
                    variant: context.piSelection.variant,
                    runId: context.runId,
                    diagnostics: context.piDiagnostics,
                    repositoryInvariant: invariant,
                    verifyRepositoryInvariant:
                        context.repositoryInvariant.verify,
                    progress,
                    progressStage: "commit-message",
                    progressIssue: issueProgress(input).issue,
                    signal: context.signal,
                }),
            "Commit message generated.",
        );
        await artifacts.write(
            IssueArtifactKind.CommitMessageDecision,
            commitMessage.output,
        );
        const commit = await stage(
            progress,
            input,
            "commit",
            "Committing implementation changes...",
            () =>
                operations.commit(context.repositoryPath, commitMessage.output),
            "Implementation changes committed.",
        );
        await artifacts.write(IssueArtifactKind.CreatedCommit, commit);
        checkSignal(context.signal);
        await progress.emit({
            ...issueProgress(input),
            stage: "commit",
            status: "info",
            message: "Created the issue commit.",
            details: { commitSha: commit.sha },
        });
        await stage(
            progress,
            input,
            "push",
            `Pushing ${context.targetBranch}...`,
            async () => {
                await remoteSafety.verifyDirectPush({
                    repository: context.repository,
                    repositoryPath: context.repositoryPath,
                    branch: context.targetBranch,
                    intendedBaseSha: checkpoint.sha,
                    expectedCommitSha: commit.sha,
                    pushMode: "non-force",
                });
                await operations.push(
                    context.repositoryPath,
                    context.targetBranch,
                    commit.sha,
                );
            },
            `Pushed ${context.targetBranch}.`,
            { commitSha: commit.sha },
        );
        return {
            kind: IssueExecutionOutcomeKind.Completed,
            completion: "pushed-commit",
            commitSha: commit.sha,
            reviewCount,
        } as const;
    };

    const applyReviewFix = async (
        input: WorkflowExecutorInput,
        invariant: { readonly branch: string; readonly head: string },
        review: ReviewAttempt,
        attempt: number,
    ): Promise<WorkflowExecutorResult | undefined> => {
        const { context } = input;
        const currentDiff = await operations.readStagedBinaryDiff(
            context.repositoryPath,
        );
        await stage(
            progress,
            input,
            "review-fix",
            `Addressing review findings (attempt ${attempt})...`,
            () =>
                runPiTask(context.pi, {
                    directory: context.repositoryPath,
                    title: `Address review for issue #${context.issue.number} (attempt ${attempt})`,
                    selection: context.piSelection,
                    prompt: buildReviewFixPrompt({
                        issue: context.issue,
                        repositoryPath: context.repositoryPath,
                        targetBranch: context.targetBranch,
                        stagedDiff: currentDiff,
                        review: review.decision,
                    }),
                    runId: context.runId,
                    diagnostics: context.piDiagnostics,
                    repositoryInvariant: invariant,
                    verifyRepositoryInvariant:
                        context.repositoryInvariant.verify,
                    progress,
                    progressStage: "review-fix",
                    progressIssue: issueProgress(input).issue,
                    signal: context.signal,
                }),
            "Review findings addressed.",
            undefined,
            attempt,
        );
        checkSignal(context.signal);
        await stage(
            progress,
            input,
            "change-staging",
            `Restaging review-fix changes (attempt ${attempt})...`,
            () => operations.stageAll(context.repositoryPath),
            "Review-fix changes staged.",
            undefined,
            attempt,
        );
        if (await operations.hasStagedChanges(context.repositoryPath)) {
            return undefined;
        }
        await progress.emit({
            ...issueProgress(input),
            stage: "review-fix",
            status: "failed",
            attempt,
            maxAttempts: REVIEW_ITERATION_LIMIT,
            message: `Review fix attempt ${attempt} produced no changes.`,
        });
        return {
            kind: IssueExecutionOutcomeKind.Failed,
            message: `Review fix attempt ${attempt} produced no changes.`,
        } as const;
    };

    const runReviewLoop = async (
        input: WorkflowExecutorInput,
        checkpoint: Awaited<ReturnType<typeof readCheckpoint>>,
        invariant: { readonly branch: string; readonly head: string },
    ): Promise<WorkflowExecutorResult> => {
        const { context, artifacts } = input;
        const reviews: ReviewAttempt[] = [];
        for (let attempt = 1; attempt <= REVIEW_ITERATION_LIMIT; attempt += 1) {
            checkSignal(context.signal);
            const review = await runReviewAttempt(input, invariant, attempt);
            reviews.push(review);
            await artifacts.appendReview(review);

            if (review.decision.verdict === ReviewVerdict.Approved) {
                return await commitApprovedReview(
                    input,
                    invariant,
                    checkpoint,
                    reviews.length,
                );
            }
            if (attempt === REVIEW_ITERATION_LIMIT) {
                const exhausted = await recovery.handleReviewExhaustion({
                    runId: context.runId,
                    repository: context.repository,
                    workspace: context.workspace,
                    repositoryPath: context.repositoryPath,
                    issue: context.issue,
                    checkpoint,
                    reviews,
                });
                return {
                    kind: IssueExecutionOutcomeKind.Escalated,
                    diagnosticsPath: exhausted.diagnosticsPath,
                    reason: "Review did not converge within the review iteration budget.",
                } as const;
            }
            const fixOutcome = await applyReviewFix(
                input,
                invariant,
                review,
                attempt,
            );
            if (fixOutcome !== undefined) return fixOutcome;
        }
        throw new RalphieError({
            message: "Implementation review loop ended unexpectedly.",
        });
    };

    const executeImplementation = async (
        input: WorkflowExecutorInput,
    ): Promise<WorkflowExecutorResult> => {
        const { context, artifacts } = input;
        checkSignal(context.signal);
        if (artifacts.has(IssueArtifactKind.IssueResolutionDecision)) {
            const resolution = await artifacts.read(
                IssueArtifactKind.IssueResolutionDecision,
            );
            return resolutionOutcome(resolution);
        }

        const recovered = await recoverCommittedAttempt(input);
        if (recovered !== undefined) return recovered;

        const { checkpoint, invariant } = await prepareAttempt(input);
        await runImplementation(input, invariant);
        checkSignal(context.signal);
        await stage(
            progress,
            input,
            "change-staging",
            "Staging all implementation changes...",
            () => operations.stageAll(context.repositoryPath),
            "Implementation changes staged.",
        );
        if (!(await operations.hasStagedChanges(context.repositoryPath))) {
            return await verifyNoChangeResolution(input, invariant);
        }
        return await runReviewLoop(input, checkpoint, invariant);
    };

    return {
        execute: async (input) => {
            try {
                return await executeImplementation(input);
            } catch (error) {
                throw asRalphieError(
                    error as GitIssueOperationError | RalphieError,
                );
            }
        },
    };
};

export const ImplementationExecutorLive = makeImplementationExecutorService;