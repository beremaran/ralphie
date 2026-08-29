import { join } from "node:path";

import { makePiSessionDiagnostics } from "./agent/task-session.ts";
import type { PiModel, PiSelection } from "./agent/model.ts";
import { type GitHubIssueCloseReason } from "./github/issue-mutations.ts";
import type { GitHubIssue, IssueFilters } from "./github/issues.ts";
import {
    type IssueExecutionContext,
    type IssueCompletionKind,
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
    type ProgressStage,
    type ProgressStatus,
    type ProgressUpdate,
} from "./progress/progress.ts";
import { reconcileRunState } from "./run/reconciliation.ts";
import {
    RUN_STATE_VERSION,
    type RunState,
    RunStateStatus,
} from "./run/state.ts";
import {
    isNeedsAttentionStop,
    NeedsAttentionStop,
} from "./process/exit-code.ts";
import { RalphieError } from "./shared/error.ts";
import { resolveWorkspacePath } from "./workspace/workspace.ts";
import {
    DEFAULT_NEEDS_ATTENTION_POLICY,
    DEFAULT_WORKFLOW_MODE,
    NeedsAttentionPolicy,
    WorkflowMode,
} from "./options.ts";
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
            return outcome.completion === "already-resolved"
                ? `Issue #${issueNumber} was already resolved.`
                : `Issue #${issueNumber} implemented and pushed.`;
        case IssueExecutionOutcomeKind.Decomposed:
            return `Issue #${issueNumber} decomposed into ${outcome.childIssueNumbers.length} child issues.`;
        case IssueExecutionOutcomeKind.NeedsAttention:
            return `Issue #${issueNumber} needs attention: ${outcome.summary}`;
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
            return outcome.completion === "already-resolved"
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
        case IssueExecutionOutcomeKind.NeedsAttention:
            return {
                ...outcome,
                evidence: [...outcome.evidence],
                questions: [...outcome.questions],
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
        status: "started",
        message: startedMessage,
    });
    try {
        const result = await operation();
        await progress.emit({
            ...context,
            stage,
            status: "succeeded",
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
            status: "failed",
            message: `${startedMessage.replace(/\.{3}$/, "")} failed: ${errorMessage(error)}`,
        });
        throw error;
    }
};

export const IssueFailurePolicy = "halt" as const;
export type IssueFailurePolicy = typeof IssueFailurePolicy;

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
    readonly onNeedsAttention: NeedsAttentionPolicy;
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
        ...(issue.comments === undefined
            ? {}
            : {
                  comments: issue.comments.map((comment) => ({
                      ...comment,
                  })),
              }),
    }));
    for (const issue of input.activeQueueIssues.values()) {
        if (!pending.some(({ number }) => number === issue.number)) {
            pending.unshift({
                ...issue,
                labels: [...issue.labels],
                ...(issue.comments === undefined
                    ? {}
                    : {
                          comments: issue.comments.map((comment) => ({
                              ...comment,
                          })),
                      }),
            });
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
        onNeedsAttention: input.onNeedsAttention,
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
    readonly issueRepositories: ReadonlyArray<RepositoryCheckout>;
    readonly resumedClosureOutcome?: IssueExecutionOutcome;
};

type RepositoryCheckout = {
    readonly repository: string;
    readonly repositoryPath: string;
    readonly branch: string;
};

const resumedClosureOutcomeFor = (
    resumeState: RunState | undefined,
    issueNumber: number,
    outcomes: ReadonlyArray<WorkflowOutcomeEntry>,
): IssueExecutionOutcome | undefined => {
    if (
        resumeState?.activeIssue?.issueNumber !== issueNumber ||
        resumeState.activeIssue.stage !== "issue-closure"
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
    readonly repo: string;
    readonly branch?: string;
    readonly maxIssues?: number;
    readonly issueFilters: IssueFilters;
    readonly agent: string;
    readonly model?: PiModel;
    readonly modelVariant?: string;
    readonly piStageVariants?: IssueExecutionContext["piStageVariants"];
    readonly verificationCommands?: ReadonlyArray<string>;
    readonly workspace: string;
    readonly cleanup: boolean;
    readonly startClean: boolean;
    readonly signal?: AbortSignal;
    readonly runId?: string;
    readonly resumeState?: RunState;
    readonly resumePath?: string;
    readonly issueFailurePolicy?: IssueFailurePolicy;
    readonly onNeedsAttention?: NeedsAttentionPolicy;
    readonly dryRun?: boolean;
};

type WorkflowConfiguration = {
    readonly requestedWorkflow: WorkflowMode;
    readonly repo: string;
    readonly requestedBranch?: string;
    readonly maxIssues?: number;
    readonly issueFilters: IssueFilters;
    readonly agent: string;
    readonly model?: PiModel;
    readonly modelVariant?: string;
    readonly piStageVariants?: IssueExecutionContext["piStageVariants"];
    readonly verificationCommands: ReadonlyArray<string>;
    readonly workspace: string;
    readonly cleanup: boolean;
    readonly startClean: boolean;
    readonly signal?: AbortSignal;
    readonly runId: string;
    readonly resumeState?: RunState;
    readonly resumePath?: string;
    readonly issueFailurePolicy: IssueFailurePolicy;
    readonly onNeedsAttention: NeedsAttentionPolicy;
    readonly dryRun: boolean;
    readonly actualRunId: string;
    readonly effectiveDryRun: boolean;
    readonly workflowMode: WorkflowMode;
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
        repo,
        branch: requestedBranch,
        maxIssues,
        issueFilters,
        agent,
        model,
        modelVariant,
        piStageVariants,
        verificationCommands = [],
        workspace,
        cleanup,
        startClean,
        signal,
        runId = crypto.randomUUID(),
        resumeState,
        resumePath,
        issueFailurePolicy = IssueFailurePolicy,
        onNeedsAttention = DEFAULT_NEEDS_ATTENTION_POLICY,
        dryRun = false,
    } = options;
    const actualRunId = resumeState?.runId ?? runId;
    const effectiveOnNeedsAttention =
        resumeState?.onNeedsAttention ?? onNeedsAttention;
    const effectiveDryRun = resumeState?.dryRun ?? dryRun;
    const workflowMode = resumeState?.workflow ?? requestedWorkflow;
    const usesPullRequests = workflowMode === WorkflowMode.Pr;
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
        repo,
        requestedBranch,
        maxIssues,
        issueFilters,
        agent,
        model,
        modelVariant,
        piStageVariants,
        verificationCommands,
        workspace,
        cleanup,
        startClean,
        signal,
        runId,
        resumeState,
        resumePath,
        issueFailurePolicy,
        onNeedsAttention: effectiveOnNeedsAttention,
        dryRun,
        actualRunId,
        effectiveDryRun,
        workflowMode,
        usesPullRequests,
        statePath,
    };
};

const emitRunStarted = async (
    progress: ProgressReporterService,
    config: WorkflowConfiguration,
): Promise<void> => {
    await progress.emit({
        stage: "run",
        status: "info",
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
            onNeedsAttention: config.onNeedsAttention,
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
        stage: "run",
        status: "succeeded",
        message:
            `Run completed: ${summary.counts.completed} completed, ` +
            `${summary.counts.decomposed} decomposed, ${summary.counts.escalated} escalated, ` +
            `${summary.counts[IssueExecutionOutcomeKind.NeedsAttention]} deferred, ` +
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
        stage: "run",
        status: "failed",
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
        onNeedsAttention,
        dryRun,
        actualRunId,
        effectiveDryRun,
        workflowMode,
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
                    "workspace-cleanup",
                    `Removing existing workspace ${workspace}...`,
                    () => workspaceService.remove(workspace),
                    `Existing workspace removed: ${workspace}.`,
                );
            }

            await track(
                progress,
                "workspace-preparation",
                `Preparing workspace ${workspace}...`,
                () => workspaceService.prepare(workspace),
                `Workspace ready: ${workspace}.`,
            );

            const octokit = await track(
                progress,
                "github-authentication",
                "Checking GitHub authentication...",
                () => githubClient.initialize(),
                "GitHub authentication verified and Octokit initialized.",
            );
            checkCancellation(signal);

            await track(
                progress,
                "git-verification",
                "Checking Git installation...",
                () => repository.verifyInstalled(),
                "Git installation verified.",
            );
            checkCancellation(signal);

            const prepared = await track(
                progress,
                "repository-preparation",
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
                "issue-discovery",
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
                        onNeedsAttention,
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
                        await issueOperations.createOrCheckoutFeatureBranch(
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

        const restoreIssueCheckout =
            (issueBaseCheckout: WorkflowCheckout): (() => Promise<void>) =>
            async () => {
                await Promise.all(
                    repositoryCheckouts.map((issueRepository) =>
                        checkpoints.restore(issueRepository.repositoryPath, {
                            branch: issueBaseCheckout.branch,
                            sha: issueBaseCheckout.head,
                        }),
                    ),
                );
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
                        ? "complexity-assessment"
                        : "issue-closure",
            };
            const issueBaseCheckout = { ...checkout };
            const featureBranch = issueFeatureBranch(issue.number);
            const issueRepositories = repositoryCheckouts;
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
                "issue-execution",
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
                        piStageVariants: config.piStageVariants,
                        piDiagnostics: diagnostics,
                        repositoryInvariant: invariantService,
                        verificationCommands: config.verificationCommands,
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
            await githubPullRequests.merge(
                octokit,
                repo,
                pullRequest.number,
                pullRequest.headSha,
            );
            await issueOperations.restoreBaseCheckout(
                issueRepository.repositoryPath,
                branch,
            );
        };

        const closeCompletedIssue = async (
            issueContext: WorkflowIssueContext,
            outcome: Extract<
                IssueExecutionOutcome,
                { readonly kind: IssueExecutionOutcomeKind.Completed }
            >,
        ): Promise<void> => {
            if (usesPullRequests && outcome.completion === "pushed-commit") {
                await track(
                    progress,
                    "issue-closure",
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
                return;
            }
            await track(
                progress,
                "issue-closure",
                `Closing issue #${issueContext.issue.number} as completed...`,
                () =>
                    issueMutations.close(
                        octokit,
                        repo,
                        issueContext.issue.number,
                        "completed",
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
                stage: "issue-closure",
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
                stage: "issue-execution",
            });
            if (issueFailurePolicy === IssueFailurePolicy) {
                throw new RalphieError({
                    message: `Issue #${issueContext.issue.number} failed: ${outcome.message}`,
                });
            }
        };

        const handleNeedsAttentionIssue = async (
            issueContext: WorkflowIssueContext,
            outcome: Extract<
                IssueExecutionOutcome,
                { readonly kind: IssueExecutionOutcomeKind.NeedsAttention }
            >,
        ): Promise<void> => {
            if (onNeedsAttention !== NeedsAttentionPolicy.Halt) return;
            checkout = await captureCheckout();
            await persistState(RunStateStatus.Active, {
                issueNumber: issueContext.issue.number,
                stage: "issue-execution",
            });
            throw new NeedsAttentionStop({
                issueNumber: issueContext.issue.number,
                summary: outcome.summary,
            });
        };

        const finishSuccessfulIssue = async (
            issueContext: WorkflowIssueContext,
            outcome: IssueExecutionOutcome,
        ): Promise<void> => {
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
                "issue-discovery",
                "Refreshing issue list...",
                () => githubIssues.listOpen(octokit, repo, issueFilters),
                (result) => `Refreshed ${result.length} matching open issues.`,
            );
            const added = queue.refresh(toQueuedIssues(refreshed));
            await progress.emit({
                stage: "issue-queue",
                status: "info",
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
            if (outcome.kind === IssueExecutionOutcomeKind.NeedsAttention) {
                await handleNeedsAttentionIssue(issueContext, outcome);
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
            await worker();
        };

        let server: PiRuntime | undefined;
        try {
            const startedServer = await track(
                progress,
                "pi-runtime",
                "Starting Pi runtime...",
                async () => {
                    const started = await pi.start();
                    server = started;
                    return started;
                },
                "Pi runtime ready.",
            );
            await processQueue(startedServer);
        } finally {
            await server?.close();
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
                stage: "workspace-cleanup",
                status: "started",
                message: startedMessage,
            });
            try {
                await workspaceService.remove(workspace);
            } catch (error) {
                await progress.emit({
                    stage: "workspace-cleanup",
                    status: "failed",
                    message: `${startedMessage.replace(/\.{3}$/, "")} failed: ${errorMessage(error)}`,
                });
                throw error;
            }
            // The event log lives inside the workspace. Disable durable writes after
            // removal so cleanup-success and run-success events cannot recreate it.
            await progress.stopPersisting();
            await progress.emit({
                stage: "workspace-cleanup",
                status: "succeeded",
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
        if (!isNeedsAttentionStop(finalError)) {
            await emitRunFailed(progress, config, finalError);
        }
        throw finalError;
    }
};