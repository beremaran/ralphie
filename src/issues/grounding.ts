import { buildGroundingPrompt } from "../agent/prompts.ts";
import { requestStructuredOutput } from "../agent/structured-output.ts";
import type { ProgressReporterService } from "../progress/progress.ts";
import { RalphieError } from "../shared/error.ts";
import {
    type GroundingDecision,
    groundingDecisionSchema,
} from "./decisions.ts";
import type { IssueExecutionContext } from "./execution.ts";

export type GroundingAssessmentResult = {
    readonly decision: GroundingDecision;
    readonly sessionID: string;
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
            stage: "issue-grounding",
            status: "started",
            message: `Checking whether #${context.issue.number} is actionable...`,
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
                }),
                schema: groundingDecisionSchema,
                agent: context.piSelection.agent,
                model: context.piSelection.model,
                variant: context.piSelection.variant,
                runId: context.runId,
                diagnostics: context.piDiagnostics,
                verifyAfter: () =>
                    context.repositoryInvariant.verify(
                        context.repositoryPath,
                        checkpoint,
                    ),
                progress,
                progressStage: "issue-grounding",
                progressIssue: issue,
                signal: context.signal,
            });
            await progress.emit({
                issue,
                stage: "issue-grounding",
                status: "succeeded",
                message: `Issue #${context.issue.number} is ${result.output.disposition.replaceAll("_", " ")}.`,
                details: { disposition: result.output.disposition },
            });
            return { decision: result.output, sessionID: result.sessionID };
        } catch (error) {
            await progress.emit({
                issue,
                stage: "issue-grounding",
                status: "failed",
                message: `Issue grounding failed: ${messageOf(error)}`,
            });
            throw error;
        }
    },
});

export const GroundingAssessmentLive = makeGroundingAssessmentService;