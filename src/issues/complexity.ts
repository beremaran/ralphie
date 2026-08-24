import { Context, Effect, Layer } from "effect";

import { requestStructuredOutput } from "../opencode/structured-output.ts";
import { buildComplexityPrompt } from "../opencode/prompts.ts";
import {
  ProgressReporter,
  ProgressStage,
  ProgressStatus,
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
  ) => Effect.Effect<ComplexityAssessmentResult, RalphieError>;
};

export const ComplexityAssessment =
  Context.GenericTag<ComplexityAssessmentService>(
    "ralphie/ComplexityAssessment",
  );

export const ComplexityAssessmentLive = Layer.effect(
  ComplexityAssessment,
  Effect.gen(function* () {
    const progress = yield* ProgressReporter;

    return {
      assess: (context) => {
        const issueProgress = {
          issue: {
            number: context.issue.number,
            title: context.issue.title,
          },
        };

        return progress
          .emit({
            ...issueProgress,
            stage: ProgressStage.ComplexityAssessment,
            status: ProgressStatus.Started,
            message: `Assessing complexity for #${context.issue.number}...`,
          })
          .pipe(
            Effect.zipRight(
              Effect.gen(function* () {
                const checkpoint = yield* context.repositoryInvariant.capture(
                  context.repositoryPath,
                );
                if (checkpoint.branch !== context.targetBranch) {
                  return yield* new RalphieError({
                    message: `Complexity assessment requires branch ${context.targetBranch}, but checkout is on ${checkpoint.branch}.`,
                  });
                }

                return yield* requestStructuredOutput(context.openCode, {
                  directory: context.repositoryPath,
                  title: `Assess issue #${context.issue.number}`,
                  prompt: buildComplexityPrompt({
                    issue: context.issue,
                    repositoryPath: context.repositoryPath,
                    targetBranch: context.targetBranch,
                  }),
                  schema: complexityDecisionSchema,
                  agent: context.openCodeSelection.agent,
                  model: context.openCodeSelection.model,
                  variant: context.openCodeSelection.variant,
                  runId: context.runId,
                  diagnostics: context.openCodeDiagnostics,
                  repositoryInvariant: checkpoint,
                  verifyRepositoryInvariant: context.repositoryInvariant.verify,
                  progress,
                  progressStage: ProgressStage.ComplexityAssessment,
                  progressIssue: issueProgress.issue,
                  signal: context.signal,
                });
              }),
            ),
            Effect.map(({ output, sessionID }) => ({
              decision: output,
              sessionID,
            })),
            Effect.tap((result) =>
              progress.emit({
                ...issueProgress,
                stage: ProgressStage.ComplexityAssessment,
                status: ProgressStatus.Succeeded,
                message: `Assessed #${context.issue.number} at complexity ${result.decision.complexity}/5.`,
                details: {
                  rationale: result.decision.rationale,
                  sessionID: result.sessionID,
                },
              }),
            ),
            Effect.tapError((error) =>
              progress.emit({
                ...issueProgress,
                stage: ProgressStage.ComplexityAssessment,
                status: ProgressStatus.Failed,
                message: `Complexity assessment failed for #${context.issue.number}: ${error.message}`,
              }),
            ),
          );
      },
    } satisfies ComplexityAssessmentService;
  }),
);
