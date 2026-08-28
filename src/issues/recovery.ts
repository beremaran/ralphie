import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
    type GitIssueCheckpointService,
    type IssueCheckpoint,
} from "../git/issue-checkpoint.ts";
import type { GitHubIssue } from "../github/issues.ts";
import {
    type ProgressStage,
    type ProgressStatus,
    type ProgressReporterService,
} from "../progress/progress.ts";
import { RalphieError } from "../shared/error.ts";
import { resolveWorkspacePath } from "../workspace/workspace.ts";
import { type ReviewDecision, ReviewVerdict } from "./decisions.ts";
import {
    IssueQueueResumeStrategy,
    type IssueWorkflowKind,
    REVIEW_ITERATION_LIMIT,
} from "./stage.ts";
import type { VerificationEvidence } from "./verification.ts";

export type ReviewAttempt = {
    readonly attempt: number;
    readonly sessionID: string;
    /** Exact staged tree reviewed; absent only in legacy persisted attempts. */
    readonly stagedTreeSha?: string;
    /** Deterministic gate output trusted by the reviewer; absent in legacy attempts. */
    readonly verification?: VerificationEvidence;
    readonly decision: ReviewDecision;
};

export type ReviewExhaustionInput = {
    readonly runId: string;
    readonly repository?: string;
    readonly workspace: string;
    readonly repositoryPath: string;
    readonly issue: GitHubIssue;
    readonly checkpoint: IssueCheckpoint;
    readonly reviews: ReadonlyArray<ReviewAttempt>;
};

export type ReviewExhaustionOutcome = "escalated-to-decomposition";

export type ReviewExhaustionResult = {
    readonly outcome: "escalated-to-decomposition";
    readonly diagnosticsPath: string;
    readonly nextWorkflow: "decomposition";
    readonly resume: IssueQueueResumeStrategy;
};

export const REVIEW_DIAGNOSTIC_PATCH_LIMIT_BYTES = 10 * 1024 * 1024;
export const REVIEW_DIAGNOSTIC_METADATA_LIMIT_BYTES = 2 * 1024 * 1024;

export type IssueRecoveryService = {
    readonly handleReviewExhaustion: (
        input: ReviewExhaustionInput,
    ) => Promise<ReviewExhaustionResult>;
};

const safeRunId = (runId: string): string =>
    runId.replace(/[^a-zA-Z0-9_-]/g, "_") || "run";

export const makeIssueRecoveryService = (
    git: GitIssueCheckpointService,
    progress: ProgressReporterService,
): IssueRecoveryService => {
    const validateReviewExhaustion = (input: ReviewExhaustionInput): void => {
        const attemptsAreComplete = input.reviews.every(
            (review, index) => review.attempt === index + 1,
        );
        const lastReview = input.reviews.at(-1);
        if (
            input.reviews.length !== REVIEW_ITERATION_LIMIT ||
            !attemptsAreComplete ||
            lastReview?.decision.verdict !== ReviewVerdict.ChangesRequested
        ) {
            throw new RalphieError({
                message: `Review exhaustion requires ${REVIEW_ITERATION_LIMIT} ordered attempts ending in changes requested.`,
            });
        }
    };

    const writeDiagnostics = async (
        input: ReviewExhaustionInput,
        patch: string,
    ): Promise<string> => {
        if (Buffer.byteLength(patch) > REVIEW_DIAGNOSTIC_PATCH_LIMIT_BYTES) {
            throw new RalphieError({
                message: `Review diagnostic patch exceeds ${REVIEW_DIAGNOSTIC_PATCH_LIMIT_BYTES} bytes. Checkout was not restored.`,
            });
        }
        const metadata = `${JSON.stringify(
            {
                ...(input.repository === undefined
                    ? {}
                    : { repository: input.repository }),
                issue: input.issue,
                checkpoint: input.checkpoint,
                reviews: input.reviews,
                createdAt: new Date().toISOString(),
            },
            null,
            2,
        )}\n`;
        if (
            Buffer.byteLength(metadata) > REVIEW_DIAGNOSTIC_METADATA_LIMIT_BYTES
        ) {
            throw new RalphieError({
                message: `Review diagnostic metadata exceeds ${REVIEW_DIAGNOSTIC_METADATA_LIMIT_BYTES} bytes. Checkout was not restored.`,
            });
        }
        const diagnosticsPath = join(
            resolveWorkspacePath(input.workspace),
            ".ralphie",
            "runs",
            safeRunId(input.runId),
            "issues",
            String(input.issue.number),
            "review-exhaustion",
        );
        try {
            await mkdir(diagnosticsPath, { recursive: true });
            await Promise.all([
                writeFile(join(diagnosticsPath, "changes.patch"), patch),
                writeFile(join(diagnosticsPath, "metadata.json"), metadata),
            ]);
        } catch (cause) {
            throw new RalphieError({
                message: `Failed to preserve review diagnostics at ${diagnosticsPath}. Checkout was not restored.`,
                cause,
            });
        }
        return diagnosticsPath;
    };

    const restoreCheckout = async (
        input: ReviewExhaustionInput,
        diagnosticsPath: string,
    ): Promise<void> => {
        const issueContext = {
            issue: {
                number: input.issue.number,
                title: input.issue.title,
            },
            attempt: input.reviews.length,
            maxAttempts: REVIEW_ITERATION_LIMIT,
        };

        await progress.emit({
            ...issueContext,
            stage: "checkout-restore",
            status: "started",
            message: `Restoring ${input.checkpoint.branch} to ${input.checkpoint.sha}...`,
            details: { diagnosticsPath },
        });
        try {
            await git.restore(input.repositoryPath, input.checkpoint);
        } catch (error) {
            await progress.emit({
                ...issueContext,
                stage: "checkout-restore",
                status: "failed",
                message: `Checkout restoration failed: ${error instanceof Error ? error.message : String(error)}`,
                details: { diagnosticsPath },
            });
            throw error;
        }
        await progress.emit({
            ...issueContext,
            stage: "checkout-restore",
            status: "succeeded",
            message: `Restored ${input.checkpoint.branch} to the clean issue base.`,
            details: { diagnosticsPath },
        });
    };

    return {
        handleReviewExhaustion: async (input) => {
            validateReviewExhaustion(input);
            const issueContext = {
                issue: {
                    number: input.issue.number,
                    title: input.issue.title,
                },
                attempt: input.reviews.length,
                maxAttempts: REVIEW_ITERATION_LIMIT,
            };
            await progress.emit({
                ...issueContext,
                stage: "review-exhaustion",
                status: "info",
                message: `Review did not converge; escalating #${input.issue.number} to decomposition.`,
            });

            const patch = await git.createPatch(input.repositoryPath);
            const diagnosticsPath = await writeDiagnostics(input, patch);
            await restoreCheckout(input, diagnosticsPath);

            return {
                outcome: "escalated-to-decomposition",
                diagnosticsPath,
                nextWorkflow: "decomposition",
                resume: IssueQueueResumeStrategy,
            };
        },
    };
};

export const IssueRecoveryLive = makeIssueRecoveryService;