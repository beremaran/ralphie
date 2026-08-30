import { describe, expect, test } from "bun:test";
import type { Octokit } from "octokit";
import type { PiClient } from "../src/pi/client.ts";

import { CommandRunnerLive } from "../src/process/command-runner.ts";
import type { GitRepositoryService } from "../src/git/repository.ts";
import type { GitRepositoryInvariantService } from "../src/git/repository-invariant.ts";
import type { GitIssueCheckpointService } from "../src/git/issue-checkpoint.ts";
import type { GitIssueOperationsService } from "../src/git/issue-operations.ts";
import type { GitHubClientService } from "../src/github/client.ts";
import type { GitHubPullRequestService } from "../src/github/pull-requests.ts";
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
import { NeedsAttentionPolicy, WorkflowMode } from "../src/options.ts";
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
            return {
                number: 1,
                url: "https://github.com/owner/repo/pull/1",
                merged: false,
                headSha: "feature-head-sha",
            };
        },
        read: async () => {
            throw new RalphieError({ message: "unused" });
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
            return {
                number: 1,
                url: "https://github.com/owner/repo/pull/1",
                merged: true,
                headSha: "feature-head-sha",
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
    return {
        commandRunner: CommandRunnerLive,
        githubClient,
        pipelineSnapshot: {} as never,
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
        expect(calls).toContain(
            "mergePullRequest:owner/repo:1:feature-head-sha",
        );
        expect(calls).toContain("restoreBase:develop");
        expect(calls).not.toContain("closeIssue:42");
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