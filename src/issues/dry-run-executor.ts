import {
    ProgressStage,
    ProgressStatus,
    type ProgressReporterService,
} from "../progress/progress.ts";
import {
    IssueArtifactKind,
    type IssueArtifactStoreService,
} from "./artifacts.ts";
import { type ComplexityAssessmentService } from "./complexity.ts";
import { ComplexityLevel } from "./decisions.ts";
import { IssueExecutionOutcomeKind } from "./execution.ts";
import type {
    IssueExecutionContext,
    IssueExecutionOutcome,
} from "./execution.ts";

export type DryRunIssueExecutorService = {
    readonly execute: (
        context: IssueExecutionContext,
    ) => Promise<IssueExecutionOutcome>;
};

export const makeDryRunIssueExecutorService = (
    artifactStores: IssueArtifactStoreService,
    assessment: ComplexityAssessmentService,
    progress: ProgressReporterService,
): DryRunIssueExecutorService => ({
    execute: async (context) => {
        const artifacts = await artifactStores.forIssue(context.issue.number);
        const result = await assessment.assess(context);
        await artifacts.write(
            IssueArtifactKind.ComplexityDecision,
            result.decision,
        );

        const route =
            result.decision.complexity <= ComplexityLevel.Level3
                ? "implementation"
                : "decomposition";
        await progress.emit({
            issue: {
                number: context.issue.number,
                title: context.issue.title,
            },
            stage: ProgressStage.IssuePlanning,
            status: ProgressStatus.Info,
            message: `Dry run would route #${context.issue.number} (complexity ${result.decision.complexity}/5) to ${route}.`,
            details: {
                dryRun: true,
                complexity: result.decision.complexity,
                route,
            },
        });

        return {
            kind: IssueExecutionOutcomeKind.Skipped,
            reason: `Dry run: complexity ${result.decision.complexity}/5 would use the ${route} workflow; no mutation was performed.`,
        } as const;
    },
});

export const DryRunIssueExecutorLive = makeDryRunIssueExecutorService;