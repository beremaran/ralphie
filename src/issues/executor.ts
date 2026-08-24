import { Context, Effect, Layer } from "effect";

import type { RalphieError } from "../shared/error.ts";
import { IssueArtifactKind, IssueArtifactStore } from "./artifacts.ts";
import { ComplexityAssessment } from "./complexity.ts";
import { ComplexityLevel } from "./decisions.ts";
import { DecompositionExecutor } from "./decomposition-executor.ts";
import type { IssueExecutionContext, IssueExecutionOutcome } from "./execution.ts";
import { IssueExecutionOutcomeKind } from "./execution.ts";
import { ImplementationExecutor } from "./implementation-executor.ts";

export type IssueExecutorService = {
  readonly execute: (
    context: IssueExecutionContext,
  ) => Effect.Effect<IssueExecutionOutcome, RalphieError>;
};

export const IssueExecutor = Context.GenericTag<IssueExecutorService>(
  "ralphie/IssueExecutor",
);

/** Assess one issue, retain the decision, then route it to its concrete workflow. */
export const IssueExecutorLive = Layer.effect(
  IssueExecutor,
  Effect.gen(function* () {
    const artifactStores = yield* IssueArtifactStore;
    const complexityAssessment = yield* ComplexityAssessment;
    const implementationExecutor = yield* ImplementationExecutor;
    const decompositionExecutor = yield* DecompositionExecutor;

    return {
      execute: (context) =>
        Effect.gen(function* () {
          const artifacts = yield* artifactStores.forIssue(
            context.issue.number,
            context.workspace && context.runId
              ? {
                  workspace: context.workspace,
                  runId: context.runId,
                  ...(context.project === undefined
                    ? {}
                    : { project: context.project }),
                  repository: context.repository,
                }
              : undefined,
          );
          const decision = artifacts.has(IssueArtifactKind.ComplexityDecision)
            ? yield* artifacts.read(IssueArtifactKind.ComplexityDecision)
            : yield* complexityAssessment.assess(context).pipe(
                Effect.map(({ decision }) => decision),
                Effect.tap((value) =>
                  artifacts.write(IssueArtifactKind.ComplexityDecision, value),
                ),
              );

          const input = { context, artifacts };
          if (decision.complexity >= ComplexityLevel.Level4) {
            return yield* decompositionExecutor.execute(input);
          }

          const implementation = yield* implementationExecutor.execute(input);
          if (implementation.kind !== IssueExecutionOutcomeKind.Escalated) {
            return implementation;
          }

          const decomposition = yield* decompositionExecutor.execute(input);
          if (decomposition.kind !== IssueExecutionOutcomeKind.Decomposed) {
            return {
              kind: IssueExecutionOutcomeKind.Failed,
              message: "Review escalation did not complete decomposition.",
            } as const;
          }
          return {
            ...implementation,
            childIssueNumbers: decomposition.childIssueNumbers,
          };
        }).pipe(
          Effect.catchTag("RalphieError", (error) =>
            Effect.succeed({
              kind: IssueExecutionOutcomeKind.Failed,
              message: error.message,
            } as const),
          ),
        ),
    } satisfies IssueExecutorService;
  }),
);
