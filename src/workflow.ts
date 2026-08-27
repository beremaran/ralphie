import { join } from "node:path";

import {
    registerPiAgentSemaphore,
    makePiAgentSemaphore,
} from "./agent/concurrency.ts";
import { makePiSessionDiagnostics } from "./agent/task-session.ts";
import type { PiModel } from "./agent/model.ts";
import { GitHubIssueCloseReason } from "./github/issue-mutations.ts";
import type { GitHubIssue, IssueFilters } from "./github/issues.ts";
import type { PreparedIssueWorktree } from "./git/worktree.ts";
import {
    IssueCompletionKind,
    IssueExecutionOutcomeKind,
    type IssueExecutionOutcome,
} from "./issues/execution.ts";
import { IssueArtifactKind } from "./issues/artifacts.ts";
import {
    createIssueQueue,
    IssueQueueState,
    toQueuedIssues,
} from "./issues/queue.ts";
import type { PiRuntime } from "./pi/server.ts";
import {
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
} from "./run/state.ts";
import { RalphieError } from "./shared/error.ts";
import { resolveWorkspacePath } from "./workspace/workspace.ts";
import { DEFAULT_WORKFLOW_MODE, WorkflowMode } from "./options.ts";
import type { RalphieRuntime } from "./runtime.ts";

const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

const checkCancellation = (signal: AbortSignal | undefined): void => {
    try {
        signal?.throwIfAborted();
    } catch (cause) {
        throw new RalphieError({
            message: "Run cancelled before the next operation started.",
            cause,
        });
    }
};

const issueFeatureBranch = (issueNumber: number): string =>
    `ralphie/issue-${issueNumber}`;

const outcomeMessage = (
    issueNumber: number,
    outcome: IssueExecutionOutcome,
): string => {
    switch (outcome.kind) {
        case IssueExecutionOutcomeKind.Completed:
            return outcome.completion === IssueCompletionKind.AlreadyResolved
                ? `Issue #${issueNumber} was already resolved.`
                : `Issue #${issueNumber} implemented and pushed.`;
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
            return outcome.completion === IssueCompletionKind.AlreadyResolved
                ? { ...outcome, evidence: [...outcome.evidence] }
                : {
                      kind: outcome.kind,
                      completion: outcome.completion,
                      commitSha: outcome.commitSha,
                      ...(outcome.reviewCount === undefined
                          ? {}
                          : { reviewCount: outcome.reviewCount }),
                  };
        case IssueExecutionOutcomeKind.Decomposed:
            return {
                ...outcome,
                childIssueNumbers: [...outcome.childIssueNumbers],
            };
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

type ProgressContext = Omit<ProgressUpdate, "stage" | "status" | "message">;

const track = async <Result>(
    progress: ProgressReporterService,
    stage: ProgressStage,
    startedMessage: string,
    operation: () => Promise<Result>,
    succeededMessage: string | ((result: Result) => string),
    context: ProgressContext = {},
): Promise<Result> => {
    await progress.emit({
        ...context,
        stage,
        status: ProgressStatus.Started,
        message: startedMessage,
    });
    try {
        const result = await operation();
        await progress.emit({
            ...context,
            stage,
            status: ProgressStatus.Succeeded,
            message:
                typeof succeededMessage === "function"
                    ? succeededMessage(result)
                    : succeededMessage,
        });
        return result;
    } catch (error) {
        await progress.emit({
            ...context,
            stage,
            status: ProgressStatus.Failed,
            message: `${startedMessage.replace(/\.{3}$/, "")} failed: ${errorMessage(error)}`,
        });
        throw error;
    }
};

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

/** Run Ralphie using an explicit dependency object. */
export const workflow = async (
    {
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
    }: WorkflowOptions,
    runtime: RalphieRuntime,
): Promise<WorkflowSummary> => {
    const {
        progress,
        runStateStore: stateStore,
        workspace: workspaceService,
        githubClient,
        githubIssues,
        githubIssueMutations: issueMutations,
        githubPullRequests,
        gitRepository: repository,
        gitRepositoryInvariant: invariantService,
        gitIssueCheckpoint: checkpoints,
        gitIssueOperations: issueOperations,
        gitWorktrees: worktrees,
        issueArtifactStore: artifactStores,
        issueExecutor: normalIssueExecutor,
        dryRunIssueExecutor,
        pi,
    } = runtime;

    const actualRunId = resumeState?.runId ?? runId;
    const effectiveDryRun = resumeState?.dryRun ?? dryRun;
    const workflowMode = resumeState?.workflow ?? requestedWorkflow;
    const effectiveIssueConcurrency =
        resumeState?.issueConcurrency ?? issueConcurrency;
    const usesPullRequests =
        workflowMode === WorkflowMode.Pr ||
        workflowMode === WorkflowMode.ParallelPr;
    const statePath =
        resumePath ??
        join(
            resolveWorkspacePath(workspace),
            ".ralphie",
            "runs",
            actualRunId,
            "state.json",
        );

    await progress.emit({
        stage: ProgressStage.Run,
        status: ProgressStatus.Info,
        message: `Ralphie started for ${repo} on ${requestedBranch ?? "default branch"}.`,
        details: {
            repository: repo,
            ...(requestedBranch === undefined
                ? {}
                : { branch: requestedBranch }),
            workspace,
            model: model
                ? `${model.providerID}/${model.modelID}`
                : "Pi default",
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
    const activeQueueIssues = new Map<number, GitHubIssue>();
    let persistCancellationState: (() => Promise<void>) | undefined;
    let restoreCancellationCheckout: (() => Promise<void>) | undefined;

    const run = async (): Promise<WorkflowSummary> => {
        checkCancellation(signal);
        if (startClean) {
            await track(
                progress,
                ProgressStage.WorkspaceCleanup,
                `Removing existing workspace ${workspace}...`,
                () => workspaceService.remove(workspace),
                `Existing workspace removed: ${workspace}.`,
            );
        }

        await track(
            progress,
            ProgressStage.WorkspacePreparation,
            `Preparing workspace ${workspace}...`,
            () => workspaceService.prepare(workspace),
            `Workspace ready: ${workspace}.`,
        );

        const octokit = await track(
            progress,
            ProgressStage.GitHubAuthentication,
            "Checking GitHub authentication...",
            () => githubClient.initialize(),
            "GitHub authentication verified and Octokit initialized.",
        );
        checkCancellation(signal);

        await track(
            progress,
            ProgressStage.GitVerification,
            "Checking Git installation...",
            () => repository.verifyInstalled(),
            "Git installation verified.",
        );
        checkCancellation(signal);

        const prepared = await track(
            progress,
            ProgressStage.RepositoryPreparation,
            `Preparing ${repo} on ${requestedBranch ?? "main/master"}...`,
            () => repository.prepare(repo, requestedBranch, workspace),
            (result) => `Repository ready: ${result.path}.`,
            {
                details: {
                    repository: repo,
                    ...(requestedBranch === undefined
                        ? {}
                        : { branch: requestedBranch }),
                    workspace,
                },
            },
        );
        const branch = prepared.branch;
        checkCancellation(signal);

        const discoveredIssues = await track(
            progress,
            ProgressStage.IssueDiscovery,
            "Fetching matching open issues...",
            () => githubIssues.listOpen(octokit, repo, issueFilters),
            (result) =>
                result.length === 0
                    ? "No open issues match the current filters."
                    : `Found ${result.length} matching open issues.`,
            { details: { filters: issueFilters } },
        );
        checkCancellation(signal);

        const repositoryCheckouts = [
            {
                repository: repo,
                repositoryPath: prepared.path,
                branch: prepared.branch,
            },
        ];
        const captureCheckout = () => invariantService.capture(prepared.path);
        let checkout = await captureCheckout();
        if (resumeState !== undefined) {
            const reconciliation = reconcileRunState(resumeState, {
                repository: repo,
                branch,
                git: checkout,
                github: {
                    openIssueNumbers: discoveredIssues.map(
                        ({ number }) => number,
                    ),
                },
            });
            if (!reconciliation.compatible) {
                throw new RalphieError({
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

        const persistState = async (
            status: RunStateStatus,
            currentIssue?: RunState["activeIssue"],
        ): Promise<void> => {
            const snapshot = queue.snapshot();
            const pending = snapshot.pending.map(({ issue }) => ({
                ...issue,
                labels: [...issue.labels],
            }));
            for (const issue of activeQueueIssues.values()) {
                if (!pending.some(({ number }) => number === issue.number)) {
                    pending.unshift({ ...issue, labels: [...issue.labels] });
                }
            }
            await stateStore.save(statePath, {
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
                    processedCount:
                        activeQueueIssues.size > 0
                            ? Math.max(
                                  0,
                                  snapshot.processedCount -
                                      activeQueueIssues.size,
                              )
                            : snapshot.processedCount,
                },
                outcomes: outcomes.map(({ issueNumber, outcome }) => ({
                    issueNumber,
                    outcome: copyOutcome(outcome),
                })),
                ...(currentIssue === undefined
                    ? {}
                    : { activeIssue: currentIssue }),
                checkout,
                updatedAt: new Date().toISOString(),
            });
        };

        persistCancellationState = () =>
            persistState(RunStateStatus.Active, activeIssue);
        await persistState(RunStateStatus.Active);
        const issueExecutor = effectiveDryRun
            ? dryRunIssueExecutor
            : normalIssueExecutor;
        const diagnostics = makePiSessionDiagnostics();

        const processQueue = async (server: PiRuntime): Promise<void> => {
            const worker = async (): Promise<void> => {
                while (queue.state() === IssueQueueState.Ready) {
                    checkCancellation(signal);
                    const issue = queue.next();
                    if (issue === undefined) break;
                    activeQueueIssues.set(issue.number, issue);
                    const current = queue.processedCount();
                    const total =
                        resumeState?.maxIssues ??
                        maxIssues ??
                        current + queue.pendingCount();
                    const resumedClosureOutcome =
                        resumeState?.activeIssue?.issueNumber ===
                            issue.number &&
                        resumeState.activeIssue.stage ===
                            ProgressStage.IssueClosure
                            ? outcomes.find(
                                  (entry) =>
                                      entry.issueNumber === issue.number &&
                                      entry.outcome.kind ===
                                          IssueExecutionOutcomeKind.Completed,
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
                    let preparedIssueWorktree:
                        | PreparedIssueWorktree
                        | undefined;
                    if (
                        workflowMode === WorkflowMode.ParallelPr &&
                        !effectiveDryRun
                    ) {
                        preparedIssueWorktree = await worktrees.prepareIssue({
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
                        await Promise.all(
                            issueRepositories.map(async (issueRepository) => {
                                const preparedBranch =
                                    workflowMode === WorkflowMode.ParallelPr
                                        ? { headSha: issueBaseCheckout.head }
                                        : await issueOperations.createOrCheckoutFeatureBranch(
                                              issueRepository.repositoryPath,
                                              featureBranch,
                                              issueRepository.branch,
                                              issueBaseCheckout.head,
                                          );
                                await issueOperations.push(
                                    issueRepository.repositoryPath,
                                    featureBranch,
                                    preparedBranch.headSha,
                                );
                            }),
                        );
                    }

                    restoreCancellationCheckout =
                        workflowMode === WorkflowMode.ParallelPr
                            ? undefined
                            : async () => {
                                  await Promise.all(
                                      repositoryCheckouts.map(
                                          (issueRepository) =>
                                              checkpoints.restore(
                                                  issueRepository.repositoryPath,
                                                  {
                                                      branch: issueBaseCheckout.branch,
                                                      sha: issueBaseCheckout.head,
                                                  },
                                              ),
                                      ),
                                  );
                              };
                    await persistState(RunStateStatus.Active, activeIssue);

                    const outcome =
                        resumedClosureOutcome ??
                        (await track(
                            progress,
                            ProgressStage.IssueExecution,
                            `Executing #${issue.number} ${issue.title}...`,
                            () =>
                                issueExecutor.execute({
                                    issue,
                                    repository: repo,
                                    repositoryPath:
                                        issueRepositories.find(
                                            ({ repository }) =>
                                                repository.toLowerCase() ===
                                                repo.toLowerCase(),
                                        )?.repositoryPath ?? prepared.path,
                                    targetBranch:
                                        usesPullRequests && !effectiveDryRun
                                            ? featureBranch
                                            : branch,
                                    workspace,
                                    runId: actualRunId,
                                    octokit,
                                    pi: server.client,
                                    piSelection: selection,
                                    piDiagnostics: diagnostics,
                                    repositoryInvariant: invariantService,
                                    signal,
                                }),
                            (result) => outcomeMessage(issue.number, result),
                            {
                                issue: {
                                    number: issue.number,
                                    title: issue.title,
                                },
                                current,
                                total,
                            },
                        ));
                    if (resumedClosureOutcome === undefined) {
                        outcomes.push({ issueNumber: issue.number, outcome });
                    }

                    if (outcome.kind === IssueExecutionOutcomeKind.Completed) {
                        checkout = await captureCheckout();
                        activeIssue = {
                            issueNumber: issue.number,
                            stage: ProgressStage.IssueClosure,
                        };
                        await persistState(RunStateStatus.Active, activeIssue);
                        if (
                            usesPullRequests &&
                            outcome.completion ===
                                IssueCompletionKind.PushedCommit
                        ) {
                            const artifacts = await artifactStores.forIssue(
                                issue.number,
                                {
                                    workspace,
                                    runId: actualRunId,
                                    repository: repo,
                                },
                            );
                            const reviews = artifacts.has(
                                IssueArtifactKind.ReviewAttempts,
                            )
                                ? await artifacts.read(
                                      IssueArtifactKind.ReviewAttempts,
                                  )
                                : [];
                            const issueRepository = issueRepositories[0]!;
                            const deliver = async () => {
                                const pullRequest =
                                    await githubPullRequests.createOrFind(
                                        octokit,
                                        repo,
                                        {
                                            title: `Fix #${issue.number}: ${issue.title}`,
                                            issueNumber: issue.number,
                                            closesIssue: true,
                                            head: featureBranch,
                                            base: branch,
                                        },
                                    );
                                await githubPullRequests.publishReviewAttempts(
                                    octokit,
                                    repo,
                                    pullRequest.number,
                                    reviews,
                                );
                                await githubPullRequests.merge(
                                    octokit,
                                    repo,
                                    pullRequest.number,
                                );
                                if (workflowMode !== WorkflowMode.ParallelPr) {
                                    await issueOperations.restoreBaseCheckout(
                                        issueRepository.repositoryPath,
                                        branch,
                                    );
                                }
                            };
                            await track(
                                progress,
                                ProgressStage.IssueClosure,
                                `Opening and merging pull request for issue #${issue.number}...`,
                                deliver,
                                "Pull request merged; GitHub will close the issue.",
                                {
                                    issue: {
                                        number: issue.number,
                                        title: issue.title,
                                    },
                                    details: { completion: outcome.completion },
                                },
                            );
                            if (preparedIssueWorktree !== undefined) {
                                await worktrees.removeIssue(
                                    repositoryCheckouts[0]!,
                                    preparedIssueWorktree,
                                );
                            }
                        } else {
                            await track(
                                progress,
                                ProgressStage.IssueClosure,
                                `Closing issue #${issue.number} as completed...`,
                                () =>
                                    issueMutations.close(
                                        octokit,
                                        repo,
                                        issue.number,
                                        GitHubIssueCloseReason.Completed,
                                    ),
                                `Issue #${issue.number} closed as completed.`,
                                {
                                    issue: {
                                        number: issue.number,
                                        title: issue.title,
                                    },
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
                        checkout = await captureCheckout();
                        await persistState(RunStateStatus.Active, {
                            issueNumber: issue.number,
                            stage: ProgressStage.IssueExecution,
                        });
                        if (issueFailurePolicy === IssueFailurePolicy.Halt) {
                            throw new RalphieError({
                                message: `Issue #${issue.number} failed: ${outcome.message}`,
                            });
                        }
                    } else {
                        if (
                            preparedIssueWorktree !== undefined &&
                            !(
                                outcome.kind ===
                                    IssueExecutionOutcomeKind.Completed &&
                                outcome.completion ===
                                    IssueCompletionKind.PushedCommit
                            )
                        ) {
                            await worktrees.removeIssue(
                                repositoryCheckouts[0]!,
                                preparedIssueWorktree,
                            );
                        }
                        activeIssue = undefined;
                        activeQueueIssues.delete(issue.number);
                        restoreCancellationCheckout = undefined;
                        checkout = await captureCheckout();
                        await persistState(RunStateStatus.Active);
                    }

                    if (
                        outcome.kind === IssueExecutionOutcomeKind.Decomposed ||
                        outcome.kind === IssueExecutionOutcomeKind.Escalated
                    ) {
                        const refreshed = await track(
                            progress,
                            ProgressStage.IssueDiscovery,
                            "Refreshing issue list...",
                            () =>
                                githubIssues.listOpen(
                                    octokit,
                                    repo,
                                    issueFilters,
                                ),
                            (result) =>
                                `Refreshed ${result.length} matching open issues.`,
                        );
                        const added = queue.refresh(toQueuedIssues(refreshed));
                        await progress.emit({
                            stage: ProgressStage.IssueQueue,
                            status: ProgressStatus.Info,
                            message: `Issue queue refreshed; added ${added} new issues.`,
                            details: { added, pending: queue.pendingCount() },
                        });
                        await persistState(RunStateStatus.Active);
                    }
                }
            };

            if (workflowMode === WorkflowMode.ParallelPr) {
                await Promise.all(
                    Array.from(
                        { length: Math.max(1, effectiveIssueConcurrency) },
                        () => worker(),
                    ),
                );
            } else {
                await worker();
            }
        };

        const server = await track(
            progress,
            ProgressStage.PiRuntime,
            "Starting Pi runtime...",
            () => pi.start(),
            "Pi runtime ready.",
        );

        // Attach the run-wide permit before any issue worker starts.
        if (agentConcurrency !== undefined) {
            registerPiAgentSemaphore(
                server.client,
                makePiAgentSemaphore(agentConcurrency),
            );
        }

        try {
            await processQueue(server);
        } finally {
            server.close();
        }

        if (queue.state() === IssueQueueState.DependencyBlocked) {
            await persistState(RunStateStatus.Active);
            throw new RalphieError({
                message: `${queue.pendingCount()} pending issues are blocked by open dependencies.`,
            });
        }

        await persistState(RunStateStatus.Complete);
        activeIssue = undefined;
        activeQueueIssues.clear();
        restoreCancellationCheckout = undefined;
        const summary = summarize(actualRunId, outcomes);
        if (cleanup) {
            const startedMessage = `Removing workspace ${workspace}...`;
            await progress.emit({
                stage: ProgressStage.WorkspaceCleanup,
                status: ProgressStatus.Started,
                message: startedMessage,
            });
            try {
                await workspaceService.remove(workspace);
            } catch (error) {
                await progress.emit({
                    stage: ProgressStage.WorkspaceCleanup,
                    status: ProgressStatus.Failed,
                    message: `${startedMessage.replace(/\.{3}$/, "")} failed: ${errorMessage(error)}`,
                });
                throw error;
            }
            // The event log lives inside the workspace. Disable durable writes after
            // removal so cleanup-success and run-success events cannot recreate it.
            await progress.stopPersisting();
            await progress.emit({
                stage: ProgressStage.WorkspaceCleanup,
                status: ProgressStatus.Succeeded,
                message: `Workspace removed: ${workspace}.`,
            });
        }
        return summary;
    };

    try {
        const summary = await run();
        await progress.emit({
            stage: ProgressStage.Run,
            status: ProgressStatus.Succeeded,
            message:
                `Run completed: ${summary.counts.completed} completed, ` +
                `${summary.counts.decomposed} decomposed, ${summary.counts.escalated} escalated, ` +
                `${summary.counts.skipped} skipped, ${summary.counts.failed} failed.`,
            details: {
                runId: summary.runId,
                counts: summary.counts,
                statePath,
            },
        });
        return summary;
    } catch (error) {
        if (signal?.aborted) {
            let restoreError: unknown;
            if (
                activeIssue !== undefined &&
                restoreCancellationCheckout !== undefined
            ) {
                try {
                    await restoreCancellationCheckout();
                } catch (failure) {
                    restoreError = failure;
                }
            }
            if (persistCancellationState !== undefined) {
                await persistCancellationState();
            }
            error = new RalphieError({
                message:
                    restoreError === undefined
                        ? "Run cancelled; active checkout was preserved and resumable state was saved."
                        : "Run cancelled; resumable state was saved but active checkout restoration failed.",
                cause: restoreError ?? error,
            });
        }

        await progress.emit({
            stage: ProgressStage.Run,
            status: ProgressStatus.Failed,
            message: `Run failed: ${errorMessage(error)}`,
            details: { runId: actualRunId, statePath },
        });
        throw error;
    }
};