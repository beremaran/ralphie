import { createHash } from "node:crypto";
import { join } from "node:path";

import {
    type GitIssueCheckpointService,
    type IssueCheckpoint,
} from "../../git/ports.ts";
import { type GitRepositoryInvariantService } from "../../git/ports.ts";
import type { HandOffRequest } from "../../agent/task-session.ts";
import type { GitHubIssue } from "../../github/domain.ts";
import { type ProgressReporterService } from "../../progress/ports.ts";
import {
    errorMessage,
    hasErrorCode,
    RalphieError,
} from "../../shared/error.ts";
import {
    handOffDecisionSchema,
    type HandOffDecision,
    type ReviewDecision,
    ReviewVerdict,
} from "../domain/decisions.ts";
import type { Clock, IdGenerator, RunLayout } from "../../run/ports.ts";
import { IssueQueueResumeStrategy } from "../domain/stage.ts";
import type { VerificationEvidence } from "./verification.ts";
import type { IssueFreshnessFingerprint } from "./artifacts.ts";

/** File operations used by the diagnostic archive boundary. */
export type RecoveryFileSystem = {
    readonly mkdir: (
        directory: string,
        options?: { readonly recursive: true },
    ) => Promise<void>;
    readonly readFile: (filePath: string, encoding: "utf8") => Promise<string>;
    readonly writeFile: (
        filePath: string,
        contents: string,
        options: { readonly encoding: "utf8"; readonly flag: "wx" },
    ) => Promise<void>;
    readonly rename: (temporaryPath: string, filePath: string) => Promise<void>;
    readonly rm: (
        filePath: string,
        options: { readonly recursive: true; readonly force: true },
    ) => Promise<void>;
};

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
    /** The review budget these attempts exhausted. */
    readonly reviewRounds: number;
};

export type ReviewExhaustionOutcome = "escalated-to-decomposition";

export type ReviewExhaustionResult = {
    readonly outcome: "escalated-to-decomposition";
    readonly diagnosticsPath: string;
    readonly nextWorkflow: "decomposition";
    readonly resume: IssueQueueResumeStrategy;
};

export type HandOffRecoveryInput = {
    readonly runId: string;
    readonly repository?: string;
    readonly workspace: string;
    readonly repositoryPath: string;
    readonly issue: GitHubIssue;
    readonly checkpoint: IssueCheckpoint;
    readonly fingerprint: IssueFreshnessFingerprint;
    /** The grounding decision that confirmed the agent's request. */
    readonly decision: HandOffDecision;
    /** The original bounded request from the mutating agent, if any. */
    readonly request?: HandOffRequest;
    /** May be supplied by callers when the service was assembled without one. */
    readonly repositoryInvariant?: GitRepositoryInvariantService;
    /** Caller cancellation observed by the invariant verification. */
    readonly signal?: AbortSignal;
};

export type HandOffRecoveryResult = {
    readonly diagnosticsPath: string;
};

export const REVIEW_DIAGNOSTIC_PATCH_LIMIT_BYTES = 10 * 1024 * 1024;
export const REVIEW_DIAGNOSTIC_METADATA_LIMIT_BYTES = 2 * 1024 * 1024;

export type IssueRecoveryService = {
    readonly handleReviewExhaustion: (
        input: ReviewExhaustionInput,
    ) => Promise<ReviewExhaustionResult>;
    readonly handleHandOff: (
        input: HandOffRecoveryInput,
    ) => Promise<HandOffRecoveryResult>;
};

const recoverableError = (message: string, cause: unknown): RalphieError =>
    cause instanceof RalphieError
        ? cause
        : new RalphieError({ message, cause });

const diagnosticPath = (
    layout: RunLayout,
    input: Pick<ReviewExhaustionInput, "issue">,
    name: string,
): string => layout.diagnosticsPath(input.issue.number, name);

const handOffDiagnosticName = (
    fingerprint: IssueFreshnessFingerprint,
): string =>
    `hand-off-${createHash("sha256")
        .update(JSON.stringify(fingerprint))
        .digest("hex")
        .slice(0, 16)}`;

const persistDiagnostic = async (
    fileSystem: RecoveryFileSystem,
    ids: IdGenerator,
    input: {
        readonly directory: string;
        readonly diagnosticsPath: string;
        readonly patch: string;
        readonly metadata: string;
        readonly description: string;
    },
): Promise<void> => {
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

    const temporaryPath = `${input.diagnosticsPath}.${ids.next()}.tmp`;
    try {
        await fileSystem.mkdir(input.directory, { recursive: true });
        await fileSystem.mkdir(temporaryPath);
        await fileSystem.writeFile(
            join(temporaryPath, "changes.patch"),
            input.patch,
            { encoding: "utf8", flag: "wx" },
        );
        await fileSystem.writeFile(
            join(temporaryPath, "metadata.json"),
            input.metadata,
            { encoding: "utf8", flag: "wx" },
        );
        await fileSystem.rename(temporaryPath, input.diagnosticsPath);
    } catch (cause) {
        await fileSystem
            .rm(temporaryPath, { recursive: true, force: true })
            .catch(() => undefined);
        throw new RalphieError({
            message: `Failed to preserve ${input.description.toLowerCase()} at ${input.diagnosticsPath}. Checkout was not restored.`,
            cause,
        });
    }
};

const handOffMetadata = (
    input: HandOffRecoveryInput,
    diagnosticsPath: string,
    clock: Clock,
): string => {
    const request = input.request;
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
                createdAt: clock.now().toISOString(),
            },
            null,
            2,
        )}\n`;
    } catch (cause) {
        throw recoverableError(
            `Failed to preserve hand-off diagnostics at ${diagnosticsPath}. Checkout was not restored.`,
            cause,
        );
    }
};

const matchingDiagnostic = async (
    fileSystem: RecoveryFileSystem,
    diagnosticsPath: string,
    metadata: string,
): Promise<boolean> => {
    try {
        const existing = JSON.parse(
            await fileSystem.readFile(
                join(diagnosticsPath, "metadata.json"),
                "utf8",
            ),
        ) as Record<string, unknown>;
        const expected = JSON.parse(metadata) as Record<string, unknown>;
        const { createdAt: _existingCreatedAt, ...existingBinding } = existing;
        const { createdAt: _expectedCreatedAt, ...expectedBinding } = expected;
        if (
            JSON.stringify(existingBinding) !== JSON.stringify(expectedBinding)
        ) {
            throw new RalphieError({
                message: `Hand-off diagnostics at ${diagnosticsPath} do not match the confirmed decision.`,
            });
        }
        return true;
    } catch (cause) {
        if (hasErrorCode(cause, "ENOENT") || hasErrorCode(cause, "ENOTDIR"))
            return false;
        throw recoverableError(
            `Failed to validate hand-off diagnostics at ${diagnosticsPath}. Checkout was not restored.`,
            cause,
        );
    }
};

export type IssueRecoveryServiceOptions = {
    readonly fileSystem: RecoveryFileSystem;
    readonly layout: RunLayout;
    readonly clock: Clock;
    readonly ids: IdGenerator;
};

export const makeIssueRecoveryService = (
    { fileSystem, layout, clock, ids }: IssueRecoveryServiceOptions,
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
            input.reviews.length !== input.reviewRounds ||
            !attemptsAreComplete ||
            lastReview?.decision.verdict !== ReviewVerdict.ChangesRequested
        ) {
            throw new RalphieError({
                message: `Review exhaustion requires ${input.reviewRounds} ordered attempts ending in changes requested.`,
            });
        }
    };

    const writeDiagnostics = async (
        input: ReviewExhaustionInput,
        patch: string,
    ): Promise<string> => {
        const diagnosticsPath = diagnosticPath(
            layout,
            input,
            "review-exhaustion",
        );
        const metadata = `${JSON.stringify(
            {
                ...(input.repository === undefined
                    ? {}
                    : { repository: input.repository }),
                issue: input.issue,
                checkpoint: input.checkpoint,
                reviews: input.reviews,
                createdAt: clock.now().toISOString(),
            },
            null,
            2,
        )}\n`;
        await persistDiagnostic(fileSystem, ids, {
            directory: layout.diagnosticsDirectory(input.issue.number),
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
            maxAttempts: input.reviewRounds,
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
                message: `Checkout restoration failed: ${errorMessage(error)}`,
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

    const writeHandOffDiagnostics = async (
        input: HandOffRecoveryInput,
        patch?: string,
    ): Promise<
        { readonly path: string; readonly reused: boolean } | undefined
    > => {
        const diagnosticsPath = diagnosticPath(
            layout,
            input,
            handOffDiagnosticName(input.fingerprint),
        );
        const metadata = handOffMetadata(input, diagnosticsPath, clock);
        if (await matchingDiagnostic(fileSystem, diagnosticsPath, metadata)) {
            return { path: diagnosticsPath, reused: true };
        }
        if (patch === undefined) return undefined;
        await persistDiagnostic(fileSystem, ids, {
            directory: layout.diagnosticsDirectory(input.issue.number),
            diagnosticsPath,
            patch,
            metadata,
            description: "Hand-off diagnostics",
        });
        return { path: diagnosticsPath, reused: false };
    };

    const restoreHandOffCheckout = async (
        input: HandOffRecoveryInput,
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
            await invariant.verify(
                input.repositoryPath,
                {
                    branch: input.checkpoint.branch,
                    head: input.checkpoint.sha,
                },
                input.signal,
            );
        } catch (cause) {
            await progress.emit({
                ...issueContext,
                stage: "checkout-restore",
                status: "failed",
                message: `Hand-off checkout recovery failed: ${errorMessage(cause)}`,
                details: { diagnosticsPath },
            });
            throw recoverableError(
                `Failed to restore the clean checkout for hand-off recovery at ${diagnosticsPath}.`,
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

    const validateHandOff = (input: HandOffRecoveryInput): void => {
        try {
            handOffDecisionSchema.parse(input.decision);
        } catch (cause) {
            throw new RalphieError({
                message:
                    "Hand-off recovery requires a confirmed grounding decision.",
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
                maxAttempts: input.reviewRounds,
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

        handleHandOff: async (input) => {
            validateHandOff(input);
            const invariant = input.repositoryInvariant ?? repositoryInvariant;
            if (invariant === undefined) {
                throw new RalphieError({
                    message:
                        "Hand-off recovery requires a repository invariant service.",
                });
            }

            const existing = await writeHandOffDiagnostics(input);
            if (existing !== undefined) {
                await restoreHandOffCheckout(input, existing.path, invariant);
                return { diagnosticsPath: existing.path };
            }

            let patch: string;
            try {
                patch = await git.createPatch(input.repositoryPath);
            } catch (cause) {
                throw recoverableError(
                    "Failed to capture hand-off diagnostics. Checkout was not restored.",
                    cause,
                );
            }
            const diagnostic = await writeHandOffDiagnostics(input, patch);
            if (diagnostic === undefined) {
                throw new RalphieError({
                    message: "Hand-off diagnostics were not persisted.",
                });
            }
            await restoreHandOffCheckout(input, diagnostic.path, invariant);
            return { diagnosticsPath: diagnostic.path };
        },
    };
};