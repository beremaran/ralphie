import { Context, Effect, Layer } from "effect";
import {
  GitIssueOperations,
  type GitIssueOperationError,
  type GitIssueOperationsService,
} from "../git/issue-operations.ts";
import {
  GitIssuePreparation,
  type GitIssuePreparationService,
} from "../git/issue-preparation.ts";
import {
  GitPushMode,
  GitRemoteSafety,
  type GitRemoteSafetyService,
} from "../git/remote-safety.ts";
import {
  buildCommitMessagePrompt,
  buildImplementationPrompt,
  buildResolutionVerificationPrompt,
  buildReviewFixPrompt,
  buildReviewPrompt,
} from "../agent/prompts.ts";
import { requestStructuredOutput } from "../agent/structured-output.ts";
import { runPiTask } from "../agent/task-session.ts";
import {
  ProgressReporter,
  ProgressStage,
  ProgressStatus,
  type ProgressReporterService,
} from "../progress/progress.ts";
import { RalphieError } from "../shared/error.ts";
import type {
  WorkflowExecutorInput,
  WorkflowExecutorResult,
} from "./workflow-executor-input.ts";
import { IssueArtifactKind } from "./artifacts.ts";
import type { IssueExecutionContext } from "./execution.ts";
import {
  commitMessageDecisionSchema,
  issueResolutionDecisionSchema,
  IssueResolutionStatus,
  reviewDecisionSchema,
  ReviewVerdict,
} from "./decisions.ts";
import { IssueCompletionKind, IssueExecutionOutcomeKind } from "./execution.ts";
import {
  IssueRecovery,
  type IssueRecoveryService,
  type ReviewAttempt,
} from "./recovery.ts";
import { REVIEW_ITERATION_LIMIT } from "./stage.ts";

/** The implementation workflow for issues with complexity 0 through 3. */
export type ImplementationExecutorService = {
  readonly execute: (
    input: WorkflowExecutorInput,
  ) => Effect.Effect<WorkflowExecutorResult, RalphieError>;
};

export const ImplementationExecutor =
  Context.GenericTag<ImplementationExecutorService>(
    "ralphie/ImplementationExecutor",
  );

const asRalphieError = (error: unknown): RalphieError => {
  if (error instanceof RalphieError) return error;
  return new RalphieError({
    message: error instanceof Error ? error.message : String(error),
    cause: error,
  });
};

const issueProgress = (input: WorkflowExecutorInput) => ({
  issue: {
    number: input.context.issue.number,
    title: input.context.issue.title,
  },
});

const checkSignal = (
  signal: AbortSignal | undefined,
): Effect.Effect<void, RalphieError> =>
  Effect.try({
    try: () => signal?.throwIfAborted(),
    catch: (cause) =>
      new RalphieError({
        message: "Issue execution was aborted.",
        cause,
      }),
  }).pipe(Effect.asVoid);

function stage<A>(
  progress: ProgressReporterService,
  input: WorkflowExecutorInput,
  progressStage: ProgressStage,
  startedMessage: string,
  operation: Effect.Effect<A, RalphieError>,
  succeededMessage: string | ((value: A) => string),
  details?: Readonly<Record<string, unknown>>,
  attempt?: number,
): Effect.Effect<A, RalphieError> {
  const base = {
    ...issueProgress(input),
    stage: progressStage,
    ...(attempt === undefined
      ? {}
      : {
          attempt,
          maxAttempts: REVIEW_ITERATION_LIMIT,
        }),
    ...(details === undefined
      ? {}
      : {
          details,
        }),
  };
  return progress
    .emit({
      ...base,
      status: ProgressStatus.Started,
      message: startedMessage,
    })
    .pipe(
      Effect.zipRight(operation),
      Effect.tap((value) =>
        progress.emit({
          ...base,
          status: ProgressStatus.Succeeded,
          message:
            typeof succeededMessage === "function"
              ? succeededMessage(value)
              : succeededMessage,
        }),
      ),
      Effect.tapError((error) =>
        progress.emit({
          ...base,
          status: ProgressStatus.Failed,
          message: `${startedMessage.replace(/\.{3}$/, "")} failed: ${error.message}`,
        }),
      ),
    );
}

const readCheckpoint = (
  preparation: GitIssuePreparationService,
  input: WorkflowExecutorInput,
) =>
  preparation.prepare({
    issueNumber: input.context.issue.number,
    repositoryPath: input.context.repositoryPath,
    branch: input.context.targetBranch,
  });

export const ImplementationExecutorLive = Layer.effect(
  ImplementationExecutor,
  Effect.gen(function* () {
    const preparation = yield* GitIssuePreparation;
    const operations = yield* GitIssueOperations;
    const remoteSafety = yield* GitRemoteSafety;
    const recovery = yield* IssueRecovery;
    const progress = yield* ProgressReporter;

    return {
      execute: (input) =>
        Effect.gen(function* () {
          const { context, artifacts } = input;
          yield* checkSignal(context.signal);
          if (artifacts.has(IssueArtifactKind.IssueResolutionDecision)) {
            const resolution = yield* artifacts.read(
              IssueArtifactKind.IssueResolutionDecision,
            );
            return resolution.status === IssueResolutionStatus.Resolved
              ? ({
                  kind: IssueExecutionOutcomeKind.Completed,
                  completion: IssueCompletionKind.AlreadyResolved,
                  resolutionSummary: resolution.summary,
                  evidence: resolution.evidence,
                } as const)
              : ({
                  kind: IssueExecutionOutcomeKind.Failed,
                  message: resolution.summary,
                } as const);
          }
          if (
            artifacts.has(IssueArtifactKind.IssueCheckpoint) &&
            artifacts.has(IssueArtifactKind.CreatedCommit)
          ) {
            const storedCheckpoint = yield* artifacts.read(
              IssueArtifactKind.IssueCheckpoint,
            );
            const createdCommit = yield* artifacts.read(
              IssueArtifactKind.CreatedCommit,
            );
            const actual = yield* context.repositoryInvariant.capture(
              context.repositoryPath,
            );
            if (actual.head.toLowerCase() === createdCommit.sha.toLowerCase()) {
              yield* remoteSafety
                .verifyDirectPush({
                  repository: context.repository,
                  repositoryPath: context.repositoryPath,
                  branch: context.targetBranch,
                  intendedBaseSha: storedCheckpoint.sha,
                  expectedCommitSha: createdCommit.sha,
                  pushMode: GitPushMode.NonForce,
                })
                .pipe(
                  Effect.mapError(asRalphieError),
                  Effect.zipRight(
                    operations
                      .push(
                        context.repositoryPath,
                        context.targetBranch,
                        createdCommit.sha,
                      )
                      .pipe(Effect.mapError(asRalphieError)),
                  ),
                );
              const savedReviews = artifacts.has(
                IssueArtifactKind.ReviewAttempts,
              )
                ? yield* artifacts.read(IssueArtifactKind.ReviewAttempts)
                : [];
              return {
                kind: IssueExecutionOutcomeKind.Completed,
                completion: IssueCompletionKind.PushedCommit,
                commitSha: createdCommit.sha,
                reviewCount: savedReviews.length,
              } as const;
            }
            if (
              actual.head.toLowerCase() !== storedCheckpoint.sha.toLowerCase()
            ) {
              return yield* new RalphieError({
                message: `Cannot recover issue #${context.issue.number}: checkout HEAD ${actual.head} matches neither checkpoint ${storedCheckpoint.sha} nor created commit ${createdCommit.sha}.`,
              });
            }
          }
          const checkpoint = yield* readCheckpoint(preparation, input);
          if (
            artifacts.has(IssueArtifactKind.ReviewAttempts) ||
            artifacts.has(IssueArtifactKind.CommitMessageDecision)
          ) {
            yield* artifacts.resetImplementationAttempt();
          }
          const invariant = {
            branch: checkpoint.branch,
            head: checkpoint.sha,
          };
          yield* context.repositoryInvariant.verify(
            context.repositoryPath,
            invariant,
          );
          yield* stage(
            progress,
            input,
            ProgressStage.RemoteSafety,
            "Checking repository push safety...",
            remoteSafety
              .verifyDirectPush({
                repository: context.repository,
                repositoryPath: context.repositoryPath,
                branch: context.targetBranch,
                intendedBaseSha: checkpoint.sha,
                pushMode: GitPushMode.NonForce,
              })
              .pipe(Effect.mapError(asRalphieError)),
            "Repository push safety checks passed.",
          );

          yield* stage(
            progress,
            input,
            ProgressStage.Implementation,
            `Implementing #${context.issue.number}...`,
            runPiTask(context.pi, {
              directory: context.repositoryPath,
              title: `Implement issue #${context.issue.number}`,
              selection: context.piSelection,
              prompt: buildImplementationPrompt({
                issue: context.issue,
                repositoryPath: context.repositoryPath,
                targetBranch: context.targetBranch,
              }),
              runId: context.runId,
              diagnostics: context.piDiagnostics,
              repositoryInvariant: invariant,
              verifyRepositoryInvariant: context.repositoryInvariant.verify,
              progress,
              progressStage: ProgressStage.Implementation,
              progressIssue: issueProgress(input).issue,
              signal: context.signal,
            }),
            "Implementation completed.",
          );

          yield* checkSignal(context.signal);
          yield* stage(
            progress,
            input,
            ProgressStage.ChangeStaging,
            "Staging all implementation changes...",
            operations.stageAll(context.repositoryPath),
            "Implementation changes staged.",
          );
          const hasChanges = yield* operations.hasStagedChanges(
            context.repositoryPath,
          );
          if (!hasChanges) {
            const resolution = yield* stage(
              progress,
              input,
              ProgressStage.ResolutionVerification,
              "Verifying whether the issue is already resolved...",
              requestStructuredOutput(context.pi, {
                directory: context.repositoryPath,
                title: `Verify resolution of issue #${context.issue.number}`,
                prompt: buildResolutionVerificationPrompt({
                  issue: context.issue,
                  repositoryPath: context.repositoryPath,
                  targetBranch: context.targetBranch,
                }),
                schema: issueResolutionDecisionSchema,
                agent: context.piSelection.agent,
                model: context.piSelection.model,
                variant: context.piSelection.variant,
                runId: context.runId,
                diagnostics: context.piDiagnostics,
                repositoryInvariant: invariant,
                verifyRepositoryInvariant: context.repositoryInvariant.verify,
                progress,
                progressStage: ProgressStage.ResolutionVerification,
                progressIssue: issueProgress(input).issue,
                signal: context.signal,
              }),
              ({ output }) =>
                output.status === IssueResolutionStatus.Resolved
                  ? "Issue is already resolved in the current checkout."
                  : "Issue remains unresolved in the current checkout.",
            );
            yield* artifacts.write(
              IssueArtifactKind.IssueResolutionDecision,
              resolution.output,
            );
            return resolution.output.status === IssueResolutionStatus.Resolved
              ? ({
                  kind: IssueExecutionOutcomeKind.Completed,
                  completion: IssueCompletionKind.AlreadyResolved,
                  resolutionSummary: resolution.output.summary,
                  evidence: resolution.output.evidence,
                } as const)
              : ({
                  kind: IssueExecutionOutcomeKind.Failed,
                  message: `Issue remains unresolved after a no-change implementation: ${resolution.output.summary}`,
                } as const);
          }

          const reviews: ReviewAttempt[] = [];
          for (
            let attempt = 1;
            attempt <= REVIEW_ITERATION_LIMIT;
            attempt += 1
          ) {
            yield* checkSignal(context.signal);
            const stagedDiff = yield* operations.readStagedBinaryDiff(
              context.repositoryPath,
            );
            const reviewResult = yield* stage(
              progress,
              input,
              ProgressStage.Review,
              `Reviewing staged changes (attempt ${attempt}/${REVIEW_ITERATION_LIMIT})...`,
              requestStructuredOutput(context.pi, {
                directory: context.repositoryPath,
                title: `Review issue #${context.issue.number} (attempt ${attempt})`,
                prompt: buildReviewPrompt({
                  issue: context.issue,
                  repositoryPath: context.repositoryPath,
                  targetBranch: context.targetBranch,
                  stagedDiff,
                }),
                schema: reviewDecisionSchema,
                agent: context.piSelection.agent,
                model: context.piSelection.model,
                variant: context.piSelection.variant,
                runId: context.runId,
                diagnostics: context.piDiagnostics,
                repositoryInvariant: invariant,
                verifyRepositoryInvariant: context.repositoryInvariant.verify,
                progress,
                progressStage: ProgressStage.Review,
                progressIssue: issueProgress(input).issue,
                signal: context.signal,
              }),
              ({ output }) =>
                `Review ${attempt}/${REVIEW_ITERATION_LIMIT}: ${output.verdict}.`,
              undefined,
              attempt,
            );
            const review: ReviewAttempt = {
              attempt,
              sessionID: reviewResult.sessionID,
              decision: reviewResult.output,
            };
            reviews.push(review);
            yield* artifacts.appendReview(review);

            if (review.decision.verdict === ReviewVerdict.Approved) {
              const finalDiff = yield* operations.readStagedBinaryDiff(
                context.repositoryPath,
              );
              const commitMessage = yield* stage(
                progress,
                input,
                ProgressStage.CommitMessage,
                "Generating a commit message...",
                requestStructuredOutput(context.pi, {
                  directory: context.repositoryPath,
                  title: `Generate commit message for issue #${context.issue.number}`,
                  prompt: buildCommitMessagePrompt({
                    issue: context.issue,
                    repositoryPath: context.repositoryPath,
                    targetBranch: context.targetBranch,
                    stagedDiff: finalDiff,
                  }),
                  schema: commitMessageDecisionSchema,
                  agent: context.piSelection.agent,
                  model: context.piSelection.model,
                  variant: context.piSelection.variant,
                  runId: context.runId,
                  diagnostics: context.piDiagnostics,
                  repositoryInvariant: invariant,
                  verifyRepositoryInvariant: context.repositoryInvariant.verify,
                  progress,
                  progressStage: ProgressStage.CommitMessage,
                  progressIssue: issueProgress(input).issue,
                  signal: context.signal,
                }),
                "Commit message generated.",
              );
              yield* artifacts.write(
                IssueArtifactKind.CommitMessageDecision,
                commitMessage.output,
              );
              const commit = yield* stage(
                progress,
                input,
                ProgressStage.Commit,
                "Committing implementation changes...",
                operations.commit(context.repositoryPath, commitMessage.output),
                "Implementation changes committed.",
              );
              yield* artifacts.write(IssueArtifactKind.CreatedCommit, commit);
              yield* checkSignal(context.signal);
              yield* progress.emit({
                ...issueProgress(input),
                stage: ProgressStage.Commit,
                status: ProgressStatus.Info,
                message: "Created the issue commit.",
                details: {
                  commitSha: commit.sha,
                },
              });
              yield* stage(
                progress,
                input,
                ProgressStage.Push,
                `Pushing ${context.targetBranch}...`,
                remoteSafety
                  .verifyDirectPush({
                    repository: context.repository,
                    repositoryPath: context.repositoryPath,
                    branch: context.targetBranch,
                    intendedBaseSha: checkpoint.sha,
                    expectedCommitSha: commit.sha,
                    pushMode: GitPushMode.NonForce,
                  })
                  .pipe(
                    Effect.mapError(asRalphieError),
                    Effect.zipRight(
                      operations
                        .push(
                          context.repositoryPath,
                          context.targetBranch,
                          commit.sha,
                        )
                        .pipe(Effect.mapError(asRalphieError)),
                    ),
                  ),
                `Pushed ${context.targetBranch}.`,
                {
                  commitSha: commit.sha,
                },
              );
              return {
                kind: IssueExecutionOutcomeKind.Completed,
                completion: IssueCompletionKind.PushedCommit,
                commitSha: commit.sha,
                reviewCount: reviews.length,
              } as const;
            }

            if (attempt === REVIEW_ITERATION_LIMIT) {
              const exhausted = yield* recovery.handleReviewExhaustion({
                runId: context.runId,
                repository: context.repository,
                workspace: context.workspace,
                repositoryPath: context.repositoryPath,
                issue: context.issue,
                checkpoint,
                reviews,
              });
              return {
                kind: IssueExecutionOutcomeKind.Escalated,
                diagnosticsPath: exhausted.diagnosticsPath,
                reason:
                  "Review did not converge within the review iteration budget.",
              } as const;
            }

            const currentDiff = yield* operations.readStagedBinaryDiff(
              context.repositoryPath,
            );
            yield* stage(
              progress,
              input,
              ProgressStage.ReviewFix,
              `Addressing review findings (attempt ${attempt})...`,
              runPiTask(context.pi, {
                directory: context.repositoryPath,
                title: `Address review for issue #${context.issue.number} (attempt ${attempt})`,
                selection: context.piSelection,
                prompt: buildReviewFixPrompt({
                  issue: context.issue,
                  repositoryPath: context.repositoryPath,
                  targetBranch: context.targetBranch,
                  stagedDiff: currentDiff,
                  review: review.decision,
                }),
                runId: context.runId,
                diagnostics: context.piDiagnostics,
                repositoryInvariant: invariant,
                verifyRepositoryInvariant: context.repositoryInvariant.verify,
                progress,
                progressStage: ProgressStage.ReviewFix,
                progressIssue: issueProgress(input).issue,
                signal: context.signal,
              }),
              "Review findings addressed.",
              undefined,
              attempt,
            );
            yield* checkSignal(context.signal);
            yield* stage(
              progress,
              input,
              ProgressStage.ChangeStaging,
              `Restaging review-fix changes (attempt ${attempt})...`,
              operations.stageAll(context.repositoryPath),
              "Review-fix changes staged.",
              undefined,
              attempt,
            );
            if (!(yield* operations.hasStagedChanges(context.repositoryPath))) {
              yield* progress.emit({
                ...issueProgress(input),
                stage: ProgressStage.ReviewFix,
                status: ProgressStatus.Failed,
                attempt,
                maxAttempts: REVIEW_ITERATION_LIMIT,
                message: `Review fix attempt ${attempt} produced no changes.`,
              });
              return {
                kind: IssueExecutionOutcomeKind.Failed,
                message: `Review fix attempt ${attempt} produced no changes.`,
              } as const;
            }
          }

          return yield* new RalphieError({
            message: "Implementation review loop ended unexpectedly.",
          });
        }).pipe(
          Effect.mapError((error: GitIssueOperationError | RalphieError) =>
            asRalphieError(error),
          ),
        ),
    } satisfies ImplementationExecutorService;
  }),
);