import { requestStructuredOutput } from "../agent/structured-output.ts";
import { buildComplexityPrompt } from "../agent/prompts.ts";
import {
    type ProgressStage,
    type ProgressStatus,
    type ProgressReporterService,
} from "../progress/progress.ts";
import { RalphieError } from "../shared/error.ts";
import {
    complexityDecisionSchema,
    type ComplexityDecision,
} from "./decisions.ts";
import type { IssueExecutionContext } from "./execution.ts";

export type ComplexityAssessmentResult = {
    readonly decision: ComplexityDecision;
    readonly sessionID: string;
};

export type ComplexityAssessmentService = {
    readonly assess: (
        context: IssueExecutionContext,
    ) => Promise<ComplexityAssessmentResult>;
};

const messageOf = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

export const makeComplexityAssessmentService = (
    progress: ProgressReporterService,
): ComplexityAssessmentService => ({
    assess: async (context) => {
        const issueProgress = {
            issue: {
                number: context.issue.number,
                title: context.issue.title,
            },
        };
        await progress.emit({
            ...issueProgress,
            stage: "complexity-assessment",
            status: "started",
            message: `Assessing complexity for #${context.issue.number}...`,
        });

        try {
            const checkpoint = await context.repositoryInvariant.capture(
                context.repositoryPath,
            );
            if (checkpoint.branch !== context.targetBranch) {
                throw new RalphieError({
                    message: `Complexity assessment requires branch ${context.targetBranch}, but checkout is on ${checkpoint.branch}.`,
                });
            }

            const result = await requestStructuredOutput(context.pi, {
                directory: context.repositoryPath,
                title: `Assess issue #${context.issue.number}`,
                prompt: buildComplexityPrompt({
                    issue: context.issue,
                    repositoryPath: context.repositoryPath,
                    targetBranch: context.targetBranch,
                }),
                schema: complexityDecisionSchema,
                agent: context.piSelection.agent,
                model: context.piSelection.model,
                variant:
                    context.piStageVariants?.complexity ??
                    context.piSelection.variant,
                runId: context.runId,
                diagnostics: context.piDiagnostics,
                verifyAfter: () =>
                    context.repositoryInvariant.verify(
                        context.repositoryPath,
                        checkpoint,
                    ),
                progress,
                progressStage: "complexity-assessment",
                progressIssue: issueProgress.issue,
                signal: context.signal,
            });
            const assessed = {
                decision: result.output,
                sessionID: result.sessionID,
            };
            await progress.emit({
                ...issueProgress,
                stage: "complexity-assessment",
                status: "succeeded",
                message: `Assessed #${context.issue.number} at complexity ${assessed.decision.complexity}/5.`,
                details: {
                    rationale: assessed.decision.rationale,
                    sessionID: assessed.sessionID,
                },
            });
            return assessed;
        } catch (error) {
            await progress.emit({
                ...issueProgress,
                stage: "complexity-assessment",
                status: "failed",
                message: `Complexity assessment failed: ${messageOf(error)}`,
            });
            throw error;
        }
    },
});

export const ComplexityAssessmentLive = makeComplexityAssessmentService;