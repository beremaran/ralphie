import { buildDecompositionPrompt } from "../agent/prompts.ts";
import { requestStructuredOutput } from "../agent/structured-output.ts";
import type { PiNeedsAttentionRequest } from "../agent/task-session.ts";
import {
    nextDecompositionLineage,
    type DecompositionLineage,
} from "../github/decomposition-markdown.ts";
import type { GitHubIssuesService } from "../github/issues.ts";
import { RalphieError } from "../shared/error.ts";
import type { ProgressReporterService } from "../progress/progress.ts";
import {
    issueBreakdownDecisionSchema,
    type IssueBreakdownDecision,
} from "./decisions.ts";
import {
    planDecompositionOperations,
    type DecompositionOperationPlan,
} from "./decomposition-plan.ts";
import type { IssueExecutionContext } from "./execution.ts";
import { DEFAULT_MAX_DECOMPOSITION_DEPTH } from "../options.ts";

export type DecompositionPlanResult =
    | {
          readonly kind: "breakdown";
          readonly breakdown: IssueBreakdownDecision;
          readonly lineage: DecompositionLineage;
          readonly operations: DecompositionOperationPlan;
      }
    | {
          readonly kind: "needs-attention";
          readonly request: PiNeedsAttentionRequest;
      };

export type DecompositionPlannerService = {
    /**
     * Run the read-only decomposition session and marker discovery for one
     * issue without persisting artifacts or mutating GitHub. Used by dry runs
     * to report the intended hierarchy and dependency operations.
     */
    readonly plan: (
        context: IssueExecutionContext,
    ) => Promise<DecompositionPlanResult>;
};

export const makeDecompositionPlannerService = (
    issues: GitHubIssuesService,
    progress: ProgressReporterService,
): DecompositionPlannerService => ({
    plan: async (context) => {
        const lineage = nextDecompositionLineage(
            context.issue,
            context.maxDecompositionDepth ?? DEFAULT_MAX_DECOMPOSITION_DEPTH,
        );
        const invariant = await context.repositoryInvariant.capture(
            context.repositoryPath,
        );
        if (invariant.branch !== context.targetBranch) {
            throw new RalphieError({
                message: `Decomposition requires branch ${context.targetBranch}, but checkout is on ${invariant.branch}.`,
            });
        }
        const result = await requestStructuredOutput(context.agent, {
            directory: context.repositoryPath,
            title: `Plan the decomposition of issue #${context.issue.number}`,
            prompt: buildDecompositionPrompt({
                issue: context.issue,
                repositoryPath: context.repositoryPath,
                targetBranch: context.targetBranch,
                failedReviewSummaries: [],
            }),
            schema: issueBreakdownDecisionSchema,
            agent: context.agentSelection.agent,
            model: context.agentSelection.model,
            variant: context.agentSelection.variant,
            runId: context.runId,
            diagnostics: context.agentDiagnostics,
            verifyAfter: () =>
                context.repositoryInvariant.verify(
                    context.repositoryPath,
                    invariant,
                ),
            progress,
            progressStage: "decomposition",
            progressIssue: {
                number: context.issue.number,
                title: context.issue.title,
            },
            signal: context.signal,
        });
        if (result.needsAttention !== undefined) {
            return { kind: "needs-attention", request: result.needsAttention };
        }
        const discovered = await issues.listDecompositionChildren(
            context.octokit,
            context.repository,
            {
                rootIssueNumber: lineage.rootIssueNumber,
                parentIssueNumber: context.issue.number,
                depth: lineage.depth,
            },
        );
        const existingByKey = new Map(
            discovered.map((child) => [child.decompositionKey, child.number]),
        );
        return {
            kind: "breakdown",
            breakdown: result.output,
            lineage,
            operations: planDecompositionOperations(
                result.output,
                lineage,
                existingByKey,
            ),
        };
    },
});

export const DecompositionPlannerLive = makeDecompositionPlannerService;