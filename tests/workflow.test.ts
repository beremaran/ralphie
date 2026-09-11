import { describe, expect, test } from "bun:test";
import type { Octokit } from "octokit";
import type { AgentClient } from "../src/core/ports/agent.ts";
import { type PiModelInfo } from "../src/core/domain/pi-models.ts";

import { type GitRepositoryService } from "../src/core/ports/git.ts";
import { type GitRepositoryInvariantService } from "../src/core/ports/git.ts";
import { type GitIssueCheckpointService } from "../src/core/ports/git.ts";
import { type GitIssueOperationsService } from "../src/core/ports/git.ts";
import { type GitHubClientService } from "../src/core/ports/github.ts";
import { type GitHubIssueMutationService } from "../src/core/ports/github.ts";
import { makeParentCompletionService } from "../src/adapters/github/parent-completion.ts";
import { type GitHubNeedsAttentionNotificationService } from "../src/core/ports/github.ts";
import { type GitHubIssuesService } from "../src/core/ports/github.ts";
import { type GitHubIssue } from "../src/core/domain/github.ts";
import {
    type IssueExecutionContext,
    type IssueExecutionOutcome,
    IssueExecutionOutcomeKind,
} from "../src/core/app/issues/execution.ts";
import {
    makeIssueExecutorService,
    type IssueExecutorService,
} from "../src/core/app/issues/executor.ts";
import {
    IssueArtifactKind,
    type IssueArtifactStoreService,
    makeIssueArtifactStore,
} from "../src/core/app/issues/artifacts.ts";
import { DEFAULT_AGENT } from "../src/core/domain/agent-model.ts";
import type { AgentModel } from "../src/core/domain/agent-model.ts";
import { type PiAgentService } from "../src/core/ports/pi.ts";
import type {
    ProgressReporterService,
    ProgressUpdate,
} from "../src/core/ports/progress.ts";
import { makeTestProgressRecorder } from "./shared/progress-recorder.ts";
import { type RunEventLog } from "../src/core/ports/run.ts";
import { type RunStateStoreService } from "../src/core/ports/run.ts";
import { type RunState, RunStateStatus } from "../src/core/domain/run-state.ts";
import { type WorkspaceService } from "../src/core/ports/workspace.ts";
import { workflow } from "../src/core/app/workflow.ts";
import { IssueOrder, IssueSort } from "../src/core/domain/github.ts";
import type { IssueWorkflowRuntime } from "../src/runtime.ts";
import { RalphieError } from "../src/shared/error.ts";
import {
    ComplexityLevel,
    type GroundingDecision,
    GroundingDisposition,
    IssueResolutionStatus,
    NeedsAttentionReason,
} from "../src/core/domain/decisions.ts";

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
    readonly artifactStore?: IssueArtifactStoreService;
    readonly refreshedIssues?: Readonly<Record<number, GitHubIssue>>;
    readonly needsAttentionNotification?: GitHubNeedsAttentionNotificationService;
    readonly onStateSave?: (state: RunState) => void;
    readonly eventLog?: RunEventLog;
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
    const eventLog: RunEventLog = options.eventLog ?? {
        append: () => {},
        close: () => {
            calls.push("closeEventLog");
        },
    };
    const stateStore: RunStateStoreService = {
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
        issueExecutor,
        agentRuntime,
        progress,
        runEventLog: eventLog,
        runStateStore: stateStore,
        workspace,
    };
};

const issueWorkCallPrefixes = [
    "executeIssue:",
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
                calls.push(
                    `directPush:${context.issue.number}:${context.targetBranch}`,
                );
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
    issueFilters: {
        labels: ["bug"],
        sort: IssueSort.Created,
        order: IssueOrder.Ascending,
    },
    agent: DEFAULT_AGENT,
    workspace: "/tmp/ralphie",
    runId: "test-run",
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
            },
            testRuntime(calls, states, {}, events),
        );
        expect(summary.counts.completed).toBe(1);
        expect(states.at(-1)?.status).toBe(RunStateStatus.Complete);
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
            "closeEventLog",
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

    test("defers an issue needing attention and continues with the queue", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        const events: ProgressUpdate[] = [];
        const summary = await workflow(
            { ...baseOptions },
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
                queuePosition: 1,
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
            { ...baseOptions },
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

    test("continues after the decomposition ceiling", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        const summary = await workflow(
            {
                ...baseOptions,
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

    test("records a needs-attention outcome and continues without reporting an ordinary failure", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        const events: ProgressUpdate[] = [];
        const summary = await workflow(
            {
                ...baseOptions,
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
        );
        expect(summary.counts[IssueExecutionOutcomeKind.NeedsAttention]).toBe(
            1,
        );
        expect(states.at(-1)?.status).toBe(RunStateStatus.Complete);
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
                }),
            }),
        );
        expect(events.some(({ status }) => status === "needs-attention")).toBe(
            true,
        );
        expect(calls).not.toContain("closeIssue:42");
    });

    test("surfaces dependency-blocked issues as needs-attention outcomes and continues", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        const events: ProgressUpdate[] = [];
        const blockedIssue: GitHubIssue = {
            ...firstIssue,
            number: 44,
            body: '<!-- ralphie:decomposition root=7 parent=35 key="blocked" depth=2 -->\n\nBlocked work.\n\n## Dependencies\n\n- #42 (prerequisite)',
        };
        const summary = await workflow(
            {
                ...baseOptions,
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
                        },
                    ],
                },
                events,
            ),
        );

        // The dependency never completed, so the blocked issue was never
        // handed to the executor, never closed, and never notified unless the
        // blocked path itself reports it.
        expect(summary.counts[IssueExecutionOutcomeKind.NeedsAttention]).toBe(
            2,
        );
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
        expect(states.at(-1)?.status).toBe(RunStateStatus.Complete);
        expect(
            states.at(-1)?.queue.pending.map(({ number }) => number),
        ).toContain(44);
    });

    test("completes with dependency-blocked issues recorded and still pending", async () => {
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

    test("persists the needs-attention outcome before continuing to the next issue", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        const events: ProgressUpdate[] = [];
        const executor = groundedRouteExecutor(calls, {
            42: "needs-attention",
            43: "actionable",
        });
        let savedOutcome = false;

        const summary = await workflow(
            {
                ...baseOptions,
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
        );

        const pendingState = states.find(
            (state) =>
                state.activeIssue?.issueNumber === 42 &&
                state.outcomes.some(({ issueNumber }) => issueNumber === 42),
        );
        if (pendingState === undefined) {
            throw new Error("Missing persisted needs-attention state");
        }
        expect(pendingState).toMatchObject({
            status: RunStateStatus.Active,
            runId: "test-run",
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
        const outcome42 = pendingState.outcomes.find(
            ({ issueNumber }) => issueNumber === 42,
        )?.outcome;
        if (outcome42?.kind !== IssueExecutionOutcomeKind.NeedsAttention) {
            throw new Error("Expected a needs-attention outcome for #42.");
        }
        expect(
            "artifactPath" in outcome42 && outcome42.artifactPath,
        ).toBeString();
        expectCallOrder(calls, [
            `artifact:42:${IssueArtifactKind.NeedsAttentionDecision}`,
            "save:needs-attention",
            "closeRuntime",
        ]);
        expect(summary.counts[IssueExecutionOutcomeKind.NeedsAttention]).toBe(
            1,
        );
        expect(summary.counts.completed).toBe(1);
        expect(calls).toContain("grounding:43");
        expect(calls).toContain("closeIssue:43");
        expect(calls).not.toContain("closeIssue:42");
        expect(states.at(-1)?.status).toBe(RunStateStatus.Complete);
        expect(events.some(({ status }) => status === "failed")).toBeFalse();
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

    test("records a failed issue, restores its checkout, and reports the drained failure", async () => {
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
        ).rejects.toThrow("Run drained with issue failures");
        expect(
            states.some(
                (state) =>
                    state.activeIssue?.issueNumber === 42 &&
                    state.queue.pending
                        .map(({ number }) => number)
                        .includes(42),
            ),
        ).toBeTrue();
        expect(calls).toContain("restoreCheckout");
        expect(states.at(-1)?.status).toBe(RunStateStatus.Complete);
        expect(states.at(-1)?.outcomes[0]).toMatchObject({
            issueNumber: 42,
            outcome: { kind: IssueExecutionOutcomeKind.Failed },
        });
        expect(calls.at(-1)).toBe("closeRuntime");
    });

    test("continues independent issues after failure and reports partial failure after draining", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        await expect(
            workflow(
                {
                    ...baseOptions,
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

    test("refreshes the queue after decomposition and runs a new child within budget", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        const child = { ...firstIssue, number: 51, title: "Child" };
        const summary = await workflow(
            { ...baseOptions },
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

    test("stops before other work when workspace removal fails", async () => {
        const calls: string[] = [];
        await expect(
            workflow(
                baseOptions,
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
            "removeWorkspace:/tmp/ralphie",
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
                        signal: controller.signal,
                    },
                    testRuntime(calls, states, {
                        abortAt: stage,
                        abortController: controller,
                    }),
                ),
            ).rejects.toThrow("Run cancelled");
            expect(calls).toEqual([
                "removeWorkspace:/tmp/ralphie",
                ...expectedCalls,
            ]);
            expect(calls).not.toContain("startServer");
            expect(
                calls.filter((call) => call === "removeWorkspace:/tmp/ralphie"),
            ).toHaveLength(1);
            expect(states).toHaveLength(0);
        },
    );

    test("cancels after the agent starts, closes the server, and saves active state", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        const controller = new AbortController();
        await expect(
            workflow(
                { ...baseOptions, signal: controller.signal },
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
        expect(
            calls.filter((call) => call === "removeWorkspace:/tmp/ralphie"),
        ).toHaveLength(1);
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

    test("restores the active checkout and saves active state on cancellation", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        const controller = new AbortController();
        await expect(
            workflow(
                { ...baseOptions, signal: controller.signal },
                testRuntime(calls, states, { abortOnExecute: controller }),
            ),
        ).rejects.toThrow("Run cancelled");
        expect(states.at(-1)?.status).toBe(RunStateStatus.Active);
        expect(states.at(-1)?.activeIssue?.issueNumber).toBe(42);
        expect(calls).toContain("restoreCheckout");
        expect(
            calls.filter((call) => call === "removeWorkspace:/tmp/ralphie"),
        ).toHaveLength(1);
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
});