import { buildGroundingPrompt } from "../agent/prompts.ts";
import { requestStructuredOutput } from "../agent/structured-output.ts";
import type { ProgressReporterService } from "../progress/progress.ts";
import { RalphieError } from "../shared/error.ts";
import {
    type GroundingDecision,
    groundingDecisionSchema,
} from "./decisions.ts";
import type { IssueExecutionContext } from "./execution.ts";
import type { PiNeedsAttentionRequest } from "../agent/task-session.ts";

export type GroundingAssessmentResult = {
    readonly decision: GroundingDecision;
    readonly sessionID: string;
    readonly needsAttention?: PiNeedsAttentionRequest;
};

export type GroundingAssessmentService = {
    readonly assess: (
        context: IssueExecutionContext,
    ) => Promise<GroundingAssessmentResult>;
};

const messageOf = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

export const makeGroundingAssessmentService = (
    progress: ProgressReporterService,
): GroundingAssessmentService => ({
    assess: async (context) => {
        const issue = {
            number: context.issue.number,
            title: context.issue.title,
        };
        await progress.emit({
            issue,
            stage: "grounding",
            status: "started",
            message: `Checking whether #${context.issue.number} is actionable...`,
            details: { agentWorkSkipped: false },
        });
        try {
            const checkpoint = await context.repositoryInvariant.capture(
                context.repositoryPath,
            );
            if (checkpoint.branch !== context.targetBranch) {
                throw new RalphieError({
                    message: `Issue grounding requires branch ${context.targetBranch}, but checkout is on ${checkpoint.branch}.`,
                });
            }
            const result = await requestStructuredOutput(context.pi, {
                directory: context.repositoryPath,
                title: `Check readiness of issue #${context.issue.number}`,
                prompt: buildGroundingPrompt({
                    issue: context.issue,
                    repositoryPath: context.repositoryPath,
                    targetBranch: context.targetBranch,
                    headSha: checkpoint.head,
                }),
                schema: groundingDecisionSchema,
                agent: context.piSelection.agent,
                model: context.piSelection.model,
                variant:
                    context.piStageVariants?.grounding ??
                    context.piSelection.variant,
                runId: context.runId,
                diagnostics: context.piDiagnostics,
                repositoryInvariant: checkpoint,
                verifyRepositoryInvariant: context.repositoryInvariant.verify,
                progress,
                progressStage: "grounding",
                progressIssue: issue,
                signal: context.signal,
            });
            await progress.emit({
                issue,
                stage: "grounding",
                status: "succeeded",
                message: `Issue #${context.issue.number} is ${result.output.disposition.replaceAll("_", " ")}.`,
                details: {
                    disposition: result.output.disposition,
                    sessionID: result.sessionID,
                    agentWorkSkipped: false,
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
                stage: "grounding",
                status: "failed",
                message: `Issue grounding failed: ${messageOf(error)}`,
                details: { agentWorkSkipped: false },
            });
            throw error;
        }
    },
});

export const GroundingAssessmentLive = makeGroundingAssessmentService;