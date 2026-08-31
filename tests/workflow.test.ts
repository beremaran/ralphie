import { describe, expect, test } from "bun:test";
import type { Octokit } from "octokit";
import type { PiClient } from "../src/pi/client.ts";

import { CommandRunnerLive } from "../src/process/command-runner.ts";
import type { GitRepositoryService } from "../src/git/repository.ts";
import type { GitRepositoryInvariantService } from "../src/git/repository-invariant.ts";
import type { GitIssueCheckpointService } from "../src/git/issue-checkpoint.ts";
import type { GitIssueOperationsService } from "../src/git/issue-operations.ts";
import type { GitHubClientService } from "../src/github/client.ts";
import type {
    GitHubPullRequest,
    GitHubPullRequestService,
} from "../src/github/pull-requests.ts";
import type {
    PipelineObservationOutcome,
    PipelineObservationRead,
    PipelineObservationService,
    PipelineObservationTransition,
    PipelineRemoteHeadReader,
    PipelineSnapshot,
    PipelineSnapshotFetcher,
} from "../src/github/pipeline-observation.ts";
import { makePipelineObservationService } from "../src/github/pipeline-observation.ts";
import type { GitHubIssueMutationService } from "../src/github/issue-mutations.ts";
import { makeParentCompletionService } from "../src/github/parent-completion.ts";
import type { GitHubNeedsAttentionNotificationService } from "../src/github/needs-attention.ts";
import type { GitHubIssue, GitHubIssuesService } from "../src/github/issues.ts";
import {
    type IssueCompletionKind,
    type IssueExecutionContext,
    type IssueExecutionOutcome,
    IssueExecutionOutcomeKind,
} from "../src/issues/execution.ts";
import type { IssueExecutorService } from "../src/issues/executor.ts";
import type { DryRunIssueExecutorService } from "../src/issues/dry-run-executor.ts";
import type { IssueArtifactStoreService } from "../src/issues/artifacts.ts";
import { makeIssueArtifactStore } from "../src/issues/artifacts.ts";
import { DEFAULT_PI_AGENT } from "../src/agent/model.ts";
import type { PiService } from "../src/pi/server.ts";
import {
    makeProgressRecorder,
    type ProgressReporterService,
    type ProgressUpdate,
    type ProgressStage,
    type ProgressStatus,
} from "../src/progress/progress.ts";
import {
    type RunState,
    RunStateStatus,
    type RunStateStoreService,
} from "../src/run/state.ts";
import type { WorkspaceService } from "../src/workspace/workspace.ts";
import { workflow } from "../src/workflow.ts";
import {
    IssueFailurePolicy,
    NeedsAttentionPolicy,
    WorkflowMode,
} from "../src/options.ts";
import { IssueOrder, IssueSort } from "../src/github/issues.ts";
import type { RalphieRuntime } from "../src/runtime.ts";
import { RalphieError } from "../src/shared/error.ts";
import { NeedsAttentionReason } from "../src/issues/decisions.ts";

const firstIssue: GitHubIssue = {
    number: 42,
    title: "Test issue",
    url: "https://github.com/owner/repo/issues/42",
    body: "Test body",
    labels: ["bug"],
    state: "open",
    updatedAt: "2026-08-28T00:00:00.000Z",
    comments: [],
    commentCount: 0,
    commentVersion: "2026-08-28T00:00:00.000Z",
};
const secondIssue: GitHubIssue = {
    ...firstIssue,
    number: 43,
    title: "Second test issue",
    url: "https://github.com/owner/repo/issues/43",
};

const greenSnapshot = (observedSha: string): PipelineSnapshot => ({
    repository: "owner/repo",
    branch: "ralphie/issue-42",
    commitSha: observedSha,
    state: "non-empty",
    items: [],
    sourceErrors: [],
    completenessErrors: [],
    diagnostics: [],
    reason: "success",
    greenCandidate: true,
    fingerprint: `success-${observedSha}`,
});

type TestRuntimeOptions = {
    readonly outcomes?: ReadonlyArray<IssueExecutionOutcome>;
    readonly issueLists?: ReadonlyArray<ReadonlyArray<GitHubIssue>>;
    readonly refreshIssues?: ReadonlyArray<GitHubIssue>;
    readonly refreshFailure?: RalphieError;
    readonly githubFailure?: RalphieError;
    readonly gitFailure?: RalphieError;
    readonly startFailure?: RalphieError;
    readonly removeFailure?: RalphieError;
    readonly closeFailure?: RalphieError;
    readonly abortOnExecute?: AbortController;
    readonly abortAt?: "github" | "repository" | "issues" | "pi" | "between";
    readonly abortController?: AbortController;
    readonly captureStart?: number;
    readonly failPiReadyProgress?: boolean;
    readonly executionContexts?: IssueExecutionContext[];
    readonly executeGate?: (context: IssueExecutionContext) => Promise<void>;
    readonly refreshedIssues?: Readonly<Record<number, GitHubIssue>>;
    readonly needsAttentionNotification?: GitHubNeedsAttentionNotificationService;
    readonly dryRunOutcome?: IssueExecutionOutcome;
    readonly onStateSave?: (state: RunState) => void;
    /** Native sub-issues reported for every parent during reconciliation. */
    readonly parentSubIssues?: ReadonlyArray<GitHubIssue>;
    /** Result of creating or re-reading the matching pull request. */
    readonly prOverride?: GitHubPullRequest;
    /** Result of the gate's pre-merge re-read. */
    readonly prReadOverride?: GitHubPullRequest;
    /** Sequential results returned by pull-request reads, in call order. */
    readonly prReadSequence?: ReadonlyArray<GitHubPullRequest>;
    /** Replaces the gate observer entirely (used by the local fake-check e2e). */
    readonly pipelineObservationOverride?: PipelineObservationService;
    /** Invoked when the pull-request merge mutation is attempted. */
    readonly onMergeCall?: () => void;
    /** Outcomes returned by the gate's check observer, in call order. */
    readonly pipelineObservationOutcomes?: ReadonlyArray<PipelineObservationOutcome>;
    /** When set, the observer aborts the controller before returning. */
    readonly observeAbortController?: AbortController;
    /** When set, merging the pull request rejects with this error. */
    readonly mergePullRequestFailure?: RalphieError;
};

const testRuntime = (
    calls: string[],
    savedStates: RunState[],
    options: TestRuntimeOptions = {},
    progressEvents: ProgressUpdate[] = [],
): RalphieRuntime => {
    let listIndex = 0;
    let refreshIndex = 0;
    let outcomeIndex = 0;
    let captureIndex = options.captureStart ?? 0;
    let gateIndex = 0;
    let readIndex = 0;
    const outcomes = options.outcomes ?? [
        {
            kind: IssueExecutionOutcomeKind.Completed,
            completion: "pushed-commit",
            commitSha: "abc123",
            reviewCount: 1,
        },
    ];
    const issueLists = options.issueLists ?? [[firstIssue]];

    const githubClient: GitHubClientService = {
        initialize: async () => {
            calls.push("initializeGitHub");
            if (options.abortAt === "github") options.abortController?.abort();
            if (options.githubFailure) throw options.githubFailure;
            return {} as Octokit;
        },
    };
    const repository: GitRepositoryService = {
        verifyInstalled: async () => {
            calls.push("verifyGitInstalled");
            if (options.gitFailure) throw options.gitFailure;
        },
        prepare: async (repo, branch, workspace, destinationPath) => {
            calls.push(`prepareRepository:${repo}:${branch}:${workspace}`);
            if (options.abortAt === "repository")
                options.abortController?.abort();
            return {
                path: destinationPath ?? `${workspace}/repo`,
                branch: branch ?? "main",
                cloned: true,
                branchChanged: branch !== "main",
                cleaned: false,
            };
        },
    };
    const invariant: GitRepositoryInvariantService = {
        capture: async () => ({
            branch: "develop",
            head: `head-${captureIndex++}`,
        }),
        verify: async () => {},
    };
    const checkpoint: GitIssueCheckpointService = {
        capture: async () => ({ branch: "develop", sha: "a".repeat(40) }),
        createPatch: async () => "",
        restore: async () => {
            calls.push("restoreCheckout");
        },
    };
    const githubIssues: GitHubIssuesService = {
        listDecompositionChildren: async () => [],
        refresh: async (_client, _repo, issueNumber) => {
            calls.push(`refreshIssue:${issueNumber}`);
            if (options.refreshFailure) throw options.refreshFailure;
            const configured =
                options.refreshIssues?.[
                    Math.min(
                        refreshIndex,
                        (options.refreshIssues?.length ?? 1) - 1,
                    )
                ];
            refreshIndex += 1;
            return (
                configured ??
                options.refreshedIssues?.[issueNumber] ??
                issueLists
                    .flat()
                    .find(({ number }) => number === issueNumber) ??
                firstIssue
            );
        },
        listOpen: async (_client, repo, filters) => {
            calls.push(
                `listIssues:${repo}:${filters.labels.join(",")}:${filters.sort}:${filters.order}`,
            );
            if (options.abortAt === "issues") options.abortController?.abort();
            const result =
                issueLists[Math.min(listIndex, issueLists.length - 1)] ?? [];
            listIndex += 1;
            return result;
        },
    };
    const mutations: GitHubIssueMutationService = {
        create: async () => {
            throw new RalphieError({ message: "unused" });
        },
        update: async () => {
            throw new RalphieError({ message: "unused" });
        },
        close: async (_client, _repository, issueNumber) => {
            calls.push(`closeIssue:${issueNumber}`);
            if (options.closeFailure) throw options.closeFailure;
            return (
                issueLists
                    .flat()
                    .find(({ number }) => number === issueNumber) ?? firstIssue
            );
        },
    };
    const pullRequests: GitHubPullRequestService = {
        createOrFind: async (_client, repo, input) => {
            calls.push(`createPullRequest:${repo}:${input.head}:${input.base}`);
            return (
                options.prOverride ?? {
                    number: 1,
                    url: "https://github.com/owner/repo/pull/1",
                    merged: false,
                    headSha: "feature-head-sha",
                    state: "open",
                }
            );
        },
        read: async (_client, repo, number) => {
            calls.push(`readPullRequest:${repo}:${number}`);
            const sequenced =
                options.prReadSequence === undefined
                    ? undefined
                    : options.prReadSequence[
                          Math.min(readIndex, options.prReadSequence.length - 1)
                      ];
            readIndex += 1;
            return (
                sequenced ??
                options.prReadOverride ??
                options.prOverride ?? {
                    number,
                    url: `https://github.com/owner/repo/pull/${number}`,
                    merged: false,
                    headSha: "feature-head-sha",
                    state: "open",
                }
            );
        },
        readSnapshot: async () => {
            throw new RalphieError({ message: "unused" });
        },
        rereadMatchingSnapshot: async () => {
            throw new RalphieError({ message: "unused" });
        },
        publishPullRequestReviewAttempts: async () => {
            throw new RalphieError({ message: "unused" });
        },
        publishReviewAttempts: async (_client, repo, number) => {
            calls.push(`publishReviews:${repo}:${number}`);
        },
        merge: async (_client, repo, number, expectedHeadSha) => {
            calls.push(`mergePullRequest:${repo}:${number}:${expectedHeadSha}`);
            options.onMergeCall?.();
            if (options.mergePullRequestFailure) {
                throw options.mergePullRequestFailure;
            }
            return {
                number,
                url: `https://github.com/owner/repo/pull/${number}`,
                merged: true,
                headSha: expectedHeadSha,
                state: "closed",
            };
        },
    };
    const operations: GitIssueOperationsService = {
        stageAll: async () => {},
        readStagedBinaryDiff: async () => "",
        readCommittedBinaryDiff: async () => "",
        hasStagedChanges: async () => false,
        commit: async () => ({ sha: "a".repeat(40), treeSha: "b".repeat(40) }),
        push: async (_path, branch) => {
            calls.push(`pushBranch:${branch}`);
        },
        createOrCheckoutFeatureBranch: async (
            _path,
            featureBranch,
            baseBranch,
            baseSha,
        ) => {
            calls.push(`prepareFeatureBranch:${featureBranch}:${baseBranch}`);
            return {
                branch: featureBranch,
                baseBranch,
                baseSha,
                headSha: baseSha,
                created: true,
            };
        },
        restoreBaseCheckout: async (_path, branch) => {
            calls.push(`restoreBase:${branch}`);
        },
    };
    const artifactStore: IssueArtifactStoreService = {
        forIssue: (issueNumber) => makeIssueArtifactStore(issueNumber),
    };
    const issueExecutor: IssueExecutorService = {
        execute: async (context) => {
            options.executionContexts?.push(context);
            if (options.executeGate !== undefined)
                await options.executeGate(context);
            calls.push(
                `executeIssue:${context.issue.number}:${context.repositoryPath}:${context.targetBranch}:${context.piSelection.agent}`,
            );
            if (options.abortOnExecute !== undefined) {
                options.abortOnExecute.abort();
                throw new RalphieError({ message: "agent interrupted" });
            }
            const result =
                outcomes[Math.min(outcomeIndex, outcomes.length - 1)];
            outcomeIndex += 1;
            if (result === undefined) throw new Error("Missing test outcome");
            if (options.abortAt === "between") options.abortController?.abort();
            return result;
        },
    };
    const dryRunIssueExecutor: DryRunIssueExecutorService = {
        execute: async ({ issue }) => {
            calls.push(`dryRunIssue:${issue.number}`);
            return (
                options.dryRunOutcome ?? {
                    kind: IssueExecutionOutcomeKind.Skipped,
                    route: "implementation",
                    reason: "dry run",
                }
            );
        },
    };
    const pi: PiService = {
        start: async () => {
            if (options.startFailure) throw options.startFailure;
            calls.push("startServer");
            if (options.abortAt === "pi") options.abortController?.abort();
            return {
                url: "http://127.0.0.1:4096",
                client: {} as PiClient,
                close: async () => {
                    calls.push("closeRuntime");
                },
            };
        },
    };
    const stateStore: RunStateStoreService = {
        load: async () => {
            throw new RalphieError({ message: "unused" });
        },
        save: async (_path, state) => {
            const saved = structuredClone(state);
            savedStates.push(saved);
            options.onStateSave?.(saved);
        },
    };
    const workspace: WorkspaceService = {
        prepare: async (path) => {
            calls.push(`prepareWorkspace:${path}`);
        },
        remove: async (path) => {
            calls.push(`removeWorkspace:${path}`);
            if (options.removeFailure) throw options.removeFailure;
        },
    };
    const progressRecorder = makeProgressRecorder(progressEvents);
    const progress: ProgressReporterService = options.failPiReadyProgress
        ? {
              ...progressRecorder,
              emit: async (update) => {
                  if (
                      update.stage === "pi-runtime" &&
                      update.status === "succeeded"
                  ) {
                      throw new Error("Pi ready progress emission failed");
                  }
                  await progressRecorder.emit(update);
              },
          }
        : progressRecorder;
    const snapshotForOutcome = (
        observedSha: string,
        reason: PipelineSnapshot["reason"],
    ): PipelineSnapshot => ({
        repository: "owner/repo",
        branch: "ralphie/issue-42",
        commitSha: observedSha,
        state: "non-empty",
        items: [],
        sourceErrors: [],
        completenessErrors: [],
        diagnostics: [],
        reason,
        greenCandidate: reason === "success",
        fingerprint: `${reason}-${observedSha}`,
    });
    const pipelineObservation: PipelineObservationService =
        options.pipelineObservationOverride ?? {
            observe: async (input) => {
                calls.push("observePrGate");
                if (options.observeAbortController !== undefined) {
                    options.observeAbortController.abort();
                }
                const observedSha =
                    input.request?.commitSha ?? "feature-head-sha";
                const outcomesList = options.pipelineObservationOutcomes ?? [
                    {
                        kind: "green",
                        observedSha,
                        snapshot: snapshotForOutcome(observedSha, "success"),
                        elapsedMs: 1_000,
                        polls: 2,
                    } satisfies PipelineObservationOutcome,
                ];
                const outcome =
                    outcomesList[Math.min(gateIndex, outcomesList.length - 1)]!;
                gateIndex += 1;
                return { outcome, transitions: [] };
            },
        };
    return {
        commandRunner: CommandRunnerLive,
        githubClient,
        pipelineSnapshot: {} as never,
        pipelineObservation,
        githubIssues,
        githubIssueMutations: mutations,
        githubIssueRelationships: {
            listSubIssues: async () => options.parentSubIssues ?? [],
            parentOf: async () => undefined,
            attachSubIssue: async () => {},
            listBlockedBy: async () => [],
            addBlockedBy: async () => {},
        },
        parentCompletion: makeParentCompletionService({
            issues: githubIssues,
            relationships: {
                listSubIssues: async () => options.parentSubIssues ?? [],
                parentOf: async () => undefined,
                attachSubIssue: async () => {},
                listBlockedBy: async () => [],
                addBlockedBy: async () => {},
            },
            mutations,
        }),
        githubPullRequests: pullRequests,
        githubNeedsAttentionNotification:
            options.needsAttentionNotification ?? {
                notify: async () => {
                    throw new Error("unused");
                },
            },
        gitRepository: repository,
        gitRepositoryInvariant: invariant,
        gitIssueCheckpoint: checkpoint,
        gitIssueOperations: operations,
        gitIssuePreparation: {} as never,
        gitRemoteSafety: {} as never,
        issueArtifactStore: artifactStore,
        complexityAssessment: {} as never,
        groundingAssessment: {} as never,
        resolutionVerification: {} as never,
        decompositionExecutor: {} as never,
        implementationExecutor: {} as never,
        dryRunIssueExecutor,
        issueExecutor,
        issueRecovery: {} as never,
        needsAttentionRouter: {} as never,
        pi,
        progress,
        runStateStore: stateStore,
        workspace,
    };
};

const baseOptions = {
    repo: "owner/repo",
    branch: "develop",
    maxIssues: 1,
    issueFilters: {
        labels: ["bug"],
        sort: IssueSort.Created,
        order: IssueOrder.Ascending,
    },
    agent: DEFAULT_PI_AGENT,
    workspace: "/tmp/ralphie",
    cleanup: false,
    startClean: false,
    runId: "test-run",
    onNeedsAttention: NeedsAttentionPolicy.Continue,
} as const;

describe("workflow", () => {
    test("executes an issue, persists completion, releases Pi, and cleans up", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        const events: ProgressUpdate[] = [];
        const summary = await workflow(
            {
                ...baseOptions,
                model: { providerID: "openai", modelID: "gpt-5" },
                modelVariant: "high",
                agent: "reviewer",
                maxDecompositionDepth: 6,
                cleanup: true,
                startClean: true,
            },
            testRuntime(calls, states, {}, events),
        );
        expect(summary.counts.completed).toBe(1);
        expect(states.at(-1)?.status).toBe(RunStateStatus.Complete);
        expect(states.at(-1)?.onNeedsAttention).toBe(
            NeedsAttentionPolicy.Continue,
        );
        expect(states.at(-1)?.maxDecompositionDepth).toBe(6);
        expect(states.at(-1)?.queue.completedIssueNumbers).toEqual([42]);
        expect(calls).toEqual([
            "removeWorkspace:/tmp/ralphie",
            "prepareWorkspace:/tmp/ralphie",
            "initializeGitHub",
            "verifyGitInstalled",
            "prepareRepository:owner/repo:develop:/tmp/ralphie",
            "listIssues:owner/repo:bug:created:asc",
            "startServer",
            "refreshIssue:42",
            "executeIssue:42:/tmp/ralphie/repo:develop:reviewer",
            "closeIssue:42",
            "closeRuntime",
            "removeWorkspace:/tmp/ralphie",
        ]);
        expect(events.some(({ stage }) => stage === "issue-execution")).toBe(
            true,
        );
    });

    test("keeps completed issue closure unchanged when notifications are enabled", async () => {
        const calls: string[] = [];
        let notified = false;
        const summary = await workflow(
            {
                ...baseOptions,
                notificationsEnabled: true,
            },
            testRuntime(calls, [], {
                needsAttentionNotification: {
                    notify: async () => {
                        notified = true;
                        return { comment: "created", label: "applied" };
                    },
                },
            }),
        );

        expect(summary.counts.completed).toBe(1);
        expect(notified).toBeFalse();
        expect(calls).toContain("closeIssue:42");
    });

    test("uses an issue branch and merged pull request without closing the issue directly", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        const contexts: IssueExecutionContext[] = [];
        const summary = await workflow(
            { ...baseOptions, workflow: WorkflowMode.Pr },
            testRuntime(calls, states, { executionContexts: contexts }),
        );
        expect(summary.counts.completed).toBe(1);
        expect(contexts[0]?.targetBranch).toBe("ralphie/issue-42");
        expect(calls).toContain(
            "prepareFeatureBranch:ralphie/issue-42:develop",
        );
        expect(calls).toContain("pushBranch:ralphie/issue-42");
        expect(calls).toContain(
            "createPullRequest:owner/repo:ralphie/issue-42:develop",
        );
        expect(calls).toContain("publishReviews:owner/repo:1");
        expect(calls).toContain("observePrGate");
        expect(calls).toContain("readPullRequest:owner/repo:1");
        expect(calls).toContain(
            "mergePullRequest:owner/repo:1:feature-head-sha",
        );
        expect(calls).toContain("restoreBase:develop");
        expect(calls).not.toContain("closeIssue:42");
        expect(
            states.filter((state) => state.prClosure !== undefined).at(-1)
                ?.prClosure,
        ).toMatchObject({
            pullRequestNumber: 1,
            observedHeadSha: "feature-head-sha",
            gate: "merged",
        });
    });

    test("keeps the feature branch and PR and persists an active gate when checks fail", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        await expect(
            workflow(
                { ...baseOptions, workflow: WorkflowMode.Pr },
                testRuntime(calls, states, {
                    pipelineObservationOutcomes: [
                        {
                            kind: "failed",
                            observedSha: "feature-head-sha",
                            reason: "failing",
                            message: "check failed",
                            snapshot: {
                                ...greenSnapshot("feature-head-sha"),
                                reason: "failure",
                                greenCandidate: false,
                                fingerprint: "failure-feature-head-sha",
                            },
                            elapsedMs: 500,
                            polls: 1,
                        } satisfies PipelineObservationOutcome,
                    ],
                }),
            ),
        ).rejects.toThrow("PR gate did not pass");
        expect(calls).toContain(
            "createPullRequest:owner/repo:ralphie/issue-42:develop",
        );
        expect(calls).toContain("publishReviews:owner/repo:1");
        expect(calls).toContain("observePrGate");
        expect(calls).not.toContain("mergePullRequest");
        expect(calls).not.toContain("closeIssue:42");
        expect(states.at(-1)?.status).toBe(RunStateStatus.Active);
        expect(states.at(-1)?.activeIssue).toEqual({
            issueNumber: 42,
            stage: "issue-closure",
        });
        expect(states.at(-1)?.prClosure).toMatchObject({
            pullRequestNumber: 1,
            observedHeadSha: "feature-head-sha",
            gate: "failed",
        });
        expect(states.at(-1)?.prClosure?.terminalReason).toContain("failing");
        expect(
            states.at(-1)?.queue.pending.map(({ number }) => number),
        ).toEqual([42]);
    });

    test.each([
        {
            name: "times out",
            outcome: {
                kind: "timeout",
                observedSha: "feature-head-sha",
                elapsedMs: 30_000,
                polls: 6,
            } satisfies PipelineObservationOutcome,
            gate: "timeout",
        },
        {
            name: "discovers no pipelines",
            outcome: {
                kind: "no-pipelines-discovered",
                observedSha: "feature-head-sha",
                elapsedMs: 30_000,
                polls: 6,
            } satisfies PipelineObservationOutcome,
            gate: "no-pipelines",
        },
        {
            name: "observes cancelled checks",
            outcome: {
                kind: "failed",
                observedSha: "feature-head-sha",
                reason: "cancelled",
                message: "cancelled",
                snapshot: greenSnapshot("feature-head-sha"),
                elapsedMs: 500,
                polls: 1,
            } satisfies PipelineObservationOutcome,
            gate: "cancelled",
        },
    ])(
        "does not merge or close when the PR gate $name",
        async ({ outcome, gate }) => {
            const calls: string[] = [];
            const states: RunState[] = [];
            await expect(
                workflow(
                    { ...baseOptions, workflow: WorkflowMode.Pr },
                    testRuntime(calls, states, {
                        pipelineObservationOutcomes: [outcome],
                    }),
                ),
            ).rejects.toThrow("PR gate did not pass");
            expect(calls).not.toContain("mergePullRequest");
            expect(calls).not.toContain("closeIssue:42");
            expect(states.at(-1)?.prClosure?.gate).toBe(gate);
            expect(states.at(-1)?.status).toBe(RunStateStatus.Active);
        },
    );

    test("resumes a failed PR gate by re-observing the existing PR and merging once checks pass", async () => {
        const failingOutcome = {
            kind: "failed",
            observedSha: "feature-head-sha",
            reason: "failing",
            message: "check failed",
            snapshot: greenSnapshot("feature-head-sha"),
            elapsedMs: 500,
            polls: 1,
        } satisfies PipelineObservationOutcome;
        const firstCalls: string[] = [];
        const firstStates: RunState[] = [];
        await expect(
            workflow(
                { ...baseOptions, workflow: WorkflowMode.Pr },
                testRuntime(firstCalls, firstStates, {
                    pipelineObservationOutcomes: [failingOutcome],
                }),
            ),
        ).rejects.toThrow("PR gate did not pass");
        const resumeState = firstStates.at(-1);
        if (resumeState === undefined) {
            throw new Error("Missing resumable state");
        }
        const calls: string[] = [];
        const states: RunState[] = [];
        const contexts: IssueExecutionContext[] = [];
        const summary = await workflow(
            { ...baseOptions, workflow: WorkflowMode.Pr, resumeState },
            testRuntime(calls, states, {
                issueLists: [[]],
                executionContexts: contexts,
                captureStart: 1,
            }),
        );
        expect(
            calls.some((call) => call.startsWith("executeIssue:")),
        ).toBeFalse();
        expect(calls).not.toContain(
            "createPullRequest:owner/repo:ralphie/issue-42:develop",
        );
        expect(calls).toContain("readPullRequest:owner/repo:1");
        expect(calls).toContain("observePrGate");
        expect(calls).toContain(
            "mergePullRequest:owner/repo:1:feature-head-sha",
        );
        expect(summary.counts.completed).toBe(1);
        expect(
            states.filter((state) => state.prClosure !== undefined).at(-1)
                ?.prClosure,
        ).toMatchObject({ gate: "merged" });
    });

    test("trusts a saved green gate only after confirming the same current head, then merges without re-observing", async () => {
        const resumeState: RunState = {
            version: 6,
            status: RunStateStatus.Active,
            runId: "green-gate-resume",
            repository: baseOptions.repo,
            branch: "develop",
            workflow: WorkflowMode.Pr,
            onNeedsAttention: NeedsAttentionPolicy.Continue,
            dryRun: false,
            notificationsEnabled: false,
            selection: { agent: DEFAULT_PI_AGENT },
            maxIssues: 1,
            queue: {
                pending: [{ ...firstIssue, labels: [...firstIssue.labels] }],
                completedIssueNumbers: [],
                processedCount: 0,
            },
            outcomes: [
                {
                    issueNumber: 42,
                    outcome: {
                        kind: IssueExecutionOutcomeKind.Completed,
                        completion: "pushed-commit",
                        commitSha: "abc123",
                    },
                },
            ],
            activeIssue: { issueNumber: 42, stage: "issue-closure" },
            prClosure: {
                pullRequestNumber: 1,
                observedHeadSha: "feature-head-sha",
                startedAt: "2026-08-28T00:00:00.000Z",
                updatedAt: "2026-08-28T00:00:00.000Z",
                gate: "green",
            },
            checkout: { branch: "develop", head: "head-0" },
            updatedAt: "2026-08-28T00:00:00.000Z",
        };
        const calls: string[] = [];
        const states: RunState[] = [];
        const summary = await workflow(
            { ...baseOptions, workflow: WorkflowMode.Pr, resumeState },
            testRuntime(calls, states, { issueLists: [[]] }),
        );
        expect(calls).not.toContain("observePrGate");
        expect(calls).toContain(
            "mergePullRequest:owner/repo:1:feature-head-sha",
        );
        expect(summary.counts.completed).toBe(1);
        expect(
            states.filter((state) => state.prClosure !== undefined).at(-1)
                ?.prClosure,
        ).toMatchObject({ gate: "merged" });
    });

    test("invalidates all prior evidence when a saved green gate no longer matches the PR head", async () => {
        const resumeState: RunState = {
            version: 6,
            status: RunStateStatus.Active,
            runId: "stale-gate-resume",
            repository: baseOptions.repo,
            branch: "develop",
            workflow: WorkflowMode.Pr,
            onNeedsAttention: NeedsAttentionPolicy.Continue,
            dryRun: false,
            notificationsEnabled: false,
            selection: { agent: DEFAULT_PI_AGENT },
            maxIssues: 1,
            queue: {
                pending: [{ ...firstIssue, labels: [...firstIssue.labels] }],
                completedIssueNumbers: [],
                processedCount: 0,
            },
            outcomes: [
                {
                    issueNumber: 42,
                    outcome: {
                        kind: IssueExecutionOutcomeKind.Completed,
                        completion: "pushed-commit",
                        commitSha: "abc123",
                    },
                },
            ],
            activeIssue: { issueNumber: 42, stage: "issue-closure" },
            prClosure: {
                pullRequestNumber: 1,
                observedHeadSha: "feature-head-sha",
                startedAt: "2026-08-28T00:00:00.000Z",
                updatedAt: "2026-08-28T00:00:00.000Z",
                gate: "green",
            },
            checkout: { branch: "develop", head: "head-0" },
            updatedAt: "2026-08-28T00:00:00.000Z",
        };
        const calls: string[] = [];
        const states: RunState[] = [];
        await expect(
            workflow(
                { ...baseOptions, workflow: WorkflowMode.Pr, resumeState },
                testRuntime(calls, states, {
                    issueLists: [[]],
                    prOverride: {
                        number: 1,
                        url: "https://github.com/owner/repo/pull/1",
                        merged: false,
                        headSha: "new-head-sha",
                        state: "open",
                    },
                    pipelineObservationOutcomes: [
                        {
                            kind: "failed",
                            observedSha: "new-head-sha",
                            reason: "failing",
                            message: "check failed",
                            snapshot: greenSnapshot("new-head-sha"),
                            elapsedMs: 500,
                            polls: 1,
                        } satisfies PipelineObservationOutcome,
                    ],
                }),
            ),
        ).rejects.toThrow("PR gate did not pass");
        expect(calls).not.toContain("mergePullRequest");
        expect(calls).not.toContain("closeIssue:42");
        expect(states.at(-1)?.prClosure).toMatchObject({
            observedHeadSha: "new-head-sha",
            gate: "failed",
        });
        expect(states.at(-1)?.status).toBe(RunStateStatus.Active);
    });

    test("reconciles an already-merged PR without publishing, observing, or merging again", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        const summary = await workflow(
            { ...baseOptions, workflow: WorkflowMode.Pr },
            testRuntime(calls, states, {
                prOverride: {
                    number: 1,
                    url: "https://github.com/owner/repo/pull/1",
                    merged: true,
                    headSha: "feature-head-sha",
                    state: "closed",
                },
            }),
        );
        expect(calls).not.toContain("observePrGate");
        expect(calls).not.toContain("publishReviews");
        expect(calls).not.toContain("mergePullRequest");
        expect(calls).not.toContain("closeIssue:42");
        expect(summary.counts.completed).toBe(1);
        expect(
            states.filter((state) => state.prClosure !== undefined).at(-1)
                ?.prClosure,
        ).toMatchObject({ gate: "merged" });
    });

    test("does not merge or close when the matching PR is closed without merging", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        await expect(
            workflow(
                { ...baseOptions, workflow: WorkflowMode.Pr },
                testRuntime(calls, states, {
                    prOverride: {
                        number: 1,
                        url: "https://github.com/owner/repo/pull/1",
                        merged: false,
                        headSha: "feature-head-sha",
                        state: "closed",
                    },
                }),
            ),
        ).rejects.toThrow("closed without merging");
        expect(calls).not.toContain("observePrGate");
        expect(calls).not.toContain("mergePullRequest");
        expect(calls).not.toContain("closeIssue:42");
        expect(states.at(-1)?.prClosure?.gate).toBe("closed");
        expect(states.at(-1)?.status).toBe(RunStateStatus.Active);
    });

    test("discards a green decision and halts when the PR head changes before the merge", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        await expect(
            workflow(
                { ...baseOptions, workflow: WorkflowMode.Pr },
                testRuntime(calls, states, {
                    prReadOverride: {
                        number: 1,
                        url: "https://github.com/owner/repo/pull/1",
                        merged: false,
                        headSha: "new-head-sha",
                        state: "open",
                    },
                }),
            ),
        ).rejects.toThrow("head changed");
        expect(calls).toContain("observePrGate");
        expect(calls).not.toContain("mergePullRequest");
        expect(calls).not.toContain("closeIssue:42");
        expect(states.at(-1)?.prClosure).toMatchObject({
            observedHeadSha: "new-head-sha",
            gate: "stale",
            terminalReason: expect.stringContaining("discarded"),
        });
        expect(states.at(-1)?.status).toBe(RunStateStatus.Active);
    });

    test("preserves cancellation exit behavior and records an aborted gate", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        const controller = new AbortController();
        await expect(
            workflow(
                {
                    ...baseOptions,
                    workflow: WorkflowMode.Pr,
                    signal: controller.signal,
                },
                testRuntime(calls, states, {
                    observeAbortController: controller,
                    pipelineObservationOutcomes: [
                        {
                            kind: "aborted",
                            observedSha: "feature-head-sha",
                            elapsedMs: 10,
                            polls: 1,
                        } satisfies PipelineObservationOutcome,
                    ],
                }),
            ),
        ).rejects.toThrow("Run cancelled");
        expect(calls).not.toContain("mergePullRequest");
        expect(calls).not.toContain("closeIssue:42");
        expect(states.at(-1)?.status).toBe(RunStateStatus.Active);
        expect(states.at(-1)?.prClosure?.gate).toBe("aborted");
    });

    test("emits pr-gate progress events with the PR number, head SHA, and reason when checks fail", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        const events: ProgressUpdate[] = [];
        await expect(
            workflow(
                { ...baseOptions, workflow: WorkflowMode.Pr },
                testRuntime(
                    calls,
                    states,
                    {
                        pipelineObservationOutcomes: [
                            {
                                kind: "failed",
                                observedSha: "feature-head-sha",
                                reason: "failing",
                                message: "check failed",
                                snapshot: {
                                    ...greenSnapshot("feature-head-sha"),
                                    reason: "failure",
                                    greenCandidate: false,
                                    fingerprint: "failure-feature-head-sha",
                                },
                                elapsedMs: 500,
                                polls: 1,
                            } satisfies PipelineObservationOutcome,
                        ],
                    },
                    events,
                ),
            ),
        ).rejects.toThrow("PR gate did not pass");
        const prGateEvents = events.filter(({ stage }) => stage === "pr-gate");
        expect(prGateEvents.map(({ status }) => status)).toEqual([
            "started",
            "failed",
        ]);
        const failed = prGateEvents.find(({ status }) => status === "failed");
        expect(failed?.message).toContain("PR #1");
        expect(failed?.message).toContain("feature-head-sha");
        expect(failed?.details).toMatchObject({
            pullRequestNumber: 1,
            observedHeadSha: "feature-head-sha",
            gate: "failed",
            elapsedMs: 500,
        });
        expect(calls).not.toContain("mergePullRequest");
    });

    test("does not merge before the fake check service reaches its stable green snapshot", async () => {
        const gateHeadSha = "f".repeat(40);
        const gateItem = (
            status: PipelineSnapshot["items"][number]["status"],
        ): PipelineSnapshot["items"][number] => ({
            source: "check-run",
            provider: "github-actions",
            name: "build",
            status,
            rawState: {},
            diagnostic: {
                source: "check-run",
                disposition: "selected",
                provider: "github-actions",
                name: "build",
                rawState: {},
                rawValues: {},
                errors: [],
            },
        });
        const gateSnapshot = (
            items: ReadonlyArray<PipelineSnapshot["items"][number]>,
            reason: PipelineSnapshot["reason"],
        ): PipelineSnapshot => ({
            repository: "owner/repo",
            branch: "ralphie/issue-42",
            commitSha: gateHeadSha,
            state: items.length === 0 ? "empty" : "non-empty",
            items,
            sourceErrors: [],
            completenessErrors: [],
            diagnostics: [],
            reason,
            greenCandidate: reason === "success",
            fingerprint: `${reason}-${gateHeadSha}-${items.length}`,
        });
        const scenario = [
            gateSnapshot([], "no-checks"),
            gateSnapshot([gateItem("pending")], "pending"),
            gateSnapshot([gateItem("passing")], "success"),
        ];
        const timeline: string[] = [];
        let fetchCount = 0;
        const fetchSnapshot: PipelineSnapshotFetcher = async () => {
            const snapshot =
                scenario[Math.min(fetchCount, scenario.length - 1)]!;
            fetchCount += 1;
            timeline.push(`fetch:${snapshot.reason}`);
            return { kind: "snapshot", snapshot };
        };
        const fakeCheckService = makePipelineObservationService({
            now: () => 0,
            sleep: async () => {},
        });
        const observedService: PipelineObservationService = {
            observe: async (input) => {
                if (!("request" in input) || input.request === undefined) {
                    throw new Error("expected coordinate observation input");
                }
                return fakeCheckService.observe({
                    client: input.client,
                    request: input.request,
                    options: input.options ?? input.settings,
                    signal: input.signal,
                    fetchSnapshot,
                    readHead: async () => gateHeadSha,
                    ...(input.onTransition === undefined
                        ? {}
                        : { onTransition: input.onTransition }),
                });
            },
        };

        const calls: string[] = [];
        const states: RunState[] = [];
        const events: ProgressUpdate[] = [];
        const summary = await workflow(
            { ...baseOptions, workflow: WorkflowMode.Pr },
            testRuntime(
                calls,
                states,
                {
                    prOverride: {
                        number: 1,
                        url: "https://github.com/owner/repo/pull/1",
                        merged: false,
                        headSha: gateHeadSha,
                        state: "open",
                    },
                    pipelineObservationOverride: observedService,
                    onMergeCall: () => timeline.push("merge"),
                },
                events,
            ),
        );
        expect(summary.counts.completed).toBe(1);
        // The fake GitHub check service records every poll and every merge;
        // the merge must come only after a stable green snapshot (two
        // consecutive identical success reads plus the final verification read).
        expect(timeline).toEqual([
            "fetch:no-checks",
            "fetch:pending",
            "fetch:success",
            "fetch:success",
            "fetch:success",
            "merge",
        ]);
        const mergeIndex = timeline.indexOf("merge");
        expect(
            timeline
                .slice(0, mergeIndex)
                .filter((entry) => entry === "fetch:success"),
        ).toHaveLength(3);
        expect(timeline.slice(0, mergeIndex)).not.toContain("merge");
        const prGateEvents = events.filter(({ stage }) => stage === "pr-gate");
        expect(prGateEvents.map(({ status }) => status)).toEqual([
            "started",
            "info",
            "info",
            "info",
            "succeeded",
            "succeeded",
        ]);
        expect(prGateEvents[1]?.message).toContain("waiting for registration");
        expect(prGateEvents[2]?.message).toContain("1 check registered");
        expect(prGateEvents[3]?.message).toContain("pending -> passing");
        const checksPassed = prGateEvents.find(
            (event) =>
                event.status === "succeeded" &&
                (event.message ?? "").includes("Checks passed"),
        );
        expect(checksPassed?.message).toContain("PR #1");
        expect(checksPassed?.message).toContain(gateHeadSha);
        expect(checksPassed?.message).toContain("success (passing)");
        expect(checksPassed?.details).toMatchObject({
            pullRequestNumber: 1,
            observedHeadSha: gateHeadSha,
            gate: "green",
            polls: 4,
        });
        expect(checksPassed?.details?.snapshot).toBeDefined();
        const merged = prGateEvents.find(
            (event) =>
                event.status === "succeeded" &&
                (event.message ?? "").includes("merged at head"),
        );
        expect(merged?.message).toContain("PR #1");
        expect(merged?.details).toMatchObject({
            pullRequestNumber: 1,
            gate: "merged",
        });
    });

    test("resumes a pending PR gate by continuing to poll and merging once checks pass", async () => {
        const resumeState: RunState = {
            version: 6,
            status: RunStateStatus.Active,
            runId: "pending-gate-resume",
            repository: baseOptions.repo,
            branch: "develop",
            workflow: WorkflowMode.Pr,
            onNeedsAttention: NeedsAttentionPolicy.Continue,
            dryRun: false,
            notificationsEnabled: false,
            selection: { agent: DEFAULT_PI_AGENT },
            maxIssues: 1,
            queue: {
                pending: [{ ...firstIssue, labels: [...firstIssue.labels] }],
                completedIssueNumbers: [],
                processedCount: 0,
            },
            outcomes: [
                {
                    issueNumber: 42,
                    outcome: {
                        kind: IssueExecutionOutcomeKind.Completed,
                        completion: "pushed-commit",
                        commitSha: "abc123",
                    },
                },
            ],
            activeIssue: { issueNumber: 42, stage: "issue-closure" },
            prClosure: {
                pullRequestNumber: 1,
                observedHeadSha: "feature-head-sha",
                startedAt: "2026-08-28T00:00:00.000Z",
                updatedAt: "2026-08-28T00:00:00.000Z",
                gate: "pending",
            },
            checkout: { branch: "develop", head: "head-0" },
            updatedAt: "2026-08-28T00:00:00.000Z",
        };
        const calls: string[] = [];
        const states: RunState[] = [];
        const summary = await workflow(
            { ...baseOptions, workflow: WorkflowMode.Pr, resumeState },
            testRuntime(calls, states, { issueLists: [[]] }),
        );
        expect(calls.some((call) => call.startsWith("executeIssue:"))).toBe(
            false,
        );
        expect(calls).not.toContain(
            "createPullRequest:owner/repo:ralphie/issue-42:develop",
        );
        expect(calls).toContain("observePrGate");
        expect(calls).toContain(
            "mergePullRequest:owner/repo:1:feature-head-sha",
        );
        expect(summary.counts.completed).toBe(1);
        expect(
            states.filter((state) => state.prClosure !== undefined).at(-1)
                ?.prClosure,
        ).toMatchObject({
            pullRequestNumber: 1,
            observedHeadSha: "feature-head-sha",
            gate: "merged",
        });
    });

    test("does not merge or close when the gate observes unknown checks", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        await expect(
            workflow(
                { ...baseOptions, workflow: WorkflowMode.Pr },
                testRuntime(calls, states, {
                    pipelineObservationOutcomes: [
                        {
                            kind: "failed",
                            observedSha: "feature-head-sha",
                            reason: "unknown",
                            message: "ambiguous checks",
                            snapshot: {
                                ...greenSnapshot("feature-head-sha"),
                                reason: "unknown",
                                greenCandidate: false,
                                fingerprint: "unknown-feature-head-sha",
                            },
                            elapsedMs: 500,
                            polls: 1,
                        } satisfies PipelineObservationOutcome,
                    ],
                }),
            ),
        ).rejects.toThrow("PR gate did not pass");
        expect(calls).not.toContain("mergePullRequest");
        expect(calls).not.toContain("closeIssue:42");
        expect(states.at(-1)?.prClosure?.gate).toBe("unknown");
        expect(states.at(-1)?.status).toBe(RunStateStatus.Active);
    });

    test("records a stale gate when the expected-head merge is rejected", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        const oldHead: GitHubPullRequest = {
            number: 1,
            url: "https://github.com/owner/repo/pull/1",
            merged: false,
            headSha: "feature-head-sha",
            state: "open",
        };
        const newHead: GitHubPullRequest = {
            ...oldHead,
            headSha: "new-head-sha",
        };
        await expect(
            workflow(
                { ...baseOptions, workflow: WorkflowMode.Pr },
                testRuntime(calls, states, {
                    prReadSequence: [oldHead, newHead],
                    mergePullRequestFailure: new RalphieError({
                        message:
                            "Pull request #1 head changed from feature-head-sha to new-head-sha.",
                    }),
                }),
            ),
        ).rejects.toThrow("Failed to merge");
        expect(calls).toContain(
            "mergePullRequest:owner/repo:1:feature-head-sha",
        );
        expect(calls).not.toContain("closeIssue:42");
        expect(states.at(-1)?.prClosure).toMatchObject({
            pullRequestNumber: 1,
            observedHeadSha: "new-head-sha",
            gate: "stale",
            terminalReason: expect.stringContaining("head changed"),
        });
        expect(states.at(-1)?.status).toBe(RunStateStatus.Active);
    });

    test("dry-run assesses through the queue without invoking mutation execution", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        const events: ProgressUpdate[] = [];
        const summary = await workflow(
            { ...baseOptions, dryRun: true },
            testRuntime(calls, states, {}, events),
        );
        expect(summary.outcomes).toEqual([
            {
                issueNumber: 42,
                outcome: {
                    kind: IssueExecutionOutcomeKind.Skipped,
                    route: "implementation",
                    reason: "dry run",
                },
            },
        ]);
        expect(calls).toContain("dryRunIssue:42");
        expect(calls).not.toContain(
            "executeIssue:42:/tmp/ralphie/repo:develop:build",
        );
        expect(states.at(-1)?.status).toBe(RunStateStatus.Complete);
        expect(events).toContainEqual(
            expect.objectContaining({
                stage: "run",
                status: "succeeded",
                details: expect.objectContaining({
                    routes: [{ issueNumber: 42, route: "implementation" }],
                }),
            }),
        );
    });

    test("keeps a resumed dry run on the dry-run executor", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        const summary = await workflow(
            {
                ...baseOptions,
                dryRun: false,
                resumeState: {
                    version: 4,
                    status: RunStateStatus.Active,
                    runId: "resumed-dry-run",
                    repository: baseOptions.repo,
                    branch: "develop",
                    workflow: WorkflowMode.Lgtm,
                    onNeedsAttention: NeedsAttentionPolicy.Continue,
                    dryRun: true,
                    selection: { agent: DEFAULT_PI_AGENT },
                    maxIssues: 1,
                    queue: {
                        pending: [
                            { ...firstIssue, labels: [...firstIssue.labels] },
                        ],
                        completedIssueNumbers: [],
                        processedCount: 0,
                    },
                    outcomes: [],
                    checkout: { branch: "develop", head: "head-0" },
                    updatedAt: "2026-08-28T00:00:00.000Z",
                },
            },
            testRuntime(calls, states),
        );

        expect(summary.counts.skipped).toBe(1);
        expect(calls).toContain("dryRunIssue:42");
        expect(calls).not.toContain(
            "executeIssue:42:/tmp/ralphie/repo:develop:build",
        );
    });

    test("defers an issue needing attention and continues with the queue", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        const events: ProgressUpdate[] = [];
        const summary = await workflow(
            { ...baseOptions, maxIssues: 2 },
            testRuntime(
                calls,
                states,
                {
                    issueLists: [[firstIssue, secondIssue]],
                    outcomes: [
                        {
                            kind: IssueExecutionOutcomeKind.NeedsAttention,
                            reason: NeedsAttentionReason.ExternalDependency,
                            summary: "A prerequisite is still open.",
                            evidence: ["Issue body links the prerequisite."],
                            questions: [
                                "Complete the prerequisite, then retry.",
                            ],
                            artifactPath: "/tmp/needs-attention.json",
                        },
                        {
                            kind: IssueExecutionOutcomeKind.Completed,
                            completion: "pushed-commit",
                            commitSha: "second-sha",
                        },
                    ],
                },
                events,
            ),
        );

        expect(summary.outcomes.map(({ issueNumber }) => issueNumber)).toEqual([
            42, 43,
        ]);
        expect(events[0]).toMatchObject({
            stage: "run",
            status: "info",
            details: {
                policy: NeedsAttentionPolicy.Continue,
                onNeedsAttention: NeedsAttentionPolicy.Continue,
                budget: 2,
            },
        });
        const needsAttention = events.find(
            ({ status }) => status === "needs-attention",
        );
        expect(needsAttention).toMatchObject({
            stage: "grounding",
            current: 1,
            total: 2,
            details: {
                reason: NeedsAttentionReason.ExternalDependency,
                summary: "A prerequisite is still open.",
                evidence: ["Issue body links the prerequisite."],
                questions: ["Complete the prerequisite, then retry."],
                artifactPath: "/tmp/needs-attention.json",
                policy: NeedsAttentionPolicy.Continue,
                queuePosition: 1,
                budget: 2,
            },
        });
        expect(summary.counts[IssueExecutionOutcomeKind.NeedsAttention]).toBe(
            1,
        );
        expect(states.at(-1)?.queue.completedIssueNumbers).toEqual([43]);
        expect(calls).not.toContain("closeIssue:42");
        expect(calls).toContain("closeIssue:43");
    });

    test("continues after the decomposition ceiling even when needs-attention defaults to halt", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        const summary = await workflow(
            {
                ...baseOptions,
                maxIssues: 2,
                onNeedsAttention: NeedsAttentionPolicy.Halt,
            },
            testRuntime(calls, states, {
                issueLists: [[firstIssue, secondIssue]],
                outcomes: [
                    {
                        kind: IssueExecutionOutcomeKind.NeedsAttention,
                        reason: NeedsAttentionReason.DecompositionLimitReached,
                        summary: "Maximum decomposition depth reached.",
                        evidence: [
                            "The next depth exceeds the configured maximum.",
                        ],
                        questions: [
                            "Increase the maximum or narrow the issue.",
                        ],
                        route: "needs-attention",
                        policy: NeedsAttentionPolicy.Continue,
                    },
                    {
                        kind: IssueExecutionOutcomeKind.Completed,
                        completion: "pushed-commit",
                        commitSha: "second-sha",
                    },
                ],
            }),
        );

        expect(summary.outcomes.map(({ issueNumber }) => issueNumber)).toEqual([
            42, 43,
        ]);
        expect(summary.counts[IssueExecutionOutcomeKind.NeedsAttention]).toBe(
            1,
        );
        expect(calls).toContain("closeIssue:43");
        expect(states.at(-1)?.status).toBe(RunStateStatus.Complete);
    });

    test("halts with a handled stop without reporting an ordinary failure", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        const events: ProgressUpdate[] = [];
        await expect(
            workflow(
                {
                    ...baseOptions,
                    onNeedsAttention: NeedsAttentionPolicy.Halt,
                },
                testRuntime(
                    calls,
                    states,
                    {
                        outcomes: [
                            {
                                kind: IssueExecutionOutcomeKind.NeedsAttention,
                                reason: NeedsAttentionReason.ExternalDependency,
                                summary: "A prerequisite is still open.",
                                evidence: ["The prerequisite is unresolved."],
                                questions: ["When will it be available?"],
                                artifactPath: "/tmp/needs-attention.json",
                            },
                        ],
                    },
                    events,
                ),
            ),
        ).rejects.toMatchObject({ _tag: "NeedsAttentionStop" });
        expect(states.at(-1)?.status).toBe(RunStateStatus.Active);
        expect(states.at(-1)?.onNeedsAttention).toBe(NeedsAttentionPolicy.Halt);
        expect(states.at(-1)?.activeIssue?.issueNumber).toBe(42);
        expect(events.some(({ status }) => status === "failed")).toBe(false);
        expect(events).toContainEqual(
            expect.objectContaining({
                stage: "grounding",
                status: "needs-attention",
                details: expect.objectContaining({
                    reason: NeedsAttentionReason.ExternalDependency,
                    summary: "A prerequisite is still open.",
                    evidence: ["The prerequisite is unresolved."],
                    questions: ["When will it be available?"],
                    artifactPath: "/tmp/needs-attention.json",
                    policy: NeedsAttentionPolicy.Halt,
                }),
            }),
        );
        expect(events).toContainEqual(
            expect.objectContaining({
                stage: "run",
                status: "needs-attention",
                message: expect.stringContaining("needs-attention"),
                details: expect.objectContaining({
                    handled: true,
                    policy: NeedsAttentionPolicy.Halt,
                    counts: {
                        completed: 0,
                        decomposed: 0,
                        escalated: 0,
                        "needs-attention": 1,
                        skipped: 0,
                        failed: 0,
                    },
                }),
            }),
        );
        expect(calls).not.toContain("closeIssue:42");
    });

    test("persists the needs-attention outcome before notification and clears the intent after success", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        const saveSequence: string[] = [];
        let received:
            | {
                  readonly repository: string;
                  readonly issueNumber: number;
                  readonly reason: NeedsAttentionReason;
                  readonly labelName?: string;
              }
            | undefined;
        const notification: GitHubNeedsAttentionNotificationService = {
            notify: async (
                _client,
                repository,
                issueNumber,
                input,
                labelName,
            ) => {
                saveSequence.push("notify");
                received = {
                    repository,
                    issueNumber,
                    reason: input.reason,
                    ...(labelName === undefined ? {} : { labelName }),
                };
                return { comment: "created", label: "applied" };
            },
        };
        await workflow(
            {
                ...baseOptions,
                notificationsEnabled: true,
                needsAttentionLabel: "needs-attention",
            },
            testRuntime(calls, states, {
                needsAttentionNotification: notification,
                outcomes: [
                    {
                        kind: IssueExecutionOutcomeKind.NeedsAttention,
                        reason: NeedsAttentionReason.ExternalDependency,
                        summary: "A prerequisite is still open.",
                        evidence: ["The prerequisite is unresolved."],
                        questions: ["When will it be available?"],
                        artifactPath: "/tmp/needs-attention.json",
                    },
                ],
                onStateSave: (state) =>
                    saveSequence.push(
                        state.pendingNotification === undefined
                            ? "save"
                            : "save-pending",
                    ),
            }),
        );

        expect(received).toEqual({
            repository: "owner/repo",
            issueNumber: 42,
            reason: NeedsAttentionReason.ExternalDependency,
            labelName: "needs-attention",
        });
        expect(saveSequence.indexOf("save-pending")).toBeGreaterThanOrEqual(0);
        expect(saveSequence.indexOf("notify")).toBeGreaterThan(
            saveSequence.indexOf("save-pending"),
        );
        expect(
            states.some(({ pendingNotification }) => pendingNotification),
        ).toBeTrue();
        expect(states.at(-1)?.pendingNotification).toBeUndefined();
        expect(states.at(-1)?.outcomes[0]?.outcome.kind).toBe(
            IssueExecutionOutcomeKind.NeedsAttention,
        );
    });

    test("retains a halted open issue after a successful notification", async () => {
        const states: RunState[] = [];
        const notification: GitHubNeedsAttentionNotificationService = {
            notify: async () => ({
                comment: "created",
                label: "not-configured",
            }),
        };

        await expect(
            workflow(
                {
                    ...baseOptions,
                    onNeedsAttention: NeedsAttentionPolicy.Halt,
                    notificationsEnabled: true,
                },
                testRuntime([], states, {
                    needsAttentionNotification: notification,
                    outcomes: [
                        {
                            kind: IssueExecutionOutcomeKind.NeedsAttention,
                            reason: NeedsAttentionReason.ExternalDependency,
                            summary: "A prerequisite is still open.",
                            evidence: ["The prerequisite is unresolved."],
                            questions: ["When will it be available?"],
                            artifactPath: "/tmp/needs-attention.json",
                        },
                    ],
                }),
            ),
        ).rejects.toMatchObject({ _tag: "NeedsAttentionStop" });

        const state = states.at(-1);
        if (state === undefined) throw new Error("Missing halted state");
        expect(state.pendingNotification).toBeUndefined();
        expect(state.queue.pending.map(({ number }) => number)).toContain(42);
        expect(state.queue.completedIssueNumbers).not.toContain(42);
        expect(state.activeIssue).toEqual({
            issueNumber: 42,
            stage: "grounding",
        });
    });

    test("keeps notification recovery distinct and retries the saved outcome without Pi work", async () => {
        const firstStates: RunState[] = [];
        let attempts = 0;
        const notification: GitHubNeedsAttentionNotificationService = {
            notify: async () => {
                attempts += 1;
                if (attempts === 1) throw new Error("GitHub unavailable");
                return { comment: "unchanged", label: "not-configured" };
            },
        };
        const outcome: IssueExecutionOutcome = {
            kind: IssueExecutionOutcomeKind.NeedsAttention,
            reason: NeedsAttentionReason.ExternalDependency,
            summary: "A prerequisite is still open.",
            evidence: ["The prerequisite is unresolved."],
            questions: ["When will it be available?"],
            artifactPath: "/tmp/needs-attention.json",
        };
        await expect(
            workflow(
                {
                    ...baseOptions,
                    notificationsEnabled: true,
                },
                testRuntime([], firstStates, {
                    needsAttentionNotification: notification,
                    outcomes: [outcome],
                }),
            ),
        ).rejects.toMatchObject({
            _tag: "NeedsAttentionNotificationRecoveryBoundaryError",
        });

        const failedState = firstStates.at(-1);
        if (failedState === undefined)
            throw new Error("Missing pending notification state");
        expect(
            failedState.outcomes.find(({ issueNumber }) => issueNumber === 42)
                ?.outcome,
        ).toEqual(failedState.pendingNotification?.outcome);

        const resumedStates: RunState[] = [];
        const resumedCalls: string[] = [];
        const summary = await workflow(
            {
                ...baseOptions,
                resumeState: failedState,
            },
            testRuntime(resumedCalls, resumedStates, {
                needsAttentionNotification: notification,
                outcomes: [outcome],
                captureStart: 1,
            }),
        );
        expect(summary.counts[IssueExecutionOutcomeKind.NeedsAttention]).toBe(
            1,
        );
        expect(attempts).toBe(2);
        expect(
            resumedCalls.some((call) => call.startsWith("executeIssue:")),
        ).toBeFalse();
        expect(resumedStates.at(-1)?.status).toBe(RunStateStatus.Complete);
        expect(resumedStates.at(-1)?.pendingNotification).toBeUndefined();
    });

    test("fails closed when a disabled resumed run contains pending notification intent", async () => {
        const calls: string[] = [];
        let notified = false;
        const outcome = {
            kind: IssueExecutionOutcomeKind.NeedsAttention as const,
            reason: NeedsAttentionReason.ExternalDependency,
            summary: "A prerequisite is still open.",
            evidence: ["The prerequisite is unresolved."],
            questions: ["When will it be available?"],
            artifactPath: "/tmp/needs-attention.json",
        };
        const state: RunState = {
            version: 5,
            status: RunStateStatus.Active,
            runId: "disabled-notification-resume",
            repository: baseOptions.repo,
            branch: "develop",
            workflow: WorkflowMode.Lgtm,
            onNeedsAttention: NeedsAttentionPolicy.Continue,
            dryRun: false,
            notificationsEnabled: false,
            selection: { agent: DEFAULT_PI_AGENT },
            maxIssues: 1,
            queue: {
                pending: [{ ...firstIssue, labels: [...firstIssue.labels] }],
                completedIssueNumbers: [],
                processedCount: 0,
            },
            outcomes: [{ issueNumber: 42, outcome }],
            activeIssue: { issueNumber: 42, stage: "notification-recovery" },
            pendingNotification: { issueNumber: 42, outcome },
            checkout: { branch: "develop", head: "head-0" },
            updatedAt: "2026-08-28T00:00:00.000Z",
        };
        const notification: GitHubNeedsAttentionNotificationService = {
            notify: async () => {
                notified = true;
                return { comment: "created", label: "applied" };
            },
        };

        await expect(
            workflow(
                { ...baseOptions, resumeState: state },
                testRuntime(calls, [], {
                    needsAttentionNotification: notification,
                }),
            ),
        ).rejects.toMatchObject({
            _tag: "NeedsAttentionNotificationRecoveryBoundaryError",
        });
        expect(notified).toBeFalse();
        expect(calls).not.toContain("startServer");
    });

    test("does not notify when needs-attention notifications are disabled", async () => {
        const states: RunState[] = [];
        let notified = false;
        const notification: GitHubNeedsAttentionNotificationService = {
            notify: async () => {
                notified = true;
                return { comment: "created", label: "not-configured" };
            },
        };
        await workflow(
            { ...baseOptions, notificationsEnabled: false },
            testRuntime([], states, {
                needsAttentionNotification: notification,
                outcomes: [
                    {
                        kind: IssueExecutionOutcomeKind.NeedsAttention,
                        reason: NeedsAttentionReason.ExternalDependency,
                        summary: "A prerequisite is still open.",
                        evidence: ["The prerequisite is unresolved."],
                        questions: ["When will it be available?"],
                        artifactPath: "/tmp/needs-attention.json",
                    },
                ],
            }),
        );
        expect(notified).toBeFalse();
        expect(states.at(-1)?.pendingNotification).toBeUndefined();
    });

    test("does not notify during a dry run", async () => {
        let notified = false;
        const notification: GitHubNeedsAttentionNotificationService = {
            notify: async () => {
                notified = true;
                return { comment: "created", label: "not-configured" };
            },
        };
        await workflow(
            {
                ...baseOptions,
                dryRun: true,
                notificationsEnabled: true,
            },
            testRuntime([], [], {
                needsAttentionNotification: notification,
                dryRunOutcome: {
                    kind: IssueExecutionOutcomeKind.NeedsAttention,
                    reason: NeedsAttentionReason.ExternalDependency,
                    summary: "A prerequisite is still open.",
                    evidence: ["The prerequisite is unresolved."],
                    questions: ["When will it be available?"],
                    route: "needs-attention",
                },
            }),
        );
        expect(notified).toBeFalse();
    });

    test("does not deliver a PR branch for a needs-attention outcome", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        await workflow(
            {
                ...baseOptions,
                workflow: WorkflowMode.Pr,
                onNeedsAttention: NeedsAttentionPolicy.Continue,
            },
            testRuntime(calls, states, {
                outcomes: [
                    {
                        kind: IssueExecutionOutcomeKind.NeedsAttention,
                        reason: NeedsAttentionReason.ExternalDependency,
                        summary: "A prerequisite is still open.",
                        evidence: ["The prerequisite is unresolved."],
                        questions: ["When will it be available?"],
                        artifactPath: "/tmp/needs-attention.json",
                    },
                ],
            }),
        );
        expect(calls).not.toContain("pushBranch:ralphie/issue-42");
        expect(calls).not.toContain("createPullRequest:owner/repo");
        expect(calls).not.toContain("mergePullRequest:owner/repo:1");
        expect(calls).not.toContain("closeIssue:42");
        expect(states.at(-1)?.queue.processedCount).toBe(1);
    });

    test("refreshes issue freshness metadata before active resume", async () => {
        const initialIssue = {
            ...firstIssue,
            updatedAt: "2026-08-28T00:00:00.000Z",
            commentCount: 1,
            commentVersion: "2026-08-28T00:00:00.000Z",
        };
        const needsAttention: IssueExecutionOutcome = {
            kind: IssueExecutionOutcomeKind.NeedsAttention,
            reason: NeedsAttentionReason.ExternalDependency,
            summary: "A prerequisite is still open.",
            evidence: ["The prerequisite is unresolved."],
            questions: ["When will it be available?"],
            artifactPath: "/tmp/needs-attention.json",
        };
        const firstCalls: string[] = [];
        const firstStates: RunState[] = [];
        await expect(
            workflow(
                { ...baseOptions, onNeedsAttention: NeedsAttentionPolicy.Halt },
                testRuntime(firstCalls, firstStates, {
                    issueLists: [[initialIssue]],
                    outcomes: [needsAttention],
                }),
            ),
        ).rejects.toMatchObject({ _tag: "NeedsAttentionStop" });
        const resumeState = firstStates.at(-1);
        if (resumeState === undefined)
            throw new Error("Missing resumable state");

        const currentIssue = {
            ...initialIssue,
            updatedAt: "2026-08-29T00:00:00.000Z",
            commentCount: 2,
            commentVersion: "2026-08-29T00:00:00.000Z",
        };
        const contexts: IssueExecutionContext[] = [];
        await expect(
            workflow(
                {
                    ...baseOptions,
                    onNeedsAttention: NeedsAttentionPolicy.Halt,
                    resumeState,
                },
                testRuntime([], [], {
                    issueLists: [[currentIssue]],
                    outcomes: [needsAttention],
                    executionContexts: contexts,
                    captureStart: 1,
                }),
            ),
        ).rejects.toMatchObject({ _tag: "NeedsAttentionStop" });

        expect(contexts[0]?.issue).toEqual(currentIssue);
    });

    test("refreshes the selected issue before branch preparation and execution", async () => {
        const calls: string[] = [];
        const refreshedIssue = {
            ...firstIssue,
            body: "Current issue body",
            updatedAt: "2026-08-29T00:00:00.000Z",
            commentCount: 2,
            commentVersion: "2026-08-29T00:00:00.000Z",
        };
        const contexts: IssueExecutionContext[] = [];

        await workflow(
            { ...baseOptions, workflow: WorkflowMode.Pr },
            testRuntime(calls, [], {
                refreshedIssues: { 42: refreshedIssue },
                executionContexts: contexts,
            }),
        );

        expect(contexts[0]?.issue).toEqual(refreshedIssue);
        expect(calls.indexOf("refreshIssue:42")).toBeLessThan(
            calls.indexOf("prepareFeatureBranch:ralphie/issue-42:develop"),
        );
        expect(calls.indexOf("refreshIssue:42")).toBeLessThan(
            calls.findIndex((call) => call.startsWith("executeIssue:42:")),
        );
    });

    test.each([
        {
            kind: IssueExecutionOutcomeKind.Completed,
            completion: "pushed-commit",
            commitSha: "abc",
        },
        {
            kind: IssueExecutionOutcomeKind.Completed,
            completion: "already-resolved",
            resolutionSummary: "The checkout already satisfies the issue.",
            evidence: ["targeted validation passed"],
        },
        { kind: IssueExecutionOutcomeKind.Decomposed, childIssueNumbers: [51] },
        {
            kind: IssueExecutionOutcomeKind.Escalated,
            diagnosticsPath: "/tmp/diagnostics.json",
            reason: "review budget exhausted",
            childIssueNumbers: [52],
        },
        { kind: IssueExecutionOutcomeKind.Skipped, reason: "no changes" },
    ] satisfies ReadonlyArray<IssueExecutionOutcome>)(
        "records the executor outcome",
        async (outcome) => {
            const calls: string[] = [];
            const states: RunState[] = [];
            const summary = await workflow(
                baseOptions,
                testRuntime(calls, states, { outcomes: [outcome] }),
            );
            expect(summary.outcomes).toEqual([{ issueNumber: 42, outcome }]);
            expect(summary.counts[outcome.kind]).toBe(1);
            expect(states.at(-1)?.status).toBe(RunStateStatus.Complete);
            if (
                outcome.kind === IssueExecutionOutcomeKind.Decomposed ||
                outcome.kind === IssueExecutionOutcomeKind.Escalated
            ) {
                expect(
                    calls.filter((call) => call.startsWith("listIssues:")),
                ).toHaveLength(2);
            }
        },
    );

    test("halts, persists the active issue, and releases Pi on failure", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        await expect(
            workflow(
                baseOptions,
                testRuntime(calls, states, {
                    outcomes: [
                        {
                            kind: IssueExecutionOutcomeKind.Failed,
                            message: "boom",
                        },
                    ],
                }),
            ),
        ).rejects.toThrow("Issue #42 failed");
        expect(states.at(-1)?.status).toBe(RunStateStatus.Active);
        expect(states.at(-1)?.activeIssue?.issueNumber).toBe(42);
        expect(
            states.at(-1)?.queue.pending.map(({ number }) => number),
        ).toEqual([42]);
        expect(states.at(-1)?.queue.processedCount).toBe(0);
        expect(calls.at(-1)).toBe("closeRuntime");
    });

    test("continues independent issues after failure and reports partial failure after draining", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        await expect(
            workflow(
                {
                    ...baseOptions,
                    maxIssues: 2,
                    issueFailurePolicy: IssueFailurePolicy.Continue,
                },
                testRuntime(calls, states, {
                    issueLists: [[firstIssue, secondIssue]],
                    outcomes: [
                        {
                            kind: IssueExecutionOutcomeKind.Failed,
                            message: "boom",
                        },
                        {
                            kind: IssueExecutionOutcomeKind.Completed,
                            completion: "pushed-commit",
                            commitSha: "second-commit",
                        },
                    ],
                }),
            ),
        ).rejects.toThrow("Run drained with issue failures");
        expect(
            calls.filter((call) => call.startsWith("executeIssue:")),
        ).toHaveLength(2);
        expect(states.at(-1)?.status).toBe(RunStateStatus.Complete);
        expect(calls).toContain("restoreCheckout");
    });

    test("closes Pi if ready progress reporting fails after startup", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        await expect(
            workflow(
                baseOptions,
                testRuntime(calls, states, {
                    failPiReadyProgress: true,
                }),
            ),
        ).rejects.toThrow("Pi ready progress emission failed");
        expect(calls).toContain("closeRuntime");
    });

    test("persists a recoverable closure stage when GitHub closure fails", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        await expect(
            workflow(
                baseOptions,
                testRuntime(calls, states, {
                    closeFailure: new RalphieError({
                        message: "close response lost",
                    }),
                }),
            ),
        ).rejects.toThrow("close response lost");
        expect(calls).toContain("closeIssue:42");
        expect(states.at(-1)?.activeIssue).toEqual({
            issueNumber: 42,
            stage: "issue-closure",
        });
        expect(
            states.at(-1)?.queue.pending.map(({ number }) => number),
        ).toEqual([42]);
        expect(states.at(-1)?.checkout).toEqual({
            branch: "develop",
            head: "head-1",
        });
        expect(states.at(-1)?.outcomes).toHaveLength(1);
    });

    test("resumes an interrupted closure without rerunning implementation", async () => {
        const failedStates: RunState[] = [];
        await expect(
            workflow(
                baseOptions,
                testRuntime([], failedStates, {
                    closeFailure: new RalphieError({
                        message: "close response lost",
                    }),
                }),
            ),
        ).rejects.toThrow();
        const resumeState = failedStates.at(-1);
        if (!resumeState) throw new Error("Missing resumable state");
        const calls: string[] = [];
        const resumedStates: RunState[] = [];
        const summary = await workflow(
            {
                ...baseOptions,
                onNeedsAttention: NeedsAttentionPolicy.Halt,
                resumeState,
            },
            testRuntime(calls, resumedStates, {
                issueLists: [[]],
                captureStart: 1,
            }),
        );
        expect(calls).toContain("closeIssue:42");
        expect(calls.some((call) => call.startsWith("executeIssue:"))).toBe(
            false,
        );
        expect(summary.counts.completed).toBe(1);
        expect(resumedStates.at(-1)?.status).toBe(RunStateStatus.Complete);
        expect(resumedStates.at(-1)?.onNeedsAttention).toBe(
            NeedsAttentionPolicy.Continue,
        );
    });

    test("refreshes the queue after decomposition and runs a new child within budget", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        const child = { ...firstIssue, number: 51, title: "Child" };
        const summary = await workflow(
            { ...baseOptions, maxIssues: 2 },
            testRuntime(calls, states, {
                issueLists: [[firstIssue], [child]],
                outcomes: [
                    {
                        kind: IssueExecutionOutcomeKind.Decomposed,
                        childIssueNumbers: [51],
                    },
                    {
                        kind: IssueExecutionOutcomeKind.Completed,
                        completion: "pushed-commit",
                        commitSha: "child-sha",
                    },
                ],
            }),
        );
        expect(summary.outcomes.map(({ issueNumber }) => issueNumber)).toEqual([
            42, 51,
        ]);
        expect(states.at(-1)?.queue.processedCount).toBe(2);
    });

    test("stops before other work when start-clean fails", async () => {
        const calls: string[] = [];
        await expect(
            workflow(
                { ...baseOptions, startClean: true },
                testRuntime(calls, [], {
                    removeFailure: new RalphieError({
                        message: "cleanup failed",
                    }),
                }),
            ),
        ).rejects.toThrow("cleanup failed");
        expect(calls).toEqual(["removeWorkspace:/tmp/ralphie"]);
    });

    test("stops when preflight authentication fails", async () => {
        const calls: string[] = [];
        await expect(
            workflow(
                baseOptions,
                testRuntime(calls, [], {
                    githubFailure: new RalphieError({
                        message: "not logged in",
                    }),
                }),
            ),
        ).rejects.toThrow("not logged in");
        expect(calls).toEqual([
            "prepareWorkspace:/tmp/ralphie",
            "initializeGitHub",
        ]);
    });

    test.each([
        ["github", ["prepareWorkspace:/tmp/ralphie", "initializeGitHub"]],
        [
            "repository",
            [
                "prepareWorkspace:/tmp/ralphie",
                "initializeGitHub",
                "verifyGitInstalled",
                "prepareRepository:owner/repo:develop:/tmp/ralphie",
            ],
        ],
        [
            "issues",
            [
                "prepareWorkspace:/tmp/ralphie",
                "initializeGitHub",
                "verifyGitInstalled",
                "prepareRepository:owner/repo:develop:/tmp/ralphie",
                "listIssues:owner/repo:bug:created:asc",
            ],
        ],
    ] as const)(
        "cancels after %s without starting later work",
        async (stage, expectedCalls) => {
            const calls: string[] = [];
            const states: RunState[] = [];
            const controller = new AbortController();
            await expect(
                workflow(
                    {
                        ...baseOptions,
                        cleanup: true,
                        signal: controller.signal,
                    },
                    testRuntime(calls, states, {
                        abortAt: stage,
                        abortController: controller,
                    }),
                ),
            ).rejects.toThrow("Run cancelled");
            expect(calls).toEqual([...expectedCalls]);
            expect(calls).not.toContain("startServer");
            expect(calls).not.toContain("removeWorkspace:/tmp/ralphie");
            expect(states).toHaveLength(0);
        },
    );

    test("cancels after Pi starts, closes the server, and saves active state", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        const controller = new AbortController();
        await expect(
            workflow(
                { ...baseOptions, cleanup: true, signal: controller.signal },
                testRuntime(calls, states, {
                    abortAt: "pi",
                    abortController: controller,
                }),
            ),
        ).rejects.toThrow("Run cancelled");
        expect(calls).toContain("startServer");
        expect(calls).toContain("closeRuntime");
        expect(calls).not.toContain(
            "executeIssue:42:/tmp/ralphie/repo:develop:build",
        );
        expect(calls).not.toContain("removeWorkspace:/tmp/ralphie");
        expect(states.at(-1)?.status).toBe(RunStateStatus.Active);
    });

    test("cancels between issues, closes the server, saves state, and does not start the next issue", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        const controller = new AbortController();
        const child = { ...firstIssue, number: 51, title: "Child" };
        await expect(
            workflow(
                {
                    ...baseOptions,
                    maxIssues: 2,
                    cleanup: true,
                    signal: controller.signal,
                },
                testRuntime(calls, states, {
                    issueLists: [[firstIssue, child]],
                    abortAt: "between",
                    abortController: controller,
                }),
            ),
        ).rejects.toThrow("Run cancelled");
        expect(
            calls.filter((call) => call.startsWith("executeIssue:")),
        ).toEqual(["executeIssue:42:/tmp/ralphie/repo:develop:build"]);
        expect(calls).toContain("closeRuntime");
        expect(calls).not.toContain(
            "executeIssue:51:/tmp/ralphie/repo:develop:build",
        );
        expect(states.at(-1)?.status).toBe(RunStateStatus.Active);
        expect(
            states.at(-1)?.queue.pending.map(({ number }) => number),
        ).toEqual([51]);
    });

    test("restores the active checkout and saves resumable state on cancellation", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        const controller = new AbortController();
        await expect(
            workflow(
                { ...baseOptions, cleanup: true, signal: controller.signal },
                testRuntime(calls, states, { abortOnExecute: controller }),
            ),
        ).rejects.toThrow("Run cancelled");
        expect(states.at(-1)?.status).toBe(RunStateStatus.Active);
        expect(states.at(-1)?.activeIssue?.issueNumber).toBe(42);
        expect(calls).toContain("restoreCheckout");
        expect(calls).not.toContain("removeWorkspace:/tmp/ralphie");
    });

    test("fails before side effects when already cancelled", async () => {
        const calls: string[] = [];
        const controller = new AbortController();
        controller.abort();
        await expect(
            workflow(
                { ...baseOptions, signal: controller.signal },
                testRuntime(calls, []),
            ),
        ).rejects.toThrow("Run cancelled");
        expect(calls).toEqual([]);
    });

    test("uses the refreshed issue before preparing a PR branch", async () => {
        const calls: string[] = [];
        const contexts: IssueExecutionContext[] = [];
        const refreshed = {
            ...firstIssue,
            title: "Refreshed title",
            body: "Refreshed body",
            labels: ["BUG", "ready"],
            comments: [
                {
                    id: 1,
                    body: "Refreshed comment",
                    updatedAt: "2026-08-29T00:00:00.000Z",
                },
            ],
            updatedAt: "2026-08-29T00:00:00.000Z",
            commentCount: 1,
            commentVersion: "2026-08-29T00:00:00.000Z",
        } as const;

        await workflow(
            { ...baseOptions, workflow: WorkflowMode.Pr },
            testRuntime(calls, [], {
                refreshIssues: [refreshed],
                executionContexts: contexts,
            }),
        );

        expect(contexts[0]?.issue).toEqual(refreshed);
        expect(calls.indexOf("refreshIssue:42")).toBeLessThan(
            calls.indexOf("prepareFeatureBranch:ralphie/issue-42:develop"),
        );
    });

    test("fails closed when live issue refresh fails", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        await expect(
            workflow(
                { ...baseOptions, workflow: WorkflowMode.Pr },
                testRuntime(calls, states, {
                    refreshFailure: new RalphieError({
                        message: "refresh failed",
                    }),
                }),
            ),
        ).rejects.toThrow("refresh failed");

        expect(calls).not.toContainEqual(
            expect.stringContaining("executeIssue"),
        );
        expect(calls).not.toContainEqual(
            expect.stringContaining("prepareFeatureBranch"),
        );
        expect(
            states.at(-1)?.queue.pending.map(({ number }) => number),
        ).toEqual([42]);
    });

    test.each([
        ["closed", { ...firstIssue, state: "closed" as const }],
        ["missing required labels", { ...firstIssue, labels: ["ready"] }],
    ])("skips %s live issues and continues", async (_name, ineligible) => {
        const calls: string[] = [];
        const states: RunState[] = [];
        const summary = await workflow(
            baseOptions,
            testRuntime(calls, states, {
                issueLists: [[firstIssue, secondIssue]],
                refreshIssues: [ineligible, secondIssue],
            }),
        );

        expect(summary.outcomes[0]).toMatchObject({
            issueNumber: 42,
            outcome: { kind: IssueExecutionOutcomeKind.Skipped },
        });
        expect(summary.outcomes[1]).toMatchObject({
            issueNumber: 43,
            outcome: { kind: IssueExecutionOutcomeKind.Completed },
        });
        expect(calls).not.toContainEqual(
            expect.stringContaining("executeIssue:42"),
        );
        expect(calls).not.toContain("closeIssue:42");
        expect(calls).toContainEqual(
            expect.stringContaining("executeIssue:43"),
        );
        expect(states.at(-1)?.queue.pending).toEqual([]);
        expect(states.at(-1)?.queue.completedIssueNumbers).toEqual([42, 43]);
        expect(states.at(-1)?.outcomes[0]?.outcome.kind).toBe(
            IssueExecutionOutcomeKind.Skipped,
        );
    });

    test("completes a decomposed parent whose sub-issues all closed earlier", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        const decomposedParent: GitHubIssue = {
            ...firstIssue,
            number: 43,
            title: "Decomposed parent",
            body: "<!-- ralphie:decomposition original=43 depth=1 -->\n\nDecomposed work.",
        };
        const closedChild: GitHubIssue = {
            ...secondIssue,
            number: 101,
            state: "closed",
            body: '<!-- ralphie:decomposition root=43 parent=43 key="storage" depth=1 -->',
        };
        const summary = await workflow(
            { ...baseOptions },
            testRuntime(calls, states, {
                issueLists: [[decomposedParent]],
                parentSubIssues: [closedChild],
            }),
        );
        expect(summary.outcomes).toEqual([]);
        expect(calls).toContain("closeIssue:43");
        expect(states.at(-1)?.status).toBe(RunStateStatus.Complete);
    });

    test("keeps a decomposed parent open while its sub-issues are open", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        const decomposedParent: GitHubIssue = {
            ...firstIssue,
            number: 43,
            title: "Decomposed parent",
            body: "<!-- ralphie:decomposition original=43 depth=1 -->\n\nDecomposed work.",
        };
        const openChild: GitHubIssue = {
            ...secondIssue,
            number: 101,
            body: '<!-- ralphie:decomposition root=43 parent=43 key="storage" depth=1 -->',
        };
        await workflow(
            { ...baseOptions },
            testRuntime(calls, states, {
                issueLists: [[decomposedParent]],
                parentSubIssues: [openChild],
            }),
        );
        expect(calls).not.toContain("closeIssue:43");
    });

    test("never reconciles parents during a dry run", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        const decomposedParent: GitHubIssue = {
            ...firstIssue,
            number: 43,
            title: "Decomposed parent",
            body: "<!-- ralphie:decomposition original=43 depth=1 -->\n\nDecomposed work.",
        };
        const closedChild: GitHubIssue = {
            ...secondIssue,
            number: 101,
            state: "closed",
            body: '<!-- ralphie:decomposition root=43 parent=43 key="storage" depth=1 -->',
        };
        await workflow(
            { ...baseOptions, dryRun: true },
            testRuntime(calls, states, {
                issueLists: [[decomposedParent]],
                parentSubIssues: [closedChild],
                dryRunOutcome: {
                    kind: IssueExecutionOutcomeKind.Skipped,
                    route: "decomposition",
                    reason: "dry run",
                },
            }),
        );
        expect(calls).not.toContain("closeIssue:43");
    });
});