import { Context, Effect, Layer } from "effect";

import {
  decompositionMarker,
  nextDecompositionLineage,
  renderChildIssueBody,
  renderDecomposedOriginalBody,
} from "../github/decomposition-markdown.ts";
import {
  GitHubMutationRecoveryError,
  GitHubMutationRecoveryOutcome,
  GitHubIssueCloseReason,
  GitHubIssueMutations,
} from "../github/issue-mutations.ts";
import { GitHubIssues } from "../github/issues.ts";
import { buildDecompositionPrompt } from "../agent/prompts.ts";
import { requestStructuredOutput } from "../agent/structured-output.ts";
import {
  ProgressReporter,
  ProgressStage,
  ProgressStatus,
} from "../progress/progress.ts";
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
    const issues = yield* GitHubIssues;
    const progress = yield* ProgressReporter;

    function recoverableMutation<Output>(
      operation: string,
      effect: Effect.Effect<Output, RalphieError>,
      input: WorkflowExecutorInput,
    ): Effect.Effect<Output, RalphieError> {
      return progress
        .emit({
          issue: {
            number: input.context.issue.number,
            title: input.context.issue.title,
          },
          stage:
            operation === "close-original"
              ? ProgressStage.IssueClosure
              : ProgressStage.IssueCreation,
          status: ProgressStatus.Started,
          message: `Applying GitHub mutation ${operation}...`,
          details: {
            operation,
          },
        })
        .pipe(
          Effect.zipRight(effect),
          Effect.tap((output) =>
            progress.emit({
              issue: {
                number: input.context.issue.number,
                title: input.context.issue.title,
              },
              stage:
                operation === "close-original"
                  ? ProgressStage.IssueClosure
                  : ProgressStage.IssueCreation,
              status: ProgressStatus.Succeeded,
              message: `GitHub mutation ${operation} completed.`,
              details: {
                operation,
                ...(typeof output === "object" &&
                output !== null &&
                "number" in output &&
                typeof output.number === "number"
                  ? {
                      createdIssueNumber: output.number,
                    }
                  : {}),
              },
            }),
          ),
          Effect.catchTag("RalphieError", (error) =>
            Effect.gen(function* () {
              yield* progress.emit({
                issue: {
                  number: input.context.issue.number,
                  title: input.context.issue.title,
                },
                stage:
                  operation === "close-original"
                    ? ProgressStage.IssueClosure
                    : ProgressStage.IssueCreation,
                status: ProgressStatus.Failed,
                message: `GitHub mutation ${operation} requires recovery: ${error.message}`,
                details: {
                  outcome: GitHubMutationRecoveryOutcome.RecoveryRequired,
                  operation,
                },
              });
              return yield* new GitHubMutationRecoveryError({
                message: `GitHub mutation ${operation} may have partially succeeded; recovery is required.`,
                operation,
                cause: error,
              });
            }),
          ),
        );
    }

    const ambiguous = (
      input: WorkflowExecutorInput,
      message: string,
      details: Readonly<Record<string, unknown>>,
    ): Effect.Effect<never, RalphieError> =>
      Effect.gen(function* () {
        yield* progress.emit({
          issue: {
            number: input.context.issue.number,
            title: input.context.issue.title,
          },
          stage: ProgressStage.IssueCreation,
          status: ProgressStatus.Failed,
          message: `GitHub mutation state is ambiguous: ${message}`,
          details: {
            ...details,
            outcome: GitHubMutationRecoveryOutcome.RecoveryRequired,
          },
        });
        return yield* new GitHubMutationRecoveryError({
          message: `GitHub mutation state is ambiguous: ${message}`,
          operation: "reconcile-created-children",
          cause: details,
        });
      });

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
                return yield* requestStructuredOutput(context.pi, {
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
                  agent: context.piSelection.agent,
                  model: context.piSelection.model,
                  variant: context.piSelection.variant,
                  runId: context.runId,
                  diagnostics: context.piDiagnostics,
                  verifyAfter: () =>
                    context.repositoryInvariant.verify(
                      context.repositoryPath,
                      invariant,
                    ),
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
          const discovered = yield* issues.listDecompositionChildren(
            context.octokit,
            context.repository,
            lineage,
          );
          const discoveredByKey = new Map<string, number>();
          for (const child of discovered) {
            if (
              !breakdown.issues.some(
                (issue) => issue.key === child.decompositionKey,
              )
            ) {
              return yield* ambiguous(
                input,
                `Found generated child ${child.number} with unexpected key ${child.decompositionKey}.`,
                {
                  issueNumber: child.number,
                  key: child.decompositionKey,
                },
              );
            }
            const previous = discoveredByKey.get(child.decompositionKey);
            if (previous !== undefined && previous !== child.number) {
              return yield* ambiguous(
                input,
                `Found multiple generated children for key ${child.decompositionKey}.`,
                {
                  key: child.decompositionKey,
                  issueNumbers: [previous, child.number],
                },
              );
            }
            discoveredByKey.set(child.decompositionKey, child.number);
          }
          for (const [key, issueNumber] of discoveredByKey) {
            const recorded = mapping[key];
            if (recorded !== undefined && recorded !== issueNumber) {
              return yield* ambiguous(
                input,
                `Artifact mapping for ${key} points to #${recorded}, but GitHub marker discovery found #${issueNumber}.`,
                {
                  key,
                  recorded,
                  discovered: issueNumber,
                },
              );
            }
            if (recorded === undefined) {
              yield* recoverableMutation(
                `record-created-${key}`,
                artifacts.recordCreatedIssue(key, issueNumber),
                input,
              );
              mapping = {
                ...mapping,
                [key]: issueNumber,
              };
            }
          }
          for (const child of breakdown.issues) {
            if (mapping[child.key] !== undefined) continue;
            const created = yield* recoverableMutation(
              `create-child-${child.key}`,
              mutations.create(context.octokit, context.repository, {
                title: child.title,
                body: `${decompositionMarker(lineage, child.key)}\n\n${child.body}`,
              }),
              input,
            );
            yield* recoverableMutation(
              `record-created-${child.key}`,
              artifacts.recordCreatedIssue(child.key, created.number),
              input,
            );
            mapping = {
              ...mapping,
              [child.key]: created.number,
            };
          }

          for (const child of breakdown.issues) {
            const childNumber = mapping[child.key];
            if (childNumber === undefined) {
              return yield* new RalphieError({
                message: `Missing created issue for ${child.key}.`,
              });
            }
            yield* recoverableMutation(
              `link-child-${child.key}`,
              mutations.update(
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
              ),
              input,
            );
          }

          yield* recoverableMutation(
            "rewrite-original",
            mutations.update(
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
            ),
            input,
          );
          yield* recoverableMutation(
            "close-original",
            mutations.close(
              context.octokit,
              context.repository,
              context.issue.number,
              GitHubIssueCloseReason.Duplicate,
            ),
            input,
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