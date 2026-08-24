import { Effect } from "effect";
import { join } from "node:path";

import { GitRepository } from "./git/repository.ts";
import { GitRepositoryInvariant } from "./git/repository-invariant.ts";
import { GitIssueCheckpoint } from "./git/issue-checkpoint.ts";
import { GitHubClient } from "./github/client.ts";
import {
  type GitHubIssue,
  GitHubIssues,
  type IssueFilters,
} from "./github/issues.ts";
import {
  IssueExecutionOutcomeKind,
  type IssueExecutionOutcome,
} from "./issues/execution.ts";
import { IssueExecutor } from "./issues/executor.ts";
import {
  createIssueQueue,
  IssueQueueState,
  toQueuedIssues,
} from "./issues/queue.ts";
import type { OpenCodeModel } from "./opencode/model.ts";
import { OpenCode, type OpenCodeServer } from "./opencode/server.ts";
import { makeOpenCodeSessionDiagnostics } from "./opencode/task-session.ts";
import {
  ProgressReporter,
  type ProgressReporterService,
  ProgressStage,
  ProgressStatus,
  type ProgressUpdate,
} from "./progress/progress.ts";
import { reconcileRunState } from "./run/reconciliation.ts";
import {
  RUN_STATE_VERSION,
  type RunState,
  RunStateStatus,
  RunStateStore,
} from "./run/state.ts";
import { RalphieError } from "./shared/error.ts";
import { Workspace, resolveWorkspacePath } from "./workspace/workspace.ts";

const closeServer = (server: OpenCodeServer) => Effect.sync(() => server.close());

type ProgressContext = Omit<ProgressUpdate, "stage" | "status" | "message">;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const checkCancellation = (signal: AbortSignal | undefined) =>
  Effect.try({
    try: () => signal?.throwIfAborted(),
    catch: (cause) =>
      new RalphieError({
        message: "Run cancelled before the next operation started.",
        cause,
      }),
  });

const copyOutcome = (outcome: IssueExecutionOutcome): RunState["outcomes"][number]["outcome"] => {
  switch (outcome.kind) {
    case IssueExecutionOutcomeKind.Decomposed:
      return { ...outcome, childIssueNumbers: [...outcome.childIssueNumbers] };
    case IssueExecutionOutcomeKind.Escalated:
      return {
        kind: outcome.kind,
        diagnosticsPath: outcome.diagnosticsPath,
        reason: outcome.reason,
        ...(outcome.childIssueNumbers === undefined
          ? {}
          : { childIssueNumbers: [...outcome.childIssueNumbers] }),
      };
    default:
      return { ...outcome };
  }
};

const track = <Result, Error, Requirements>(
  progress: ProgressReporterService,
  stage: ProgressStage,
  startedMessage: string,
  effect: Effect.Effect<Result, Error, Requirements>,
  succeededMessage: string | ((result: Result) => string),
  context: ProgressContext = {},
): Effect.Effect<Result, Error, Requirements> =>
  progress
    .emit({
      ...context,
      stage,
      status: ProgressStatus.Started,
      message: startedMessage,
    })
    .pipe(
      Effect.zipRight(effect),
      Effect.tap((result) =>
        progress.emit({
          ...context,
          stage,
          status: ProgressStatus.Succeeded,
          message:
            typeof succeededMessage === "function"
              ? succeededMessage(result)
              : succeededMessage,
        }),
      ),
      Effect.tapError((error) =>
        progress.emit({
          ...context,
          stage,
          status: ProgressStatus.Failed,
          message: `${startedMessage.replace(/\.{3}$/, "")} failed: ${errorMessage(error)}`,
        }),
      ),
    );

export enum IssueFailurePolicy {
  Halt = "halt",
}

export type WorkflowSummary = {
  readonly runId: string;
  readonly outcomes: ReadonlyArray<{
    readonly issueNumber: number;
    readonly outcome: IssueExecutionOutcome;
  }>;
  readonly counts: Readonly<Record<IssueExecutionOutcomeKind, number>>;
};

const summarize = (
  runId: string,
  outcomes: WorkflowSummary["outcomes"],
): WorkflowSummary => {
  const counts = Object.fromEntries(
    Object.values(IssueExecutionOutcomeKind).map((kind) => [kind, 0]),
  ) as Record<IssueExecutionOutcomeKind, number>;
  for (const { outcome } of outcomes) counts[outcome.kind] += 1;
  return { runId, outcomes, counts };
};

export type WorkflowOptions = {
  readonly repo: string;
  readonly branch: string;
  readonly maxIssues?: number;
  readonly issueFilters: IssueFilters;
  readonly agent: string;
  readonly model?: OpenCodeModel;
  readonly modelVariant?: string;
  readonly workspace: string;
  readonly cleanup: boolean;
  readonly startClean: boolean;
  readonly signal?: AbortSignal;
  readonly runId?: string;
  readonly resumeState?: RunState;
  readonly resumePath?: string;
  readonly issueFailurePolicy?: IssueFailurePolicy;
};

export const workflow = ({
  repo,
  branch,
  maxIssues,
  issueFilters,
  agent,
  model,
  modelVariant,
  workspace,
  cleanup,
  startClean,
  signal,
  runId = crypto.randomUUID(),
  resumeState,
  resumePath,
  issueFailurePolicy = IssueFailurePolicy.Halt,
}: WorkflowOptions) =>
  Effect.gen(function* () {
    const progress = yield* ProgressReporter;
    const stateStore = yield* RunStateStore;
    const actualRunId = resumeState?.runId ?? runId;
    const statePath =
      resumePath ??
      join(
        resolveWorkspacePath(workspace),
        ".ralphie",
        "runs",
        actualRunId,
        "state.json",
      );
    yield* progress.emit({
      stage: ProgressStage.Run,
      status: ProgressStatus.Info,
      message: `Ralphie started for ${repo} on ${branch}.`,
      details: {
        repository: repo,
        branch,
        workspace,
        model: model
          ? `${model.providerID}/${model.modelID}`
          : "OpenCode default",
        variant: modelVariant ?? "OpenCode default",
        agent,
        issueLimit: maxIssues ?? "unlimited",
        runId: actualRunId,
        ...(resumeState === undefined ? {} : { resumed: true, statePath }),
      },
    });

    let activeIssue: RunState["activeIssue"] | undefined;
    let activeQueueIssue: GitHubIssue | undefined;
    let persistCancellationState:
      | (() => Effect.Effect<void, RalphieError>)
      | undefined;
    let restoreCancellationCheckout:
      | (() => Effect.Effect<void, RalphieError>)
      | undefined;

    const run = Effect.gen(function* () {
      yield* checkCancellation(signal);
      if (startClean) {
        const workspaceService = yield* Workspace;
        yield* track(
          progress,
          ProgressStage.WorkspaceCleanup,
          `Removing existing workspace ${workspace}...`,
          workspaceService.remove(workspace),
          `Existing workspace removed: ${workspace}.`,
        );
      }

      const github = yield* GitHubClient;
      const octokit = yield* track(
        progress,
        ProgressStage.GitHubAuthentication,
        "Checking GitHub authentication...",
        github.initialize,
        "GitHub authentication verified and Octokit initialized.",
      );

      const repository = yield* GitRepository;
      yield* track(
        progress,
        ProgressStage.GitVerification,
        "Checking Git installation...",
        repository.verifyInstalled,
        "Git installation verified.",
      );

      const prepared = yield* track(
        progress,
        ProgressStage.RepositoryPreparation,
        `Preparing ${repo} on ${branch}...`,
        repository.prepare(repo, branch, workspace),
        (result) =>
          `${result.cloned ? "Repository cloned" : "Existing repository ready"}: ${result.path}.`,
        { details: { repository: repo, branch, workspace } },
      );

      const githubIssues = yield* GitHubIssues;
      const discoveredIssues = yield* track(
        progress,
        ProgressStage.IssueDiscovery,
        "Fetching matching open issues...",
        githubIssues.listOpen(octokit, repo, issueFilters),
        (result) =>
          result.length === 0
            ? "No open issues match the current filters."
            : `Found ${result.length} matching open issues; first is #${result[0]!.number} ${result[0]!.title}.`,
        { details: { filters: issueFilters } },
      );

      const invariantService = yield* GitRepositoryInvariant;
      const checkpoints = yield* GitIssueCheckpoint;
      let checkout = yield* invariantService.capture(prepared.path);
      if (resumeState !== undefined) {
        const reconciliation = reconcileRunState(resumeState, {
          repository: repo,
          branch,
          git: checkout,
          github: {
            openIssueNumbers: discoveredIssues.map(({ number }) => number),
          },
        });
        if (!reconciliation.compatible) {
          return yield* new RalphieError({
            message: `Cannot resume run ${resumeState.runId}: ${reconciliation.reasons.join("; ")}.`,
          });
        }
      }

      const initialIssues =
        resumeState === undefined
          ? discoveredIssues
          : resumeState.queue.pending;
      const queue = createIssueQueue(
        toQueuedIssues(initialIssues),
        resumeState?.maxIssues ?? maxIssues,
        resumeState === undefined
          ? undefined
          : {
              completedIssueNumbers:
                resumeState.queue.completedIssueNumbers,
              processedCount: resumeState.queue.processedCount,
            },
      );
      const outcomes: Array<{
        readonly issueNumber: number;
        readonly outcome: IssueExecutionOutcome;
      }> = [...(resumeState?.outcomes ?? [])];
      const selection = { agent, model, variant: modelVariant };

      const persistState = (
        status: RunStateStatus,
        activeIssue?: RunState["activeIssue"],
      ) => {
        const snapshot = queue.snapshot();
        const hasActiveQueueIssue =
          activeIssue !== undefined && activeQueueIssue !== undefined;
        const pending = snapshot.pending.map(({ issue }) => ({
          ...issue,
          labels: [...issue.labels],
        }));
        if (
          hasActiveQueueIssue &&
          !pending.some(({ number }) => number === activeQueueIssue.number)
        ) {
          pending.unshift({
            ...activeQueueIssue,
            labels: [...activeQueueIssue.labels],
          });
        }
        return stateStore.save(statePath, {
          version: RUN_STATE_VERSION,
          status,
          runId: actualRunId,
          repository: repo,
          branch,
          selection,
          ...((resumeState?.maxIssues ?? maxIssues) === undefined
            ? {}
            : { maxIssues: resumeState?.maxIssues ?? maxIssues }),
          queue: {
            pending,
            completedIssueNumbers: [...snapshot.completedIssueNumbers],
            processedCount: hasActiveQueueIssue
              ? Math.max(0, snapshot.processedCount - 1)
              : snapshot.processedCount,
          },
          outcomes: outcomes.map(({ issueNumber, outcome }) => ({
            issueNumber,
            outcome: copyOutcome(outcome),
          })),
          ...(activeIssue === undefined ? {} : { activeIssue }),
          checkout,
          updatedAt: new Date().toISOString(),
        });
      };

      persistCancellationState = () =>
        persistState(RunStateStatus.Active, activeIssue);

      yield* persistState(RunStateStatus.Active);
      const openCode = yield* OpenCode;
      const issueExecutor = yield* IssueExecutor;
      const diagnostics = makeOpenCodeSessionDiagnostics();
      yield* Effect.acquireUseRelease(
        track(
          progress,
          ProgressStage.OpenCodeServer,
          "Starting OpenCode server...",
          openCode.start,
          (server) => `OpenCode server started at ${server.url}.`,
        ),
        (server) =>
          Effect.gen(function* () {
            while (queue.state() === IssueQueueState.Ready) {
              yield* checkCancellation(signal);
              const issue = queue.next();
              if (issue === undefined) break;
              activeQueueIssue = issue;
              const current = queue.processedCount();
              const total =
                resumeState?.maxIssues ?? maxIssues ?? current + queue.pendingCount();
              activeIssue = {
                issueNumber: issue.number,
                stage: ProgressStage.ComplexityAssessment,
              };
              restoreCancellationCheckout = () =>
                checkpoints.restore(prepared.path, {
                  branch: checkout.branch,
                  sha: checkout.head,
                });
              yield* persistState(RunStateStatus.Active, activeIssue);
              const outcome = yield* track(
                progress,
                ProgressStage.IssueExecution,
                `Executing #${issue.number} ${issue.title}...`,
                issueExecutor.execute({
                  issue,
                  repository: repo,
                  repositoryPath: prepared.path,
                  targetBranch: branch,
                  workspace,
                  runId: actualRunId,
                  octokit,
                  openCode: server.client,
                  openCodeSelection: selection,
                  openCodeDiagnostics: diagnostics,
                  repositoryInvariant: invariantService,
                  signal,
                }),
                (result) =>
                  `Issue #${issue.number} finished with outcome ${result.kind}.`,
                {
                  issue: { number: issue.number, title: issue.title },
                  current,
                  total,
                },
              );
              outcomes.push({ issueNumber: issue.number, outcome });

              if (
                outcome.kind === IssueExecutionOutcomeKind.Completed ||
                outcome.kind === IssueExecutionOutcomeKind.Decomposed ||
                outcome.kind === IssueExecutionOutcomeKind.Escalated
              ) {
                queue.complete(issue.number);
              }

              if (outcome.kind === IssueExecutionOutcomeKind.Failed) {
                yield* persistState(RunStateStatus.Active, {
                  issueNumber: issue.number,
                  stage: ProgressStage.IssueExecution,
                });
                if (issueFailurePolicy === IssueFailurePolicy.Halt) {
                  return yield* new RalphieError({
                    message: `Issue #${issue.number} failed: ${outcome.message}`,
                  });
                }
              } else {
                activeIssue = undefined;
                activeQueueIssue = undefined;
                restoreCancellationCheckout = undefined;
                checkout = yield* invariantService.capture(prepared.path);
                yield* persistState(RunStateStatus.Active);
              }

              if (
                outcome.kind === IssueExecutionOutcomeKind.Decomposed ||
                outcome.kind === IssueExecutionOutcomeKind.Escalated
              ) {
                const refreshed = yield* track(
                  progress,
                  ProgressStage.IssueDiscovery,
                  "Refreshing open issues after decomposition...",
                  githubIssues.listOpen(octokit, repo, issueFilters),
                  (result) => `Refreshed ${result.length} matching open issues.`,
                );
                const added = queue.refresh(toQueuedIssues(refreshed));
                yield* progress.emit({
                  stage: ProgressStage.IssueQueue,
                  status: ProgressStatus.Info,
                  message: `Issue queue refreshed; added ${added} new issues.`,
                  details: { added, pending: queue.pendingCount() },
                });
                yield* persistState(RunStateStatus.Active);
              }
            }
          }),
        closeServer,
      );

      if (queue.state() === IssueQueueState.DependencyBlocked) {
        yield* persistState(RunStateStatus.Active);
        return yield* new RalphieError({
          message: `${queue.pendingCount()} pending issues are blocked by open dependencies.`,
        });
      }

      yield* persistState(RunStateStatus.Complete);
      activeIssue = undefined;
      activeQueueIssue = undefined;
      restoreCancellationCheckout = undefined;
      const summary = summarize(actualRunId, outcomes);
      if (cleanup) {
        const workspaceService = yield* Workspace;
        yield* track(
          progress,
          ProgressStage.WorkspaceCleanup,
          `Removing workspace ${workspace}...`,
          workspaceService.remove(workspace),
          `Workspace removed: ${workspace}.`,
        );
      }
      return summary;
    });

    const recoverCancellation = (error: RalphieError) => {
      if (!signal?.aborted) return Effect.fail(error);

      return Effect.gen(function* () {
        let restoreError: RalphieError | undefined;
        if (activeIssue !== undefined && restoreCancellationCheckout !== undefined) {
          yield* restoreCancellationCheckout().pipe(
            Effect.catchAll((failure) =>
              Effect.sync(() => {
                restoreError = failure;
              }),
            ),
          );
        }
        if (persistCancellationState !== undefined) {
          yield* persistCancellationState();
        }
        return yield* new RalphieError({
          message: restoreError === undefined
            ? "Run cancelled; active checkout was preserved and resumable state was saved."
            : "Run cancelled; resumable state was saved but active checkout restoration failed.",
          cause: restoreError ?? error,
        });
      });
    };

    return yield* run.pipe(
      Effect.catchAll(recoverCancellation),
      Effect.tap((summary) =>
        progress.emit({
          stage: ProgressStage.Run,
          status: ProgressStatus.Succeeded,
          message:
            `Run completed: ${summary.counts.completed} completed, ` +
            `${summary.counts.decomposed} decomposed, ${summary.counts.escalated} escalated, ` +
            `${summary.counts.skipped} skipped, ${summary.counts.failed} failed.`,
          details: { runId: summary.runId, counts: summary.counts, statePath },
        }),
      ),
      Effect.tapError((error) =>
        progress.emit({
          stage: ProgressStage.Run,
          status: ProgressStatus.Failed,
          message: `Run failed: ${errorMessage(error)}`,
          details: { runId: actualRunId, statePath },
        }),
      ),
    );
  });
