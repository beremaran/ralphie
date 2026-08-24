import { Context, Effect, Layer } from "effect";

import {
  decompositionMarker,
  nextDecompositionLineage,
  renderChildIssueBody,
  renderDecomposedOriginalBody,
} from "../github/decomposition-markdown.ts";
import {
  GitHubIssueCloseReason,
  GitHubIssueMutations,
} from "../github/issue-mutations.ts";
import { buildDecompositionPrompt } from "../opencode/prompts.ts";
import { requestStructuredOutput } from "../opencode/structured-output.ts";
import { ProgressReporter, ProgressStage } from "../progress/progress.ts";
import { RalphieError } from "../shared/error.ts";
import {
  IssueArtifactKind,
  type CreatedIssueNumberMapping,
} from "./artifacts.ts";
import { issueBreakdownDecisionSchema } from "./decisions.ts";
import { IssueExecutionOutcomeKind } from "./execution.ts";
import type {
  WorkflowExecutorInput,
  WorkflowExecutorResult,
} from "./workflow-executor-input.ts";

export type DecompositionExecutorService = {
  readonly execute: (
    input: WorkflowExecutorInput,
  ) => Effect.Effect<WorkflowExecutorResult, RalphieError>;
};

export const DecompositionExecutor =
  Context.GenericTag<DecompositionExecutorService>(
    "ralphie/DecompositionExecutor",
  );

const existingMapping = (
  input: WorkflowExecutorInput,
): Effect.Effect<CreatedIssueNumberMapping, RalphieError> =>
  input.artifacts.has(IssueArtifactKind.CreatedIssueNumbers)
    ? input.artifacts.read(IssueArtifactKind.CreatedIssueNumbers)
    : Effect.succeed({});

export const DecompositionExecutorLive = Layer.effect(
  DecompositionExecutor,
  Effect.gen(function* () {
    const mutations = yield* GitHubIssueMutations;
    const progress = yield* ProgressReporter;

    return {
      execute: (input) =>
        Effect.gen(function* () {
          const { context, artifacts } = input;
          const lineage = nextDecompositionLineage(context.issue);
          const reviewAttempts = artifacts.has(IssueArtifactKind.ReviewAttempts)
            ? yield* artifacts.read(IssueArtifactKind.ReviewAttempts)
            : [];

          const breakdown = artifacts.has(
            IssueArtifactKind.IssueBreakdownDecision,
          )
            ? yield* artifacts.read(IssueArtifactKind.IssueBreakdownDecision)
            : yield* Effect.gen(function* () {
                const invariant = yield* context.repositoryInvariant.capture(
                  context.repositoryPath,
                );
                if (invariant.branch !== context.targetBranch) {
                  return yield* new RalphieError({
                    message: `Decomposition requires branch ${context.targetBranch}, but checkout is on ${invariant.branch}.`,
                  });
                }
                return yield* requestStructuredOutput(context.openCode, {
                  directory: context.repositoryPath,
                  title: `Decompose issue #${context.issue.number}`,
                  prompt: buildDecompositionPrompt({
                    issue: context.issue,
                    repositoryPath: context.repositoryPath,
                    targetBranch: context.targetBranch,
                    failedReviewSummaries: reviewAttempts.map(
                      ({ decision }) => decision,
                    ),
                  }),
                  schema: issueBreakdownDecisionSchema,
                  agent: context.openCodeSelection.agent,
                  model: context.openCodeSelection.model,
                  variant: context.openCodeSelection.variant,
                  runId: context.runId,
                  diagnostics: context.openCodeDiagnostics,
                  repositoryInvariant: invariant,
                  verifyRepositoryInvariant:
                    context.repositoryInvariant.verify,
                  progress,
                  progressStage: ProgressStage.Decomposition,
                  progressIssue: {
                    number: context.issue.number,
                    title: context.issue.title,
                  },
                  signal: context.signal,
                });
              }).pipe(
                Effect.map(({ output }) => output),
                Effect.tap((decision) =>
                  artifacts.write(
                    IssueArtifactKind.IssueBreakdownDecision,
                    decision,
                  ),
                ),
              );

          let mapping = yield* existingMapping(input);
          for (const child of breakdown.issues) {
            if (mapping[child.key] !== undefined) continue;
            const created = yield* mutations.create(
              context.octokit,
              context.repository,
              {
                title: child.title,
                body: `${decompositionMarker(lineage, child.key)}\n\n${child.body}`,
              },
            );
            yield* artifacts.recordCreatedIssue(child.key, created.number);
            mapping = { ...mapping, [child.key]: created.number };
          }

          for (const child of breakdown.issues) {
            const childNumber = mapping[child.key];
            if (childNumber === undefined) {
              return yield* new RalphieError({
                message: `Missing created issue for ${child.key}.`,
              });
            }
            yield* mutations.update(
              context.octokit,
              context.repository,
              childNumber,
              {
                body: renderChildIssueBody({
                  child,
                  lineage,
                  issueNumbers: mapping,
                }),
              },
            );
          }

          yield* mutations.update(
            context.octokit,
            context.repository,
            context.issue.number,
            {
              body: renderDecomposedOriginalBody({
                original: context.issue,
                breakdown,
                issueNumbers: mapping,
                lineage,
              }),
            },
          );
          yield* mutations.close(
            context.octokit,
            context.repository,
            context.issue.number,
            GitHubIssueCloseReason.Duplicate,
          );

          return {
            kind: IssueExecutionOutcomeKind.Decomposed,
            childIssueNumbers: breakdown.issues.map(
              (child) => mapping[child.key]!,
            ),
          } as const;
        }),
    } satisfies DecompositionExecutorService;
  }),
);
