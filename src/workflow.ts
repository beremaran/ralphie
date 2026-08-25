import { Effect } from "effect";
import { join } from "node:path";

import { GitRepository } from "./git/repository.ts";
import { GitRepositoryInvariant } from "./git/repository-invariant.ts";
import { GitIssueCheckpoint } from "./git/issue-checkpoint.ts";
import { GitIssueOperations } from "./git/issue-operations.ts";
import { GitWorktrees, type PreparedIssueWorktree } from "./git/worktree.ts";
import { GitHubClient } from "./github/client.ts";
import { GitHubPullRequests } from "./github/pull-requests.ts";
import {
  GitHubIssueCloseReason,
  GitHubIssueMutations,
} from "./github/issue-mutations.ts";
import { type GitHubIssue, GitHubIssues, type IssueFilters } from "./github/issues.ts";
import {
  IssueCompletionKind,
  IssueExecutionOutcomeKind,
  type IssueExecutionOutcome,
} from "./issues/execution.ts";
import { IssueExecutor } from "./issues/executor.ts";
import { DryRunIssueExecutor } from "./issues/dry-run-executor.ts";
import { IssueArtifactKind, IssueArtifactStore } from "./issues/artifacts.ts";
import { createIssueQueue, IssueQueueState, toQueuedIssues } from "./issues/queue.ts";
import type { PiModel } from "./agent/model.ts";
import { Pi, type PiRuntime } from "./agent/server.ts";
import { makePiSessionDiagnostics } from "./agent/task-session.ts";
import { registerPiAgentSemaphore } from "./agent/concurrency.ts";
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
import { DEFAULT_WORKFLOW_MODE, WorkflowMode } from "./options.ts";

const closeRuntime = (server: PiRuntime) => Effect.sync(() => server.close());

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

const issueFeatureBranch = (issueNumber: number): string =>
  `ralphie/issue-${issueNumber}`;

const outcomeMessage = (
  issueNumber: number,
  outcome: IssueExecutionOutcome,
): string => {
  switch (outcome.kind) {
    case IssueExecutionOutcomeKind.Completed:
      if (outcome.completion === IssueCompletionKind.AlreadyResolved) {
        return `Issue #${issueNumber} was already resolved.`;
      }
      return `Issue #${issueNumber} implemented and pushed.`;
    case IssueExecutionOutcomeKind.Decomposed:
      return `Issue #${issueNumber} decomposed into ${outcome.childIssueNumbers.length} child issues.`;
    case IssueExecutionOutcomeKind.Escalated:
      return `Issue #${issueNumber} escalated: ${outcome.reason}`;
    case IssueExecutionOutcomeKind.Failed:
      return `Issue #${issueNumber} failed: ${outcome.message}`;
    case IssueExecutionOutcomeKind.Skipped:
      return `Issue #${issueNumber} skipped: ${outcome.reason}`;
  }
};

const copyOutcome = (
  outcome: IssueExecutionOutcome,
): RunState["outcomes"][number]["outcome"] => {
  switch (outcome.kind) {
    case IssueExecutionOutcomeKind.Completed:
      if (outcome.completion === IssueCompletionKind.AlreadyResolved) {
        return { ...outcome, evidence: [...outcome.evidence] };
      }
      return {
        kind: outcome.kind,
        completion: outcome.completion,
        commitSha: outcome.commitSha,
        ...(outcome.reviewCount === undefined
          ? {}
          : { reviewCount: outcome.reviewCount }),
      };
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
  readonly workflow?: WorkflowMode;
  readonly issueConcurrency?: number;
  readonly agentConcurrency?: number;
  readonly repo: string;
  readonly branch?: string;
  readonly maxIssues?: number;
  readonly issueFilters: IssueFilters;
  readonly agent: string;
  readonly model?: PiModel;
  readonly modelVariant?: string;
  readonly workspace: string;
  readonly cleanup: boolean;
  readonly startClean: boolean;
  readonly signal?: AbortSignal;
  readonly runId?: string;
  readonly resumeState?: RunState;
  readonly resumePath?: string;
  readonly issueFailurePolicy?: IssueFailurePolicy;
  readonly dryRun?: boolean;
};

export const workflow = ({
  workflow: requestedWorkflow = DEFAULT_WORKFLOW_MODE,
  issueConcurrency = 1,
  agentConcurrency,
  repo,
  branch: requestedBranch,
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
  dryRun = false,
}: WorkflowOptions) =>
  Effect.gen(function* () {
    const progress = yield* ProgressReporter;
    const stateStore = yield* RunStateStore;
    const actualRunId = resumeState?.runId ?? runId;
    const effectiveDryRun = resumeState?.dryRun ?? dryRun;
    const workflowMode = resumeState?.workflow ?? requestedWorkflow;
    const effectiveIssueConcurrency = resumeState?.issueConcurrency ?? issueConcurrency;
    const usesPullRequests =
      workflowMode === WorkflowMode.Pr || workflowMode === WorkflowMode.ParallelPr;
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
      message: `Ralphie started for ${repo} on ${requestedBranch ?? "default branch"}.`,
      details: {
        repository: repo,
        ...(requestedBranch === undefined ? {} : { branch: requestedBranch }),
        workspace,
        model: model ? `${model.providerID}/${model.modelID}` : "Pi default",
        variant: modelVariant ?? "Pi default",
        agent,
        issueLimit: maxIssues ?? "unlimited",
        runId: actualRunId,
        dryRun: effectiveDryRun,
        workflow: workflowMode,
        ...(resumeState === undefined ? {} : { resumed: true, statePath }),
      },
    });

    let activeIssue: RunState["activeIssue"] | undefined;
    let activeQueueIssue: GitHubIssue | undefined;
    const activeQueueIssues = new Map<number, GitHubIssue>();
    let persistCancellationState: (() => Effect.Effect<void, RalphieError>) | undefined;
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

      const workspaceService = yield* Workspace;
      yield* track(
        progress,
        ProgressStage.WorkspacePreparation,
        `Preparing workspace ${workspace}...`,
        workspaceService.prepare(workspace),
        `Workspace ready: ${workspace}.`,
      );

      const github = yield* GitHubClient;
      const octokit = yield* track(
        progress,
        ProgressStage.GitHubAuthentication,
        "Checking GitHub authentication...",
        github.initialize,
        "GitHub authentication verified and Octokit initialized.",
      );
      const issueMutations = yield* GitHubIssueMutations;
      const pullRequests = usesPullRequests ? yield* GitHubPullRequests : undefined;
      const issueOperations = usesPullRequests ? yield* GitIssueOperations : undefined;
      const artifactStores = usesPullRequests ? yield* IssueArtifactStore : undefined;
      const worktrees =
        workflowMode === WorkflowMode.ParallelPr ? yield* GitWorktrees : undefined;
      yield* checkCancellation(signal);

      const repository = yield* GitRepository;
      yield* track(
        progress,
        ProgressStage.GitVerification,
        "Checking Git installation...",
        repository.verifyInstalled,
        "Git installation verified.",
      );
      yield* checkCancellation(signal);

      const prepared = yield* track(
        progress,
        ProgressStage.RepositoryPreparation,
        `Preparing ${repo} on ${requestedBranch ?? "main/master"}...`,
        repository.prepare(repo, requestedBranch, workspace),
        (result) =>
          `Repository ready: ${result.path}.`,
        {
          details: {
            repository: repo,
            ...(requestedBranch === undefined ? {} : { branch: requestedBranch }),
            workspace,
          },
        },
      );
      const branch = prepared.branch;
      yield* checkCancellation(signal);

      const githubIssues = yield* GitHubIssues;
      const discoveredIssues = yield* track(
        progress,
        ProgressStage.IssueDiscovery,
        "Fetching matching open issues...",
        githubIssues.listOpen(octokit, repo, issueFilters),
        (result) =>
          result.length === 0
            ? "No open issues match the current filters."
            : `Found ${result.length} matching open issues.`,
        { details: { filters: issueFilters } },
      );
      yield* checkCancellation(signal);

      const invariantService = yield* GitRepositoryInvariant;
      const checkpoints = yield* GitIssueCheckpoint;
      const repositoryCheckouts = [
        { repository: repo, repositoryPath: prepared.path, branch: prepared.branch },
      ];
      const captureCheckout = () => invariantService.capture(prepared.path);
      let checkout = yield* captureCheckout();
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
        resumeState === undefined ? discoveredIssues : resumeState.queue.pending;
      const queue = createIssueQueue(
        toQueuedIssues(initialIssues),
        resumeState?.maxIssues ?? maxIssues,
        resumeState === undefined
          ? undefined
          : {
              completedIssueNumbers: resumeState.queue.completedIssueNumbers,
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
        const hasActiveQueueIssue = activeQueueIssues.size > 0;
        const pending = snapshot.pending.map(({ issue }) => ({
          ...issue,
          labels: [...issue.labels],
        }));
        for (const issue of activeQueueIssues.values()) {
          if (!pending.some(({ number }) => number === issue.number)) {
            pending.unshift({ ...issue, labels: [...issue.labels] });
          }
        }
        return stateStore.save(statePath, {
          version: RUN_STATE_VERSION,
          status,
          runId: actualRunId,
          repository: repo,
          branch,
          workflow: workflowMode,
          issueConcurrency: effectiveIssueConcurrency,
          dryRun: effectiveDryRun,
          selection,
          ...((resumeState?.maxIssues ?? maxIssues) === undefined
            ? {}
            : { maxIssues: resumeState?.maxIssues ?? maxIssues }),
          queue: {
            pending,
            completedIssueNumbers: [...snapshot.completedIssueNumbers],
            processedCount: hasActiveQueueIssue
              ? Math.max(0, snapshot.processedCount - activeQueueIssues.size)
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

      persistCancellationState = () => persistState(RunStateStatus.Active, activeIssue);

      yield* persistState(RunStateStatus.Active);
      const issueExecutor = effectiveDryRun
        ? yield* DryRunIssueExecutor
        : yield* IssueExecutor;
      const diagnostics = makePiSessionDiagnostics();
      const processQueue = (server: PiRuntime) => {
        const worker = Effect.gen(function* () {
          while (queue.state() === IssueQueueState.Ready) {
            yield* checkCancellation(signal);
            const issue = queue.next();
            if (issue === undefined) break;
            activeQueueIssue = issue;
            activeQueueIssues.set(issue.number, issue);
            const current = queue.processedCount();
            const total =
              resumeState?.maxIssues ?? maxIssues ?? current + queue.pendingCount();
            const resumedClosureOutcome =
              resumeState?.activeIssue?.issueNumber === issue.number &&
              resumeState.activeIssue.stage === ProgressStage.IssueClosure
                ? outcomes.find(
                    (entry) =>
                      entry.issueNumber === issue.number &&
                      entry.outcome.kind === IssueExecutionOutcomeKind.Completed,
                  )?.outcome
                : undefined;
            activeIssue = {
              issueNumber: issue.number,
              stage:
                resumedClosureOutcome === undefined
                  ? ProgressStage.ComplexityAssessment
                  : ProgressStage.IssueClosure,
            };
            const issueBaseCheckout = { ...checkout };
            const featureBranch = issueFeatureBranch(issue.number);
            let preparedIssueWorktree: PreparedIssueWorktree | undefined;
            if (workflowMode === WorkflowMode.ParallelPr && !effectiveDryRun) {
              preparedIssueWorktree = yield* worktrees!.prepareIssue({
                workspace,
                runId: actualRunId,
                issueNumber: issue.number,
                branch: featureBranch,
                repository: repositoryCheckouts[0]!,
                baseSha: issueBaseCheckout.head,
              });
            }
            const issueRepositories = preparedIssueWorktree
              ? [preparedIssueWorktree]
              : repositoryCheckouts;
            if (
              usesPullRequests &&
              !effectiveDryRun &&
              resumedClosureOutcome === undefined
            ) {
              yield* Effect.forEach(
                issueRepositories,
                (repository) => {
                  const base = issueBaseCheckout;
                  const prepareBranch: Effect.Effect<
                    { readonly headSha: string },
                    RalphieError
                  > =
                    workflowMode === WorkflowMode.ParallelPr
                      ? Effect.succeed({ headSha: base.head })
                      : issueOperations!.createOrCheckoutFeatureBranch(
                          repository.repositoryPath,
                          featureBranch,
                          repository.branch,
                          base.head,
                        );
                  return prepareBranch.pipe(
                    Effect.flatMap((preparedBranch) =>
                      issueOperations!
                        .push(
                          repository.repositoryPath,
                          featureBranch,
                          preparedBranch.headSha,
                        )
                        .pipe(
                          Effect.mapError(
                            (error) =>
                              new RalphieError({
                                message: error.message,
                                cause: error,
                              }),
                          ),
                        ),
                    ),
                  );
                },
                { discard: true },
              );
            }
            restoreCancellationCheckout =
              workflowMode === WorkflowMode.ParallelPr
                ? undefined
                : () =>
                    Effect.forEach(
                      repositoryCheckouts,
                      (repository) =>
                        checkpoints.restore(repository.repositoryPath, {
                          branch: issueBaseCheckout.branch,
                          sha: issueBaseCheckout.head,
                        }),
                      { discard: true },
                    );
            yield* persistState(RunStateStatus.Active, activeIssue);
            const outcome =
              resumedClosureOutcome ??
              (yield* track(
                progress,
                ProgressStage.IssueExecution,
                `Executing #${issue.number} ${issue.title}...`,
                issueExecutor.execute({
                  issue,
                  repository: repo,
                  repositoryPath:
                    issueRepositories.find(
                      ({ repository }) =>
                        repository.toLowerCase() === repo.toLowerCase(),
                    )?.repositoryPath ?? prepared.path,
                  targetBranch:
                    usesPullRequests && !effectiveDryRun ? featureBranch : branch,
                  workspace,
                  runId: actualRunId,
                  octokit,
                  pi: server.client,
                  piSelection: selection,
                  piDiagnostics: diagnostics,
                  repositoryInvariant: invariantService,
                  signal,
                }),
                (result) =>
                  outcomeMessage(issue.number, result),
                {
                  issue: { number: issue.number, title: issue.title },
                  current,
                  total,
                },
              ));
            if (resumedClosureOutcome === undefined) {
              outcomes.push({ issueNumber: issue.number, outcome });
            }

            if (outcome.kind === IssueExecutionOutcomeKind.Completed) {
              // The implementation path may have advanced HEAD. Persist the
              // post-delivery checkout so a closure-only resume reconciles
              // against the commit that was actually pushed.
              checkout = yield* captureCheckout();
              activeIssue = {
                issueNumber: issue.number,
                stage: ProgressStage.IssueClosure,
              };
              yield* persistState(RunStateStatus.Active, activeIssue);
              if (
                usesPullRequests &&
                outcome.completion === IssueCompletionKind.PushedCommit
              ) {
                const artifacts = yield* artifactStores!.forIssue(issue.number, {
                  workspace,
                  runId: actualRunId,
                  repository: repo,
                });
                const reviews = artifacts.has(IssueArtifactKind.ReviewAttempts)
                  ? yield* artifacts.read(IssueArtifactKind.ReviewAttempts)
                  : [];
                const issueRepository = issueRepositories[0]!;
                const delivery = pullRequests!
                  .createOrFind(octokit, repo, {
                    title: `Fix #${issue.number}: ${issue.title}`,
                    issueNumber: issue.number,
                    closesIssue: true,
                    head: featureBranch,
                    base: branch,
                  })
                  .pipe(
                    Effect.flatMap((pullRequest) =>
                      pullRequests!
                        .publishReviewAttempts(
                          octokit,
                          repo,
                          pullRequest.number,
                          reviews,
                        )
                        .pipe(
                          Effect.zipRight(
                            pullRequests!.merge(octokit, repo, pullRequest.number),
                          ),
                        ),
                    ),
                  );
                yield* track(
                  progress,
                  ProgressStage.IssueClosure,
                  `Opening and merging pull request for issue #${issue.number}...`,
                  workflowMode === WorkflowMode.ParallelPr
                    ? delivery
                    : delivery.pipe(
                        Effect.tap(() =>
                          issueOperations!.restoreBaseCheckout(
                            issueRepository.repositoryPath,
                            branch,
                          ),
                        ),
                      ),
                  `Pull request merged; GitHub will close issue #${issue.number}.`,
                  {
                    issue: { number: issue.number, title: issue.title },
                    details: { completion: outcome.completion },
                  },
                );
                if (preparedIssueWorktree !== undefined) {
                  yield* worktrees!.removeIssue(
                    repositoryCheckouts[0]!,
                    preparedIssueWorktree,
                  );
                }
              } else {
                yield* track(
                  progress,
                  ProgressStage.IssueClosure,
                  `Closing issue #${issue.number} as completed...`,
                  issueMutations.close(
                    octokit,
                    repo,
                    issue.number,
                    GitHubIssueCloseReason.Completed,
                  ),
                  `Issue #${issue.number} closed as completed.`,
                  {
                    issue: { number: issue.number, title: issue.title },
                    details: { completion: outcome.completion },
                  },
                );
              }
            }

            if (
              outcome.kind === IssueExecutionOutcomeKind.Completed ||
              outcome.kind === IssueExecutionOutcomeKind.Decomposed ||
              outcome.kind === IssueExecutionOutcomeKind.Escalated
            ) {
              queue.complete(issue.number);
            }

            if (outcome.kind === IssueExecutionOutcomeKind.Failed) {
              // A deterministic commit may already exist when a later push fails.
              // Persist the actual HEAD so resume can finish delivery.
              checkout = yield* captureCheckout();
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
              if (
                preparedIssueWorktree !== undefined &&
                !(
                  outcome.kind === IssueExecutionOutcomeKind.Completed &&
                  outcome.completion === IssueCompletionKind.PushedCommit
                )
              ) {
                yield* worktrees!.removeIssue(
                  repositoryCheckouts[0]!,
                  preparedIssueWorktree,
                );
              }
              activeIssue = undefined;
              activeQueueIssue = undefined;
              activeQueueIssues.delete(issue.number);
              restoreCancellationCheckout = undefined;
              checkout = yield* captureCheckout();
              yield* persistState(RunStateStatus.Active);
            }

            if (
              outcome.kind === IssueExecutionOutcomeKind.Decomposed ||
              outcome.kind === IssueExecutionOutcomeKind.Escalated
            ) {
              const refreshed = yield* track(
                progress,
                ProgressStage.IssueDiscovery,
                "Refreshing issue list...",
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
        });
        return workflowMode === WorkflowMode.ParallelPr
          ? Effect.all(
              Array.from(
                { length: Math.max(1, effectiveIssueConcurrency) },
                () => worker,
              ),
              { concurrency: "unbounded", discard: true },
            )
          : worker;
      };
      const pi = yield* Pi;
      yield* Effect.acquireUseRelease(
        track(
          progress,
          ProgressStage.PiRuntime,
          "Starting Pi runtime...",
          pi.start,
          (server) => {
            if (agentConcurrency !== undefined) {
              registerPiAgentSemaphore(
                server.client,
                Effect.unsafeMakeSemaphore(agentConcurrency),
              );
            }
            return "Pi runtime ready.";
          },
        ),
        processQueue,
        closeRuntime,
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
      activeQueueIssues.clear();
      restoreCancellationCheckout = undefined;
      const summary = summarize(actualRunId, outcomes);
      if (cleanup) {
        const workspaceService = yield* Workspace;
        const startedMessage = `Removing workspace ${workspace}...`;
        yield* progress.emit({
          stage: ProgressStage.WorkspaceCleanup,
          status: ProgressStatus.Started,
          message: startedMessage,
        });
        yield* workspaceService.remove(workspace).pipe(
          Effect.tapError((error) =>
            progress.emit({
              stage: ProgressStage.WorkspaceCleanup,
              status: ProgressStatus.Failed,
              message: `${startedMessage.replace(/\.{3}$/, "")} failed: ${errorMessage(error)}`,
            }),
          ),
        );
        // The event log lives inside the workspace. Disable durable writes after
        // removal so the cleanup-success and run-success events cannot recreate it.
        yield* progress.stopPersisting;
        yield* progress.emit({
          stage: ProgressStage.WorkspaceCleanup,
          status: ProgressStatus.Succeeded,
          message: `Workspace removed: ${workspace}.`,
        });
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
          message:
            restoreError === undefined
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
