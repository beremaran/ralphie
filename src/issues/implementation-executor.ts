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
import { assertProtectedDecisionsAuthorized } from "./scope-policy.ts";
import type {
    IssueVerificationService,
    VerificationEvidence,
} from "./verification.ts";
import {
    makeResolutionVerificationService,
    type ResolutionVerificationService,
} from "./resolution-verification.ts";

/** The implementation workflow for issues with complexity 0 through 3. */
export type ImplementationExecutorService = {
    readonly execute: (
        input: WorkflowExecutorInput,
    ) => Promise<WorkflowExecutorResult>;
};

export type ReviewFixOutcome = {
    readonly status: "verified";
    readonly verification: VerificationEvidence;
    readonly unresolvedFindings: ReadonlyArray<string>;
};

const sameBlockingFindings = (
    previous: ReviewAttempt | undefined,
    current: ReviewAttempt,
): boolean =>
    previous?.decision.verdict === ReviewVerdict.ChangesRequested &&
    JSON.stringify(previous.decision.findings) ===
        JSON.stringify(current.decision.findings);

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
    verification: IssueVerificationService = {
        stagedTreeSha: async () => "0".repeat(40),
        verify: async () => ({
            stagedTreeSha: "0".repeat(40),
            commands: [
                { command: "test", exitCode: 0, stdout: "", stderr: "" },
            ],
        }),
    },
    resolutionVerification: ResolutionVerificationService = makeResolutionVerificationService(
        progress,
    ),
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
    ): Promise<WorkflowExecutorResult> => {
        const { context, artifacts } = input;
        const resolution = await resolutionVerification.verify(context);
        await artifacts.write(
            IssueArtifactKind.IssueResolutionDecision,
            resolution.decision,
        );
        const outcome = resolutionOutcome(resolution.decision);
        return outcome.kind === IssueExecutionOutcomeKind.Failed
            ? {
                  ...outcome,
                  message: `Issue remains unresolved after a no-change implementation: ${outcome.message}`,
              }
            : outcome;
    };

    const verifyStagedChanges = async (
        input: WorkflowExecutorInput,
    ): Promise<VerificationEvidence> => {
        const diff = await operations.readStagedBinaryDiff(
            input.context.repositoryPath,
        );
        assertProtectedDecisionsAuthorized(input.context.issue, diff);
        return stage(
            progress,
            input,
            "verification",
            "Running deterministic verification...",
            () =>
                verification.verify(
                    input.context.repositoryPath,
                    input.context.verificationCommands ?? [],
                ),
            "Deterministic verification passed.",
        );
    };

    const runReviewAttempt = async (
        input: WorkflowExecutorInput,
        invariant: { readonly branch: string; readonly head: string },
        attempt: number,
        previousReviews: ReadonlyArray<ReviewAttempt>,
    ): Promise<ReviewAttempt> => {
        const { context } = input;
        const verificationEvidence = await verifyStagedChanges(input);
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
                        verification: verificationEvidence,
                        previousReviews: previousReviews.map(
                            ({ decision }) => decision,
                        ),
                    }),
                    schema: reviewDecisionSchema,
                    agent: context.piSelection.agent,
                    model: context.piSelection.model,
                    variant:
                        context.piStageVariants?.review ??
                        context.piSelection.variant,
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
            stagedTreeSha: verificationEvidence.stagedTreeSha,
            verification: verificationEvidence,
            decision: reviewResult.output,
        };
    };

    const commitApprovedReview = async (
        input: WorkflowExecutorInput,
        invariant: { readonly branch: string; readonly head: string },
        checkpoint: Awaited<ReturnType<typeof readCheckpoint>>,
        approvedReview: ReviewAttempt,
    ): Promise<WorkflowExecutorResult> => {
        const { context, artifacts } = input;
        const verificationEvidence = await verifyStagedChanges(input);
        if (
            approvedReview.stagedTreeSha === undefined ||
            verificationEvidence.stagedTreeSha.toLowerCase() !==
                approvedReview.stagedTreeSha.toLowerCase()
        ) {
            throw new RalphieError({
                message:
                    "The staged tree changed after approval; refusing to commit without a matching review.",
            });
        }
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
                        verification: verificationEvidence,
                    }),
                    schema: commitMessageDecisionSchema,
                    agent: context.piSelection.agent,
                    model: context.piSelection.model,
                    variant:
                        context.piStageVariants?.commitMessage ??
                        context.piSelection.variant,
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
            reviewCount: approvedReview.attempt,
        } as const;
    };

    const applyReviewFix = async (
        input: WorkflowExecutorInput,
        invariant: { readonly branch: string; readonly head: string },
        review: ReviewAttempt,
        attempt: number,
    ): Promise<WorkflowExecutorResult | ReviewFixOutcome> => {
        const { context } = input;
        const verificationEvidence = await verifyStagedChanges(input);
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
                        verification: verificationEvidence,
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
            "Review-fix agent finished; deterministic verification pending.",
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
            const verificationEvidence = await verifyStagedChanges(input);
            return {
                status: "verified",
                verification: verificationEvidence,
                unresolvedFindings: [],
            };
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

    const exhaustReviews = async (
        input: WorkflowExecutorInput,
        checkpoint: Awaited<ReturnType<typeof readCheckpoint>>,
        reviews: ReadonlyArray<ReviewAttempt>,
    ): Promise<WorkflowExecutorResult> => {
        const { context } = input;
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
        };
    };

    const handleReviewDecision = async (
        input: WorkflowExecutorInput,
        checkpoint: Awaited<ReturnType<typeof readCheckpoint>>,
        invariant: { readonly branch: string; readonly head: string },
        review: ReviewAttempt,
        reviews: ReadonlyArray<ReviewAttempt>,
        attempt: number,
        isRepeated: boolean,
    ): Promise<WorkflowExecutorResult | undefined> => {
        if (review.decision.verdict === ReviewVerdict.Approved) {
            return await commitApprovedReview(
                input,
                invariant,
                checkpoint,
                review,
            );
        }
        if (isRepeated) {
            return {
                kind: IssueExecutionOutcomeKind.Failed,
                message:
                    "Review repeated the same blocking findings after a verified fix; stopping instead of looping.",
            };
        }
        if (attempt === REVIEW_ITERATION_LIMIT) {
            return await exhaustReviews(input, checkpoint, reviews);
        }
        const fixOutcome = await applyReviewFix(
            input,
            invariant,
            review,
            attempt,
        );
        return "kind" in fixOutcome ? fixOutcome : undefined;
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
            const review = await runReviewAttempt(
                input,
                invariant,
                attempt,
                reviews,
            );
            const isRepeated = sameBlockingFindings(reviews.at(-1), review);
            reviews.push(review);
            await artifacts.appendReview(review);
            const outcome = await handleReviewDecision(
                input,
                checkpoint,
                invariant,
                review,
                reviews,
                attempt,
                isRepeated,
            );
            if (outcome !== undefined) return outcome;
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
            return await verifyNoChangeResolution(input);
        }
        await verifyStagedChanges(input);
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