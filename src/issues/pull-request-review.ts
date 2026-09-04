import { z } from "zod";

import type { Octokit } from "octokit";

import { buildPullRequestReviewPrompt } from "../agent/prompts.ts";
import type { AgentSelection } from "../agent/model.ts";
import { AgentSessionProfile, type AgentClient } from "../opencode/client.ts";
import type {
    AgentSessionDiagnostics,
    NeedsAttentionRequest,
} from "../agent/task-session.ts";
import type { GitIssueOperationsService } from "../git/issue-operations.ts";
import { requestStructuredOutput } from "../agent/structured-output.ts";
import type { GitHubIssue } from "../github/issues.ts";
import type {
    GitHubPullRequestService,
    PullRequestSnapshot,
} from "../github/pull-requests.ts";
import { RalphieError } from "../shared/error.ts";

import {
    ReviewFindingSeverity,
    ReviewVerdict,
    reviewDecisionSchema,
} from "./decisions.ts";
import type { IssueArtifactKind, IssueArtifactStore } from "./artifacts.ts";
import { REVIEW_ITERATION_LIMIT } from "./stage.ts";

/** Kept as literals here to avoid a runtime cycle with artifacts.ts. */
const PULL_REQUEST_REVIEW_ATTEMPTS_KIND =
    "pull-request-review-attempts" as IssueArtifactKind.PullRequestReviewAttempts;
const APPROVED_PULL_REQUEST_REVIEW_EVIDENCE_KIND =
    "approved-pull-request-review-evidence" as IssueArtifactKind.ApprovedPullRequestReviewEvidence;

/** Full object IDs are required so review evidence cannot follow a moving ref. */
export const gitObjectIdSchema = z
    .string()
    .regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i);

export const pullRequestReviewAttemptSchema = z
    .object({
        pullRequestNumber: z.number().int().positive(),
        baseSha: gitObjectIdSchema,
        reviewedHeadSha: gitObjectIdSchema,
        attempt: z.number().int().positive(),
        sessionID: z.string().min(1),
        decision: reviewDecisionSchema,
    })
    .strict();

export type PullRequestReviewAttempt = z.infer<
    typeof pullRequestReviewAttemptSchema
>;

/** A recoverable attempt history is ordered and permanently scoped to one PR/base. */
export const pullRequestReviewAttemptsSchema = z
    .array(pullRequestReviewAttemptSchema)
    .superRefine((attempts, context) => {
        const first = attempts[0];
        for (const [index, attempt] of attempts.entries()) {
            if (attempt.attempt !== index + 1) {
                context.addIssue({
                    code: "custom",
                    message: "Pull request review attempts must be ordered.",
                    path: [index, "attempt"],
                });
            }
            if (
                first &&
                (attempt.pullRequestNumber !== first.pullRequestNumber ||
                    attempt.baseSha !== first.baseSha)
            ) {
                context.addIssue({
                    code: "custom",
                    message:
                        "Pull request review attempts must share one PR/base.",
                    path: [index],
                });
            }
        }
    });

/** Durable proof of approval, permanently scoped to one PR head. */
export const approvedPullRequestReviewEvidenceSchema =
    pullRequestReviewAttemptSchema.refine(
        (attempt) => attempt.decision.verdict === ReviewVerdict.Approved,
        {
            message:
                "Approved review evidence must contain an approved decision.",
        },
    );

export type ApprovedPullRequestReviewEvidence = z.infer<
    typeof approvedPullRequestReviewEvidenceSchema
>;

export type PullRequestReviewAttemptIdentity = Pick<
    PullRequestReviewAttempt,
    | "pullRequestNumber"
    | "baseSha"
    | "reviewedHeadSha"
    | "attempt"
    | "sessionID"
>;

export type PullRequestReviewAttemptInput = {
    /** GitHub client used only for the authoritative PR reread. */
    readonly client: Octokit;
    readonly repository: string;
    readonly repositoryPath: string;
    readonly targetBranch: string;
    readonly issue: GitHubIssue;
    readonly snapshot: PullRequestSnapshot;
    /** OpenCode/Pi client; the service creates one new session per call. */
    readonly agent: AgentClient;
    readonly agentSelection: AgentSelection;
    readonly artifacts: IssueArtifactStore;
    readonly runId?: string;
    readonly diagnostics?: AgentSessionDiagnostics;
    readonly signal?: AbortSignal;
};

export type PullRequestReviewAttemptResult = {
    /** The exact identity recorded in the attempt artifact. */
    readonly identity: PullRequestReviewAttemptIdentity;
    readonly attempt: PullRequestReviewAttempt;
    /** The authoritative snapshot returned by the final PR reread. */
    readonly snapshot: PullRequestSnapshot;
    readonly decision: PullRequestReviewAttempt["decision"];
    /** True only for a valid approved decision with no blocking finding. */
    readonly approved: boolean;
    readonly needsAttention?: NeedsAttentionRequest;
};

export type PullRequestReviewAttemptServiceDependencies = {
    readonly pullRequests: Pick<
        GitHubPullRequestService,
        "rereadMatchingSnapshot"
    >;
    readonly issueOperations: Pick<
        GitIssueOperationsService,
        "readCommittedBinaryDiff"
    >;
};

export type PullRequestReviewAttemptService = {
    readonly review: (
        input: PullRequestReviewAttemptInput,
    ) => Promise<PullRequestReviewAttemptResult>;
    /** Compatibility name for orchestrators that model each call as execution. */
    readonly execute: (
        input: PullRequestReviewAttemptInput,
    ) => Promise<PullRequestReviewAttemptResult>;
};

const checkSignal = (signal: AbortSignal | undefined): void => {
    signal?.throwIfAborted();
};

const sameObjectId = (left: string, right: string): boolean =>
    left.toLowerCase() === right.toLowerCase();

const nextAttemptFor = async (
    artifacts: IssueArtifactStore,
): Promise<number> => {
    const attempts = artifacts.has(PULL_REQUEST_REVIEW_ATTEMPTS_KIND)
        ? await artifacts.read(PULL_REQUEST_REVIEW_ATTEMPTS_KIND)
        : [];
    const attempt = attempts.length + 1;
    if (attempt > REVIEW_ITERATION_LIMIT) {
        throw new RalphieError({
            message: `Pull request review attempt budget exhausted for issue ${artifacts.issueNumber}.`,
        });
    }
    return attempt;
};

const identityOf = (
    attempt: PullRequestReviewAttempt,
): PullRequestReviewAttemptIdentity => ({
    pullRequestNumber: attempt.pullRequestNumber,
    baseSha: attempt.baseSha,
    reviewedHeadSha: attempt.reviewedHeadSha,
    attempt: attempt.attempt,
    sessionID: attempt.sessionID,
});

type ReviewDecisionRequest = {
    readonly snapshot: PullRequestSnapshot;
    readonly attempt: number;
    readonly committedDiff: string;
};

const requestReviewDecision = async (
    input: PullRequestReviewAttemptInput,
    request: ReviewDecisionRequest,
) =>
    await requestStructuredOutput(input.agent, {
        directory: input.repositoryPath,
        title: `Review pull request #${request.snapshot.number} (attempt ${request.attempt})`,
        prompt: buildPullRequestReviewPrompt({
            issue: input.issue,
            repositoryPath: input.repositoryPath,
            targetBranch: input.targetBranch,
            pullRequestNumber: request.snapshot.number,
            pullRequestUrl: request.snapshot.url,
            baseSha: request.snapshot.baseSha,
            reviewedHeadSha: request.snapshot.headSha,
            committedDiff: request.committedDiff,
        }),
        schema: reviewDecisionSchema,
        profile: AgentSessionProfile.Review,
        agent: input.agentSelection.agent,
        model: input.agentSelection.model,
        variant: input.agentSelection.variant,
        runId: input.runId,
        diagnostics: input.diagnostics,
        signal: input.signal,
    });

/**
 * Assemble one immutable, fresh-session PR review attempt. GitHub reread,
 * committed-diff loading, Pi execution, and artifact writes are deliberately
 * injected so the orchestration policy remains outside this service.
 */
export const makePullRequestReviewAttemptService = (
    dependencies: PullRequestReviewAttemptServiceDependencies,
): PullRequestReviewAttemptService => {
    const review = async (
        input: PullRequestReviewAttemptInput,
    ): Promise<PullRequestReviewAttemptResult> => {
        checkSignal(input.signal);
        if (input.artifacts.issueNumber !== input.issue.number) {
            throw new RalphieError({
                message: `Pull request review artifacts belong to issue ${input.artifacts.issueNumber}, not issue ${input.issue.number}.`,
            });
        }

        const authoritativeSnapshot =
            await dependencies.pullRequests.rereadMatchingSnapshot(
                input.client,
                input.repository,
                input.snapshot,
                input.signal,
            );
        checkSignal(input.signal);
        if (
            authoritativeSnapshot.number !== input.snapshot.number ||
            !sameObjectId(authoritativeSnapshot.baseSha, input.snapshot.baseSha)
        ) {
            throw new RalphieError({
                message: `Pull request #${input.snapshot.number} no longer matches its captured PR/base snapshot.`,
            });
        }

        const attempt = await nextAttemptFor(input.artifacts);
        checkSignal(input.signal);
        const committedDiff =
            await dependencies.issueOperations.readCommittedBinaryDiff(
                input.repositoryPath,
                authoritativeSnapshot.baseSha,
                authoritativeSnapshot.headSha,
                input.signal,
            );
        checkSignal(input.signal);

        const result = await requestReviewDecision(input, {
            snapshot: authoritativeSnapshot,
            attempt,
            committedDiff,
        });
        checkSignal(input.signal);

        const reviewAttempt: PullRequestReviewAttempt = {
            pullRequestNumber: authoritativeSnapshot.number,
            baseSha: authoritativeSnapshot.baseSha,
            reviewedHeadSha: authoritativeSnapshot.headSha,
            attempt,
            sessionID: result.sessionID,
            decision: result.output,
        };

        await input.artifacts.appendPullRequestReview(
            reviewAttempt,
            input.signal,
        );
        checkSignal(input.signal);

        const approved =
            result.needsAttention === undefined &&
            result.output.verdict === ReviewVerdict.Approved &&
            result.output.findings.every(
                (finding) =>
                    finding.severity !== ReviewFindingSeverity.Blocking,
            );
        if (
            approved &&
            !input.artifacts.has(APPROVED_PULL_REQUEST_REVIEW_EVIDENCE_KIND)
        ) {
            await input.artifacts.write(
                APPROVED_PULL_REQUEST_REVIEW_EVIDENCE_KIND,
                reviewAttempt,
                input.signal,
            );
            checkSignal(input.signal);
        }

        return {
            identity: identityOf(reviewAttempt),
            attempt: reviewAttempt,
            snapshot: authoritativeSnapshot,
            decision: result.output,
            approved,
            ...(result.needsAttention === undefined
                ? {}
                : { needsAttention: result.needsAttention }),
        };
    };

    return { review, execute: review };
};