import { Context, Effect, Layer } from "effect";

import {
  ProgressReporter,
  ProgressStage,
  ProgressStatus,
} from "../progress/progress.ts";
import { RalphieError } from "../shared/error.ts";
import { IssueArtifactKind, IssueArtifactStore } from "./artifacts.ts";
import { ComplexityAssessment } from "./complexity.ts";
import { ComplexityLevel } from "./decisions.ts";
import { IssueExecutionOutcomeKind } from "./execution.ts";
import type { IssueExecutionContext, IssueExecutionOutcome } from "./execution.ts";

export type DryRunIssueExecutorService = {
  readonly execute: (
    context: IssueExecutionContext,
  ) => Effect.Effect<IssueExecutionOutcome, RalphieError>;
};

export const DryRunIssueExecutor = Context.GenericTag<DryRunIssueExecutorService>(
  "ralphie/DryRunIssueExecutor",
);

export const DryRunIssueExecutorLive = Layer.effect(
  DryRunIssueExecutor,
  Effect.gen(function* () {
    const artifactStores = yield* IssueArtifactStore;
    const assessment = yield* ComplexityAssessment;
    const progress = yield* ProgressReporter;

    return {
      execute: (context) =>
        Effect.gen(function* () {
          const artifacts = yield* artifactStores.forIssue(context.issue.number);
          const result = yield* assessment.assess(context);
          yield* artifacts.write(IssueArtifactKind.ComplexityDecision, result.decision);

          const route =
            result.decision.complexity <= ComplexityLevel.Level3
              ? "implementation"
              : "decomposition";
          yield* progress.emit({
            issue: { number: context.issue.number, title: context.issue.title },
            stage: ProgressStage.IssuePlanning,
            status: ProgressStatus.Info,
            message: `Dry run would route #${context.issue.number} (complexity ${result.decision.complexity}/5) to ${route}.`,
            details: { dryRun: true, complexity: result.decision.complexity, route },
          });

          return {
            kind: IssueExecutionOutcomeKind.Skipped,
            reason: `Dry run: complexity ${result.decision.complexity}/5 would use the ${route} workflow; no mutation was performed.`,
          } as const;
        }),
    } satisfies DryRunIssueExecutorService;
  }),
);
