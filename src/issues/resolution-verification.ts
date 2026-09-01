import { buildResolutionVerificationPrompt } from "../agent/prompts.ts";
import { requestStructuredOutput } from "../agent/structured-output.ts";
import type { ProgressReporterService } from "../progress/progress.ts";
import { RalphieError } from "../shared/error.ts";
import {
    resolutionVerificationDecisionSchema,
    type ResolutionVerificationDecision,
    IssueResolutionStatus,
} from "./decisions.ts";
import type { IssueExecutionContext } from "./execution.ts";
import type { CodexNeedsAttentionRequest } from "../agent/task-session.ts";

export type ResolutionVerificationResult = {
    readonly decision: ResolutionVerificationDecision;
    readonly sessionID: string;
    readonly needsAttention?: CodexNeedsAttentionRequest;
};

export type ResolutionVerificationService = {
    readonly verify: (
        context: IssueExecutionContext,
    ) => Promise<ResolutionVerificationResult>;
};

const messageOf = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

/**
 * Run the fresh, read-only check used when an implementation produces no
 * changes. Keeping this contract in a service lets other routes verify an
 * already-resolved issue without sharing an agent session or implementation
 * context.
 */
export const makeResolutionVerificationService = (
    progress: ProgressReporterService,
): ResolutionVerificationService => ({
    verify: async (context) => {
        const issue = {
            number: context.issue.number,
            title: context.issue.title,
        };
        await progress.emit({
            issue,
            stage: "resolution-verification",
            status: "started",
            message: "Verifying whether the issue is already resolved...",
        });
        try {
            const checkpoint = await context.repositoryInvariant.capture(
                context.repositoryPath,
            );
            if (checkpoint.branch !== context.targetBranch) {
                throw new RalphieError({
                    message: `Resolution verification requires branch ${context.targetBranch}, but checkout is on ${checkpoint.branch}.`,
                });
            }
            const result = await requestStructuredOutput(context.codex, {
                directory: context.repositoryPath,
                title: `Verify resolution of issue #${context.issue.number}`,
                prompt: buildResolutionVerificationPrompt({
                    issue: context.issue,
                    repositoryPath: context.repositoryPath,
                    targetBranch: context.targetBranch,
                }),
                schema: resolutionVerificationDecisionSchema,
                agent: context.codexSelection.agent,
                model: context.codexSelection.model,
                variant: context.codexSelection.variant,
                runId: context.runId,
                diagnostics: context.codexDiagnostics,
                repositoryInvariant: checkpoint,
                verifyRepositoryInvariant: context.repositoryInvariant.verify,
                progress,
                progressStage: "resolution-verification",
                progressIssue: issue,
                signal: context.signal,
            });
            await progress.emit({
                issue,
                stage: "resolution-verification",
                status: "succeeded",
                message:
                    result.output.status === IssueResolutionStatus.Resolved
                        ? "Issue is already resolved in the current checkout."
                        : "Issue remains unresolved in the current checkout.",
                details: {
                    status: result.output.status,
                    sessionID: result.sessionID,
                },
            });
            return {
                decision: result.output,
                sessionID: result.sessionID,
                ...(result.needsAttention === undefined
                    ? {}
                    : { needsAttention: result.needsAttention }),
            };
        } catch (error) {
            await progress.emit({
                issue,
                stage: "resolution-verification",
                status: "failed",
                message: `Resolution verification failed: ${messageOf(error)}`,
            });
            throw error;
        }
    },
});

export const ResolutionVerificationLive = makeResolutionVerificationService;
export const makeIssueResolutionVerificationService =
    makeResolutionVerificationService;
export const IssueResolutionVerificationLive =
    makeResolutionVerificationService;