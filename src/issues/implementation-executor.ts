import { Context, Effect, Layer } from "effect";
import { readdir } from "node:fs/promises";
import { basename } from "node:path";

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
} from "../opencode/prompts.ts";
import { requestStructuredOutput } from "../opencode/structured-output.ts";
import { runOpenCodeTask } from "../opencode/task-session.ts";
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
import {
  type CreatedCommitMapping,
  IssueArtifactKind,
  type ProjectCheckpoint,
} from "./artifacts.ts";
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

export const ImplementationExecutor = Context.GenericTag<ImplementationExecutorService>(
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
      new RalphieError({ message: "Issue execution was aborted.", cause }),
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
    ...(attempt === undefined ? {} : { attempt, maxAttempts: REVIEW_ITERATION_LIMIT }),
    ...(details === undefined ? {} : { details }),
  };
  return progress
    .emit({ ...base, status: ProgressStatus.Started, message: startedMessage })
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

const projectPromptInput = (context: IssueExecutionContext) => ({
  repositoryPath: context.workingDirectory ?? context.repositoryPath,
  targetBranch: context.targetBranch,
  sourceRepository: context.repository,
  projectRepositories: context.projectRepositories,
});

const executeProjectImplementation = (
  input: WorkflowExecutorInput,
  services: {
    readonly preparation: GitIssuePreparationService;
    readonly operations: GitIssueOperationsService;
    readonly remoteSafety: GitRemoteSafetyService;
    readonly recovery: IssueRecoveryService;
    readonly progress: ProgressReporterService;
  },
): Effect.Effect<WorkflowExecutorResult, RalphieError> =>
  Effect.gen(function* () {
    const { context, artifacts } = input;
    const repositories = context.projectRepositories ?? [];
    const workingDirectory = context.workingDirectory ?? context.repositoryPath;
    if (repositories.length <= 1) {
      return yield* new RalphieError({
        message: "Project implementation requires multiple repositories.",
      });
    }
    if (artifacts.has(IssueArtifactKind.IssueResolutionDecision)) {
      const resolution = yield* artifacts.read(
        IssueArtifactKind.IssueResolutionDecision,
      );
      return resolution.status === IssueResolutionStatus.Resolved
        ? {
            kind: IssueExecutionOutcomeKind.Completed,
            completion: IssueCompletionKind.AlreadyResolved,
            resolutionSummary: resolution.summary,
            evidence: resolution.evidence,
          }
        : {
            kind: IssueExecutionOutcomeKind.Failed,
            message: resolution.summary,
          };
    }

    const checkpoints = artifacts.has(IssueArtifactKind.ProjectCheckpoints)
      ? yield* artifacts.read(IssueArtifactKind.ProjectCheckpoints)
      : services.preparation.prepareProject === undefined
        ? yield* new RalphieError({
            message: "Project Git checkpoint preparation is unavailable.",
          })
        : yield* services.preparation.prepareProject(repositories, artifacts);
    const checkpointByRepository = new Map(
      checkpoints.map((checkpoint) => [checkpoint.repository, checkpoint]),
    );
    const verifyProject = () =>
      Effect.forEach(
        checkpoints,
        (checkpoint) =>
          context.repositoryInvariant.verify(checkpoint.repositoryPath, {
            branch: checkpoint.branch,
            head: checkpoint.sha,
          }),
        { discard: true },
      );
    const verifyProjectContainer = () =>
      Effect.tryPromise({
        try: async () => {
          const allowed = new Set(
            repositories.map(({ repositoryPath }) => basename(repositoryPath)),
          );
          let entries: string[];
          try {
            entries = await readdir(workingDirectory);
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
            throw cause;
          }
          const unexpected = entries
            .map((entry) => entry)
            .filter((entry) => !allowed.has(entry));
          if (unexpected.length > 0) {
            throw new RalphieError({
              message: `Project agent created files outside repository checkouts: ${unexpected.join(", ")}.`,
            });
          }
        },
        catch: (cause) =>
          cause instanceof RalphieError
            ? cause
            : new RalphieError({
                message: `Failed to inspect project working directory ${workingDirectory}.`,
                cause,
              }),
      });
    const stageProject = () =>
      Effect.forEach(
        repositories,
        (repository) => services.operations.stageAll(repository.repositoryPath),
        { discard: true },
      );
    const changedRepositories = () =>
      Effect.filter(repositories, (repository) =>
        services.operations.hasStagedChanges(repository.repositoryPath),
      );
    const combinedDiff = (changed: ReadonlyArray<(typeof repositories)[number]>) =>
      Effect.forEach(changed, (repository) =>
        services.operations
          .readStagedBinaryDiff(repository.repositoryPath)
          .pipe(
            Effect.map(
              (diff) =>
                `Repository: ${repository.repository}\nPath: ${repository.repositoryPath}\n${diff}`,
            ),
          ),
      ).pipe(Effect.map((diffs) => diffs.join("\n\n")));
    const verifyDeliverySafety = (
      created: CreatedCommitMapping,
      changed: ReadonlyArray<(typeof repositories)[number]>,
    ) =>
      Effect.forEach(
        changed,
        (repository) => {
          const checkpoint = checkpointByRepository.get(repository.repository)!;
          const commit = created[repository.repository]!;
          return services.remoteSafety
            .verifyDirectPush({
              repository: repository.repository,
              repositoryPath: repository.repositoryPath,
              branch: repository.branch,
              intendedBaseSha: checkpoint.sha,
              expectedCommitSha: commit.sha,
              pushMode: GitPushMode.NonForce,
            })
            .pipe(Effect.mapError(asRalphieError));
        },
        { discard: true },
      );
    const deliver = (
      created: CreatedCommitMapping,
      changed: ReadonlyArray<(typeof repositories)[number]>,
    ) =>
      Effect.gen(function* () {
        yield* stage(
          services.progress,
          input,
          ProgressStage.Push,
          `Pushing ${changed.length} changed project repositories...`,
          verifyDeliverySafety(created, changed).pipe(
            Effect.zipRight(
              Effect.forEach(
                changed,
                (repository) =>
                  services.operations
                    .push(
                      repository.repositoryPath,
                      repository.branch,
                      created[repository.repository]!.sha,
                    )
                    .pipe(Effect.mapError(asRalphieError)),
                { discard: true },
              ),
            ),
          ),
          "All changed project repositories pushed.",
          { repositories: changed.map(({ repository }) => repository) },
        );
        const commits = changed.map((repository) => ({
          repository: repository.repository,
          sha: created[repository.repository]!.sha,
        }));
        const reviews = artifacts.has(IssueArtifactKind.ReviewAttempts)
          ? yield* artifacts.read(IssueArtifactKind.ReviewAttempts)
          : [];
        return {
          kind: IssueExecutionOutcomeKind.Completed,
          completion: IssueCompletionKind.PushedCommit,
          commitSha: commits[0]!.sha,
          commits,
          reviewCount: reviews.length,
        } as const;
      });

    if (artifacts.has(IssueArtifactKind.CreatedCommits)) {
      const created = yield* artifacts.read(IssueArtifactKind.CreatedCommits);
      yield* Effect.forEach(
        checkpoints,
        (checkpoint) =>
          context.repositoryInvariant.capture(checkpoint.repositoryPath).pipe(
            Effect.flatMap((actual) => {
              const expectedHead =
                created[checkpoint.repository]?.sha ?? checkpoint.sha;
              return actual.branch === checkpoint.branch &&
                actual.head.toLowerCase() === expectedHead.toLowerCase()
                ? Effect.void
                : Effect.fail(
                    new RalphieError({
                      message: `Cannot resume project issue #${context.issue.number}: ${checkpoint.repository} is on ${actual.branch} at ${actual.head}, expected ${checkpoint.branch} at ${expectedHead}.`,
                    }),
                  );
            }),
          ),
        { discard: true },
      );
      yield* stageProject();
      const remaining = (yield* changedRepositories()).filter(
        ({ repository }) => created[repository] === undefined,
      );
      if (remaining.length > 0) {
        if (!artifacts.has(IssueArtifactKind.CommitMessageDecision)) {
          return yield* new RalphieError({
            message:
              "Cannot resume partially committed project work without its commit message decision.",
          });
        }
        const message = yield* artifacts.read(IssueArtifactKind.CommitMessageDecision);
        for (const repository of remaining) {
          const commit = yield* services.operations.commit(
            repository.repositoryPath,
            message,
          );
          yield* artifacts.recordCreatedCommit(repository.repository, commit);
        }
      }
      const completed = yield* artifacts.read(IssueArtifactKind.CreatedCommits);
      const affected = repositories.filter(
        ({ repository }) => completed[repository] !== undefined,
      );
      return yield* deliver(completed, affected);
    }

    yield* verifyProject();
    yield* stage(
      services.progress,
      input,
      ProgressStage.RemoteSafety,
      "Verifying project direct-push safety...",
      Effect.forEach(
        checkpoints,
        (checkpoint) =>
          services.remoteSafety
            .verifyDirectPush({
              repository: checkpoint.repository,
              repositoryPath: checkpoint.repositoryPath,
              branch: checkpoint.branch,
              intendedBaseSha: checkpoint.sha,
              pushMode: GitPushMode.NonForce,
            })
            .pipe(Effect.mapError(asRalphieError)),
        { discard: true },
      ),
      "Project direct-push safety verified.",
    );
    yield* stage(
      services.progress,
      input,
      ProgressStage.Implementation,
      `Implementing #${context.issue.number} across the project...`,
      runOpenCodeTask(context.openCode, {
        directory: workingDirectory,
        title: `Implement issue #${context.issue.number}`,
        selection: context.openCodeSelection,
        prompt: buildImplementationPrompt({
          issue: context.issue,
          ...projectPromptInput(context),
        }),
        runId: context.runId,
        diagnostics: context.openCodeDiagnostics,
        verifyAfter: verifyProject,
        progress: services.progress,
        progressStage: ProgressStage.Implementation,
        progressIssue: issueProgress(input).issue,
        signal: context.signal,
      }),
      "Project implementation completed.",
    );
    yield* verifyProjectContainer();
    yield* checkSignal(context.signal);
    yield* stage(
      services.progress,
      input,
      ProgressStage.ChangeStaging,
      "Staging changes across project repositories...",
      stageProject(),
      "Project repository changes staged.",
    );
    let changed = yield* changedRepositories();
    if (changed.length === 0) {
      const resolution = yield* stage(
        services.progress,
        input,
        ProgressStage.ResolutionVerification,
        "Verifying whether the project issue is already resolved...",
        requestStructuredOutput(context.openCode, {
          directory: workingDirectory,
          title: `Verify resolution of issue #${context.issue.number}`,
          prompt: buildResolutionVerificationPrompt({
            issue: context.issue,
            ...projectPromptInput(context),
          }),
          schema: issueResolutionDecisionSchema,
          agent: context.openCodeSelection.agent,
          model: context.openCodeSelection.model,
          variant: context.openCodeSelection.variant,
          runId: context.runId,
          diagnostics: context.openCodeDiagnostics,
          verifyAfter: verifyProject,
          progress: services.progress,
          progressStage: ProgressStage.ResolutionVerification,
          progressIssue: issueProgress(input).issue,
          signal: context.signal,
        }),
        ({ output }) =>
          output.status === IssueResolutionStatus.Resolved
            ? "Issue is already resolved across the project."
            : "Issue remains unresolved across the project.",
      );
      yield* artifacts.write(
        IssueArtifactKind.IssueResolutionDecision,
        resolution.output,
      );
      return resolution.output.status === IssueResolutionStatus.Resolved
        ? {
            kind: IssueExecutionOutcomeKind.Completed,
            completion: IssueCompletionKind.AlreadyResolved,
            resolutionSummary: resolution.output.summary,
            evidence: resolution.output.evidence,
          }
        : {
            kind: IssueExecutionOutcomeKind.Failed,
            message: `Issue remains unresolved after a no-change implementation: ${resolution.output.summary}`,
          };
    }

    const reviews: ReviewAttempt[] = [];
    for (let attempt = 1; attempt <= REVIEW_ITERATION_LIMIT; attempt += 1) {
      const stagedDiff = yield* combinedDiff(changed);
      const reviewResult = yield* stage(
        services.progress,
        input,
        ProgressStage.Review,
        `Reviewing project changes (attempt ${attempt}/${REVIEW_ITERATION_LIMIT})...`,
        requestStructuredOutput(context.openCode, {
          directory: workingDirectory,
          title: `Review issue #${context.issue.number} (attempt ${attempt})`,
          prompt: buildReviewPrompt({
            issue: context.issue,
            ...projectPromptInput(context),
            stagedDiff,
          }),
          schema: reviewDecisionSchema,
          agent: context.openCodeSelection.agent,
          model: context.openCodeSelection.model,
          variant: context.openCodeSelection.variant,
          runId: context.runId,
          diagnostics: context.openCodeDiagnostics,
          verifyAfter: verifyProject,
          progress: services.progress,
          progressStage: ProgressStage.Review,
          progressIssue: issueProgress(input).issue,
          signal: context.signal,
        }),
        ({ output }) =>
          `Review ${attempt}/${REVIEW_ITERATION_LIMIT}: ${output.verdict}.`,
        undefined,
        attempt,
      );
      const review = {
        attempt,
        sessionID: reviewResult.sessionID,
        decision: reviewResult.output,
      };
      reviews.push(review);
      yield* artifacts.appendReview(review);

      if (review.decision.verdict === ReviewVerdict.Approved) {
        const finalDiff = yield* combinedDiff(changed);
        const commitMessage = yield* stage(
          services.progress,
          input,
          ProgressStage.CommitMessage,
          "Generating a project commit message...",
          requestStructuredOutput(context.openCode, {
            directory: workingDirectory,
            title: `Generate commit message for issue #${context.issue.number}`,
            prompt: buildCommitMessagePrompt({
              issue: context.issue,
              ...projectPromptInput(context),
              stagedDiff: finalDiff,
            }),
            schema: commitMessageDecisionSchema,
            agent: context.openCodeSelection.agent,
            model: context.openCodeSelection.model,
            variant: context.openCodeSelection.variant,
            runId: context.runId,
            diagnostics: context.openCodeDiagnostics,
            verifyAfter: verifyProject,
            progress: services.progress,
            progressStage: ProgressStage.CommitMessage,
            progressIssue: issueProgress(input).issue,
            signal: context.signal,
          }),
          "Project commit message generated.",
        );
        yield* artifacts.write(
          IssueArtifactKind.CommitMessageDecision,
          commitMessage.output,
        );
        yield* stage(
          services.progress,
          input,
          ProgressStage.Commit,
          `Committing changes in ${changed.length} project repositories...`,
          Effect.forEach(
            changed,
            (repository) =>
              services.operations
                .commit(repository.repositoryPath, commitMessage.output)
                .pipe(
                  Effect.tap((commit) =>
                    artifacts.recordCreatedCommit(repository.repository, commit),
                  ),
                ),
            { discard: true },
          ),
          "Project repository changes committed.",
          { repositories: changed.map(({ repository }) => repository) },
        );
        const created = yield* artifacts.read(IssueArtifactKind.CreatedCommits);
        return yield* deliver(created, changed);
      }

      if (attempt === REVIEW_ITERATION_LIMIT) {
        if (services.recovery.handleProjectReviewExhaustion === undefined) {
          return yield* new RalphieError({
            message: "Project review exhaustion recovery is unavailable.",
          });
        }
        const exhausted = yield* services.recovery.handleProjectReviewExhaustion({
          runId: context.runId,
          ...(context.project === undefined ? {} : { project: context.project }),
          repository: context.repository,
          workspace: context.workspace,
          issue: context.issue,
          checkpoints,
          reviews,
        });
        return {
          kind: IssueExecutionOutcomeKind.Escalated,
          diagnosticsPath: exhausted.diagnosticsPath,
          reason: "Review did not converge within the review iteration budget.",
        };
      }

      yield* stage(
        services.progress,
        input,
        ProgressStage.ReviewFix,
        `Addressing project review findings (attempt ${attempt})...`,
        runOpenCodeTask(context.openCode, {
          directory: workingDirectory,
          title: `Address review for issue #${context.issue.number} (attempt ${attempt})`,
          selection: context.openCodeSelection,
          prompt: buildReviewFixPrompt({
            issue: context.issue,
            ...projectPromptInput(context),
            stagedDiff,
            review: review.decision,
          }),
          runId: context.runId,
          diagnostics: context.openCodeDiagnostics,
          verifyAfter: verifyProject,
          progress: services.progress,
          progressStage: ProgressStage.ReviewFix,
          progressIssue: issueProgress(input).issue,
          signal: context.signal,
        }),
        "Project review findings addressed.",
        undefined,
        attempt,
      );
      yield* verifyProjectContainer();
      yield* stage(
        services.progress,
        input,
        ProgressStage.ChangeStaging,
        `Restaging project changes (attempt ${attempt})...`,
        stageProject(),
        "Project review-fix changes staged.",
        undefined,
        attempt,
      );
      changed = yield* changedRepositories();
      if (changed.length === 0) {
        return {
          kind: IssueExecutionOutcomeKind.Failed,
          message: `Review fix attempt ${attempt} produced no project changes.`,
        };
      }
    }
    return yield* new RalphieError({
      message: "Project implementation review loop ended unexpectedly.",
    });
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
          if ((context.projectRepositories?.length ?? 0) > 1) {
            return yield* executeProjectImplementation(input, {
              preparation,
              operations,
              remoteSafety,
              recovery,
              progress,
            });
          }
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
              const savedReviews = artifacts.has(IssueArtifactKind.ReviewAttempts)
                ? yield* artifacts.read(IssueArtifactKind.ReviewAttempts)
                : [];
              return {
                kind: IssueExecutionOutcomeKind.Completed,
                completion: IssueCompletionKind.PushedCommit,
                commitSha: createdCommit.sha,
                reviewCount: savedReviews.length,
              } as const;
            }
            if (actual.head.toLowerCase() !== storedCheckpoint.sha.toLowerCase()) {
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
          yield* context.repositoryInvariant.verify(context.repositoryPath, invariant);
          yield* stage(
            progress,
            input,
            ProgressStage.RemoteSafety,
            "Verifying direct-push safety...",
            remoteSafety
              .verifyDirectPush({
                repository: context.repository,
                repositoryPath: context.repositoryPath,
                branch: context.targetBranch,
                intendedBaseSha: checkpoint.sha,
                pushMode: GitPushMode.NonForce,
              })
              .pipe(Effect.mapError(asRalphieError)),
            "Direct-push safety verified.",
          );

          yield* stage(
            progress,
            input,
            ProgressStage.Implementation,
            `Implementing #${context.issue.number}...`,
            runOpenCodeTask(context.openCode, {
              directory: context.repositoryPath,
              title: `Implement issue #${context.issue.number}`,
              selection: context.openCodeSelection,
              prompt: buildImplementationPrompt({
                issue: context.issue,
                repositoryPath: context.repositoryPath,
                targetBranch: context.targetBranch,
              }),
              runId: context.runId,
              diagnostics: context.openCodeDiagnostics,
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
          const hasChanges = yield* operations.hasStagedChanges(context.repositoryPath);
          if (!hasChanges) {
            const resolution = yield* stage(
              progress,
              input,
              ProgressStage.ResolutionVerification,
              "Verifying whether the issue is already resolved...",
              requestStructuredOutput(context.openCode, {
                directory: context.repositoryPath,
                title: `Verify resolution of issue #${context.issue.number}`,
                prompt: buildResolutionVerificationPrompt({
                  issue: context.issue,
                  repositoryPath: context.repositoryPath,
                  targetBranch: context.targetBranch,
                }),
                schema: issueResolutionDecisionSchema,
                agent: context.openCodeSelection.agent,
                model: context.openCodeSelection.model,
                variant: context.openCodeSelection.variant,
                runId: context.runId,
                diagnostics: context.openCodeDiagnostics,
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
          for (let attempt = 1; attempt <= REVIEW_ITERATION_LIMIT; attempt += 1) {
            yield* checkSignal(context.signal);
            const stagedDiff = yield* operations.readStagedBinaryDiff(
              context.repositoryPath,
            );
            const reviewResult = yield* stage(
              progress,
              input,
              ProgressStage.Review,
              `Reviewing staged changes (attempt ${attempt}/${REVIEW_ITERATION_LIMIT})...`,
              requestStructuredOutput(context.openCode, {
                directory: context.repositoryPath,
                title: `Review issue #${context.issue.number} (attempt ${attempt})`,
                prompt: buildReviewPrompt({
                  issue: context.issue,
                  repositoryPath: context.repositoryPath,
                  targetBranch: context.targetBranch,
                  stagedDiff,
                }),
                schema: reviewDecisionSchema,
                agent: context.openCodeSelection.agent,
                model: context.openCodeSelection.model,
                variant: context.openCodeSelection.variant,
                runId: context.runId,
                diagnostics: context.openCodeDiagnostics,
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
                requestStructuredOutput(context.openCode, {
                  directory: context.repositoryPath,
                  title: `Generate commit message for issue #${context.issue.number}`,
                  prompt: buildCommitMessagePrompt({
                    issue: context.issue,
                    repositoryPath: context.repositoryPath,
                    targetBranch: context.targetBranch,
                    stagedDiff: finalDiff,
                  }),
                  schema: commitMessageDecisionSchema,
                  agent: context.openCodeSelection.agent,
                  model: context.openCodeSelection.model,
                  variant: context.openCodeSelection.variant,
                  runId: context.runId,
                  diagnostics: context.openCodeDiagnostics,
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
                details: { commitSha: commit.sha },
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
                        .push(context.repositoryPath, context.targetBranch, commit.sha)
                        .pipe(Effect.mapError(asRalphieError)),
                    ),
                  ),
                `Pushed ${context.targetBranch}.`,
                { commitSha: commit.sha },
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
                ...(context.project === undefined ? {} : { project: context.project }),
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
                reason: "Review did not converge within the review iteration budget.",
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
              runOpenCodeTask(context.openCode, {
                directory: context.repositoryPath,
                title: `Address review for issue #${context.issue.number} (attempt ${attempt})`,
                selection: context.openCodeSelection,
                prompt: buildReviewFixPrompt({
                  issue: context.issue,
                  repositoryPath: context.repositoryPath,
                  targetBranch: context.targetBranch,
                  stagedDiff: currentDiff,
                  review: review.decision,
                }),
                runId: context.runId,
                diagnostics: context.openCodeDiagnostics,
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
