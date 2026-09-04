import type { Octokit } from "octokit";

import {
    buildCommitMessagePrompt,
    buildPullRequestRevisionPrompt,
} from "../agent/prompts.ts";
import type { AgentSelection } from "../agent/model.ts";
import { requestStructuredOutput } from "../agent/structured-output.ts";
import {
    runAgentTask,
    type AgentSessionDiagnostics,
    type NeedsAttentionRequest,
} from "../agent/task-session.ts";
import type { GitIssueOperationsService } from "../git/issue-operations.ts";
import { runGit } from "../git/run-git.ts";
import type {
    GitRevisionDeliveryOutcome,
    GitRevisionDeliveryService,
} from "../git/revision-delivery.ts";
import type { CommandRunnerService } from "../process/command-runner.ts";
import { AgentSessionProfile, type AgentClient } from "../opencode/client.ts";
import type { GitHubIssue } from "../github/issues.ts";
import type {
    GitHubPullRequestService,
    PullRequestSnapshot,
} from "../github/pull-requests.ts";
import { RalphieError } from "../shared/error.ts";

import type { IssueArtifactStore } from "./artifacts.ts";
import {
    commitMessageDecisionSchema,
    type CommitMessageDecision,
} from "./decisions.ts";
import type {
    PullRequestReviewAttemptResult,
    PullRequestReviewAttemptService,
} from "./pull-request-review.ts";
import { REVIEW_ITERATION_LIMIT } from "./stage.ts";
import type {
    IssueVerificationService,
    VerificationEvidence,
} from "./verification.ts";

export type PullRequestRevisionRecord = {
    readonly review: PullRequestReviewAttemptResult;
    readonly fixSessionID: string;
    readonly verification: VerificationEvidence;
    readonly commitMessage: CommitMessageDecision;
    readonly delivery: GitRevisionDeliveryOutcome;
};

type CoordinatorHistory = {
    readonly reviews: ReadonlyArray<PullRequestReviewAttemptResult>;
    readonly revisions: ReadonlyArray<PullRequestRevisionRecord>;
};

export type PullRequestReviewCoordinatorResult = CoordinatorHistory &
    (
        | {
              readonly status: "approved";
              readonly snapshot: PullRequestSnapshot;
              readonly review: PullRequestReviewAttemptResult;
          }
        | {
              readonly status: "pr-review-exhausted";
              readonly snapshot: PullRequestSnapshot;
              readonly reason: "review-attempt-budget-exhausted";
              readonly failedAttempt?: {
                  readonly attempt: number;
                  readonly message: string;
              };
          }
        | {
              readonly status: "needs-attention";
              readonly snapshot: PullRequestSnapshot;
              readonly phase: "review" | "revision-fix" | "commit-message";
              readonly request: NeedsAttentionRequest;
          }
        | {
              readonly status: "review-failed";
              readonly snapshot: PullRequestSnapshot;
              readonly attempt: number;
              readonly message: string;
          }
        | {
              readonly status: "head-moved";
              readonly phase: "before-fix" | "during-fix" | "after-delivery";
              readonly snapshot: PullRequestSnapshot;
          }
        | {
              readonly status: "delivery-recoverable";
              readonly snapshot: PullRequestSnapshot;
              readonly delivery: Extract<
                  GitRevisionDeliveryOutcome,
                  { readonly status: "external-movement" | "ambiguous" }
              >;
          }
        | {
              readonly status: "revision-failed";
              readonly snapshot: PullRequestSnapshot;
              readonly message: string;
          }
    );

export type PullRequestReviewCoordinatorInput = {
    readonly client: Octokit;
    readonly repository: string;
    readonly repositoryPath: string;
    /** Managed feature branch carrying the PR. */
    readonly branch: string;
    readonly targetBranch: string;
    readonly issue: GitHubIssue;
    /** Snapshot captured after the initial feature commit was pushed. */
    readonly snapshot: PullRequestSnapshot;
    readonly agent: AgentClient;
    readonly agentSelection: AgentSelection;
    readonly artifacts: IssueArtifactStore;
    /** Empty commands use the repository's discoverable `check` script. */
    readonly verificationCommands?: ReadonlyArray<string>;
    readonly runId?: string;
    readonly diagnostics?: AgentSessionDiagnostics;
    readonly signal?: AbortSignal;
};

export type PullRequestReviewCoordinatorDependencies = {
    readonly pullRequests: Pick<
        GitHubPullRequestService,
        "rereadMatchingSnapshot"
    >;
    readonly reviewAttempt: Pick<PullRequestReviewAttemptService, "review">;
    readonly issueOperations: Pick<
        GitIssueOperationsService,
        "stageAll" | "hasStagedChanges" | "readStagedBinaryDiff"
    >;
    readonly verification: Pick<IssueVerificationService, "verify">;
    readonly revisionDelivery: Pick<
        GitRevisionDeliveryService,
        "deliverRevision"
    >;
    readonly commandRunner: Pick<CommandRunnerService, "run">;
};

export type PullRequestReviewCoordinatorService = {
    readonly review: (
        input: PullRequestReviewCoordinatorInput,
    ) => Promise<PullRequestReviewCoordinatorResult>;
    readonly execute: (
        input: PullRequestReviewCoordinatorInput,
    ) => Promise<PullRequestReviewCoordinatorResult>;
};

const sameSha = (left: string, right: string): boolean =>
    left.toLowerCase() === right.toLowerCase();

const messageOf = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

const checkSignal = (signal: AbortSignal | undefined): void => {
    signal?.throwIfAborted();
};

const clearIndex = async (
    runner: Pick<CommandRunnerService, "run">,
    repositoryPath: string,
): Promise<void> => {
    await runGit(
        runner,
        repositoryPath,
        ["reset"],
        "Failed to clear the temporary revision index",
    );
};

const isRecoverableDelivery = (
    delivery: GitRevisionDeliveryOutcome,
): delivery is Extract<
    GitRevisionDeliveryOutcome,
    { readonly status: "external-movement" | "ambiguous" }
> => delivery.status === "external-movement" || delivery.status === "ambiguous";

const isCancellation = (
    error: unknown,
    signal: AbortSignal | undefined,
): boolean => signal?.aborted === true || messageOf(error).includes("cancel");

type ReviewStep =
    | {
          readonly kind: "reviewed";
          readonly result: PullRequestReviewAttemptResult;
      }
    | { readonly kind: "failed"; readonly message: string };

const rereadSnapshot = async (
    dependencies: PullRequestReviewCoordinatorDependencies,
    input: PullRequestReviewCoordinatorInput,
    snapshot: PullRequestSnapshot,
): Promise<PullRequestSnapshot> => {
    checkSignal(input.signal);
    const current = await dependencies.pullRequests.rereadMatchingSnapshot(
        input.client,
        input.repository,
        snapshot,
        input.signal,
    );
    checkSignal(input.signal);
    return current;
};

const invokeReviewAttempt = async (
    dependencies: PullRequestReviewCoordinatorDependencies,
    input: PullRequestReviewCoordinatorInput,
    snapshot: PullRequestSnapshot,
): Promise<ReviewStep> => {
    try {
        const result = await dependencies.reviewAttempt.review({
            client: input.client,
            repository: input.repository,
            repositoryPath: input.repositoryPath,
            targetBranch: input.targetBranch,
            issue: input.issue,
            snapshot,
            agent: input.agent,
            agentSelection: input.agentSelection,
            artifacts: input.artifacts,
            runId: input.runId,
            diagnostics: input.diagnostics,
            signal: input.signal,
        });
        checkSignal(input.signal);
        return {
            kind: "reviewed",
            result,
        };
    } catch (error) {
        if (isCancellation(error, input.signal)) throw error;
        return { kind: "failed", message: messageOf(error) };
    }
};

type RevisionFixStep =
    | { readonly kind: "fixed"; readonly sessionID: string }
    | {
          readonly kind: "needs-attention";
          readonly phase: "revision-fix";
          readonly request: NeedsAttentionRequest;
      }
    | { readonly kind: "revision-failed"; readonly message: string };

const runRevisionFix = async (
    input: PullRequestReviewCoordinatorInput,
    review: PullRequestReviewAttemptResult,
    attempt: number,
): Promise<RevisionFixStep> => {
    try {
        const fix = await runAgentTask(input.agent, {
            directory: input.repositoryPath,
            title: `Address pull request review for #${input.issue.number} (attempt ${attempt})`,
            selection: input.agentSelection,
            prompt: buildPullRequestRevisionPrompt({
                issue: input.issue,
                repositoryPath: input.repositoryPath,
                targetBranch: input.targetBranch,
                pullRequestNumber: review.attempt.pullRequestNumber,
                pullRequestUrl: review.snapshot.url,
                baseSha: review.attempt.baseSha,
                reviewedHeadSha: review.attempt.reviewedHeadSha,
                committedDiff: review.committedDiff,
                review: review.decision,
            }),
            runId: input.runId,
            diagnostics: input.diagnostics,
            signal: input.signal,
        });
        checkSignal(input.signal);
        if (fix.needsAttention !== undefined) {
            return {
                kind: "needs-attention",
                phase: "revision-fix",
                request: fix.needsAttention,
            };
        }
        return { kind: "fixed", sessionID: fix.session.sessionID };
    } catch (error) {
        if (isCancellation(error, input.signal)) throw error;
        return { kind: "revision-failed", message: messageOf(error) };
    }
};

type PreparedRevision = Omit<PullRequestRevisionRecord, "delivery">;

type RevisionPreparationStep =
    | { readonly kind: "prepared"; readonly revision: PreparedRevision }
    | {
          readonly kind: "needs-attention";
          readonly phase: "commit-message";
          readonly request: NeedsAttentionRequest;
      }
    | { readonly kind: "revision-failed"; readonly message: string };

const prepareRevision = async (
    dependencies: PullRequestReviewCoordinatorDependencies,
    input: PullRequestReviewCoordinatorInput,
    review: PullRequestReviewAttemptResult,
    fixSessionID: string,
    attempt: number,
): Promise<RevisionPreparationStep> => {
    let indexMayBeDirty = false;
    try {
        checkSignal(input.signal);
        if (
            await dependencies.issueOperations.hasStagedChanges(
                input.repositoryPath,
            )
        ) {
            throw new RalphieError({
                message:
                    "Refusing to prepare a PR revision over pre-existing staged changes.",
            });
        }
        indexMayBeDirty = true;
        await dependencies.issueOperations.stageAll(input.repositoryPath);
        checkSignal(input.signal);
        if (
            !(await dependencies.issueOperations.hasStagedChanges(
                input.repositoryPath,
            ))
        ) {
            throw new RalphieError({
                message: "Pull request review fix produced no staged changes.",
            });
        }
        const verification = await dependencies.verification.verify(
            input.repositoryPath,
            input.verificationCommands ?? [],
            input.signal,
        );
        checkSignal(input.signal);
        const stagedDiff =
            await dependencies.issueOperations.readStagedBinaryDiff(
                input.repositoryPath,
            );
        checkSignal(input.signal);
        const commitMessage = await requestStructuredOutput(input.agent, {
            directory: input.repositoryPath,
            title: `Generate PR revision commit message for #${input.issue.number} (attempt ${attempt})`,
            prompt: buildCommitMessagePrompt({
                issue: input.issue,
                repositoryPath: input.repositoryPath,
                targetBranch: input.targetBranch,
                stagedDiff,
                verification,
            }),
            schema: commitMessageDecisionSchema,
            profile: AgentSessionProfile.Review,
            agent: input.agentSelection.agent,
            model: input.agentSelection.model,
            variant: input.agentSelection.variant,
            runId: input.runId,
            diagnostics: input.diagnostics,
            signal: input.signal,
        });
        checkSignal(input.signal);
        if (commitMessage.needsAttention !== undefined) {
            await clearIndex(dependencies.commandRunner, input.repositoryPath);
            indexMayBeDirty = false;
            return {
                kind: "needs-attention",
                phase: "commit-message",
                request: commitMessage.needsAttention,
            };
        }
        const revision = {
            review,
            fixSessionID,
            verification,
            commitMessage: commitMessage.output,
        } satisfies PreparedRevision;
        await clearIndex(dependencies.commandRunner, input.repositoryPath);
        indexMayBeDirty = false;
        checkSignal(input.signal);
        return { kind: "prepared", revision };
    } catch (error) {
        if (isCancellation(error, input.signal)) throw error;
        return { kind: "revision-failed", message: messageOf(error) };
    } finally {
        if (indexMayBeDirty) {
            await clearIndex(
                dependencies.commandRunner,
                input.repositoryPath,
            ).catch(() => undefined);
        }
    }
};

type RejectedReviewStep =
    | {
          readonly kind: "prepared";
          readonly revision: PreparedRevision;
      }
    | {
          readonly kind: "needs-attention";
          readonly phase: "revision-fix" | "commit-message";
          readonly request: NeedsAttentionRequest;
      }
    | { readonly kind: "revision-failed"; readonly message: string }
    | {
          readonly kind: "head-moved";
          readonly phase: "before-fix" | "during-fix";
          readonly snapshot: PullRequestSnapshot;
      };

const prepareRejectedReview = async (
    dependencies: PullRequestReviewCoordinatorDependencies,
    input: PullRequestReviewCoordinatorInput,
    review: PullRequestReviewAttemptResult,
    attempt: number,
): Promise<RejectedReviewStep> => {
    const beforeFix = await rereadSnapshot(
        dependencies,
        input,
        review.snapshot,
    );
    if (!sameSha(beforeFix.headSha, review.attempt.reviewedHeadSha)) {
        return {
            kind: "head-moved",
            phase: "before-fix",
            snapshot: beforeFix,
        };
    }
    const fix = await runRevisionFix(input, review, attempt);
    if (fix.kind !== "fixed") return fix;
    const afterFix = await rereadSnapshot(dependencies, input, review.snapshot);
    if (!sameSha(afterFix.headSha, review.attempt.reviewedHeadSha)) {
        return {
            kind: "head-moved",
            phase: "during-fix",
            snapshot: afterFix,
        };
    }
    return await prepareRevision(
        dependencies,
        input,
        review,
        fix.sessionID,
        attempt,
    );
};

type DeliveryStep =
    | {
          readonly kind: "delivered";
          readonly delivery: GitRevisionDeliveryOutcome;
      }
    | { readonly kind: "revision-failed"; readonly message: string };

const deliverRevision = async (
    dependencies: PullRequestReviewCoordinatorDependencies,
    input: PullRequestReviewCoordinatorInput,
    revision: PreparedRevision,
): Promise<DeliveryStep> => {
    try {
        const delivery = await dependencies.revisionDelivery.deliverRevision({
            repository: input.repository,
            repositoryPath: input.repositoryPath,
            branch: input.branch,
            baseSha: revision.review.attempt.baseSha,
            expectedPriorHeadSha: revision.review.attempt.reviewedHeadSha,
            expectedStagedTreeSha: revision.verification.stagedTreeSha,
            message: revision.commitMessage,
            isFirstDelivery: false,
            context: {
                isCancelled: () => input.signal?.aborted === true,
            },
        });
        checkSignal(input.signal);
        return { kind: "delivered", delivery };
    } catch (error) {
        if (isCancellation(error, input.signal)) throw error;
        return { kind: "revision-failed", message: messageOf(error) };
    }
};

type CoordinatorTerminal =
    | {
          readonly status: "approved";
          readonly snapshot: PullRequestSnapshot;
          readonly review: PullRequestReviewAttemptResult;
      }
    | {
          readonly status: "pr-review-exhausted";
          readonly snapshot: PullRequestSnapshot;
          readonly reason: "review-attempt-budget-exhausted";
          readonly failedAttempt?: {
              readonly attempt: number;
              readonly message: string;
          };
      }
    | {
          readonly status: "needs-attention";
          readonly snapshot: PullRequestSnapshot;
          readonly phase: "review" | "revision-fix" | "commit-message";
          readonly request: NeedsAttentionRequest;
      }
    | {
          readonly status: "review-failed";
          readonly snapshot: PullRequestSnapshot;
          readonly attempt: number;
          readonly message: string;
      }
    | {
          readonly status: "head-moved";
          readonly phase: "before-fix" | "during-fix" | "after-delivery";
          readonly snapshot: PullRequestSnapshot;
      }
    | {
          readonly status: "revision-failed";
          readonly snapshot: PullRequestSnapshot;
          readonly message: string;
      };

type CoordinatorIteration =
    | CoordinatorTerminal
    | {
          readonly status: "retry-head";
          readonly snapshot: PullRequestSnapshot;
      }
    | {
          readonly status: "prepared";
          readonly review: PullRequestReviewAttemptResult;
          readonly revision: PreparedRevision;
      };

const runCoordinatorIteration = async (
    dependencies: PullRequestReviewCoordinatorDependencies,
    input: PullRequestReviewCoordinatorInput,
    snapshot: PullRequestSnapshot,
    attempt: number,
    reviews: PullRequestReviewAttemptResult[],
): Promise<CoordinatorIteration> => {
    const reviewStep = await invokeReviewAttempt(dependencies, input, snapshot);
    if (reviewStep.kind === "failed") {
        return attempt === REVIEW_ITERATION_LIMIT
            ? {
                  status: "pr-review-exhausted",
                  snapshot,
                  reason: "review-attempt-budget-exhausted",
                  failedAttempt: { attempt, message: reviewStep.message },
              }
            : {
                  status: "review-failed",
                  snapshot,
                  attempt,
                  message: reviewStep.message,
              };
    }

    const review = reviewStep.result;
    reviews.push(review);
    if (review.needsAttention !== undefined) {
        return {
            status: "needs-attention",
            snapshot: review.snapshot,
            phase: "review",
            request: review.needsAttention,
        };
    }
    if (review.approved) {
        return { status: "approved", snapshot: review.snapshot, review };
    }
    if (attempt === REVIEW_ITERATION_LIMIT) {
        return {
            status: "pr-review-exhausted",
            snapshot: review.snapshot,
            reason: "review-attempt-budget-exhausted",
        };
    }

    const rejected = await prepareRejectedReview(
        dependencies,
        input,
        review,
        attempt,
    );
    if (rejected.kind === "head-moved") {
        if (rejected.phase === "before-fix") {
            return { status: "retry-head", snapshot: rejected.snapshot };
        }
        return {
            status: "head-moved",
            phase: rejected.phase,
            snapshot: rejected.snapshot,
        };
    }
    if (rejected.kind === "needs-attention") {
        return {
            status: "needs-attention",
            snapshot: review.snapshot,
            phase: rejected.phase,
            request: rejected.request,
        };
    }
    if (rejected.kind === "revision-failed") {
        return {
            status: "revision-failed",
            snapshot: review.snapshot,
            message: rejected.message,
        };
    }
    return { status: "prepared", review, revision: rejected.revision };
};

type PostDeliveryStep =
    | {
          readonly status: "delivery-recoverable";
          readonly snapshot: PullRequestSnapshot;
          readonly delivery: Extract<
              GitRevisionDeliveryOutcome,
              { readonly status: "external-movement" | "ambiguous" }
          >;
      }
    | {
          readonly status: "head-moved";
          readonly phase: "after-delivery";
          readonly snapshot: PullRequestSnapshot;
      }
    | { readonly status: "continue"; readonly snapshot: PullRequestSnapshot };

const settleDeliveredRevision = async (
    dependencies: PullRequestReviewCoordinatorDependencies,
    input: PullRequestReviewCoordinatorInput,
    review: PullRequestReviewAttemptResult,
    delivery: GitRevisionDeliveryOutcome,
): Promise<PostDeliveryStep> => {
    if (isRecoverableDelivery(delivery)) {
        return {
            status: "delivery-recoverable",
            snapshot: review.snapshot,
            delivery,
        };
    }
    const next = await rereadSnapshot(dependencies, input, {
        ...review.snapshot,
        headSha: delivery.headSha,
    });
    if (!sameSha(next.headSha, delivery.headSha)) {
        return {
            status: "head-moved",
            phase: "after-delivery",
            snapshot: next,
        };
    }
    return { status: "continue", snapshot: next };
};

const processPreparedRevision = async (
    dependencies: PullRequestReviewCoordinatorDependencies,
    input: PullRequestReviewCoordinatorInput,
    iteration: Extract<CoordinatorIteration, { readonly status: "prepared" }>,
    revisions: PullRequestRevisionRecord[],
): Promise<
    | CoordinatorTerminal
    | PostDeliveryStep
    | { readonly status: "continue"; readonly snapshot: PullRequestSnapshot }
> => {
    const delivered = await deliverRevision(
        dependencies,
        input,
        iteration.revision,
    );
    if (delivered.kind === "revision-failed") {
        return {
            status: "revision-failed",
            snapshot: iteration.review.snapshot,
            message: delivered.message,
        };
    }
    const revision = { ...iteration.revision, delivery: delivered.delivery };
    revisions.push(revision);
    const postDelivery = await settleDeliveredRevision(
        dependencies,
        input,
        iteration.review,
        delivered.delivery,
    );
    if (postDelivery.status !== "continue") return postDelivery;
    return { status: "continue", snapshot: postDelivery.snapshot };
};

/**
 * Compose the post-creation review/revision state machine. Review attempts,
 * revision Git policy, and all mutable repository operations remain injected;
 * this service owns only ordering, the shared five-attempt budget, and safe
 * transitions between immutable PR heads.
 */
export const makePullRequestReviewCoordinatorService = (
    dependencies: PullRequestReviewCoordinatorDependencies,
): PullRequestReviewCoordinatorService => {
    const review = async (
        input: PullRequestReviewCoordinatorInput,
    ): Promise<PullRequestReviewCoordinatorResult> => {
        const reviews: PullRequestReviewAttemptResult[] = [];
        const revisions: PullRequestRevisionRecord[] = [];
        let currentSnapshot = input.snapshot;
        const history = (): CoordinatorHistory => ({ reviews, revisions });

        for (let attempt = 1; attempt <= REVIEW_ITERATION_LIMIT; attempt += 1) {
            checkSignal(input.signal);
            const iteration = await runCoordinatorIteration(
                dependencies,
                input,
                currentSnapshot,
                attempt,
                reviews,
            );
            if (iteration.status === "retry-head") {
                currentSnapshot = iteration.snapshot;
                continue;
            }
            if (iteration.status !== "prepared") {
                return { ...history(), ...iteration };
            }

            const processed = await processPreparedRevision(
                dependencies,
                input,
                iteration,
                revisions,
            );
            if (processed.status !== "continue") {
                return { ...history(), ...processed };
            }
            currentSnapshot = processed.snapshot;
        }

        throw new RalphieError({
            message: "Pull request review coordinator exhausted unexpectedly.",
        });
    };

    return { review, execute: review };
};

export const PullRequestReviewCoordinatorLive =
    makePullRequestReviewCoordinatorService;
