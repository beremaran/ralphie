import { describe, expect, test } from "bun:test";
import type { Octokit } from "octokit";
import type { AgentClient } from "../src/agent/contracts.ts";
import type { PiModelInfo } from "../src/pi/models.ts";

import type { GitRepositoryService } from "../src/git/repository.ts";
import type { GitRepositoryInvariantService } from "../src/git/repository-invariant.ts";
import type { GitIssueCheckpointService } from "../src/git/issue-checkpoint.ts";
import type { GitIssueOperationsService } from "../src/git/issue-operations.ts";
import type { GitHubClientService } from "../src/github/client.ts";
import type { GitHubIssueMutationService } from "../src/github/issue-mutations.ts";
import { makeParentCompletionService } from "../src/github/parent-completion.ts";
import type { GitHubNeedsAttentionNotificationService } from "../src/github/needs-attention.ts";
import type { GitHubIssue, GitHubIssuesService } from "../src/github/issues.ts";
import {
    type IssueExecutionContext,
    type IssueExecutionOutcome,
    IssueExecutionOutcomeKind,
} from "../src/issues/execution.ts";
import {
    makeIssueExecutorService,
    type IssueExecutorService,
} from "../src/issues/executor.ts";
import {
    makeDryRunIssueExecutorService,
    type DryRunIssueExecutorService,
} from "../src/issues/dry-run-executor.ts";
import {
    IssueArtifactKind,
    type IssueArtifactStore,
    type IssueArtifactStoreService,
    makeIssueArtifactStore,
    makeIssueArtifactStoreService,
} from "../src/issues/artifacts.ts";
import { DEFAULT_AGENT } from "../src/agent/model.ts";
import type { AgentModel } from "../src/agent/model.ts";
import type { PiAgentService } from "../src/pi/runtime.ts";
import type {
    ProgressReporterService,
    ProgressUpdate,
} from "../src/progress/progress.ts";
import { makeTestProgressRecorder } from "./shared/progress-recorder.ts";
import {
    type RunState,
    RunStateStatus,
    type RunStateStoreService,
} from "../src/run/state.ts";
import type { WorkspaceService } from "../src/workspace/workspace.ts";
import { workflow } from "../src/workflow.ts";
import { IssueFailurePolicy, NeedsAttentionPolicy } from "../src/options.ts";
import { IssueOrder, IssueSort } from "../src/github/issues.ts";
import type { IssueWorkflowRuntime } from "../src/runtime.ts";
import { RalphieError } from "../src/shared/error.ts";
import {
    ComplexityLevel,
    type GroundingDecision,
    GroundingDisposition,
    IssueResolutionStatus,
    NeedsAttentionReason,
} from "../src/issues/decisions.ts";

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
    readonly abortAt?: "github" | "repository" | "issues" | "agent" | "between";
    readonly abortController?: AbortController;
    readonly captureStart?: number;
    readonly failPiReadyProgress?: boolean;
    readonly executionContexts?: IssueExecutionContext[];
    readonly executeGate?: (context: IssueExecutionContext) => Promise<void>;
    readonly issueExecutor?: IssueExecutorService;
    readonly dryRunIssueExecutor?: DryRunIssueExecutorService;
    readonly artifactStore?: IssueArtifactStoreService;
    readonly refreshedIssues?: Readonly<Record<number, GitHubIssue>>;
    readonly needsAttentionNotification?: GitHubNeedsAttentionNotificationService;
    readonly dryRunOutcome?: IssueExecutionOutcome;
    readonly onStateSave?: (state: RunState) => void;
    /** Native sub-issues reported for every parent during reconciliation. */
    readonly parentSubIssues?: ReadonlyArray<GitHubIssue>;
    /** Model catalog exposed by the mock pi runtime for thinking validation. */
    readonly piCatalog?: ReadonlyArray<PiModelInfo>;
    /** Default model exposed by the mock pi runtime. */
    readonly piDefaultModel?: AgentModel;
};

const testRuntime = (
    calls: string[],
    savedStates: RunState[],
    options: TestRuntimeOptions = {},
    progressEvents: ProgressUpdate[] = [],
): IssueWorkflowRuntime => {
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
    const operations: GitIssueOperationsService = {
        stageAll: async () => {},
        readStagedBinaryDiff: async () => "",
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
    const issueExecutor: IssueExecutorService = options.issueExecutor ?? {
        execute: async (context) => {
            options.executionContexts?.push(context);
            if (options.executeGate !== undefined)
                await options.executeGate(context);
            calls.push(
                `executeIssue:${context.issue.number}:${context.repositoryPath}:${context.targetBranch}:${context.agentSelection.agent}`,
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
    const dryRunIssueExecutor: DryRunIssueExecutorService =
        options.dryRunIssueExecutor ?? {
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
    const agentRuntime: PiAgentService = {
        start: async () => {
            if (options.startFailure) throw options.startFailure;
            calls.push("startServer");
            if (options.abortAt === "agent") options.abortController?.abort();
            return {
                client: {} as AgentClient,
                catalog: options.piCatalog ?? [],
                ...(options.piDefaultModel === undefined
                    ? {}
                    : { defaultModel: options.piDefaultModel }),
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
    const progressRecorder = makeTestProgressRecorder(progressEvents);
    const progress: ProgressReporterService = options.failPiReadyProgress
        ? {
              ...progressRecorder,
              emit: async (update) => {
                  if (
                      update.stage === "agent-runtime" &&
                      update.status === "succeeded"
                  ) {
                      throw new Error("Agent ready progress emission failed");
                  }
                  await progressRecorder.emit(update);
              },
          }
        : progressRecorder;
    const relationships = {
        listSubIssues: async () => options.parentSubIssues ?? [],
        parentOf: async () => undefined,
        attachSubIssue: async () => {},
        listBlockedBy: async () => [],
        addBlockedBy: async () => {},
    };
    return {
        githubClient,
        githubIssues,
        githubIssueMutations: mutations,
        parentCompletion: makeParentCompletionService({
            issues: githubIssues,
            relationships,
            mutations,
        }),
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
        dryRunIssueExecutor,
        issueExecutor,
        agentRuntime,
        progress,
        runStateStore: stateStore,
        workspace,
    };
};

const issueWorkCallPrefixes = [
    "executeIssue:",
    "dryRunIssue:",
    "pushBranch:",
    "closeIssue:",
    "restoreCheckout",
] as const;

const expectNoIssueWork = (calls: ReadonlyArray<string>): void => {
    expect(
        calls.filter((call) =>
            issueWorkCallPrefixes.some((prefix) => call.startsWith(prefix)),
        ),
    ).toEqual([]);
};

const artifactMutationMethods = new Set<PropertyKey>([
    "write",
    "recordResolutionDecision",
    "beginNeedsAttentionHandoff",
    "recordNeedsAttentionDecision",
    "appendReview",
    "recordCreatedIssue",
    "resetImplementationAttempt",
    "clearUnresolvedResolutionDecision",
    "invalidateStaleIssueDecisions",
    "invalidateStaleNeedsAttentionDecision",
    "invalidateNeedsAttentionDecision",
    "clearNeedsAttentionHandoff",
]);

const readOnlyArtifactSpy = (
    store: IssueArtifactStore,
    mutations: string[],
): IssueArtifactStore =>
    new Proxy(store, {
        get(target, property, receiver) {
            if (artifactMutationMethods.has(property)) {
                return async () => {
                    mutations.push(String(property));
                    throw new Error(
                        `dry run attempted artifact mutation: ${String(property)}`,
                    );
                };
            }
            return Reflect.get(target, property, receiver);
        },
    });

const expectCallOrder = (
    calls: ReadonlyArray<string>,
    expected: ReadonlyArray<string>,
): void => {
    const expectedCalls = new Set(expected);
    expect(calls.filter((call) => expectedCalls.has(call))).toEqual([
        ...expected,
    ]);
};

type GroundedRoute =
    | "actionable"
    | "decomposition"
    | "already-resolved"
    | "needs-attention";

const groundingDecisionFor = (route: GroundedRoute): GroundingDecision => {
    switch (route) {
        case "actionable":
        case "decomposition":
            return { disposition: GroundingDisposition.Actionable };
        case "already-resolved":
            return { disposition: GroundingDisposition.AlreadyResolved };
        case "needs-attention":
            return {
                disposition: GroundingDisposition.NeedsAttention,
                reason: NeedsAttentionReason.ExternalDependency,
                summary: "A prerequisite is still open.",
                evidence: ["Issue body links the open prerequisite."],
                questions: ["Complete the prerequisite, then retry."],
            };
    }
};

/** Exercise workflow routing through the real issue-executor outcome contract. */
const groundedRouteExecutor = (
    calls: string[],
    routes: Readonly<Record<number, GroundedRoute>>,
): IssueExecutorService => {
    const stores = new Map<
        number,
        Awaited<ReturnType<typeof makeIssueArtifactStore>>
    >();
    const artifacts: IssueArtifactStoreService = {
        forIssue: async (issueNumber, _scope) => {
            const existing = stores.get(issueNumber);
            if (existing !== undefined) return existing;
            const created = await makeIssueArtifactStore(issueNumber);
            const tracked = {
                ...created,
                write: async (kind, value, writeSignal) => {
                    await created.write(kind, value, writeSignal);
                    calls.push(`artifact:${issueNumber}:${kind}`);
                },
            } satisfies Awaited<
                ReturnType<IssueArtifactStoreService["forIssue"]>
            >;
            stores.set(issueNumber, tracked);
            return tracked;
        },
    };
    return makeIssueExecutorService(
        artifacts,
        {
            assess: async (context) => {
                calls.push(`complexity:${context.issue.number}`);
                return {
                    decision: {
                        complexity: ComplexityLevel.Level2,
                        rationale: "The fixture is directly actionable.",
                    },
                    sessionID: `complexity-${context.issue.number}`,
                };
            },
        },
        {
            execute: async ({ context }) => {
                calls.push(`implementation:${context.issue.number}`);
                if (context.allowMissingRemoteBranch !== true) {
                    calls.push(
                        `directPush:${context.issue.number}:${context.targetBranch}`,
                    );
                }
                return {
                    kind: IssueExecutionOutcomeKind.Completed,
                    completion: "pushed-commit",
                    commitSha: `commit-${context.issue.number}`,
                    reviewCount: 1,
                };
            },
        },
        {
            execute: async () => {
                throw new Error("The route fixture must not decompose");
            },
        },
        {
            assess: async (context) => {
                calls.push(`grounding:${context.issue.number}`);
                return {
                    decision: groundingDecisionFor(
                        routes[context.issue.number] ?? "actionable",
                    ),
                    sessionID: `grounding-${context.issue.number}`,
                };
            },
        },
        {
            verify: async (context) => {
                calls.push(`verification:${context.issue.number}`);
                return {
                    decision: {
                        status: IssueResolutionStatus.Resolved,
                        summary: "The requested behavior is already present.",
                        evidence: ["The focused regression test passes."],
                    },
                    sessionID: `verification-${context.issue.number}`,
                };
            },
        },
    );
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
    agent: DEFAULT_AGENT,
    workspace: "/tmp/ralphie",
    cleanup: false,
    startClean: false,
    runId: "test-run",
    onNeedsAttention: NeedsAttentionPolicy.Continue,
} as const;

describe("workflow", () => {
    test("executes an issue, persists completion, releases the agent, and cleans up", async () => {
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

    test("fails fast before any issue work when the thinking level is unsupported", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        await expect(
            workflow(
                {
                    ...baseOptions,
                    model: {
                        providerID: "opencode-go",
                        modelID: "deepseek-v4-flash",
                    },
                    modelVariant: "medium",
                },
                testRuntime(calls, states, {
                    piCatalog: [
                        {
                            provider: "opencode-go",
                            id: "deepseek-v4-flash",
                            name: "DeepSeek V4 Flash",
                            reasoning: true,
                            thinkingLevels: ["off", "low", "high", "max"],
                        },
                    ],
                }),
            ),
        ).rejects.toThrow(/--thinking/);
        expectNoIssueWork(calls);
        expect(calls).toContain("closeRuntime");
    });

    test("skips thinking validation when the runtime exposes no model catalog", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        const summary = await workflow(
            {
                ...baseOptions,
                model: {
                    providerID: "opencode-go",
                    modelID: "deepseek-v4-flash",
                },
                modelVariant: "medium",
            },
            testRuntime(calls, states, {}),
        );
        expect(summary.counts.completed).toBe(1);
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
                    onNeedsAttention: NeedsAttentionPolicy.Continue,
                    dryRun: true,
                    selection: { agent: DEFAULT_AGENT },
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

    test("isolates every dry-run route", async () => {
        const routes: ReadonlyArray<GroundedRoute> = [
            "actionable",
            "decomposition",
            "already-resolved",
            "needs-attention",
        ];
        for (const route of routes) {
            const calls: string[] = [];
            const states: RunState[] = [];
            const events: ProgressUpdate[] = [];
            const artifactCalls: string[] = [];
            const artifactMutations: string[] = [];
            const storeService = makeIssueArtifactStoreService();
            const artifactStore: IssueArtifactStoreService = {
                forIssue: async () => {
                    artifactCalls.push("writable-loader");
                    throw new Error("dry run used writable artifacts");
                },
                forIssueReadOnly: async (issueNumber, scope) => {
                    artifactCalls.push("read-only-loader");
                    return readOnlyArtifactSpy(
                        await storeService.forIssueReadOnly!(
                            issueNumber,
                            scope,
                        ),
                        artifactMutations,
                    );
                },
            };
            let groundingCalls = 0;
            let complexityCalls = 0;
            const dryRunExecutor = makeDryRunIssueExecutorService(
                artifactStore,
                {
                    assess: async () => {
                        complexityCalls += 1;
                        if (
                            route === "already-resolved" ||
                            route === "needs-attention"
                        ) {
                            throw new Error("unexpected complexity assessment");
                        }
                        return {
                            sessionID: "dry-run-complexity",
                            decision: {
                                complexity:
                                    route === "actionable"
                                        ? ComplexityLevel.Level2
                                        : ComplexityLevel.Level4,
                                rationale: "Read-only route fixture.",
                            },
                        };
                    },
                },
                makeTestProgressRecorder(events),
                {
                    assess: async () => {
                        groundingCalls += 1;
                        return {
                            sessionID: "dry-run-grounding",
                            decision: groundingDecisionFor(route),
                        };
                    },
                },
            );
            const summary = await workflow(
                {
                    ...baseOptions,
                    dryRun: true,
                    onNeedsAttention: NeedsAttentionPolicy.Continue,
                },
                testRuntime(
                    calls,
                    states,
                    {
                        artifactStore,
                        dryRunIssueExecutor: dryRunExecutor,
                        issueExecutor: {
                            execute: async () => {
                                calls.push("executeIssue:unexpected");
                                throw new Error(
                                    "mutation executor escaped dry run",
                                );
                            },
                        },
                    },
                    events,
                ),
            );

            expect(summary.outcomes[0]?.outcome).toMatchObject({
                route: route === "actionable" ? "implementation" : route,
            });
            expect(groundingCalls).toBe(1);
            expect(complexityCalls).toBe(
                route === "already-resolved" || route === "needs-attention"
                    ? 0
                    : 1,
            );
            expect(artifactCalls).toEqual(["read-only-loader"]);
            expect(artifactMutations).toEqual([]);
            expectNoIssueWork(calls);
            expect(calls).toEqual([
                "prepareWorkspace:/tmp/ralphie",
                "initializeGitHub",
                "verifyGitInstalled",
                "prepareRepository:owner/repo:develop:/tmp/ralphie",
                "listIssues:owner/repo:bug:created:asc",
                "startServer",
                "refreshIssue:42",
                "closeRuntime",
            ]);
            expect(firstIssue.state).toBe("open");
            expect(events).toContainEqual(
                expect.objectContaining({
                    stage: "run",
                    status: "info",
                    details: expect.objectContaining({
                        dryRun: true,
                    }),
                }),
            );
            expect(events).toContainEqual(
                expect.objectContaining({
                    stage: "run",
                    status: "succeeded",
                    details: expect.objectContaining({
                        routes: [
                            {
                                issueNumber: 42,
                                route:
                                    route === "actionable"
                                        ? "implementation"
                                        : route,
                            },
                        ],
                    }),
                }),
            );
            expect(states.at(-1)?.status).toBe(RunStateStatus.Complete);
        }
    });

    test.each([
        {
            name: "lgtm-actionable",
            route: "actionable" as const,
        },
        {
            name: "lgtm-already-resolved",
            route: "already-resolved" as const,
        },
        {
            name: "lgtm-needs-attention",
            route: "needs-attention" as const,
        },
    ])("keeps a resumed dry run isolated in $name mode", async ({ route }) => {
        const calls: string[] = [];
        const states: RunState[] = [];
        const events: ProgressUpdate[] = [];
        const artifactCalls: string[] = [];
        const artifactMutations: string[] = [];
        const storeService = makeIssueArtifactStoreService();
        const artifactStore: IssueArtifactStoreService = {
            forIssue: async () => {
                artifactCalls.push("writable-loader");
                throw new Error("resumed dry run used writable artifacts");
            },
            forIssueReadOnly: async (issueNumber, scope) => {
                artifactCalls.push("read-only-loader");
                return readOnlyArtifactSpy(
                    await storeService.forIssueReadOnly!(issueNumber, scope),
                    artifactMutations,
                );
            },
        };
        const dryRunExecutor = makeDryRunIssueExecutorService(
            artifactStore,
            {
                assess: async () => ({
                    sessionID: "resumed-complexity",
                    decision: {
                        complexity:
                            route === "actionable"
                                ? ComplexityLevel.Level2
                                : ComplexityLevel.Level4,
                        rationale: "Resumed read-only route fixture.",
                    },
                }),
            },
            makeTestProgressRecorder(events),
            {
                assess: async () => ({
                    sessionID: "resumed-grounding",
                    decision: groundingDecisionFor(route),
                }),
            },
        );
        const summary = await workflow(
            {
                ...baseOptions,
                dryRun: false,
                resumeState: {
                    version: 4,
                    status: RunStateStatus.Active,
                    runId: `resumed-${route}`,
                    repository: baseOptions.repo,
                    branch: baseOptions.branch,
                    onNeedsAttention: NeedsAttentionPolicy.Continue,
                    dryRun: true,
                    selection: { agent: DEFAULT_AGENT },
                    maxIssues: 1,
                    queue: {
                        pending: [
                            {
                                ...firstIssue,
                                labels: [...firstIssue.labels],
                            },
                        ],
                        completedIssueNumbers: [],
                        processedCount: 0,
                    },
                    outcomes: [],
                    checkout: {
                        branch: baseOptions.branch,
                        head: "head-0",
                    },
                    updatedAt: "2026-08-28T00:00:00.000Z",
                },
            },
            testRuntime(
                calls,
                states,
                {
                    artifactStore,
                    dryRunIssueExecutor: dryRunExecutor,
                    issueExecutor: {
                        execute: async () => {
                            calls.push("executeIssue:unexpected");
                            throw new Error("mutation executor escaped resume");
                        },
                    },
                },
                events,
            ),
        );

        expect(summary.outcomes[0]?.outcome).toMatchObject({
            route: route === "actionable" ? "implementation" : route,
        });
        expect(artifactCalls).toEqual(["read-only-loader"]);
        expect(artifactMutations).toEqual([]);
        expectNoIssueWork(calls);
        expect(calls).toEqual([
            "prepareWorkspace:/tmp/ralphie",
            "initializeGitHub",
            "verifyGitInstalled",
            "prepareRepository:owner/repo:develop:/tmp/ralphie",
            "listIssues:owner/repo:bug:created:asc",
            "startServer",
            "refreshIssue:42",
            "closeRuntime",
        ]);
        expect(firstIssue.state).toBe("open");
        expect(events).toContainEqual(
            expect.objectContaining({
                stage: "run",
                status: "info",
                details: expect.objectContaining({
                    dryRun: true,
                    resumed: true,
                }),
            }),
        );
        expect(events).toContainEqual(
            expect.objectContaining({
                stage: "run",
                status: "succeeded",
                details: expect.objectContaining({
                    routes: [
                        {
                            issueNumber: 42,
                            route:
                                route === "actionable"
                                    ? "implementation"
                                    : route,
                        },
                    ],
                }),
            }),
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

    test("keeps a confirmed needs-attention recovery outcome open with its diagnostics path and no Git or GitHub mutations", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        const events: ProgressUpdate[] = [];
        const diagnosticsPath =
            "/tmp/.ralphie/runs/run-1/issues/42/needs-attention-abc/changes.patch";
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
                            reason: NeedsAttentionReason.MissingInformation,
                            summary: "A prerequisite is still open.",
                            evidence: [
                                "Issue body links the open prerequisite.",
                            ],
                            questions: [
                                "Complete the prerequisite, then retry.",
                            ],
                            diagnosticsPath,
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

        expect(summary.outcomes[0]?.outcome).toMatchObject({
            kind: IssueExecutionOutcomeKind.NeedsAttention,
            reason: NeedsAttentionReason.MissingInformation,
            summary: "A prerequisite is still open.",
            evidence: ["Issue body links the open prerequisite."],
            questions: ["Complete the prerequisite, then retry."],
            diagnosticsPath,
        });
        const needsAttention = events.find(
            ({ status }) => status === "needs-attention",
        );
        expect(needsAttention).toMatchObject({
            details: {
                reason: NeedsAttentionReason.MissingInformation,
                summary: "A prerequisite is still open.",
                evidence: ["Issue body links the open prerequisite."],
                questions: ["Complete the prerequisite, then retry."],
                diagnosticsPath,
                policy: NeedsAttentionPolicy.Continue,
            },
        });
        expect(states.at(-1)?.outcomes).toContainEqual(
            expect.objectContaining({
                issueNumber: 42,
                outcome: expect.objectContaining({
                    kind: IssueExecutionOutcomeKind.NeedsAttention,
                    diagnosticsPath,
                }),
            }),
        );
        expect(states.at(-1)?.queue.completedIssueNumbers).toEqual([43]);
        expect(calls).not.toContain("closeIssue:42");
        expect(calls).not.toContain("prepareFeatureBranch:");
        expect(calls).not.toContain("pushBranch:");
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
        ).rejects.toMatchObject({ name: "NeedsAttentionStop" });
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
                issue: { number: 42, title: firstIssue.title },
                current: 1,
                total: 1,
                message: expect.stringContaining("needs-attention"),
                details: expect.objectContaining({
                    handled: true,
                    reason: NeedsAttentionReason.ExternalDependency,
                    summary: "A prerequisite is still open.",
                    evidence: ["The prerequisite is unresolved."],
                    questions: ["When will it be available?"],
                    artifactPath: "/tmp/needs-attention.json",
                    issueNumber: 42,
                    issueTitle: firstIssue.title,
                    queuePosition: 1,
                    queueTotal: 1,
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

    test("surfaces dependency-blocked issues as needs-attention outcomes and halts", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        const events: ProgressUpdate[] = [];
        const blockedIssue: GitHubIssue = {
            ...firstIssue,
            number: 44,
            body: '<!-- ralphie:decomposition root=7 parent=35 key="blocked" depth=2 -->\n\nBlocked work.\n\n## Dependencies\n\n- #42 (prerequisite)',
        };
        await expect(
            workflow(
                {
                    ...baseOptions,
                    maxIssues: 2,
                    onNeedsAttention: NeedsAttentionPolicy.Halt,
                },
                testRuntime(
                    calls,
                    states,
                    {
                        issueLists: [[firstIssue, blockedIssue]],
                        outcomes: [
                            {
                                kind: IssueExecutionOutcomeKind.NeedsAttention,
                                reason: NeedsAttentionReason.MissingInformation,
                                summary: "The prerequisite needs an answer.",
                                evidence: ["The prerequisite is unanswered."],
                                questions: ["What is the answer?"],
                                route: "needs-attention",
                                policy: NeedsAttentionPolicy.Continue,
                            },
                        ],
                    },
                    events,
                ),
            ),
        ).rejects.toMatchObject({ name: "NeedsAttentionStop" });

        // The dependency never completed, so the blocked issue was never
        // handed to the executor, never closed, and never notified unless the
        // blocked path itself reports it. The halt stop names the blocked issue.
        expect(calls).not.toContain("executeIssue:44");
        expect(calls).not.toContain("closeIssue:42");
        expect(calls).not.toContain("closeIssue:44");
        expect(events.some(({ status }) => status === "failed")).toBe(false);
        expect(events).toContainEqual(
            expect.objectContaining({
                stage: "grounding",
                status: "needs-attention",
                issue: { number: 44, title: firstIssue.title },
                details: expect.objectContaining({
                    reason: NeedsAttentionReason.ExternalDependency,
                    summary: expect.stringContaining("#42"),
                    policy: NeedsAttentionPolicy.Halt,
                }),
            }),
        );
        const blockedOutcome = states
            .at(-1)
            ?.outcomes.find((entry) => entry.issueNumber === 44)?.outcome;
        if (blockedOutcome?.kind !== IssueExecutionOutcomeKind.NeedsAttention) {
            throw new Error("Expected a needs-attention outcome for #44.");
        }
        expect(blockedOutcome.reason).toBe(
            NeedsAttentionReason.ExternalDependency,
        );
        expect(
            blockedOutcome.evidence.some((item) => item.includes("#42")),
        ).toBe(true);
        expect(states.at(-1)?.status).toBe(RunStateStatus.Active);
        expect(states.at(-1)?.activeIssue?.issueNumber).toBe(44);
    });

    test("completes with dependency-blocked issues recorded and still pending when the policy continues", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        const blockedIssue: GitHubIssue = {
            ...firstIssue,
            number: 44,
            body: '<!-- ralphie:decomposition root=7 parent=35 key="blocked" depth=2 -->\n\nBlocked work.\n\n## Dependencies\n\n- #42 (prerequisite)',
        };
        const summary = await workflow(
            {
                ...baseOptions,
                maxIssues: 2,
                onNeedsAttention: NeedsAttentionPolicy.Continue,
            },
            testRuntime(calls, states, {
                issueLists: [[firstIssue, blockedIssue]],
                outcomes: [
                    {
                        kind: IssueExecutionOutcomeKind.NeedsAttention,
                        reason: NeedsAttentionReason.MissingInformation,
                        summary: "The prerequisite needs an answer.",
                        evidence: ["The prerequisite is unanswered."],
                        questions: ["What is the answer?"],
                        route: "needs-attention",
                        policy: NeedsAttentionPolicy.Continue,
                    },
                ],
            }),
        );

        expect(summary.counts[IssueExecutionOutcomeKind.Completed]).toBe(0);
        expect(summary.counts[IssueExecutionOutcomeKind.NeedsAttention]).toBe(
            2,
        );
        expect(summary.outcomes.map(({ issueNumber }) => issueNumber)).toEqual([
            42, 44,
        ]);
        expect(calls).not.toContain("closeIssue:42");
        expect(calls).not.toContain("closeIssue:44");
        expect(states.at(-1)?.status).toBe(RunStateStatus.Complete);
        expect(
            states.at(-1)?.queue.pending.map(({ number }) => number),
        ).toContain(44);
    });

    test("does not notify dependency-blocked issues; notifies genuine needs-attention outcomes", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        const blockedIssue: GitHubIssue = {
            ...firstIssue,
            number: 44,
            body: '<!-- ralphie:decomposition root=7 parent=35 key="blocked" depth=2 -->\n\nBlocked work.\n\n## Dependencies\n\n- #42 (prerequisite)',
        };
        const summary = await workflow(
            {
                ...baseOptions,
                maxIssues: 2,
                notificationsEnabled: true,
                needsAttentionLabel: "needs-attention",
            },
            testRuntime(calls, states, {
                issueLists: [[firstIssue, blockedIssue]],
                outcomes: [
                    {
                        kind: IssueExecutionOutcomeKind.NeedsAttention,
                        reason: NeedsAttentionReason.MissingInformation,
                        summary: "The prerequisite needs an answer.",
                        evidence: ["The prerequisite is unanswered."],
                        questions: ["What is the answer?"],
                        route: "needs-attention",
                        policy: NeedsAttentionPolicy.Continue,
                    },
                ],
                needsAttentionNotification: {
                    notify: async (
                        _client,
                        _repo,
                        issueNumber,
                        input,
                        label,
                    ) => {
                        calls.push(`notifyNeedsAttention:${issueNumber}`);
                        expect(issueNumber).toBe(firstIssue.number);
                        expect(input.reason).toBe(
                            NeedsAttentionReason.MissingInformation,
                        );
                        expect(label).toBe("needs-attention");
                        return {
                            comment: "created" as const,
                            label: "applied" as const,
                        };
                    },
                },
            }),
        );

        expect(summary.counts[IssueExecutionOutcomeKind.NeedsAttention]).toBe(
            2,
        );
        // The dependency-blocked issue (#44) is recorded but never notified:
        // open queue dependencies resolve by queue completion, not by human
        // attention. Only the agent-reported blocker (#firstIssue) notifies.
        expect(
            calls.filter((call) => call.startsWith("notifyNeedsAttention:")),
        ).toEqual([`notifyNeedsAttention:${firstIssue.number}`]);
        expect(states.at(-1)?.status).toBe(RunStateStatus.Complete);
    });

    test("persists halt recovery after its artifact and reuses grounding on resume", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        const events: ProgressUpdate[] = [];
        const executor = groundedRouteExecutor(calls, {
            42: "needs-attention",
            43: "actionable",
        });
        let savedOutcome = false;

        await expect(
            workflow(
                {
                    ...baseOptions,
                    maxIssues: 2,
                    onNeedsAttention: undefined,
                },
                testRuntime(
                    calls,
                    states,
                    {
                        issueLists: [[firstIssue, secondIssue]],
                        issueExecutor: executor,
                        onStateSave: (state) => {
                            if (
                                !savedOutcome &&
                                state.activeIssue?.issueNumber === 42 &&
                                state.checkout?.head === "head-1" &&
                                state.queue.pending
                                    .map(({ number }) => number)
                                    .join(",") === "42,43" &&
                                state.outcomes.some(
                                    ({ issueNumber, outcome }) =>
                                        issueNumber === 42 &&
                                        outcome.kind ===
                                            IssueExecutionOutcomeKind.NeedsAttention,
                                )
                            ) {
                                savedOutcome = true;
                                calls.push("save:needs-attention");
                            }
                        },
                    },
                    events,
                ),
            ),
        ).rejects.toMatchObject({ name: "NeedsAttentionStop" });

        const haltState = states.at(-1);
        if (haltState === undefined) throw new Error("Missing halted state");
        expect(haltState).toMatchObject({
            status: RunStateStatus.Active,
            runId: "test-run",
            onNeedsAttention: NeedsAttentionPolicy.Halt,
            activeIssue: { issueNumber: 42, stage: "grounding" },
            checkout: { branch: "develop", head: "head-1" },
            queue: {
                pending: [
                    { number: 42, state: "open" },
                    { number: 43, state: "open" },
                ],
                completedIssueNumbers: [],
                processedCount: 0,
            },
        });
        expect(haltState.outcomes).toHaveLength(1);
        expect(haltState.outcomes[0]).toMatchObject({
            issueNumber: 42,
            outcome: {
                kind: IssueExecutionOutcomeKind.NeedsAttention,
            },
        });
        expect(
            haltState.outcomes[0]?.outcome.kind ===
                IssueExecutionOutcomeKind.NeedsAttention &&
                "artifactPath" in haltState.outcomes[0].outcome &&
                haltState.outcomes[0].outcome.artifactPath,
        ).toBeString();
        expectCallOrder(calls, [
            `artifact:42:${IssueArtifactKind.NeedsAttentionDecision}`,
            "save:needs-attention",
            "closeRuntime",
        ]);
        expect(calls).not.toContain("grounding:43");
        expect(events.some(({ status }) => status === "failed")).toBeFalse();
        expect(events).toContainEqual(
            expect.objectContaining({
                stage: "run",
                status: "needs-attention",
                details: expect.objectContaining({
                    handled: true,
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

        const resumedStates: RunState[] = [];
        const resumedEvents: ProgressUpdate[] = [];
        await expect(
            workflow(
                {
                    ...baseOptions,
                    maxIssues: 2,
                    resumeState: haltState,
                },
                testRuntime(
                    calls,
                    resumedStates,
                    {
                        issueLists: [[firstIssue, secondIssue]],
                        issueExecutor: executor,
                        captureStart: 1,
                    },
                    resumedEvents,
                ),
            ),
        ).rejects.toMatchObject({ name: "NeedsAttentionStop" });

        expect(calls.filter((call) => call === "grounding:42")).toHaveLength(1);
        expect(calls).not.toContain("grounding:43");
        expect(calls.filter((call) => call === "closeRuntime")).toHaveLength(2);
        expect(calls).not.toContain("directPush:42:develop");
        expect(calls).not.toContain("closeIssue:42");
        expect(resumedStates.at(-1)).toMatchObject({
            status: RunStateStatus.Active,
            runId: haltState.runId,
            activeIssue: { issueNumber: 42, stage: "grounding" },
            queue: {
                pending: [{ number: 42 }, { number: 43 }],
                completedIssueNumbers: [],
                processedCount: 0,
            },
        });
        expect(resumedStates.at(-1)?.outcomes).toHaveLength(1);
        expect(resumedEvents).toContainEqual(
            expect.objectContaining({
                stage: "run",
                status: "needs-attention",
                details: expect.objectContaining({
                    counts: expect.objectContaining({
                        "needs-attention": 1,
                        failed: 0,
                    }),
                }),
            }),
        );
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
        ).rejects.toMatchObject({ name: "NeedsAttentionStop" });

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

    test("keeps notification recovery distinct and retries the saved outcome without agent work", async () => {
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
            name: "NeedsAttentionNotificationRecoveryBoundaryError",
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
            onNeedsAttention: NeedsAttentionPolicy.Continue,
            dryRun: false,
            notificationsEnabled: false,
            selection: { agent: DEFAULT_AGENT },
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
            name: "NeedsAttentionNotificationRecoveryBoundaryError",
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
        ).rejects.toMatchObject({ name: "NeedsAttentionStop" });
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
        ).rejects.toMatchObject({ name: "NeedsAttentionStop" });

        expect(contexts[0]?.issue).toEqual(currentIssue);
    });

    test("refreshes the selected issue before execution", async () => {
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
            { ...baseOptions },
            testRuntime(calls, [], {
                refreshedIssues: { 42: refreshedIssue },
                executionContexts: contexts,
            }),
        );

        expect(contexts[0]?.issue).toEqual(refreshedIssue);
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

    test("halts, persists the active issue, and releases the agent on failure", async () => {
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

    test("closes the agent if ready progress reporting fails after startup", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        await expect(
            workflow(
                baseOptions,
                testRuntime(calls, states, {
                    failPiReadyProgress: true,
                }),
            ),
        ).rejects.toThrow("Agent ready progress emission failed");
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

    test("resumes a saved verified closure without rerunning grounding or verification", async () => {
        const failedCalls: string[] = [];
        const failedStates: RunState[] = [];
        await expect(
            workflow(
                baseOptions,
                testRuntime(failedCalls, failedStates, {
                    issueExecutor: groundedRouteExecutor(failedCalls, {
                        42: "already-resolved",
                    }),
                    closeFailure: new RalphieError({
                        message: "close response lost",
                    }),
                }),
            ),
        ).rejects.toThrow("close response lost");

        const resumeState = failedStates.at(-1);
        if (resumeState === undefined)
            throw new Error("Missing resumable state");
        expect(resumeState.activeIssue).toEqual({
            issueNumber: 42,
            stage: "issue-closure",
        });
        expect(resumeState.outcomes).toEqual([
            {
                issueNumber: 42,
                outcome: {
                    kind: IssueExecutionOutcomeKind.Completed,
                    completion: "already-resolved",
                    resolutionSummary:
                        "The requested behavior is already present.",
                    evidence: ["The focused regression test passes."],
                },
            },
        ]);

        const resumedCalls: string[] = [];
        const resumedStates: RunState[] = [];
        const summary = await workflow(
            { ...baseOptions, resumeState },
            testRuntime(resumedCalls, resumedStates, {
                issueExecutor: groundedRouteExecutor(resumedCalls, {
                    42: "actionable",
                }),
                issueLists: [[]],
                captureStart: 1,
            }),
        );

        expect(summary.counts.completed).toBe(1);
        expect(resumedCalls).toContain("refreshIssue:42");
        expect(resumedCalls).toContain("closeIssue:42");
        expect(resumedCalls).not.toContain("grounding:42");
        expect(resumedCalls).not.toContain("verification:42");
        expect(resumedCalls).not.toContain("complexity:42");
        expect(resumedCalls).not.toContain("implementation:42");
        expect(resumedStates.at(-1)?.outcomes).toHaveLength(1);
        expect(resumedStates.at(-1)?.status).toBe(RunStateStatus.Complete);
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

    test("cancels after the agent starts, closes the server, and saves active state", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        const controller = new AbortController();
        await expect(
            workflow(
                { ...baseOptions, cleanup: true, signal: controller.signal },
                testRuntime(calls, states, {
                    abortAt: "agent",
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

    test("fails closed when live issue refresh fails", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        await expect(
            workflow(
                { ...baseOptions },
                testRuntime(calls, states, {
                    refreshFailure: new RalphieError({
                        message: "refresh failed",
                    }),
                }),
            ),
        ).rejects.toThrow("refresh failed");

        expect(
            calls.indexOf("listIssues:owner/repo:bug:created:asc"),
        ).toBeLessThan(calls.indexOf("refreshIssue:42"));
        expectNoIssueWork(calls);
        expect(states.at(-1)).toMatchObject({
            status: RunStateStatus.Active,
            queue: { processedCount: 0 },
        });
        expect(
            states.at(-1)?.queue.pending.map(({ number }) => number),
        ).toEqual([42]);
    });

    test.each([
        {
            name: "closed",
            ineligible: { ...firstIssue, state: "closed" as const },
            reason: "Live reconciliation found that the issue is no longer open.",
        },
        {
            name: "missing required labels",
            ineligible: { ...firstIssue, labels: ["ready"] },
            reason: "Live reconciliation found that the issue no longer has every required label.",
        },
    ])(
        "skips $name live issues, persists the reason, and continues",
        async ({ ineligible, reason }) => {
            const calls: string[] = [];
            const states: RunState[] = [];
            const skippedOutcome = {
                kind: IssueExecutionOutcomeKind.Skipped,
                reason,
            } as const;
            const summary = await workflow(
                baseOptions,
                testRuntime(calls, states, {
                    issueLists: [[firstIssue, secondIssue]],
                    refreshIssues: [ineligible, secondIssue],
                }),
            );

            expect(summary.outcomes).toEqual([
                { issueNumber: 42, outcome: skippedOutcome },
                {
                    issueNumber: 43,
                    outcome: expect.objectContaining({
                        kind: IssueExecutionOutcomeKind.Completed,
                    }),
                },
            ]);
            expect(summary.counts.skipped).toBe(1);
            expect(calls).not.toContainEqual(
                expect.stringContaining("executeIssue:42"),
            );
            expect(calls).not.toContain("closeIssue:42");
            expect(calls).toContainEqual(
                expect.stringContaining("executeIssue:43"),
            );
            expect(calls.indexOf("refreshIssue:42")).toBeLessThan(
                calls.indexOf("refreshIssue:43"),
            );
            expect(calls.indexOf("refreshIssue:43")).toBeLessThan(
                calls.findIndex((call) => call.startsWith("executeIssue:43")),
            );
            const skippedState = states.find(({ outcomes }) =>
                outcomes.some(
                    ({ issueNumber, outcome }) =>
                        issueNumber === 42 &&
                        outcome.kind === IssueExecutionOutcomeKind.Skipped,
                ),
            );
            expect(skippedState?.outcomes[0]).toEqual({
                issueNumber: 42,
                outcome: skippedOutcome,
            });
            expect(
                skippedState?.queue.pending.map(({ number }) => number),
            ).not.toContain(42);
            expect(states.at(-1)).toMatchObject({
                status: RunStateStatus.Complete,
                queue: {
                    pending: [],
                    completedIssueNumbers: [42, 43],
                    processedCount: 1,
                },
            });
        },
    );

    test.each([
        {
            name: "closed",
            ineligible: { ...firstIssue, state: "closed" as const },
            reason: "Live reconciliation found that the issue is no longer open.",
        },
        {
            name: "missing its configured label",
            ineligible: { ...firstIssue, labels: ["ready"] },
            reason: "Live reconciliation found that the issue no longer has every required label.",
        },
    ])(
        "does no issue or mutation work when the live snapshot is $name",
        async ({ ineligible, reason }) => {
            const calls: string[] = [];
            const states: RunState[] = [];
            const summary = await workflow(
                { ...baseOptions },
                testRuntime(calls, states, {
                    issueLists: [[firstIssue]],
                    refreshIssues: [ineligible],
                }),
            );

            expect(summary.outcomes).toEqual([
                {
                    issueNumber: 42,
                    outcome: {
                        kind: IssueExecutionOutcomeKind.Skipped,
                        reason,
                    },
                },
            ]);
            expectNoIssueWork(calls);
            const completedState = states.at(-1);
            expect(completedState).toMatchObject({
                status: RunStateStatus.Complete,
                queue: {
                    pending: [],
                    completedIssueNumbers: [42],
                    processedCount: 0,
                },
            });
            expect(completedState?.activeIssue).toBeUndefined();
            if (completedState === undefined)
                throw new Error("Missing completed state");

            const resumedCalls: string[] = [];
            const resumedStates: RunState[] = [];
            const resumed = await workflow(
                {
                    ...baseOptions,
                    resumeState: completedState,
                },
                testRuntime(resumedCalls, resumedStates, {
                    issueLists: [[]],
                }),
            );
            expect(resumed.outcomes).toEqual(summary.outcomes);
            expect(resumedCalls).not.toContain("refreshIssue:42");
            expectNoIssueWork(resumedCalls);
            expect(resumedStates.at(-1)?.queue.pending).toEqual([]);
        },
    );

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