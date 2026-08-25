import { Effect, Either } from "effect";
import { join } from "node:path";
import type { Octokit } from "octokit";

import { GitRepository, type PreparedRepository } from "./git/repository.ts";
import { GitRepositoryInvariant } from "./git/repository-invariant.ts";
import { GitIssueCheckpoint } from "./git/issue-checkpoint.ts";
import { GitIssueOperations } from "./git/issue-operations.ts";
import { GitWorktrees, type PreparedIssueWorktrees } from "./git/worktree.ts";
import { GitHubClient } from "./github/client.ts";
import { GitHubPullRequests } from "./github/pull-requests.ts";
import {
  GitHubIssueCloseReason,
  GitHubIssueMutations,
} from "./github/issue-mutations.ts";
import { type GitHubIssue, GitHubIssues, type IssueFilters } from "./github/issues.ts";
import { GitHubRepositoryPatterns } from "./github/repository-patterns.ts";
import {
  IssueCompletionKind,
  IssueExecutionOutcomeKind,
  type IssueExecutionOutcome,
} from "./issues/execution.ts";
import { IssueExecutor } from "./issues/executor.ts";
import { DryRunIssueExecutor } from "./issues/dry-run-executor.ts";
import { IssueArtifactKind, IssueArtifactStore } from "./issues/artifacts.ts";
import { createIssueQueue, IssueQueueState, toQueuedIssues } from "./issues/queue.ts";
import type { OpenCodeModel } from "./opencode/model.ts";
import { OpenCode, type OpenCodeServer } from "./opencode/server.ts";
import { makeOpenCodeSessionDiagnostics } from "./opencode/task-session.ts";
import { registerOpenCodeAgentSemaphore } from "./opencode/concurrency.ts";
import {
  assertUniqueProjectRepositoryNames,
  multiRepositoryProjectPath,
  type PreparedProject,
  projectRepositoryPath,
  singleRepositoryProjectPath,
} from "./project/project.ts";
import {
  ProgressReporter,
  type ProgressReporterService,
  ProgressStage,
  ProgressStatus,
  type ProgressUpdate,
  withProgressContext,
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
import { DEFAULT_WORKFLOW_MODE, WorkflowMode } from "./config/config.ts";

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

const issueFeatureBranch = (issueNumber: number): string =>
  `ralphie/issue-${issueNumber}`;

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
        ...(outcome.commits === undefined
          ? {}
          : { commits: outcome.commits.map((commit) => ({ ...commit })) }),
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
  readonly project?: string;
  readonly repo: string;
  readonly branch?: string;
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
  readonly dryRun?: boolean;
  readonly sharedResources?: WorkflowSharedResources;
};

export type WorkflowSharedResources = {
  readonly octokit: Octokit;
  readonly openCode: OpenCodeServer;
  readonly preparedRepository?: PreparedRepository;
  readonly preparedProject?: PreparedProject;
};

export type BatchWorkflowOptions = {
  readonly repositories: ReadonlyArray<WorkflowOptions>;
  readonly repositoryPatterns?: ReadonlyArray<RepositoryPatternWorkflowOptions>;
  readonly workspace: string;
  readonly cleanup: boolean;
  readonly startClean: boolean;
  readonly agentConcurrency?: number;
};

export type RepositoryPatternWorkflowOptions = Omit<
  WorkflowOptions,
  "repo" | "resumeState" | "resumePath" | "runId" | "sharedResources"
> & {
  readonly project: string;
  readonly repoPattern: string;
};

export const workflow = ({
  workflow: requestedWorkflow = DEFAULT_WORKFLOW_MODE,
  issueConcurrency = 1,
  project,
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
  sharedResources,
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
      message: `Ralphie started for ${repo} on ${requestedBranch ?? "main/master (auto)"}.`,
      details: {
        ...(project === undefined ? {} : { project }),
        repository: repo,
        ...(requestedBranch === undefined ? {} : { branch: requestedBranch }),
        workspace,
        model: model ? `${model.providerID}/${model.modelID}` : "OpenCode default",
        variant: modelVariant ?? "OpenCode default",
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

      if (sharedResources === undefined) {
        const workspaceService = yield* Workspace;
        yield* track(
          progress,
          ProgressStage.WorkspacePreparation,
          `Preparing workspace ${workspace}...`,
          workspaceService.prepare(workspace),
          `Workspace ready: ${workspace}.`,
        );
      }

      const octokit =
        sharedResources?.octokit ??
        (yield* Effect.gen(function* () {
          const github = yield* GitHubClient;
          return yield* track(
            progress,
            ProgressStage.GitHubAuthentication,
            "Checking GitHub authentication...",
            github.initialize,
            "GitHub authentication verified and Octokit initialized.",
          );
        }));
      const issueMutations = yield* GitHubIssueMutations;
      const pullRequests = usesPullRequests ? yield* GitHubPullRequests : undefined;
      const issueOperations = usesPullRequests ? yield* GitIssueOperations : undefined;
      const artifactStores = usesPullRequests ? yield* IssueArtifactStore : undefined;
      const worktrees =
        workflowMode === WorkflowMode.ParallelPr ? yield* GitWorktrees : undefined;
      yield* checkCancellation(signal);

      const repository = yield* GitRepository;
      if (sharedResources === undefined) {
        yield* track(
          progress,
          ProgressStage.GitVerification,
          "Checking Git installation...",
          repository.verifyInstalled,
          "Git installation verified.",
        );
      }
      yield* checkCancellation(signal);

      const prepared =
        sharedResources?.preparedRepository ??
        (yield* track(
          progress,
          ProgressStage.RepositoryPreparation,
          `Preparing ${repo} on ${requestedBranch ?? "main/master"}...`,
          repository.prepare(repo, requestedBranch, workspace),
          (result) =>
            `${result.cloned ? "Repository cloned" : "Existing repository ready"}: ${result.path}.`,
          {
            details: {
              repository: repo,
              ...(requestedBranch === undefined ? {} : { branch: requestedBranch }),
              workspace,
            },
          },
        ));
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
            : `Found ${result.length} matching open issues; first is #${result[0]!.number} ${result[0]!.title}.`,
        { details: { filters: issueFilters } },
      );
      yield* checkCancellation(signal);

      const invariantService = yield* GitRepositoryInvariant;
      const checkpoints = yield* GitIssueCheckpoint;
      const projectRepositories = sharedResources?.preparedProject?.repositories ?? [
        { repository: repo, repositoryPath: prepared.path, branch: prepared.branch },
      ];
      const captureProjectCheckouts = () =>
        Effect.forEach(projectRepositories, (repository) =>
          invariantService.capture(repository.repositoryPath).pipe(
            Effect.map((checkout) => ({
              repository: repository.repository,
              ...checkout,
            })),
          ),
        );
      let projectCheckouts = yield* captureProjectCheckouts();
      const sourceCheckout = () => {
        const source = projectCheckouts.find(
          (entry) => entry.repository.toLowerCase() === repo.toLowerCase(),
        )!;
        return { branch: source.branch, head: source.head };
      };
      let checkout = sourceCheckout();
      if (resumeState !== undefined) {
        const reconciliation = reconcileRunState(resumeState, {
          ...(project === undefined ? {} : { project }),
          repository: repo,
          branch,
          git: checkout,
          projectCheckouts,
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
        const currentActiveQueueIssue = activeQueueIssue;
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
          ...(project === undefined ? {} : { project }),
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
          projectCheckouts: projectCheckouts.map((entry) => ({ ...entry })),
          updatedAt: new Date().toISOString(),
        });
      };

      persistCancellationState = () => persistState(RunStateStatus.Active, activeIssue);

      yield* persistState(RunStateStatus.Active);
      const issueExecutor = effectiveDryRun
        ? yield* DryRunIssueExecutor
        : yield* IssueExecutor;
      const diagnostics = makeOpenCodeSessionDiagnostics();
      const processQueue = (server: OpenCodeServer) => {
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
            const issueBaseCheckouts = projectCheckouts.map((entry) => ({
              ...entry,
            }));
            const featureBranch = issueFeatureBranch(issue.number);
            let preparedIssueWorktrees: PreparedIssueWorktrees | undefined;
            if (workflowMode === WorkflowMode.ParallelPr && !effectiveDryRun) {
              preparedIssueWorktrees = yield* worktrees!.prepareIssue({
                workspace,
                runId: actualRunId,
                issueNumber: issue.number,
                branch: featureBranch,
                repositories: projectRepositories,
                baseShas: Object.fromEntries(
                  issueBaseCheckouts.map((checkout) => [
                    checkout.repository,
                    checkout.head,
                  ]),
                ),
              });
            }
            const issueRepositories =
              preparedIssueWorktrees?.repositories ?? projectRepositories;
            if (
              usesPullRequests &&
              !effectiveDryRun &&
              resumedClosureOutcome === undefined
            ) {
              yield* Effect.forEach(
                issueRepositories,
                (repository) => {
                  const base = issueBaseCheckouts.find(
                    ({ repository: slug }) =>
                      slug.toLowerCase() === repository.repository.toLowerCase(),
                  )!;
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
            const executionProjectRepositories = issueRepositories.map((repository) =>
              usesPullRequests && !effectiveDryRun
                ? { ...repository, branch: featureBranch }
                : repository,
            );
            restoreCancellationCheckout =
              workflowMode === WorkflowMode.ParallelPr
                ? undefined
                : () =>
                    Effect.forEach(
                      projectRepositories,
                      (repository) => {
                        const base = issueBaseCheckouts.find(
                          ({ repository: slug }) =>
                            slug.toLowerCase() === repository.repository.toLowerCase(),
                        )!;
                        return checkpoints.restore(repository.repositoryPath, {
                          branch: base.branch,
                          sha: base.head,
                        });
                      },
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
                  ...(project === undefined ? {} : { project }),
                  repository: repo,
                  repositoryPath:
                    issueRepositories.find(
                      ({ repository }) =>
                        repository.toLowerCase() === repo.toLowerCase(),
                    )?.repositoryPath ?? prepared.path,
                  ...(sharedResources?.preparedProject === undefined
                    ? {}
                    : {
                        workingDirectory:
                          preparedIssueWorktrees?.path ??
                          sharedResources.preparedProject.path,
                        projectRepositories: executionProjectRepositories,
                      }),
                  targetBranch:
                    usesPullRequests && !effectiveDryRun ? featureBranch : branch,
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
              ));
            if (resumedClosureOutcome === undefined) {
              outcomes.push({ issueNumber: issue.number, outcome });
            }

            if (outcome.kind === IssueExecutionOutcomeKind.Completed) {
              // The implementation path may have advanced HEAD. Persist the
              // post-delivery checkout so a closure-only resume reconciles
              // against the commit that was actually pushed.
              projectCheckouts = yield* captureProjectCheckouts();
              checkout = sourceCheckout();
              activeIssue = {
                issueNumber: issue.number,
                stage: ProgressStage.IssueClosure,
              };
              yield* persistState(RunStateStatus.Active, activeIssue);
              if (
                usesPullRequests &&
                outcome.completion === IssueCompletionKind.PushedCommit
              ) {
                const commits = outcome.commits ?? [
                  { repository: repo, sha: outcome.commitSha },
                ];
                const orderedCommits = [...commits].sort((left, right) =>
                  left.repository.toLowerCase() === repo.toLowerCase()
                    ? 1
                    : right.repository.toLowerCase() === repo.toLowerCase()
                      ? -1
                      : left.repository.localeCompare(right.repository),
                );
                const artifacts = yield* artifactStores!.forIssue(issue.number, {
                  workspace,
                  runId: actualRunId,
                  ...(project === undefined ? {} : { project }),
                  repository: repo,
                });
                const reviews = artifacts.has(IssueArtifactKind.ReviewAttempts)
                  ? yield* artifacts.read(IssueArtifactKind.ReviewAttempts)
                  : [];
                yield* track(
                  progress,
                  ProgressStage.IssueClosure,
                  `Opening and merging pull request${orderedCommits.length === 1 ? "" : "s"} for issue #${issue.number}...`,
                  Effect.forEach(
                    orderedCommits,
                    (commit) => {
                      const repository = issueRepositories.find(
                        ({ repository }) =>
                          repository.toLowerCase() === commit.repository.toLowerCase(),
                      )!;
                      const baseRepository = projectRepositories.find(
                        ({ repository }) =>
                          repository.toLowerCase() === commit.repository.toLowerCase(),
                      )!;
                      const closesIssue =
                        commit.repository.toLowerCase() === repo.toLowerCase();
                      const delivery = pullRequests!
                        .createOrFind(octokit, commit.repository, {
                          title: `Fix #${issue.number}: ${issue.title}`,
                          body: closesIssue
                            ? undefined
                            : `Coordinated change for ${repo}#${issue.number}.`,
                          issueNumber: issue.number,
                          closesIssue,
                          ...(closesIssue ? {} : { issueRepository: repo }),
                          head: featureBranch,
                          base: baseRepository.branch,
                        })
                        .pipe(
                          Effect.flatMap((pullRequest) =>
                            pullRequests!
                              .publishReviewAttempts(
                                octokit,
                                commit.repository,
                                pullRequest.number,
                                reviews,
                              )
                              .pipe(
                                Effect.zipRight(
                                  pullRequests!.merge(
                                    octokit,
                                    commit.repository,
                                    pullRequest.number,
                                  ),
                                ),
                              ),
                          ),
                        );
                      return workflowMode === WorkflowMode.ParallelPr
                        ? delivery
                        : delivery.pipe(
                            Effect.tap(() =>
                              issueOperations!.restoreBaseCheckout(
                                repository.repositoryPath,
                                baseRepository.branch,
                              ),
                            ),
                          );
                    },
                    { discard: true },
                  ),
                  `Pull request${orderedCommits.length === 1 ? "" : "s"} merged; GitHub will close issue #${issue.number}.`,
                  {
                    issue: { number: issue.number, title: issue.title },
                    details: { completion: outcome.completion },
                  },
                );
                if (preparedIssueWorktrees !== undefined) {
                  yield* worktrees!.removeIssue(
                    projectRepositories,
                    preparedIssueWorktrees,
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
              // A deterministic commit may already exist when a later project
              // push fails. Persist the actual project HEADs so resume can
              // reconcile the created-commit artifacts and finish delivery.
              projectCheckouts = yield* captureProjectCheckouts();
              checkout = sourceCheckout();
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
                preparedIssueWorktrees !== undefined &&
                !(
                  outcome.kind === IssueExecutionOutcomeKind.Completed &&
                  outcome.completion === IssueCompletionKind.PushedCommit
                )
              ) {
                yield* worktrees!.removeIssue(
                  projectRepositories,
                  preparedIssueWorktrees,
                );
              }
              activeIssue = undefined;
              activeQueueIssue = undefined;
              activeQueueIssues.delete(issue.number);
              restoreCancellationCheckout = undefined;
              projectCheckouts = yield* captureProjectCheckouts();
              checkout = sourceCheckout();
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
      if (sharedResources === undefined) {
        const openCode = yield* OpenCode;
        yield* Effect.acquireUseRelease(
          track(
            progress,
            ProgressStage.OpenCodeServer,
            "Starting OpenCode server...",
            openCode.start,
            (server) => `OpenCode server started at ${server.url}.`,
          ),
          processQueue,
          closeServer,
        );
      } else {
        yield* processQueue(sharedResources.openCode);
      }

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

export const batchWorkflow = ({
  repositories,
  repositoryPatterns = [],
  workspace,
  cleanup,
  startClean,
  agentConcurrency,
}: BatchWorkflowOptions) =>
  Effect.gen(function* () {
    const progress = yield* ProgressReporter;
    const workspaceService = yield* Workspace;

    if (startClean) {
      yield* track(
        progress,
        ProgressStage.WorkspaceCleanup,
        `Removing existing workspace ${workspace}...`,
        workspaceService.remove(workspace),
        `Existing workspace removed: ${workspace}.`,
      );
    }

    yield* track(
      progress,
      ProgressStage.WorkspacePreparation,
      `Preparing workspace ${workspace}...`,
      workspaceService.prepare(workspace),
      `Workspace ready: ${workspace}.`,
    );
    const signal = repositories[0]?.signal ?? repositoryPatterns[0]?.signal;
    yield* checkCancellation(signal);

    const github = yield* GitHubClient;
    const octokit = yield* track(
      progress,
      ProgressStage.GitHubAuthentication,
      "Checking GitHub authentication...",
      github.initialize,
      "GitHub authentication verified and Octokit initialized.",
    );
    yield* checkCancellation(signal);

    const patterns = yield* GitHubRepositoryPatterns;
    const expandedPatterns = yield* Effect.forEach(repositoryPatterns, (pattern) =>
      track(
        progress,
        ProgressStage.RepositoryDiscovery,
        `Resolving repository pattern ${pattern.repoPattern}...`,
        patterns.resolve(octokit, pattern.repoPattern),
        (matches) =>
          `Repository pattern ${pattern.repoPattern} matched ${matches.length} repositories.`,
        { project: pattern.project, details: { pattern: pattern.repoPattern } },
      ).pipe(
        Effect.map((matches) =>
          matches.map(
            ({ slug }): WorkflowOptions => ({
              ...pattern,
              repo: slug,
              runId: crypto.randomUUID(),
              cleanup: false,
              startClean: false,
            }),
          ),
        ),
      ),
    );
    const allRepositories = [...repositories, ...expandedPatterns.flat()];
    const normalizedRepositories = allRepositories.map(({ repo }) =>
      repo.toLowerCase(),
    );
    if (new Set(normalizedRepositories).size !== normalizedRepositories.length) {
      return yield* new RalphieError({
        message:
          "Repository patterns and explicit entries resolved to duplicate repositories.",
      });
    }

    const git = yield* GitRepository;
    yield* track(
      progress,
      ProgressStage.GitVerification,
      "Checking Git installation...",
      git.verifyInstalled,
      "Git installation verified.",
    );
    yield* checkCancellation(signal);

    const grouped = new Map<string, WorkflowOptions[]>();
    for (const options of allRepositories) {
      const key = options.project ?? options.repo;
      grouped.set(key, [...(grouped.get(key) ?? []), options]);
    }
    const groupedProjects = [...grouped.entries()];
    const projectRoots = groupedProjects.map(([projectName, entries]) =>
      entries.length > 1
        ? multiRepositoryProjectPath(workspace, projectName)
        : singleRepositoryProjectPath(workspace, entries[0]!.repo),
    );
    if (
      new Set(projectRoots.map((path) => path.toLowerCase())).size !==
      projectRoots.length
    ) {
      return yield* new RalphieError({
        message: "Configured projects resolve to overlapping workspace directories.",
      });
    }
    const preparedProjects = yield* Effect.forEach(
      groupedProjects,
      ([projectName, projectRepositories]) =>
        Effect.gen(function* () {
          const isMultiRepository = projectRepositories.length > 1;
          if (isMultiRepository) {
            assertUniqueProjectRepositoryNames(
              projectName,
              projectRepositories.map(({ repo }) => repo),
            );
          }
          const preparedEntries = yield* Effect.forEach(
            projectRepositories,
            (options) => {
              const destinationPath = isMultiRepository
                ? projectRepositoryPath(workspace, projectName, options.repo)
                : singleRepositoryProjectPath(workspace, options.repo);
              const repositoryRunId =
                options.resumeState?.runId ?? options.runId ?? crypto.randomUUID();
              return track(
                progress,
                ProgressStage.RepositoryPreparation,
                `Preparing ${options.repo} on ${options.branch ?? "main/master"}...`,
                git.prepare(options.repo, options.branch, workspace, destinationPath),
                (result) =>
                  `${result.cloned ? "Repository cloned" : "Existing repository ready"}: ${result.path}.`,
                {
                  project: options.project,
                  repository: options.repo,
                  repositoryRunId,
                  details: {
                    repository: options.repo,
                    branch: options.branch,
                    workspace,
                  },
                },
              ).pipe(
                Effect.map((preparedRepository) => ({
                  options: { ...options, runId: repositoryRunId },
                  preparedRepository,
                })),
              );
            },
            { concurrency: "unbounded" },
          );
          const preparedProject: PreparedProject = {
            name: projectName,
            path: isMultiRepository
              ? multiRepositoryProjectPath(workspace, projectName)
              : preparedEntries[0]!.preparedRepository.path,
            repositories: preparedEntries.map(({ options, preparedRepository }) => ({
              repository: options.repo,
              repositoryPath: preparedRepository.path,
              branch: preparedRepository.branch,
            })),
          };
          return { name: projectName, preparedProject, entries: preparedEntries };
        }),
      { concurrency: "unbounded" },
    );
    yield* checkCancellation(signal);

    const openCode = yield* OpenCode;
    const agentSemaphore =
      agentConcurrency === undefined
        ? undefined
        : yield* Effect.makeSemaphore(agentConcurrency);
    const results = yield* Effect.acquireUseRelease(
      track(
        progress,
        ProgressStage.OpenCodeServer,
        "Starting OpenCode server...",
        openCode.start,
        (server) => `OpenCode server started at ${server.url}.`,
      ),
      (server) =>
        Effect.gen(function* () {
          if (agentSemaphore !== undefined) {
            yield* Effect.sync(() =>
              registerOpenCodeAgentSemaphore(server.client, agentSemaphore),
            );
          }
          return yield* Effect.forEach(
            preparedProjects,
            ({ preparedProject, entries }) =>
              Effect.gen(function* () {
                const projectResults: Array<{
                  repository: string;
                  result: Either.Either<WorkflowSummary, RalphieError>;
                }> = [];
                for (const { options, preparedRepository } of entries) {
                  const repositoryRunId = options.runId!;
                  const result = yield* workflow({
                    ...options,
                    startClean: false,
                    cleanup: false,
                    runId: repositoryRunId,
                    sharedResources: {
                      octokit,
                      openCode: server,
                      preparedRepository,
                      preparedProject,
                    },
                  }).pipe(
                    (effect) =>
                      withProgressContext(effect, {
                        ...(options.project === undefined
                          ? {}
                          : { project: options.project }),
                        repository: options.repo,
                        repositoryRunId,
                      }),
                    Effect.either,
                  );
                  projectResults.push({ repository: options.repo, result });
                  if (Either.isLeft(result)) break;
                }
                return projectResults;
              }),
            { concurrency: "unbounded" },
          ).pipe(Effect.map((projectResults) => projectResults.flat()));
        }),
      closeServer,
    );

    const failures = results.filter(({ result }) => Either.isLeft(result));
    if (failures.length > 0) {
      const notStarted = allRepositories.length - results.length;
      return yield* new RalphieError({
        message: `${failures.length} repository runs failed${notStarted === 0 ? "" : `; ${notStarted} same-project runs were not started`}: ${failures
          .map(({ repository, result }) =>
            Either.isLeft(result)
              ? `${repository}: ${errorMessage(result.left)}`
              : repository,
          )
          .join("; ")}`,
      });
    }

    if (cleanup) {
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
      yield* progress.stopPersisting;
      yield* progress.emit({
        stage: ProgressStage.WorkspaceCleanup,
        status: ProgressStatus.Succeeded,
        message: `Workspace removed: ${workspace}.`,
      });
    }

    return results.map(({ repository, result }) => ({
      repository,
      summary: Either.getOrThrow(result),
    }));
  });
