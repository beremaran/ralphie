import { Context, Effect, Layer } from "effect";

import type { RalphieError } from "../shared/error.ts";
import {
  IssueArtifactKind,
  IssueArtifactStore,
} from "./artifacts.ts";
import { ComplexityAssessment } from "./complexity.ts";
import { ComplexityLevel } from "./decisions.ts";
import { DecompositionExecutor } from "./decomposition-executor.ts";
import type {
  IssueExecutionContext,
  IssueExecutionOutcome,
} from "./execution.ts";
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
          );
          const assessment = yield* complexityAssessment.assess(context);

          yield* artifacts.write(
            IssueArtifactKind.ComplexityDecision,
            assessment.decision,
          );

          const input = { context, artifacts };
          return assessment.decision.complexity <= ComplexityLevel.Level3
            ? yield* implementationExecutor.execute(input)
            : yield* decompositionExecutor.execute(input);
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
