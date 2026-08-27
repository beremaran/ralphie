import { join } from "node:path";

import {
    registerPiAgentSemaphore,
    makePiAgentSemaphore,
} from "./agent/concurrency.ts";
import { makePiSessionDiagnostics } from "./agent/task-session.ts";
import type { PiModel, PiSelection } from "./agent/model.ts";
import { GitHubIssueCloseReason } from "./github/issue-mutations.ts";
import type { GitHubIssue, IssueFilters } from "./github/issues.ts";
import type {
    PreparedIssueWorktree,
    RepositoryCheckout,
} from "./git/worktree.ts";
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

type WorkflowCheckout = NonNullable<RunState["checkout"]>;
type WorkflowOutcomeEntry = WorkflowSummary["outcomes"][number];

type PersistWorkflowStateInput = {
    readonly stateStore: RalphieRuntime["runStateStore"];
    readonly statePath: string;
    readonly queue: ReturnType<typeof createIssueQueue>;
    readonly activeQueueIssues: ReadonlyMap<number, GitHubIssue>;
    readonly actualRunId: string;
    readonly repository: string;
    readonly branch: string;
    readonly workflowMode: WorkflowMode;
    readonly issueConcurrency: number;
    readonly dryRun: boolean;
    readonly selection: PiSelection;
    readonly issueLimit?: number;
    readonly outcomes: ReadonlyArray<WorkflowOutcomeEntry>;
    readonly checkout: WorkflowCheckout;
};

const persistWorkflowState = async (
    input: PersistWorkflowStateInput,
    status: RunStateStatus,
    currentIssue?: RunState["activeIssue"],
): Promise<void> => {
    const snapshot = input.queue.snapshot();
    const pending = snapshot.pending.map(({ issue }) => ({
        ...issue,
        labels: [...issue.labels],
    }));
    for (const issue of input.activeQueueIssues.values()) {
        if (!pending.some(({ number }) => number === issue.number)) {
            pending.unshift({ ...issue, labels: [...issue.labels] });
        }
    }
    const processedCount =
        input.activeQueueIssues.size > 0
            ? Math.max(
                  0,
                  snapshot.processedCount - input.activeQueueIssues.size,
              )
            : snapshot.processedCount;
    await input.stateStore.save(input.statePath, {
        version: RUN_STATE_VERSION,
        status,
        runId: input.actualRunId,
        repository: input.repository,
        branch: input.branch,
        workflow: input.workflowMode,
        issueConcurrency: input.issueConcurrency,
        dryRun: input.dryRun,
        selection: input.selection,
        ...(input.issueLimit === undefined
            ? {}
            : { maxIssues: input.issueLimit }),
        queue: {
            pending,
            completedIssueNumbers: [...snapshot.completedIssueNumbers],
            processedCount,
        },
        outcomes: input.outcomes.map(({ issueNumber, outcome }) => ({
            issueNumber,
            outcome: copyOutcome(outcome),
        })),
        ...(currentIssue === undefined ? {} : { activeIssue: currentIssue }),
        checkout: input.checkout,
        updatedAt: new Date().toISOString(),
    });
};

type WorkflowIssueContext = {
    readonly issue: GitHubIssue;
    readonly current: number;
    readonly total: number;
    readonly featureBranch: string;
    readonly issueBaseCheckout: WorkflowCheckout;
    readonly preparedIssueWorktree?: PreparedIssueWorktree;
    readonly issueRepositories: ReadonlyArray<RepositoryCheckout>;
    readonly resumedClosureOutcome?: IssueExecutionOutcome;
};

const resumedClosureOutcomeFor = (
    resumeState: RunState | undefined,
    issueNumber: number,
    outcomes: ReadonlyArray<WorkflowOutcomeEntry>,
): IssueExecutionOutcome | undefined => {
    if (
        resumeState?.activeIssue?.issueNumber !== issueNumber ||
        resumeState.activeIssue.stage !== ProgressStage.IssueClosure
    ) {
        return undefined;
    }
    return outcomes.find(
        (entry) =>
            entry.issueNumber === issueNumber &&
            entry.outcome.kind === IssueExecutionOutcomeKind.Completed,
    )?.outcome;
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

type WorkflowConfiguration = {
    readonly requestedWorkflow: WorkflowMode;
    readonly issueConcurrency: number;
    readonly agentConcurrency?: number;
    readonly repo: string;
    readonly requestedBranch?: string;
    readonly maxIssues?: number;
    readonly issueFilters: IssueFilters;
    readonly agent: string;
    readonly model?: PiModel;
    readonly modelVariant?: string;
    readonly workspace: string;
    readonly cleanup: boolean;
    readonly startClean: boolean;
    readonly signal?: AbortSignal;
    readonly runId: string;
    readonly resumeState?: RunState;
    readonly resumePath?: string;
    readonly issueFailurePolicy: IssueFailurePolicy;
    readonly dryRun: boolean;
    readonly actualRunId: string;
    readonly effectiveDryRun: boolean;
    readonly workflowMode: WorkflowMode;
    readonly effectiveIssueConcurrency: number;
    readonly usesPullRequests: boolean;
    readonly statePath: string;
};

type WorkflowLifecycle = {
    activeIssue?: RunState["activeIssue"];
    readonly activeQueueIssues: Map<number, GitHubIssue>;
    persistCancellationState?: () => Promise<void>;
    restoreCancellationCheckout?: () => Promise<void>;
};

const makeWorkflowConfiguration = (
    options: WorkflowOptions,
): WorkflowConfiguration => {
    const {
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
    } = options;
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
    return {
        requestedWorkflow,
        issueConcurrency,
        agentConcurrency,
        repo,
        requestedBranch,
        maxIssues,
        issueFilters,
        agent,
        model,
        modelVariant,
        workspace,
        cleanup,
        startClean,
        signal,
        runId,
        resumeState,
        resumePath,
        issueFailurePolicy,
        dryRun,
        actualRunId,
        effectiveDryRun,
        workflowMode,
        effectiveIssueConcurrency,
        usesPullRequests,
        statePath,
    };
};

const emitRunStarted = async (
    progress: ProgressReporterService,
    config: WorkflowConfiguration,
): Promise<void> => {
    await progress.emit({
        stage: ProgressStage.Run,
        status: ProgressStatus.Info,
        message: `Ralphie started for ${config.repo} on ${config.requestedBranch ?? "default branch"}.`,
        details: {
            repository: config.repo,
            ...(config.requestedBranch === undefined
                ? {}
                : { branch: config.requestedBranch }),
            workspace: config.workspace,
            model: config.model
                ? `${config.model.providerID}/${config.model.modelID}`
                : "Pi default",
            variant: config.modelVariant ?? "Pi default",
            agent: config.agent,
            issueLimit: config.maxIssues ?? "unlimited",
            runId: config.actualRunId,
            dryRun: config.effectiveDryRun,
            workflow: config.workflowMode,
            ...(config.resumeState === undefined
                ? {}
                : { resumed: true, statePath: config.statePath }),
        },
    });
};

const emitRunSucceeded = async (
    progress: ProgressReporterService,
    config: WorkflowConfiguration,
    summary: WorkflowSummary,
): Promise<void> => {
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
            statePath: config.statePath,
        },
    });
};

const cancellationError = async (
    error: unknown,
    config: WorkflowConfiguration,
    lifecycle: WorkflowLifecycle,
): Promise<unknown> => {
    if (!config.signal?.aborted) return error;
    let restoreError: unknown;
    if (
        lifecycle.activeIssue !== undefined &&
        lifecycle.restoreCancellationCheckout !== undefined
    ) {
        try {
            await lifecycle.restoreCancellationCheckout();
        } catch (failure) {
            restoreError = failure;
        }
    }
    if (lifecycle.persistCancellationState !== undefined) {
        await lifecycle.persistCancellationState();
    }
    return new RalphieError({
        message:
            restoreError === undefined
                ? "Run cancelled; active checkout was preserved and resumable state was saved."
                : "Run cancelled; resumable state was saved but active checkout restoration failed.",
        cause: restoreError ?? error,
    });
};

const emitRunFailed = async (
    progress: ProgressReporterService,
    config: WorkflowConfiguration,
    error: unknown,
): Promise<void> => {
    await progress.emit({
        stage: ProgressStage.Run,
        status: ProgressStatus.Failed,
        message: `Run failed: ${errorMessage(error)}`,
        details: { runId: config.actualRunId, statePath: config.statePath },
    });
};

/** Run Ralphie using an explicit dependency object. */
export const workflow = async (
    options: WorkflowOptions,
    runtime: RalphieRuntime,
): Promise<WorkflowSummary> => {
    const config = makeWorkflowConfiguration(options);
    const {
        requestedWorkflow,
        issueConcurrency,
        agentConcurrency,
        repo,
        requestedBranch,
        maxIssues,
        issueFilters,
        agent,
        model,
        modelVariant,
        workspace,
        cleanup,
        startClean,
        signal,
        runId,
        resumeState,
        resumePath,
        issueFailurePolicy,
        dryRun,
        actualRunId,
        effectiveDryRun,
        workflowMode,
        effectiveIssueConcurrency,
        usesPullRequests,
        statePath,
    } = config;
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

    await emitRunStarted(progress, config);

    let activeIssue: RunState["activeIssue"] | undefined;
    const activeQueueIssues = new Map<number, GitHubIssue>();
    let persistCancellationState: (() => Promise<void>) | undefined;
    let restoreCancellationCheckout: (() => Promise<void>) | undefined;

    const run = async (): Promise<WorkflowSummary> => {
        checkCancellation(signal);
        let checkout: WorkflowCheckout;

        const prepareWorkspaceAndIssues = async () => {
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

            return {
                octokit,
                prepared,
                branch: prepared.branch,
                discoveredIssues,
            };
        };

        const verifyResumeState = (
            branch: string,
            checkout: WorkflowCheckout,
            discoveredIssues: ReadonlyArray<GitHubIssue>,
        ): void => {
            if (resumeState === undefined) return;
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
        };

        const makeQueue = (initialIssues: ReadonlyArray<GitHubIssue>) =>
            createIssueQueue(
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

        const prepareRunState = async (input: {
            readonly prepared: Awaited<ReturnType<typeof repository.prepare>>;
            readonly branch: string;
            readonly discoveredIssues: ReadonlyArray<GitHubIssue>;
        }) => {
            const { prepared, branch, discoveredIssues } = input;
            const repositoryCheckouts: ReadonlyArray<RepositoryCheckout> = [
                {
                    repository: repo,
                    repositoryPath: prepared.path,
                    branch: prepared.branch,
                },
            ];
            const captureCheckout = () =>
                invariantService.capture(prepared.path);
            checkout = await captureCheckout();
            verifyResumeState(branch, checkout, discoveredIssues);
            const initialIssues =
                resumeState === undefined
                    ? discoveredIssues
                    : resumeState.queue.pending;
            const queue = makeQueue(initialIssues);
            return { repositoryCheckouts, captureCheckout, queue };
        };

        const prepareWorkflow = async () => {
            const preparedInput = await prepareWorkspaceAndIssues();
            const { repositoryCheckouts, captureCheckout, queue } =
                await prepareRunState(preparedInput);
            const { octokit, prepared, branch } = preparedInput;
            const outcomes: Array<WorkflowOutcomeEntry> = [
                ...(resumeState?.outcomes ?? []),
            ];
            const selection: PiSelection = {
                agent,
                model,
                variant: modelVariant,
            };

            const persistState = (
                status: RunStateStatus,
                currentIssue?: RunState["activeIssue"],
            ): Promise<void> =>
                persistWorkflowState(
                    {
                        stateStore,
                        statePath,
                        queue,
                        activeQueueIssues,
                        actualRunId,
                        repository: repo,
                        branch,
                        workflowMode,
                        issueConcurrency: effectiveIssueConcurrency,
                        dryRun: effectiveDryRun,
                        selection,
                        issueLimit: resumeState?.maxIssues ?? maxIssues,
                        outcomes,
                        checkout,
                    },
                    status,
                    currentIssue,
                );

            persistCancellationState = () =>
                persistState(RunStateStatus.Active, activeIssue);
            await persistState(RunStateStatus.Active);
            const issueExecutor = effectiveDryRun
                ? dryRunIssueExecutor
                : normalIssueExecutor;
            const diagnostics = makePiSessionDiagnostics();
            return {
                octokit,
                prepared,
                branch,
                repositoryCheckouts,
                captureCheckout,
                queue,
                outcomes,
                selection,
                persistState,
                issueExecutor,
                diagnostics,
            };
        };

        const {
            octokit,
            prepared,
            branch,
            repositoryCheckouts,
            captureCheckout,
            queue,
            outcomes,
            selection,
            persistState,
            issueExecutor,
            diagnostics,
        } = await prepareWorkflow();

        const prepareIssueWorktree = async (
            issue: GitHubIssue,
            featureBranch: string,
            issueBaseCheckout: WorkflowCheckout,
        ): Promise<PreparedIssueWorktree | undefined> => {
            if (workflowMode !== WorkflowMode.ParallelPr || effectiveDryRun) {
                return undefined;
            }
            return await worktrees.prepareIssue({
                workspace,
                runId: actualRunId,
                issueNumber: issue.number,
                branch: featureBranch,
                repository: repositoryCheckouts[0]!,
                baseSha: issueBaseCheckout.head,
            });
        };

        const pushIssueBranch = async (
            issueRepositories: ReadonlyArray<RepositoryCheckout>,
            featureBranch: string,
            issueBaseCheckout: WorkflowCheckout,
            resumedClosureOutcome: IssueExecutionOutcome | undefined,
        ): Promise<void> => {
            if (
                !usesPullRequests ||
                effectiveDryRun ||
                resumedClosureOutcome !== undefined
            ) {
                return;
            }
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
        };

        const restoreIssueCheckout = (
            issueBaseCheckout: WorkflowCheckout,
        ): (() => Promise<void>) | undefined => {
            if (workflowMode === WorkflowMode.ParallelPr) return undefined;
            return async () => {
                await Promise.all(
                    repositoryCheckouts.map((issueRepository) =>
                        checkpoints.restore(issueRepository.repositoryPath, {
                            branch: issueBaseCheckout.branch,
                            sha: issueBaseCheckout.head,
                        }),
                    ),
                );
            };
        };

        const prepareIssue = async (
            issue: GitHubIssue,
        ): Promise<WorkflowIssueContext> => {
            const current = queue.processedCount();
            const total =
                resumeState?.maxIssues ??
                maxIssues ??
                current + queue.pendingCount();
            const resumedClosureOutcome = resumedClosureOutcomeFor(
                resumeState,
                issue.number,
                outcomes,
            );
            activeIssue = {
                issueNumber: issue.number,
                stage:
                    resumedClosureOutcome === undefined
                        ? ProgressStage.ComplexityAssessment
                        : ProgressStage.IssueClosure,
            };
            const issueBaseCheckout = { ...checkout };
            const featureBranch = issueFeatureBranch(issue.number);
            const preparedIssueWorktree = await prepareIssueWorktree(
                issue,
                featureBranch,
                issueBaseCheckout,
            );
            const issueRepositories: ReadonlyArray<RepositoryCheckout> =
                preparedIssueWorktree
                    ? [preparedIssueWorktree]
                    : repositoryCheckouts;
            await pushIssueBranch(
                issueRepositories,
                featureBranch,
                issueBaseCheckout,
                resumedClosureOutcome,
            );
            restoreCancellationCheckout =
                restoreIssueCheckout(issueBaseCheckout);
            await persistState(RunStateStatus.Active, activeIssue);
            return {
                issue,
                current,
                total,
                featureBranch,
                issueBaseCheckout,
                preparedIssueWorktree,
                issueRepositories,
                resumedClosureOutcome,
            };
        };

        const executeIssue = async (
            issueContext: WorkflowIssueContext,
            server: PiRuntime,
        ): Promise<IssueExecutionOutcome> => {
            if (issueContext.resumedClosureOutcome !== undefined) {
                return issueContext.resumedClosureOutcome;
            }
            const repositoryPath =
                issueContext.issueRepositories.find(
                    ({ repository }) =>
                        repository.toLowerCase() === repo.toLowerCase(),
                )?.repositoryPath ?? prepared.path;
            return await track(
                progress,
                ProgressStage.IssueExecution,
                `Executing #${issueContext.issue.number} ${issueContext.issue.title}...`,
                () =>
                    issueExecutor.execute({
                        issue: issueContext.issue,
                        repository: repo,
                        repositoryPath,
                        targetBranch:
                            usesPullRequests && !effectiveDryRun
                                ? issueContext.featureBranch
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
                (result) => outcomeMessage(issueContext.issue.number, result),
                {
                    issue: {
                        number: issueContext.issue.number,
                        title: issueContext.issue.title,
                    },
                    current: issueContext.current,
                    total: issueContext.total,
                },
            );
        };

        const deliverPullRequest = async (
            issueContext: WorkflowIssueContext,
        ): Promise<void> => {
            const artifacts = await artifactStores.forIssue(
                issueContext.issue.number,
                {
                    workspace,
                    runId: actualRunId,
                    repository: repo,
                },
            );
            const reviews = artifacts.has(IssueArtifactKind.ReviewAttempts)
                ? await artifacts.read(IssueArtifactKind.ReviewAttempts)
                : [];
            const issueRepository = issueContext.issueRepositories[0]!;
            const pullRequest = await githubPullRequests.createOrFind(
                octokit,
                repo,
                {
                    title: `Fix #${issueContext.issue.number}: ${issueContext.issue.title}`,
                    issueNumber: issueContext.issue.number,
                    closesIssue: true,
                    head: issueContext.featureBranch,
                    base: branch,
                },
            );
            await githubPullRequests.publishReviewAttempts(
                octokit,
                repo,
                pullRequest.number,
                reviews,
            );
            await githubPullRequests.merge(octokit, repo, pullRequest.number);
            if (workflowMode !== WorkflowMode.ParallelPr) {
                await issueOperations.restoreBaseCheckout(
                    issueRepository.repositoryPath,
                    branch,
                );
            }
        };

        const closeCompletedIssue = async (
            issueContext: WorkflowIssueContext,
            outcome: Extract<
                IssueExecutionOutcome,
                { readonly kind: IssueExecutionOutcomeKind.Completed }
            >,
        ): Promise<void> => {
            if (
                usesPullRequests &&
                outcome.completion === IssueCompletionKind.PushedCommit
            ) {
                await track(
                    progress,
                    ProgressStage.IssueClosure,
                    `Opening and merging pull request for issue #${issueContext.issue.number}...`,
                    () => deliverPullRequest(issueContext),
                    "Pull request merged; GitHub will close the issue.",
                    {
                        issue: {
                            number: issueContext.issue.number,
                            title: issueContext.issue.title,
                        },
                        details: { completion: outcome.completion },
                    },
                );
                if (issueContext.preparedIssueWorktree !== undefined) {
                    await worktrees.removeIssue(
                        repositoryCheckouts[0]!,
                        issueContext.preparedIssueWorktree,
                    );
                }
                return;
            }
            await track(
                progress,
                ProgressStage.IssueClosure,
                `Closing issue #${issueContext.issue.number} as completed...`,
                () =>
                    issueMutations.close(
                        octokit,
                        repo,
                        issueContext.issue.number,
                        GitHubIssueCloseReason.Completed,
                    ),
                `Issue #${issueContext.issue.number} closed as completed.`,
                {
                    issue: {
                        number: issueContext.issue.number,
                        title: issueContext.issue.title,
                    },
                    details: { completion: outcome.completion },
                },
            );
        };

        const completeIssue = async (
            issueContext: WorkflowIssueContext,
            outcome: IssueExecutionOutcome,
        ): Promise<void> => {
            if (outcome.kind !== IssueExecutionOutcomeKind.Completed) return;
            checkout = await captureCheckout();
            activeIssue = {
                issueNumber: issueContext.issue.number,
                stage: ProgressStage.IssueClosure,
            };
            await persistState(RunStateStatus.Active, activeIssue);
            await closeCompletedIssue(issueContext, outcome);
        };

        const completeQueueItem = (
            issueNumber: number,
            outcome: IssueExecutionOutcome,
        ): void => {
            if (
                outcome.kind === IssueExecutionOutcomeKind.Completed ||
                outcome.kind === IssueExecutionOutcomeKind.Decomposed ||
                outcome.kind === IssueExecutionOutcomeKind.Escalated
            ) {
                queue.complete(issueNumber);
            }
        };

        const handleFailedIssue = async (
            issueContext: WorkflowIssueContext,
            outcome: Extract<
                IssueExecutionOutcome,
                { readonly kind: IssueExecutionOutcomeKind.Failed }
            >,
        ): Promise<void> => {
            checkout = await captureCheckout();
            await persistState(RunStateStatus.Active, {
                issueNumber: issueContext.issue.number,
                stage: ProgressStage.IssueExecution,
            });
            if (issueFailurePolicy === IssueFailurePolicy.Halt) {
                throw new RalphieError({
                    message: `Issue #${issueContext.issue.number} failed: ${outcome.message}`,
                });
            }
        };

        const removeIssueWorktree = async (
            issueContext: WorkflowIssueContext,
            outcome: IssueExecutionOutcome,
        ): Promise<void> => {
            if (issueContext.preparedIssueWorktree === undefined) return;
            if (
                outcome.kind === IssueExecutionOutcomeKind.Completed &&
                outcome.completion === IssueCompletionKind.PushedCommit
            ) {
                return;
            }
            await worktrees.removeIssue(
                repositoryCheckouts[0]!,
                issueContext.preparedIssueWorktree,
            );
        };

        const finishSuccessfulIssue = async (
            issueContext: WorkflowIssueContext,
            outcome: IssueExecutionOutcome,
        ): Promise<void> => {
            await removeIssueWorktree(issueContext, outcome);
            activeIssue = undefined;
            activeQueueIssues.delete(issueContext.issue.number);
            restoreCancellationCheckout = undefined;
            checkout = await captureCheckout();
            await persistState(RunStateStatus.Active);
        };

        const refreshAfterDecomposition = async (
            outcome: IssueExecutionOutcome,
        ): Promise<void> => {
            if (
                outcome.kind !== IssueExecutionOutcomeKind.Decomposed &&
                outcome.kind !== IssueExecutionOutcomeKind.Escalated
            ) {
                return;
            }
            const refreshed = await track(
                progress,
                ProgressStage.IssueDiscovery,
                "Refreshing issue list...",
                () => githubIssues.listOpen(octokit, repo, issueFilters),
                (result) => `Refreshed ${result.length} matching open issues.`,
            );
            const added = queue.refresh(toQueuedIssues(refreshed));
            await progress.emit({
                stage: ProgressStage.IssueQueue,
                status: ProgressStatus.Info,
                message: `Issue queue refreshed; added ${added} new issues.`,
                details: { added, pending: queue.pendingCount() },
            });
            await persistState(RunStateStatus.Active);
        };

        const finalizeIssue = async (
            issueContext: WorkflowIssueContext,
            outcome: IssueExecutionOutcome,
        ): Promise<void> => {
            if (issueContext.resumedClosureOutcome === undefined) {
                outcomes.push({
                    issueNumber: issueContext.issue.number,
                    outcome,
                });
            }
            await completeIssue(issueContext, outcome);
            completeQueueItem(issueContext.issue.number, outcome);
            if (outcome.kind === IssueExecutionOutcomeKind.Failed) {
                await handleFailedIssue(issueContext, outcome);
                return;
            }
            await finishSuccessfulIssue(issueContext, outcome);
            await refreshAfterDecomposition(outcome);
        };

        const processNextIssue = async (
            server: PiRuntime,
        ): Promise<boolean> => {
            checkCancellation(signal);
            const issue = queue.next();
            if (issue === undefined) return false;
            activeQueueIssues.set(issue.number, issue);
            const issueContext = await prepareIssue(issue);
            const outcome = await executeIssue(issueContext, server);
            await finalizeIssue(issueContext, outcome);
            return true;
        };

        const processQueue = async (server: PiRuntime): Promise<void> => {
            const worker = async (): Promise<void> => {
                while (queue.state() === IssueQueueState.Ready) {
                    if (!(await processNextIssue(server))) break;
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
        await emitRunSucceeded(progress, config, summary);
        return summary;
    } catch (error) {
        const finalError = await cancellationError(error, config, {
            activeIssue,
            activeQueueIssues,
            persistCancellationState,
            restoreCancellationCheckout,
        });
        await emitRunFailed(progress, config, finalError);
        throw finalError;
    }
};