import { buildPreflightPrompt } from "../../agent/prompts.ts";
import { requestStructuredOutput } from "../../agent/structured-output.ts";
import type { ProgressReporterService } from "../../progress/ports.ts";
import { RalphieError, errorMessage } from "../../shared/error.ts";
import {
    type PreflightDecision,
    preflightDecisionSchema,
} from "../domain/decisions.ts";
import type { IssueExecutionContext } from "./execution-model.ts";
import type { HandOffRequest } from "../../agent/task-session.ts";

export type PreflightAssessmentResult = {
    readonly decision: PreflightDecision;
    readonly sessionID: string;
    readonly handOff?: HandOffRequest;
};

export type PreflightAssessmentService = {
    readonly assess: (
        context: IssueExecutionContext,
    ) => Promise<PreflightAssessmentResult>;
};

export const makePreflightAssessmentService = (
    progress: ProgressReporterService,
): PreflightAssessmentService => ({
    assess: async (context) => {
        const issue = {
            number: context.issue.number,
            title: context.issue.title,
        };
        await progress.emit({
            issue,
            stage: "preflight",
            status: "started",
            message: `Running pre-flight for #${context.issue.number}...`,
            details: { agentWorkSkipped: false },
        });
        try {
            const checkpoint = await context.repositoryInvariant.capture(
                context.repositoryPath,
                context.signal,
            );
            if (checkpoint.branch !== context.targetBranch) {
                throw new RalphieError({
                    message: `Pre-flight requires branch ${context.targetBranch}, but checkout is on ${checkpoint.branch}.`,
                });
            }
            const result = await requestStructuredOutput(context.agent, {
                directory: context.repositoryPath,
                title: `Pre-flight issue #${context.issue.number}`,
                prompt: buildPreflightPrompt({
                    issue: context.issue,
                    repositoryPath: context.repositoryPath,
                    targetBranch: context.targetBranch,
                    headSha: checkpoint.head,
                }),
                schema: preflightDecisionSchema,
                role: "preflight",
                repositoryInvariant: checkpoint,
                verifyRepositoryInvariant: context.repositoryInvariant.verify,
                progress,
                progressStage: "preflight",
                progressIssue: issue,
                signal: context.signal,
            });
            await progress.emit({
                issue,
                stage: "preflight",
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
                ...(result.handOff === undefined
                    ? {}
                    : { handOff: result.handOff }),
            };
        } catch (error) {
            await progress.emit({
                issue,
                stage: "preflight",
                status: "failed",
                message: `Pre-flight failed: ${errorMessage(error)}`,
                details: { agentWorkSkipped: false },
            });
            throw error;
        }
    },
});