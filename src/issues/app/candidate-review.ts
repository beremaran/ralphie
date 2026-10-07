import type {
    GitIssueOperationsService,
    GitRemoteSafetyService,
    IssueCheckpoint,
} from "../../git/ports.ts";
import {
    buildReviewFixPrompt,
    buildReviewResumePrompt,
    buildSpecReviewPrompt,
    buildStandardsReviewPrompt,
    buildVerificationFixPrompt,
    buildVerificationResumePrompt,
    PROMPT_DIFF_LIMIT,
} from "../../agent/prompts.ts";
import { type FixSession, runFix } from "./fix-session.ts";
import { requestStructuredOutput } from "../../agent/structured-output.ts";
import type { HandOffRequest } from "../../agent/task-session.ts";
import { z } from "zod";
import {
    skillInvocation,
    skillLocation,
} from "../../harness/app/skill-injection.ts";
import type {
    ProgressStage,
    ProgressReporterService,
} from "../../progress/ports.ts";
import { RalphieError } from "../../shared/error.ts";
import {
    IssueExecutionOutcomeKind,
    type WorkflowExecutorInput,
    type WorkflowExecutorResult,
} from "./execution-model.ts";
import { IssueArtifactKind } from "./artifacts.ts";
import {
    type CommitMessageDecision,
    ReviewVerdict,
} from "../domain/decisions.ts";
import {
    combineReviews,
    specReviewSchema,
    standardsReviewSchema,
} from "../domain/review-gate.ts";
import type { IssueRecoveryService, ReviewAttempt } from "./recovery.ts";
import { assertProtectedDecisionsAuthorized } from "../domain/scope-policy.ts";
import {
    type IssueVerificationService,
    type VerificationEvidence,
    VerificationCommandError,
} from "./verification.ts";
import type { ReviewEvidenceFiles } from "./review-evidence.ts";
import {
    checkSignal,
    issueProgress,
    reviewBudget,
    stage,
    verificationFixBudget,
} from "./implementation-stage.ts";

type VerificationResult =
    | { readonly status: "passed"; readonly verification: VerificationEvidence }
    | WorkflowExecutorResult;

type VerificationAttempt =
    | { readonly status: "passed"; readonly verification: VerificationEvidence }
    | {
          readonly status: "repairable";
          readonly error: VerificationCommandError;
      };

/**
 * The mutable view of the review loop's checkout: where HEAD is (the
 * checkpoint, or the newest local candidate commit), the invariant sessions
 * must leave intact, and the candidate subjects so far.
 */
type ReviewState = {
    head: string;
    invariant: { readonly branch: string; readonly head: string };
    readonly candidateSubjects: string[];
    /** The implementer's session, which fixes continue. */
    readonly fix: FixSession;
};

const sameBlockingFindings = (
    previous: ReviewAttempt | undefined,
    current: ReviewAttempt,
): boolean =>
    previous?.decision.verdict === ReviewVerdict.ChangesRequested &&
    JSON.stringify(previous.decision.findings) ===
        JSON.stringify(current.decision.findings);

export type ReviewFixOutcome = {
    readonly status: "staged";
    readonly unresolvedFindings: ReadonlyArray<string>;
};

export type CandidateReviewDependencies = {
    readonly operations: GitIssueOperationsService;
    readonly remoteSafety: GitRemoteSafetyService;
    readonly recovery: IssueRecoveryService;
    readonly progress: ProgressReporterService;
    readonly verification: IssueVerificationService;
    readonly reviewEvidence?: ReviewEvidenceFiles | undefined;
    /** Route a session's hand-off request; undefined when there is none. */
    readonly routeSignal: (
        input: WorkflowExecutorInput,
        request: HandOffRequest | undefined,
        checkpoint: IssueCheckpoint,
    ) => Promise<WorkflowExecutorResult | undefined>;
};

export type CandidateReviewService = {
    /**
     * Verify, commit a local candidate, review it on both axes and fix until
     * approval; then deliver one commit, escalate, or fail.
     */
    readonly run: (
        input: WorkflowExecutorInput,
        checkpoint: IssueCheckpoint,
        invariant: { readonly branch: string; readonly head: string },
        fix: FixSession,
    ) => Promise<WorkflowExecutorResult>;
};

/** The two-axis review gate over local candidate commits. */
export const makeCandidateReview = ({
    operations,
    remoteSafety,
    recovery,
    progress,
    verification,
    reviewEvidence,
    routeSignal,
}: CandidateReviewDependencies): CandidateReviewService => {
    const verifyStagedChanges = async (
        input: WorkflowExecutorInput,
    ): Promise<VerificationEvidence> => {
        const diff = await operations.readStagedBinaryDiff(
            input.context.repositoryPath,
        );
        assertProtectedDecisionsAuthorized(input.context.issue, diff);
        const commands = input.context.verificationCommands ?? [];
        return stage(
            progress,
            input,
            "verification",
            commands.length === 0
                ? "Skipping deterministic verification (no verify commands configured)..."
                : "Running deterministic verification...",
            () => verification.verify(input.context.repositoryPath, commands),
            commands.length === 0
                ? "Deterministic verification skipped."
                : "Deterministic verification passed.",
        );
    };

    const reportFreshFixer =
        (input: WorkflowExecutorInput, progressStage: ProgressStage) =>
        (reason: string) =>
            progress.emit({
                ...issueProgress(input),
                stage: progressStage,
                status: "info",
                message: `Starting a fresh fixer session: ${reason}.`,
            });

    const repairVerificationFailure = async (
        input: WorkflowExecutorInput,
        state: Pick<ReviewState, "invariant" | "fix">,
        failure: VerificationCommandError,
        attempt: number,
    ): Promise<void> => {
        const { context } = input;
        const stagedDiff = await operations.readStagedBinaryDiff(
            context.repositoryPath,
        );
        await stage(
            progress,
            input,
            "verification-fix",
            `Repairing deterministic verification (attempt ${attempt}/${verificationFixBudget(context)})...`,
            () =>
                runFix(context.agent, state.fix, {
                    directory: context.repositoryPath,
                    title: `Repair verification for issue #${context.issue.number} (attempt ${attempt})`,
                    resumePrompt: buildVerificationResumePrompt({
                        diagnoseInvocation: skillInvocation(
                            state.fix.harness,
                            "diagnosing-bugs",
                        ),
                        failedVerification: failure.verification,
                    }),
                    freshPrompt: buildVerificationFixPrompt({
                        issue: context.issue,
                        repositoryPath: context.repositoryPath,
                        targetBranch: context.targetBranch,
                        stagedDiff,
                        failedVerification: failure.verification,
                    }),
                    onFreshSession: reportFreshFixer(input, "verification-fix"),
                    repositoryInvariant: state.invariant,
                    verifyRepositoryInvariant:
                        context.repositoryInvariant.verify,
                    progress,
                    progressStage: "verification-fix",
                    progressIssue: issueProgress(input).issue,
                    signal: context.signal,
                }),
            "Verification-fix agent finished; deterministic verification pending.",
            undefined,
            { attempt, maxAttempts: verificationFixBudget(context) },
        );
        checkSignal(context.signal);
        await stage(
            progress,
            input,
            "change-staging",
            `Restaging verification-fix changes (attempt ${attempt})...`,
            () => operations.stageAll(context.repositoryPath),
            "Verification-fix changes staged.",
            undefined,
            { attempt, maxAttempts: verificationFixBudget(context) },
        );
    };

    const ensureVerificationPassing = async (
        input: WorkflowExecutorInput,
        state: Pick<ReviewState, "invariant" | "fix">,
    ): Promise<VerificationResult> => {
        const attemptVerification = async (): Promise<VerificationAttempt> => {
            try {
                return {
                    status: "passed",
                    verification: await verifyStagedChanges(input),
                };
            } catch (error) {
                if (!(error instanceof VerificationCommandError)) throw error;
                return { status: "repairable", error };
            }
        };
        const maxFixes = verificationFixBudget(input.context);
        for (let attempt = 1; attempt <= maxFixes; attempt += 1) {
            const verification = await attemptVerification();
            if (verification.status === "passed") return verification;
            await repairVerificationFailure(
                input,
                state,
                verification.error,
                attempt,
            );
        }
        const finalVerification = await attemptVerification();
        return finalVerification.status === "passed"
            ? finalVerification
            : {
                  kind: IssueExecutionOutcomeKind.Failed,
                  message: `Deterministic verification still failed after ${maxFixes} repair attempts: ${finalVerification.error.message}`,
                  exhausted: true,
              };
    };

    const candidateMessage = async (
        input: WorkflowExecutorInput,
        state: ReviewState,
        attempt: number,
    ): Promise<CommitMessageDecision> =>
        state.candidateSubjects.length === 0
            ? await input.artifacts.read(
                  IssueArtifactKind.CommitMessageDecision,
              )
            : { subject: `Address review findings (round ${attempt})` };

    /** Commit the verified staged tree as a local candidate; never pushed. */
    const commitCandidate = async (
        input: WorkflowExecutorInput,
        checkpoint: IssueCheckpoint,
        state: ReviewState,
        attempt: number,
    ): Promise<void> => {
        const { context } = input;
        const message = await candidateMessage(input, state, attempt);
        const candidate = await stage(
            progress,
            input,
            "commit",
            `Creating candidate commit (attempt ${attempt}/${reviewBudget(context)})...`,
            () => operations.commitCandidate(context.repositoryPath, message),
            "Candidate commit created locally.",
            undefined,
            { attempt, maxAttempts: reviewBudget(context) },
        );
        state.head = candidate.sha;
        state.invariant = { branch: checkpoint.branch, head: candidate.sha };
        state.candidateSubjects.push(message.subject);
    };

    /**
     * Fold every candidate commit back into the index so the checkout is the
     * checkpoint plus staged changes again (the shape recovery and the final
     * commit expect). A no-op when no candidate exists.
     */
    const foldCandidates = async (
        input: WorkflowExecutorInput,
        checkpoint: IssueCheckpoint,
        state: ReviewState,
    ): Promise<void> => {
        if (state.candidateSubjects.length === 0) return;
        await operations.squashCandidates(
            input.context.repositoryPath,
            checkpoint.sha,
        );
        state.head = checkpoint.sha;
        state.invariant = { branch: checkpoint.branch, head: checkpoint.sha };
        state.candidateSubjects.length = 0;
    };

    const requestReview = <Output>(
        input: WorkflowExecutorInput,
        state: ReviewState,
        request: {
            readonly role: "standards-reviewer" | "spec-reviewer";
            readonly title: string;
            readonly prompt: string;
            readonly schema: z.ZodType<Output>;
        },
    ) => {
        const { context } = input;
        return requestStructuredOutput(context.agent, {
            directory: context.repositoryPath,
            ...request,
            repositoryInvariant: state.invariant,
            verifyRepositoryInvariant: context.repositoryInvariant.verify,
            progress,
            progressStage: "review",
            progressIssue: issueProgress(input).issue,
            signal: context.signal,
        });
    };

    /**
     * When the range diff is too large for the prompt, write the commit log
     * and the whole diff to a git-excluded file the reviewers must read, and
     * remove it once both reviews end.
     */
    const withReviewEvidence = async <Result>(
        input: WorkflowExecutorInput,
        state: ReviewState,
        rangeDiff: string,
        run: (evidencePath: string | undefined) => Promise<Result>,
    ): Promise<Result> => {
        if (
            reviewEvidence === undefined ||
            rangeDiff.length <= PROMPT_DIFF_LIMIT
        ) {
            return await run(undefined);
        }
        const file = await reviewEvidence.publish({
            repositoryPath: input.context.repositoryPath,
            name: "candidate-diff.txt",
            contents: [
                "Commits, oldest first:",
                ...state.candidateSubjects.map((subject) => `- ${subject}`),
                "",
                rangeDiff,
            ].join("\n"),
        });
        try {
            return await run(file.path);
        } finally {
            await file.remove().catch(() => {});
        }
    };

    /** Both axes run in parallel; a failure waits for its sibling before it propagates. */
    const runBothReviews = async (
        input: WorkflowExecutorInput,
        checkpoint: IssueCheckpoint,
        state: ReviewState,
        attempt: number,
        verificationEvidence: VerificationEvidence,
        previousReviews: ReadonlyArray<ReviewAttempt>,
    ) => {
        const { context } = input;
        const rangeDiff = await operations.readRangeDiff(
            context.repositoryPath,
            checkpoint.sha,
            state.head,
        );
        const prompt = (evidencePath: string | undefined) => ({
            issue: context.issue,
            repositoryPath: context.repositoryPath,
            targetBranch: context.targetBranch,
            fixedPoint: checkpoint.sha,
            candidateSha: state.head,
            rangeDiff,
            commitSubjects: state.candidateSubjects,
            verification: verificationEvidence,
            previousReviews: previousReviews.map(({ decision }) => decision),
            skillsDirectory: skillLocation(
                context.agent.roles["standards-reviewer"].harness,
            ),
            ...(evidencePath === undefined ? {} : { evidencePath }),
        });
        const [standards, spec] = await withReviewEvidence(
            input,
            state,
            rangeDiff,
            async (evidencePath) =>
                await Promise.allSettled([
                    requestReview(input, state, {
                        role: "standards-reviewer",
                        title: `Review standards for issue #${context.issue.number} (attempt ${attempt})`,
                        prompt: buildStandardsReviewPrompt(
                            prompt(evidencePath),
                        ),
                        schema: standardsReviewSchema,
                    }),
                    requestReview(input, state, {
                        role: "spec-reviewer",
                        title: `Review spec for issue #${context.issue.number} (attempt ${attempt})`,
                        prompt: buildSpecReviewPrompt({
                            ...prompt(evidencePath),
                            skillsDirectory: skillLocation(
                                context.agent.roles["spec-reviewer"].harness,
                            ),
                        }),
                        schema: specReviewSchema,
                    }),
                ]),
        );
        if (standards.status === "rejected") throw standards.reason;
        if (spec.status === "rejected") throw spec.reason;
        return { standards: standards.value, spec: spec.value };
    };

    const runReviewAttempt = async (
        input: WorkflowExecutorInput,
        state: ReviewState,
        attempt: number,
        verificationEvidence: VerificationEvidence,
        previousReviews: ReadonlyArray<ReviewAttempt>,
        checkpoint: IssueCheckpoint,
    ): Promise<ReviewAttempt | WorkflowExecutorResult> => {
        const { context } = input;
        await commitCandidate(input, checkpoint, state, attempt);
        const reviews = await stage(
            progress,
            input,
            "review",
            `Reviewing candidate commits on both axes (attempt ${attempt}/${reviewBudget(context)})...`,
            () =>
                runBothReviews(
                    input,
                    checkpoint,
                    state,
                    attempt,
                    verificationEvidence,
                    previousReviews,
                ),
            ({ standards, spec }) =>
                `Review ${attempt}/${reviewBudget(context)}: ${
                    combineReviews(standards.output, spec.output).verdict
                }.`,
            undefined,
            { attempt, maxAttempts: reviewBudget(context) },
        );
        const signal = reviews.standards.handOff ?? reviews.spec.handOff;
        if (signal !== undefined)
            await foldCandidates(input, checkpoint, state);
        const routed = await routeSignal(input, signal, checkpoint);
        if (routed !== undefined) return routed;
        return {
            attempt,
            sessionID: `${reviews.standards.sessionID}+${reviews.spec.sessionID}`,
            stagedTreeSha: verificationEvidence.stagedTreeSha,
            verification: verificationEvidence,
            decision: combineReviews(
                reviews.standards.output,
                reviews.spec.output,
            ),
        };
    };

    /**
     * Deliver the approved work as exactly one created commit: the candidates
     * were already folded away, so the staged tree is the approved tree.
     */
    const commitApprovedReview = async (
        input: WorkflowExecutorInput,
        checkpoint: IssueCheckpoint,
        approvedReview: ReviewAttempt,
        verificationEvidence: VerificationEvidence,
    ): Promise<WorkflowExecutorResult> => {
        const { context, artifacts } = input;
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
        const commitMessage = await artifacts.read(
            IssueArtifactKind.CommitMessageDecision,
        );
        const commit = await stage(
            progress,
            input,
            "commit",
            "Committing implementation changes...",
            () => operations.commit(context.repositoryPath, commitMessage),
            "Implementation changes committed.",
        );
        await artifacts.write(
            IssueArtifactKind.CreatedCommit,
            commit,
            context.signal,
        );
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
        checkpoint: IssueCheckpoint,
        state: ReviewState,
        review: ReviewAttempt,
        attempt: number,
    ): Promise<WorkflowExecutorResult | ReviewFixOutcome> => {
        const { context } = input;
        const currentDiff = await operations.readRangeDiff(
            context.repositoryPath,
            checkpoint.sha,
            state.head,
        );
        await stage(
            progress,
            input,
            "review-fix",
            `Addressing review findings (attempt ${attempt})...`,
            () =>
                runFix(context.agent, state.fix, {
                    directory: context.repositoryPath,
                    title: `Address review for issue #${context.issue.number} (attempt ${attempt})`,
                    resumePrompt: buildReviewResumePrompt({
                        implementInvocation: skillInvocation(
                            state.fix.harness,
                            "implement",
                        ),
                        review: review.decision,
                    }),
                    onFreshSession: reportFreshFixer(input, "review-fix"),
                    freshPrompt: buildReviewFixPrompt({
                        issue: context.issue,
                        repositoryPath: context.repositoryPath,
                        targetBranch: context.targetBranch,
                        candidateDiff: currentDiff,
                        review: review.decision,
                        verification: review.verification,
                    }),
                    repositoryInvariant: state.invariant,
                    verifyRepositoryInvariant:
                        context.repositoryInvariant.verify,
                    progress,
                    progressStage: "review-fix",
                    progressIssue: issueProgress(input).issue,
                    signal: context.signal,
                }),
            "Review-fix agent finished; deterministic verification pending.",
            undefined,
            { attempt, maxAttempts: reviewBudget(context) },
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
            { attempt, maxAttempts: reviewBudget(context) },
        );
        if (await operations.hasStagedChanges(context.repositoryPath)) {
            return {
                status: "staged",
                unresolvedFindings: [],
            };
        }
        await progress.emit({
            ...issueProgress(input),
            stage: "review-fix",
            status: "failed",
            attempt,
            maxAttempts: reviewBudget(context),
            message: `Review fix attempt ${attempt} produced no changes.`,
        });
        return {
            kind: IssueExecutionOutcomeKind.Failed,
            message: `Review fix attempt ${attempt} produced no changes.`,
        } as const;
    };

    const exhaustReviews = async (
        input: WorkflowExecutorInput,
        checkpoint: IssueCheckpoint,
        state: ReviewState,
        reviews: ReadonlyArray<ReviewAttempt>,
    ): Promise<WorkflowExecutorResult> => {
        const { context } = input;
        await foldCandidates(input, checkpoint, state);
        const exhausted = await recovery.handleReviewExhaustion({
            runId: context.runId,
            repository: context.repository,
            workspace: context.workspace,
            repositoryPath: context.repositoryPath,
            issue: context.issue,
            checkpoint,
            reviews,
            reviewRounds: reviewBudget(context),
        });
        return {
            kind: IssueExecutionOutcomeKind.Escalated,
            diagnosticsPath: exhausted.diagnosticsPath,
            reason: "Review did not converge within the review iteration budget.",
        };
    };

    const handleReviewDecision = async (
        input: WorkflowExecutorInput,
        checkpoint: IssueCheckpoint,
        state: ReviewState,
        review: ReviewAttempt,
        reviews: ReadonlyArray<ReviewAttempt>,
        attempt: number,
        isRepeated: boolean,
    ): Promise<WorkflowExecutorResult | undefined> => {
        if (isRepeated) {
            return {
                kind: IssueExecutionOutcomeKind.Failed,
                message:
                    "Review repeated the same blocking findings after a verified fix; stopping instead of looping.",
            };
        }
        if (attempt === reviewBudget(input.context)) {
            return await exhaustReviews(input, checkpoint, state, reviews);
        }
        const fixOutcome = await applyReviewFix(
            input,
            checkpoint,
            state,
            review,
            attempt,
        );
        return "kind" in fixOutcome ? fixOutcome : undefined;
    };

    /**
     * Approval folds the candidates into one staged tree, reverifies it, and
     * only then creates the single commit. A verification repair that changes
     * the approved tree sends the loop back for another review.
     */
    const handleApprovedReview = async (
        input: WorkflowExecutorInput,
        checkpoint: IssueCheckpoint,
        state: ReviewState,
        review: ReviewAttempt,
        attempt: number,
    ): Promise<WorkflowExecutorResult | undefined> => {
        await foldCandidates(input, checkpoint, state);
        const finalVerification = await ensureVerificationPassing(input, state);
        if (!("status" in finalVerification)) return finalVerification;
        if (
            finalVerification.verification.stagedTreeSha.toLowerCase() ===
            review.stagedTreeSha?.toLowerCase()
        ) {
            return await commitApprovedReview(
                input,
                checkpoint,
                review,
                finalVerification.verification,
            );
        }
        if (attempt === reviewBudget(input.context)) {
            return {
                kind: IssueExecutionOutcomeKind.Failed,
                message:
                    "Verification repair changed the staged tree after the final review attempt; refusing to commit without another review.",
            };
        }
        await progress.emit({
            ...issueProgress(input),
            stage: "review",
            status: "info",
            attempt,
            maxAttempts: reviewBudget(input.context),
            message:
                "Verification repair changed the approved staged tree; reviewing the repaired tree again.",
        });
        return undefined;
    };

    const finishReviewAttempt = async (
        input: WorkflowExecutorInput,
        checkpoint: IssueCheckpoint,
        state: ReviewState,
        review: ReviewAttempt,
        reviews: ReadonlyArray<ReviewAttempt>,
        attempt: number,
        isRepeated: boolean,
    ): Promise<WorkflowExecutorResult | undefined> =>
        review.decision.verdict === ReviewVerdict.Approved
            ? await handleApprovedReview(
                  input,
                  checkpoint,
                  state,
                  review,
                  attempt,
              )
            : await handleReviewDecision(
                  input,
                  checkpoint,
                  state,
                  review,
                  reviews,
                  attempt,
                  isRepeated,
              );

    const runReviewLoop = async (
        input: WorkflowExecutorInput,
        checkpoint: IssueCheckpoint,
        invariant: { readonly branch: string; readonly head: string },
        fix: FixSession,
    ): Promise<WorkflowExecutorResult> => {
        const { context, artifacts } = input;
        const reviews: ReviewAttempt[] = [];
        const state: ReviewState = {
            head: checkpoint.sha,
            invariant,
            candidateSubjects: [],
            fix,
        };
        const maxRounds = reviewBudget(context);
        for (let attempt = 1; attempt <= maxRounds; attempt += 1) {
            checkSignal(context.signal);
            const verification = await ensureVerificationPassing(input, state);
            if (!("status" in verification)) return verification;
            const review = await runReviewAttempt(
                input,
                state,
                attempt,
                verification.verification,
                reviews,
                checkpoint,
            );
            if ("kind" in review) return review;
            const isRepeated = sameBlockingFindings(reviews.at(-1), review);
            reviews.push(review);
            await artifacts.appendReview(review, context.signal);
            const outcome = await finishReviewAttempt(
                input,
                checkpoint,
                state,
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

    return { run: runReviewLoop };
};