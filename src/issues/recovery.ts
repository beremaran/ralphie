import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
    type GitIssueCheckpointService,
    type IssueCheckpoint,
} from "../git/issue-checkpoint.ts";
import type { GitRepositoryInvariantService } from "../git/repository-invariant.ts";
import type { NeedsAttentionRequest } from "../agent/task-session.ts";
import type { GitHubIssue } from "../github/issues.ts";
import {
    type ProgressStage,
    type ProgressStatus,
    type ProgressReporterService,
} from "../progress/progress.ts";
import { RalphieError } from "../shared/error.ts";
import {
    needsAttentionDecisionSchema,
    type NeedsAttentionDecision,
    type ReviewDecision,
    ReviewVerdict,
} from "./decisions.ts";
import { resolveWorkspacePath } from "../workspace/workspace.ts";
import {
    IssueQueueResumeStrategy,
    type IssueWorkflowKind,
    REVIEW_ITERATION_LIMIT,
} from "./stage.ts";
import type { VerificationEvidence } from "./verification.ts";
import type { IssueFreshnessFingerprint } from "./artifacts.ts";

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

export type NeedsAttentionRecoveryInput = {
    readonly runId: string;
    readonly repository?: string;
    readonly workspace: string;
    readonly repositoryPath: string;
    readonly issue: GitHubIssue;
    readonly checkpoint: IssueCheckpoint;
    readonly fingerprint: IssueFreshnessFingerprint;
    /** The grounding decision that confirmed the agent's request. */
    readonly decision: NeedsAttentionDecision;
    /** The original bounded request from the mutating agent, when available. */
    readonly request?: NeedsAttentionRequest;
    /** Compatibility name for callers that retain the agent terminology. */
    readonly agentRequest?: NeedsAttentionRequest;
    /** May be supplied by callers when the service was assembled without one. */
    readonly repositoryInvariant?: GitRepositoryInvariantService;
};

export type NeedsAttentionRecoveryResult = {
    readonly diagnosticsPath: string;
};

export const REVIEW_DIAGNOSTIC_PATCH_LIMIT_BYTES = 10 * 1024 * 1024;
export const REVIEW_DIAGNOSTIC_METADATA_LIMIT_BYTES = 2 * 1024 * 1024;

export type IssueRecoveryService = {
    readonly handleReviewExhaustion: (
        input: ReviewExhaustionInput,
    ) => Promise<ReviewExhaustionResult>;
    readonly handleNeedsAttention: (
        input: NeedsAttentionRecoveryInput,
    ) => Promise<NeedsAttentionRecoveryResult>;
};

const safeRunId = (runId: string): string =>
    runId.replace(/[^a-zA-Z0-9_-]/g, "_") || "run";

const recoverableError = (message: string, cause: unknown): RalphieError =>
    cause instanceof RalphieError
        ? cause
        : new RalphieError({ message, cause });

const diagnosticPath = (
    input: Pick<ReviewExhaustionInput, "workspace" | "runId" | "issue">,
    name: string,
): string =>
    join(
        resolveWorkspacePath(input.workspace),
        ".ralphie",
        "runs",
        safeRunId(input.runId),
        "issues",
        String(input.issue.number),
        name,
    );

const needsAttentionDiagnosticName = (
    fingerprint: IssueFreshnessFingerprint,
): string =>
    `needs-attention-${createHash("sha256")
        .update(JSON.stringify(fingerprint))
        .digest("hex")
        .slice(0, 16)}`;

const persistDiagnostic = async (input: {
    readonly diagnosticsPath: string;
    readonly patch: string;
    readonly metadata: string;
    readonly description: string;
}): Promise<void> => {
    if (
        Buffer.byteLength(input.patch, "utf8") >
        REVIEW_DIAGNOSTIC_PATCH_LIMIT_BYTES
    ) {
        throw new RalphieError({
            message: `${input.description} patch exceeds ${REVIEW_DIAGNOSTIC_PATCH_LIMIT_BYTES} bytes. Checkout was not restored.`,
        });
    }
    if (
        Buffer.byteLength(input.metadata, "utf8") >
        REVIEW_DIAGNOSTIC_METADATA_LIMIT_BYTES
    ) {
        throw new RalphieError({
            message: `${input.description} metadata exceeds ${REVIEW_DIAGNOSTIC_METADATA_LIMIT_BYTES} bytes. Checkout was not restored.`,
        });
    }

    const temporaryPath = `${input.diagnosticsPath}.${randomUUID()}.tmp`;
    try {
        await mkdir(dirname(input.diagnosticsPath), { recursive: true });
        await mkdir(temporaryPath);
        await writeFile(join(temporaryPath, "changes.patch"), input.patch, {
            encoding: "utf8",
            flag: "wx",
        });
        await writeFile(join(temporaryPath, "metadata.json"), input.metadata, {
            encoding: "utf8",
            flag: "wx",
        });
        await rename(temporaryPath, input.diagnosticsPath);
    } catch (cause) {
        await rm(temporaryPath, { recursive: true, force: true }).catch(
            () => undefined,
        );
        throw new RalphieError({
            message: `Failed to preserve ${input.description.toLowerCase()} at ${input.diagnosticsPath}. Checkout was not restored.`,
            cause,
        });
    }
};

const needsAttentionMetadata = (
    input: NeedsAttentionRecoveryInput,
    diagnosticsPath: string,
): string => {
    const request = input.request ?? input.agentRequest;
    try {
        return `${JSON.stringify(
            {
                ...(input.repository === undefined
                    ? {}
                    : { repository: input.repository }),
                issue: input.issue,
                checkpoint: input.checkpoint,
                fingerprint: input.fingerprint,
                decision: input.decision,
                ...(request === undefined ? {} : { request }),
                createdAt: new Date().toISOString(),
            },
            null,
            2,
        )}\n`;
    } catch (cause) {
        throw recoverableError(
            `Failed to preserve needs-attention diagnostics at ${diagnosticsPath}. Checkout was not restored.`,
            cause,
        );
    }
};

const matchingDiagnostic = async (
    diagnosticsPath: string,
    metadata: string,
): Promise<boolean> => {
    try {
        const existing = JSON.parse(
            await readFile(join(diagnosticsPath, "metadata.json"), "utf8"),
        ) as Record<string, unknown>;
        const expected = JSON.parse(metadata) as Record<string, unknown>;
        const { createdAt: _existingCreatedAt, ...existingBinding } = existing;
        const { createdAt: _expectedCreatedAt, ...expectedBinding } = expected;
        if (
            JSON.stringify(existingBinding) !== JSON.stringify(expectedBinding)
        ) {
            throw new RalphieError({
                message: `Needs-attention diagnostics at ${diagnosticsPath} do not match the confirmed decision.`,
            });
        }
        return true;
    } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return false;
        throw recoverableError(
            `Failed to validate needs-attention diagnostics at ${diagnosticsPath}. Checkout was not restored.`,
            cause,
        );
    }
};

export const makeIssueRecoveryService = (
    git: GitIssueCheckpointService,
    progress: ProgressReporterService,
    repositoryInvariant?: GitRepositoryInvariantService,
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
        const diagnosticsPath = diagnosticPath(input, "review-exhaustion");
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
        await persistDiagnostic({
            diagnosticsPath,
            patch,
            metadata,
            description: "Review diagnostics",
        });
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

    const writeNeedsAttentionDiagnostics = async (
        input: NeedsAttentionRecoveryInput,
        patch?: string,
    ): Promise<
        { readonly path: string; readonly reused: boolean } | undefined
    > => {
        const diagnosticsPath = diagnosticPath(
            input,
            needsAttentionDiagnosticName(input.fingerprint),
        );
        const metadata = needsAttentionMetadata(input, diagnosticsPath);
        if (await matchingDiagnostic(diagnosticsPath, metadata)) {
            return { path: diagnosticsPath, reused: true };
        }
        if (patch === undefined) return undefined;
        await persistDiagnostic({
            diagnosticsPath,
            patch,
            metadata,
            description: "Needs-attention diagnostics",
        });
        return { path: diagnosticsPath, reused: false };
    };

    const restoreNeedsAttentionCheckout = async (
        input: NeedsAttentionRecoveryInput,
        diagnosticsPath: string,
        invariant: GitRepositoryInvariantService,
    ): Promise<void> => {
        const issueContext = {
            issue: {
                number: input.issue.number,
                title: input.issue.title,
            },
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
            await invariant.verify(input.repositoryPath, {
                branch: input.checkpoint.branch,
                head: input.checkpoint.sha,
            });
        } catch (cause) {
            await progress.emit({
                ...issueContext,
                stage: "checkout-restore",
                status: "failed",
                message: `Needs-attention checkout recovery failed: ${cause instanceof Error ? cause.message : String(cause)}`,
                details: { diagnosticsPath },
            });
            throw recoverableError(
                `Failed to restore the clean checkout for needs-attention recovery at ${diagnosticsPath}.`,
                cause,
            );
        }
        await progress.emit({
            ...issueContext,
            stage: "checkout-restore",
            status: "succeeded",
            message: `Restored ${input.checkpoint.branch} to the clean issue base.`,
            details: { diagnosticsPath },
        });
    };

    const validateNeedsAttention = (
        input: NeedsAttentionRecoveryInput,
    ): void => {
        try {
            needsAttentionDecisionSchema.parse(input.decision);
        } catch (cause) {
            throw new RalphieError({
                message:
                    "Needs-attention recovery requires a confirmed grounding decision.",
                cause,
            });
        }
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

        handleNeedsAttention: async (input) => {
            validateNeedsAttention(input);
            const invariant = input.repositoryInvariant ?? repositoryInvariant;
            if (invariant === undefined) {
                throw new RalphieError({
                    message:
                        "Needs-attention recovery requires a repository invariant service.",
                });
            }

            const existing = await writeNeedsAttentionDiagnostics(input);
            if (existing !== undefined) {
                await restoreNeedsAttentionCheckout(
                    input,
                    existing.path,
                    invariant,
                );
                return { diagnosticsPath: existing.path };
            }

            let patch: string;
            try {
                patch = await git.createPatch(input.repositoryPath);
            } catch (cause) {
                throw recoverableError(
                    "Failed to capture needs-attention diagnostics. Checkout was not restored.",
                    cause,
                );
            }
            const diagnostic = await writeNeedsAttentionDiagnostics(
                input,
                patch,
            );
            if (diagnostic === undefined) {
                throw new RalphieError({
                    message: "Needs-attention diagnostics were not persisted.",
                });
            }
            await restoreNeedsAttentionCheckout(
                input,
                diagnostic.path,
                invariant,
            );
            return { diagnosticsPath: diagnostic.path };
        },
    };
};

export const IssueRecoveryLive = makeIssueRecoveryService;