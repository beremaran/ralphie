import { RalphieError } from "../shared/error.ts";
import {
    IssueArtifactKind,
    type IssueArtifactStoreService,
} from "./artifacts.ts";
import type { ComplexityAssessmentService } from "./complexity.ts";
import { ComplexityLevel } from "./decisions.ts";
import type {
    IssueExecutionContext,
    IssueExecutionOutcome,
} from "./execution.ts";
import { IssueExecutionOutcomeKind } from "./execution.ts";
import type { DecompositionExecutorService } from "./decomposition-executor.ts";
import type { ImplementationExecutorService } from "./implementation-executor.ts";

export type IssueExecutorService = {
    readonly execute: (
        context: IssueExecutionContext,
    ) => Promise<IssueExecutionOutcome>;
};

/** Assess one issue, retain the decision, then route it to its concrete workflow. */
export const makeIssueExecutorService = (
    artifactStores: IssueArtifactStoreService,
    complexityAssessment: ComplexityAssessmentService,
    implementationExecutor: ImplementationExecutorService,
    decompositionExecutor: DecompositionExecutorService,
): IssueExecutorService => ({
    execute: async (context) => {
        try {
            const artifacts = await artifactStores.forIssue(
                context.issue.number,
                context.workspace && context.runId
                    ? {
                          workspace: context.workspace,
                          runId: context.runId,
                          repository: context.repository,
                      }
                    : undefined,
            );
            const decision = artifacts.has(IssueArtifactKind.ComplexityDecision)
                ? await artifacts.read(IssueArtifactKind.ComplexityDecision)
                : await complexityAssessment
                      .assess(context)
                      .then(async ({ decision }) => {
                          await artifacts.write(
                              IssueArtifactKind.ComplexityDecision,
                              decision,
                          );
                          return decision;
                      });

            const input = { context, artifacts };
            if (decision.complexity >= ComplexityLevel.Level4) {
                return await decompositionExecutor.execute(input);
            }

            const implementation = await implementationExecutor.execute(input);
            if (implementation.kind !== IssueExecutionOutcomeKind.Escalated) {
                return implementation;
            }

            const decomposition = await decompositionExecutor.execute(input);
            if (decomposition.kind !== IssueExecutionOutcomeKind.Decomposed) {
                return {
                    kind: IssueExecutionOutcomeKind.Failed,
                    message:
                        "Review escalation did not complete decomposition.",
                } as const;
            }
            return {
                ...implementation,
                childIssueNumbers: decomposition.childIssueNumbers,
            };
        } catch (error) {
            if (error instanceof RalphieError) {
                return {
                    kind: IssueExecutionOutcomeKind.Failed,
                    message: error.message,
                } as const;
            }
            throw error;
        }
    },
});

export const IssueExecutorLive = makeIssueExecutorService;