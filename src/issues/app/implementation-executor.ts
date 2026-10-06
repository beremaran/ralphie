import {
    type GitIssueOperationError,
    type GitIssueOperationsService,
} from "../../git/ports.ts";
import { type GitIssuePreparationService } from "../ports.ts";
import { type GitRemoteSafetyService } from "../../git/ports.ts";
import {
    buildImplementationAfterResolutionCorrectionPrompt,
    buildImplementationPrompt,
    buildImplementationRetryPrompt,
    buildReviewFixPrompt,
    buildSpecReviewPrompt,
    buildStandardsReviewPrompt,
    buildVerificationFixPrompt,
} from "../../agent/prompts.ts";
import { requestStructuredOutput } from "../../agent/structured-output.ts";
import {
    HAND_OFF_MESSAGE_LIMIT,
    HAND_OFF_REASONS,
    runAgentTask,
    type HandOffRequest,
} from "../../agent/task-session.ts";
import { z } from "zod";
import {
    skillInvocation,
    skillLocation,
} from "../../harness/app/skill-injection.ts";
import {
    type ProgressStage,
    type ProgressReporterService,
} from "../../progress/ports.ts";
import { RalphieError } from "../../shared/error.ts";
import {
    type IssueExecutionContext,
    IssueExecutionOutcomeKind,
    type WorkflowExecutorInput,
    type WorkflowExecutorResult,
} from "./execution.ts";
import { IssueArtifactKind, issueFreshnessFingerprint } from "./artifacts.ts";
import {
    type CommitMessageDecision,
    commitMessageDecisionSchema,
    GroundingDisposition,
    type HandOffDecision,
    HandOffReason,
    type IssueResolutionDecision,
    IssueResolutionStatus,
    ReviewVerdict,
} from "../domain/decisions.ts";
import {
    combineReviews,
    specReviewSchema,
    standardsReviewSchema,
} from "../domain/review-gate.ts";
import { type IssueRecoveryService, type ReviewAttempt } from "./recovery.ts";
import {
    DEFAULT_IMPLEMENTATION_ATTEMPTS,
    REVIEW_ITERATION_LIMIT,
} from "../domain/stage.ts";
import { assertProtectedDecisionsAuthorized } from "../domain/scope-policy.ts";
import type {
    IssueVerificationService,
    VerificationEvidence,
} from "./verification.ts";
import { VerificationCommandError } from "./verification.ts";
import {
    makeResolutionVerificationService,
    type ResolutionVerificationService,
} from "./resolution-verification.ts";
import type { HandOffRouterService } from "./hand-off.ts";

/** The implementation workflow for issues with complexity 0 through 3. */
export type ImplementationExecutorService = {
    readonly execute: (
        input: WorkflowExecutorInput,
    ) => Promise<WorkflowExecutorResult>;
};

export type ReviewFixOutcome = {
    readonly status: "staged";
    readonly unresolvedFindings: ReadonlyArray<string>;
};

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

/**
 * The result of the implementer's `/implement` session: `done` carries the
 * commit message for the staged changes, `needs_attention` a hand-off request.
 */
export const implementationResultSchema = z
    .object({
        status: z.enum(["done", "needs_attention"]),
        summary: z.string().trim().min(1),
        commitMessage: commitMessageDecisionSchema.optional(),
        needsAttention: z
            .object({
                reason: z.enum(HAND_OFF_REASONS),
                questions: z.array(z.string().trim().min(1)).min(1).max(10),
            })
            .strict()
            .optional(),
    })
    .strict()
    .superRefine((result, context) => {
        if (result.status === "done" && result.commitMessage === undefined) {
            context.addIssue({
                code: "custom",
                path: ["commitMessage"],
                message: "A done result must include a commitMessage.",
            });
        }
        if (
            result.status === "needs_attention" &&
            result.needsAttention === undefined
        ) {
            context.addIssue({
                code: "custom",
                path: ["needsAttention"],
                message:
                    "A needs_attention result must include needsAttention.",
            });
        }
    });

type ImplementationResult = z.infer<typeof implementationResultSchema>;

/** Used when a rejected hand-off request lets the work continue without a message. */
const fallbackCommitMessage = (issue: {
    readonly number: number;
}): CommitMessageDecision => ({ subject: `Address issue #${issue.number}` });

const handoffRequest = (
    result: ImplementationResult,
): HandOffRequest | undefined =>
    result.status !== "needs_attention" || result.needsAttention === undefined
        ? undefined
        : {
              reason: result.needsAttention.reason,
              message: [result.summary, ...result.needsAttention.questions]
                  .join("\n")
                  .slice(0, HAND_OFF_MESSAGE_LIMIT),
          };

const promptInput = (context: IssueExecutionContext) => ({
    issue: context.issue,
    repositoryPath: context.repositoryPath,
    targetBranch: context.targetBranch,
    implementInvocation: skillInvocation(
        context.agent.roles.implementer.harness,
        "implement",
    ),
});

const implementationPrompt = (
    input: WorkflowExecutorInput,
    attempt: number,
    unresolvedSummary: string | undefined,
): string => {
    const { context, unresolvedResolution } = input;
    if (attempt === 1 && unresolvedResolution !== undefined) {
        return buildImplementationAfterResolutionCorrectionPrompt({
            ...promptInput(context),
            unresolvedSummary: unresolvedResolution.summary,
            evidence: unresolvedResolution.evidence,
        });
    }
    if (unresolvedSummary !== undefined) {
        return buildImplementationRetryPrompt({
            ...promptInput(context),
            unresolvedSummary,
            attempt,
        });
    }
    return buildImplementationPrompt(promptInput(context));
};

/** One attempt out of the budget its stage runs under. */
type AttemptCounter = {
    readonly attempt: number;
    readonly maxAttempts: number;
};

const implementationBudget = (context: IssueExecutionContext): number =>
    context.implementationAttempts ?? DEFAULT_IMPLEMENTATION_ATTEMPTS;

const reviewBudget = (context: IssueExecutionContext): number =>
    context.reviewRounds ?? REVIEW_ITERATION_LIMIT;

const verificationFixBudget = (context: IssueExecutionContext): number =>
    context.verificationFixes ?? REVIEW_ITERATION_LIMIT;

const stage = async <A>(
    progress: ProgressReporterService,
    input: WorkflowExecutorInput,
    progressStage: ProgressStage,
    startedMessage: string,
    operation: () => Promise<A>,
    succeededMessage: string | ((value: A) => string),
    details?: Readonly<Record<string, unknown>>,
    attempt?: AttemptCounter,
): Promise<A> => {
    const base = {
        ...issueProgress(input),
        stage: progressStage,
        ...attempt,
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
        signal: input.context.signal,
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
    handOffRouter?: HandOffRouterService,
): ImplementationExecutorService => {
    const routeSignal = async (
        input: WorkflowExecutorInput,
        request: HandOffRequest | undefined,
        checkpoint: Awaited<ReturnType<typeof readCheckpoint>>,
    ): Promise<WorkflowExecutorResult | undefined> => {
        if (request === undefined) return undefined;
        if (handOffRouter === undefined) {
            throw new RalphieError({
                message:
                    "A hand-off signal requires the verifier/router service.",
            });
        }
        return await handOffRouter.route({
            ...input,
            request,
            checkpoint,
        });
    };
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
            context.signal,
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
            await artifacts.resetImplementationAttempt(context.signal);
        }
        const invariant = {
            branch: checkpoint.branch,
            head: checkpoint.sha,
        };
        await context.repositoryInvariant.verify(
            context.repositoryPath,
            invariant,
            context.signal,
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
        checkpoint: Awaited<ReturnType<typeof readCheckpoint>>,
        attempt: number,
        unresolvedSummary?: string,
    ): Promise<WorkflowExecutorResult | CommitMessageDecision> => {
        const { context } = input;
        const result = await stage(
            progress,
            input,
            "implementation",
            `Implementing #${context.issue.number}...`,
            () =>
                requestStructuredOutput(context.agent, {
                    directory: context.repositoryPath,
                    title: `Implement issue #${context.issue.number}`,
                    role: "implementer",

                    schema: implementationResultSchema,
                    prompt: implementationPrompt(
                        input,
                        attempt,
                        unresolvedSummary,
                    ),
                    repositoryInvariant: invariant,
                    verifyRepositoryInvariant:
                        context.repositoryInvariant.verify,
                    progress,
                    progressStage: "implementation",
                    progressIssue: issueProgress(input).issue,
                    signal: context.signal,
                }),
            "Implementation session submitted; inspecting repository changes.",
            undefined,
            { attempt, maxAttempts: implementationBudget(context) },
        );
        const routed = await routeSignal(
            input,
            result.handOff ?? handoffRequest(result.output),
            checkpoint,
        );
        return (
            routed ??
            result.output.commitMessage ??
            fallbackCommitMessage(context.issue)
        );
    };

    const inspectNoChangeResolution = async (
        input: WorkflowExecutorInput,
        checkpoint: Awaited<ReturnType<typeof readCheckpoint>>,
        finalAttempt: boolean,
    ): Promise<
        WorkflowExecutorResult | { readonly unresolvedSummary: string }
    > => {
        const { context, artifacts } = input;
        const resolution = await resolutionVerification.verify(context);
        const routed = await routeSignal(input, resolution.handOff, checkpoint);
        if (routed !== undefined) return routed;
        const outcome = resolutionOutcome(resolution.decision);
        if (
            outcome.kind === IssueExecutionOutcomeKind.Failed &&
            !finalAttempt
        ) {
            return { unresolvedSummary: outcome.message };
        }
        await artifacts.write(
            IssueArtifactKind.IssueResolutionDecision,
            {
                decision: resolution.decision,
                fingerprint: issueFreshnessFingerprint(context.issue),
            },
            context.signal,
        );
        return outcome.kind === IssueExecutionOutcomeKind.Failed
            ? {
                  ...outcome,
                  message: `Issue remains unresolved after ${implementationBudget(context)} no-change implementation attempts: ${outcome.message}`,
                  exhausted: true,
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

    const repairVerificationFailure = async (
        input: WorkflowExecutorInput,
        invariant: { readonly branch: string; readonly head: string },
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
                runAgentTask(context.agent, {
                    directory: context.repositoryPath,
                    title: `Repair verification for issue #${context.issue.number} (attempt ${attempt})`,
                    role: "fixer",
                    prompt: buildVerificationFixPrompt({
                        issue: context.issue,
                        repositoryPath: context.repositoryPath,
                        targetBranch: context.targetBranch,
                        stagedDiff,
                        failedVerification: failure.verification,
                    }),
                    repositoryInvariant: invariant,
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
        invariant: { readonly branch: string; readonly head: string },
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
                invariant,
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
        checkpoint: Awaited<ReturnType<typeof readCheckpoint>>,
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
        checkpoint: Awaited<ReturnType<typeof readCheckpoint>>,
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

    /** Both axes run in parallel; a failure waits for its sibling before it propagates. */
    const runBothReviews = async (
        input: WorkflowExecutorInput,
        checkpoint: Awaited<ReturnType<typeof readCheckpoint>>,
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
        const prompt = {
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
        };
        const [standards, spec] = await Promise.allSettled([
            requestReview(input, state, {
                role: "standards-reviewer",
                title: `Review standards for issue #${context.issue.number} (attempt ${attempt})`,
                prompt: buildStandardsReviewPrompt(prompt),
                schema: standardsReviewSchema,
            }),
            requestReview(input, state, {
                role: "spec-reviewer",
                title: `Review spec for issue #${context.issue.number} (attempt ${attempt})`,
                prompt: buildSpecReviewPrompt({
                    ...prompt,
                    skillsDirectory: skillLocation(
                        context.agent.roles["spec-reviewer"].harness,
                    ),
                }),
                schema: specReviewSchema,
            }),
        ]);
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
        checkpoint: Awaited<ReturnType<typeof readCheckpoint>>,
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
        checkpoint: Awaited<ReturnType<typeof readCheckpoint>>,
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
        checkpoint: Awaited<ReturnType<typeof readCheckpoint>>,
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
                runAgentTask(context.agent, {
                    directory: context.repositoryPath,
                    title: `Address review for issue #${context.issue.number} (attempt ${attempt})`,
                    role: "fixer",
                    prompt: buildReviewFixPrompt({
                        issue: context.issue,
                        repositoryPath: context.repositoryPath,
                        targetBranch: context.targetBranch,
                        stagedDiff: currentDiff,
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
        checkpoint: Awaited<ReturnType<typeof readCheckpoint>>,
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
        checkpoint: Awaited<ReturnType<typeof readCheckpoint>>,
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
        checkpoint: Awaited<ReturnType<typeof readCheckpoint>>,
        state: ReviewState,
        review: ReviewAttempt,
        attempt: number,
    ): Promise<WorkflowExecutorResult | undefined> => {
        await foldCandidates(input, checkpoint, state);
        const finalVerification = await ensureVerificationPassing(
            input,
            state.invariant,
        );
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
        checkpoint: Awaited<ReturnType<typeof readCheckpoint>>,
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
        checkpoint: Awaited<ReturnType<typeof readCheckpoint>>,
        invariant: { readonly branch: string; readonly head: string },
    ): Promise<WorkflowExecutorResult> => {
        const { context, artifacts } = input;
        const reviews: ReviewAttempt[] = [];
        const state: ReviewState = {
            head: checkpoint.sha,
            invariant,
            candidateSubjects: [],
        };
        const maxRounds = reviewBudget(context);
        for (let attempt = 1; attempt <= maxRounds; attempt += 1) {
            checkSignal(context.signal);
            const verification = await ensureVerificationPassing(
                input,
                state.invariant,
            );
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

    const runImplementationAttempts = async (
        input: WorkflowExecutorInput,
        checkpoint: Awaited<ReturnType<typeof readCheckpoint>>,
        invariant: { readonly branch: string; readonly head: string },
    ): Promise<WorkflowExecutorResult> => {
        const { context } = input;
        const maximumAttempts = implementationBudget(context);
        let unresolvedSummary: string | undefined;
        for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
            const implementation = await runImplementation(
                input,
                invariant,
                checkpoint,
                attempt,
                unresolvedSummary,
            );
            if ("kind" in implementation) return implementation;
            checkSignal(context.signal);
            await stage(
                progress,
                input,
                "change-staging",
                `Inspecting and staging implementation attempt ${attempt}...`,
                () => operations.stageAll(context.repositoryPath),
                `Implementation attempt ${attempt} inspected.`,
                undefined,
                { attempt, maxAttempts: maximumAttempts },
            );
            if (await operations.hasStagedChanges(context.repositoryPath)) {
                await input.artifacts.write(
                    IssueArtifactKind.CommitMessageDecision,
                    implementation,
                    context.signal,
                );
                return await runReviewLoop(input, checkpoint, invariant);
            }
            const noChange = await inspectNoChangeResolution(
                input,
                checkpoint,
                attempt === maximumAttempts,
            );
            if (!("unresolvedSummary" in noChange)) return noChange;
            unresolvedSummary = noChange.unresolvedSummary;
        }
        throw new RalphieError({
            message: "Implementation retry loop ended unexpectedly.",
        });
    };

    /**
     * Out-of-attempts failures are a human's problem: preserve diagnostics,
     * restore the clean checkout and hand the issue off as ready-for-human.
     */
    const handOffWhenExhausted = async (
        input: WorkflowExecutorInput,
        checkpoint: Awaited<ReturnType<typeof readCheckpoint>>,
        result: WorkflowExecutorResult,
    ): Promise<WorkflowExecutorResult> => {
        if (result.kind !== IssueExecutionOutcomeKind.Failed) return result;
        if (result.exhausted !== true) return result;
        const { context } = input;
        const decision: HandOffDecision = {
            disposition: GroundingDisposition.HandOff,
            reason: HandOffReason.ImplementationExhausted,
            summary: `Ralphie could not finish issue #${context.issue.number}: ${result.message}`,
            evidence: [result.message],
            questions: [
                "Review the preserved diagnostics, then finish the change by hand or rewrite the issue so an agent can complete it.",
            ],
        };
        const { disposition: _disposition, ...details } = decision;
        const recovered = await recovery.handleHandOff({
            runId: context.runId,
            repository: context.repository,
            workspace: context.workspace,
            repositoryPath: context.repositoryPath,
            issue: context.issue,
            checkpoint,
            fingerprint: issueFreshnessFingerprint(context.issue),
            decision,
            repositoryInvariant: context.repositoryInvariant,
            signal: context.signal,
        });
        return {
            kind: IssueExecutionOutcomeKind.HandOff,
            ...details,
            diagnosticsPath: recovered.diagnosticsPath,
        };
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
            if (resolution.decision.status === IssueResolutionStatus.Resolved) {
                return resolutionOutcome(resolution.decision);
            }
            await artifacts.clearUnresolvedResolutionDecision(context.signal);
        }

        const recovered = await recoverCommittedAttempt(input);
        if (recovered !== undefined) return recovered;

        const { checkpoint, invariant } = await prepareAttempt(input);
        return await handOffWhenExhausted(
            input,
            checkpoint,
            await runImplementationAttempts(input, checkpoint, invariant),
        );
    };

    return {
        execute: async (input) => {
            try {
                await input.artifacts.invalidateStaleIssueDecisions(
                    issueFreshnessFingerprint(input.context.issue),
                    input.context.signal,
                );
                return await executeImplementation(input);
            } catch (error) {
                throw asRalphieError(
                    error as GitIssueOperationError | RalphieError,
                );
            }
        },
    };
};