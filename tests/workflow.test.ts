import {
    exitCodeForError,
    RalphieExitCode,
} from "../src/workflow/exit-code.ts";
import { RunHaltedError } from "../src/shared/error.ts";
import { describe, expect, test } from "bun:test";

import { type GitRepositoryService } from "../src/git/ports.ts";
import { type GitRepositoryInvariantService } from "../src/git/ports.ts";
import { type GitIssueCheckpointService } from "../src/git/ports.ts";
import { type GitIssueOperationsService } from "../src/git/ports.ts";
import { type GitHubConnectionService } from "../src/github/ports.ts";
import { type GitHubIssueMutationService } from "../src/github/ports.ts";
import { makeParentCompletionService } from "../src/issues/app/parent-completion.ts";
import {
    type GitHubHandOffInput,
    type GitHubHandOffService,
} from "../src/github/ports.ts";
import { type GitHubIssuesService } from "../src/github/ports.ts";
import { type GitHubTriageService } from "../src/github/ports.ts";
import { type TriageService } from "../src/issues/app/triage.ts";
import { type TriageResult } from "../src/issues/domain/triage.ts";
import { type GitHubIssue } from "../src/github/domain.ts";
import {
    type IssueExecutionContext,
    type IssueExecutionOutcome,
    IssueExecutionOutcomeKind,
} from "../src/issues/app/execution.ts";
import {
    makeIssueExecutorService,
    type IssueExecutorService,
} from "../src/issues/app/executor.ts";
import {
    IssueArtifactKind,
    type IssueArtifactStoreService,
    makeIssueArtifactStore,
} from "../src/issues/app/artifacts.ts";
import { defaultRoles } from "./shared/agent-sessions.ts";
import { makeFakeHarness } from "./shared/fake-harness.ts";
import { resolveRoleAssignments } from "../src/harness/app/roles.ts";
import type {
    ProgressReporterService,
    ProgressUpdate,
} from "../src/progress/ports.ts";
import { makeTestProgressRecorder } from "./shared/progress-recorder.ts";
import { countingIds, fixedClock, testLayout } from "./shared/test-values.ts";
import { type RunControl, type RunEventLog } from "../src/run/ports.ts";
import { type RunStateStoreService } from "../src/run/ports.ts";
import { type RunState, RunStateStatus } from "../src/run/state.ts";
import { type WorkspaceService } from "../src/workspace/ports.ts";
import { workflow } from "../src/workflow/workflow.ts";
import { IssueOrder, IssueSort } from "../src/github/domain.ts";
import type { IssueWorkflowRuntime } from "../src/runtime.ts";
import { RalphieError } from "../src/shared/error.ts";
import {
    type PreflightDecision,
    GroundingDisposition,
    IssueResolutionStatus,
    HandOffReason,
} from "../src/issues/domain/decisions.ts";

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
    readonly removeFailure?: RalphieError;
    readonly closeFailure?: RalphieError;
    readonly abortOnExecute?: AbortController;
    readonly abortAt?: "github" | "repository" | "issues" | "agent" | "between";
    readonly abortController?: AbortController;
    readonly captureStart?: number;
    readonly executionContexts?: IssueExecutionContext[];
    readonly executeGate?: (context: IssueExecutionContext) => Promise<void>;
    readonly issueExecutor?: IssueExecutorService;
    readonly artifactStore?: IssueArtifactStoreService;
    readonly refreshedIssues?: Readonly<Record<number, GitHubIssue>>;
    readonly handOffService?: GitHubHandOffService;
    readonly triageService?: TriageService;
    readonly githubTriage?: GitHubTriageService;
    readonly onStateSave?: (state: RunState) => void;
    readonly eventLog?: RunEventLog;
    /** Native sub-issues reported for every parent during reconciliation. */
    readonly parentSubIssues?: ReadonlyArray<GitHubIssue>;
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

    const githubConnection: GitHubConnectionService = {
        connect: async () => {
            calls.push("initializeGitHub");
            if (options.abortAt === "github") options.abortController?.abort();
            if (options.githubFailure) throw options.githubFailure;
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
        refresh: async (_repo, issueNumber) => {
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
        listOpen: async (repo, filters) => {
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
        comment: async (_repository, issueNumber) => {
            calls.push(`commentIssue:${issueNumber}`);
        },
        close: async (_repository, issueNumber) => {
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
        commitCandidate: async () => ({
            sha: "c".repeat(40),
            treeSha: "b".repeat(40),
        }),
        readRangeDiff: async () => "",
        squashCandidates: async () => {},
        push: async (_path, branch) => {
            calls.push(`pushBranch:${branch}`);
        },
    };
    const issueExecutor: IssueExecutorService = options.issueExecutor ?? {
        execute: async (context) => {
            options.executionContexts?.push({ ...context });
            if (options.executeGate !== undefined)
                await options.executeGate(context);
            calls.push(
                `executeIssue:${context.issue.number}:${context.repositoryPath}:${context.targetBranch}:${context.agent.roles.implementer.harness}`,
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
    const progress: ProgressReporterService = progressRecorder;
    const relationships = {
        listSubIssues: async () => options.parentSubIssues ?? [],
        parentOf: async () => undefined,
        attachSubIssue: async () => {},
        listBlockedBy: async () => [],
        addBlockedBy: async () => {},
    };
    return {
        githubConnection,
        githubIssues,
        githubIssueMutations: mutations,
        parentCompletion: makeParentCompletionService({
            issues: githubIssues,
            relationships,
            mutations,
        }),
        githubHandOff: options.handOffService ?? {
            handOff: async () => ({ comment: "created" }),
        },
        gitRepository: repository,
        gitRepositoryInvariant: invariant,
        gitIssueCheckpoint: checkpoint,
        gitIssueOperations: operations,
        githubTriage: options.githubTriage ?? {
            promote: async () => ({ comment: "created" }),
            explainImplemented: async () => ({ comment: "created" }),
        },
        triage: options.triageService ?? {
            triage: async () => {
                throw new Error("Triage must not run in this test");
            },
        },
        issueExecutor,
        harness: makeFakeHarness().service,
        progress,
        runEventLog: eventLog,
        runStateStore: stateStore,
        layout: testLayout(),
        clock: fixedClock(),
        ids: countingIds("test"),
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
    | "hand-off";

const preflightDecisionFor = (route: GroundedRoute): PreflightDecision => {
    switch (route) {
        case "actionable":
            return {
                disposition: GroundingDisposition.Actionable,
                fitsOneSession: true,
            };
        case "decomposition":
            return {
                disposition: GroundingDisposition.Actionable,
                fitsOneSession: false,
            };
        case "already-resolved":
            return { disposition: GroundingDisposition.AlreadyResolved };
        case "hand-off":
            return {
                disposition: GroundingDisposition.HandOff,
                reason: HandOffReason.ExternalDependency,
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
                calls.push(`preflight:${context.issue.number}`);
                return {
                    decision: preflightDecisionFor(
                        routes[context.issue.number] ?? "actionable",
                    ),
                    sessionID: `preflight-${context.issue.number}`,
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
    roles: defaultRoles(),
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
                roles: resolveRoleAssignments({
                    harnesses: { codex: { model: "gpt-5", effort: "high" } },
                    roles: { default: "codex" },
                }),
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
            "refreshIssue:42",
            "executeIssue:42:/tmp/ralphie/repo:develop:codex",
            "closeIssue:42",
            "removeWorkspace:/tmp/ralphie",
            "closeEventLog",
        ]);
        expect(events.some(({ stage }) => stage === "issue-execution")).toBe(
            true,
        );
    });

    test("completed issues are closed without any hand-off", async () => {
        const calls: string[] = [];
        let handedOff = false;
        const summary = await workflow(
            baseOptions,
            testRuntime(calls, [], {
                handOffService: {
                    handOff: async () => {
                        handedOff = true;
                        return { comment: "created" };
                    },
                },
            }),
        );

        expect(summary.counts.completed).toBe(1);
        expect(handedOff).toBeFalse();
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
                            kind: IssueExecutionOutcomeKind.HandOff,
                            reason: HandOffReason.ExternalDependency,
                            summary: "A prerequisite is still open.",
                            evidence: ["Issue body links the prerequisite."],
                            questions: [
                                "Complete the prerequisite, then retry.",
                            ],
                            artifactPath: "/tmp/hand-off.json",
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
        const handOff = events.find(({ status }) => status === "hand-off");
        expect(handOff).toMatchObject({
            stage: "hand-off",
            current: 1,
            total: 2,
            details: {
                reason: HandOffReason.ExternalDependency,
                summary: "A prerequisite is still open.",
                evidence: ["Issue body links the prerequisite."],
                questions: ["Complete the prerequisite, then retry."],
                artifactPath: "/tmp/hand-off.json",
                queuePosition: 1,
            },
        });
        expect(summary.counts[IssueExecutionOutcomeKind.HandOff]).toBe(1);
        expect(states.at(-1)?.queue.completedIssueNumbers).toEqual([43]);
        expect(calls).not.toContain("closeIssue:42");
        expect(calls).toContain("closeIssue:43");
    });

    test("keeps a confirmed hand-off recovery outcome open with its diagnostics path and no Git or GitHub mutations", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        const events: ProgressUpdate[] = [];
        const diagnosticsPath =
            "/tmp/.ralphie/runs/run-1/issues/42/hand-off-abc/changes.patch";
        const summary = await workflow(
            { ...baseOptions },
            testRuntime(
                calls,
                states,
                {
                    issueLists: [[firstIssue, secondIssue]],
                    outcomes: [
                        {
                            kind: IssueExecutionOutcomeKind.HandOff,
                            reason: HandOffReason.MissingInformation,
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
            kind: IssueExecutionOutcomeKind.HandOff,
            reason: HandOffReason.MissingInformation,
            summary: "A prerequisite is still open.",
            evidence: ["Issue body links the open prerequisite."],
            questions: ["Complete the prerequisite, then retry."],
            diagnosticsPath,
        });
        const handOff = events.find(({ status }) => status === "hand-off");
        expect(handOff).toMatchObject({
            details: {
                reason: HandOffReason.MissingInformation,
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
                    kind: IssueExecutionOutcomeKind.HandOff,
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
                        kind: IssueExecutionOutcomeKind.HandOff,
                        reason: HandOffReason.DecompositionLimitReached,
                        summary: "Maximum decomposition depth reached.",
                        evidence: [
                            "The next depth exceeds the configured maximum.",
                        ],
                        questions: [
                            "Increase the maximum or narrow the issue.",
                        ],
                        route: "hand-off",
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
        expect(summary.counts[IssueExecutionOutcomeKind.HandOff]).toBe(1);
        expect(calls).toContain("closeIssue:43");
        expect(states.at(-1)?.status).toBe(RunStateStatus.Complete);
    });

    test("records a hand-off outcome and continues without reporting an ordinary failure", async () => {
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
                            kind: IssueExecutionOutcomeKind.HandOff,
                            reason: HandOffReason.ExternalDependency,
                            summary: "A prerequisite is still open.",
                            evidence: ["The prerequisite is unresolved."],
                            questions: ["When will it be available?"],
                            artifactPath: "/tmp/hand-off.json",
                        },
                    ],
                },
                events,
            ),
        );
        expect(summary.counts[IssueExecutionOutcomeKind.HandOff]).toBe(1);
        expect(states.at(-1)?.status).toBe(RunStateStatus.Complete);
        expect(events.some(({ status }) => status === "failed")).toBe(false);
        expect(events).toContainEqual(
            expect.objectContaining({
                stage: "hand-off",
                status: "hand-off",
                details: expect.objectContaining({
                    reason: HandOffReason.ExternalDependency,
                    summary: "A prerequisite is still open.",
                    evidence: ["The prerequisite is unresolved."],
                    questions: ["When will it be available?"],
                    artifactPath: "/tmp/hand-off.json",
                }),
            }),
        );
        expect(events.some(({ status }) => status === "hand-off")).toBe(true);
        expect(calls).not.toContain("closeIssue:42");
    });

    test("skips dependency-blocked issues without a hand-off and continues", async () => {
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
                            kind: IssueExecutionOutcomeKind.HandOff,
                            reason: HandOffReason.MissingInformation,
                            summary: "The prerequisite needs an answer.",
                            evidence: ["The prerequisite is unanswered."],
                            questions: ["What is the answer?"],
                            route: "hand-off",
                        },
                    ],
                },
                events,
            ),
        );

        // The dependency never completed, so the blocked issue was never
        // handed to the executor or closed, and nothing changed on GitHub.
        expect(summary.counts[IssueExecutionOutcomeKind.HandOff]).toBe(1);
        expect(summary.counts[IssueExecutionOutcomeKind.Skipped]).toBe(1);
        expect(calls).not.toContain("executeIssue:44");
        expect(calls).not.toContain("closeIssue:42");
        expect(calls).not.toContain("closeIssue:44");
        expect(events.some(({ status }) => status === "failed")).toBe(false);
        expect(events).toContainEqual(
            expect.objectContaining({
                stage: "issue-queue",
                status: "skipped",
                issue: { number: 44, title: firstIssue.title },
                message: expect.stringContaining("#42"),
            }),
        );
        const blockedOutcome = states
            .at(-1)
            ?.outcomes.find((entry) => entry.issueNumber === 44)?.outcome;
        if (blockedOutcome?.kind !== IssueExecutionOutcomeKind.Skipped) {
            throw new Error("Expected a skipped outcome for #44.");
        }
        expect(blockedOutcome.reason).toContain("#42");
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
                        kind: IssueExecutionOutcomeKind.HandOff,
                        reason: HandOffReason.MissingInformation,
                        summary: "The prerequisite needs an answer.",
                        evidence: ["The prerequisite is unanswered."],
                        questions: ["What is the answer?"],
                        route: "hand-off",
                    },
                ],
            }),
        );

        expect(summary.counts[IssueExecutionOutcomeKind.Completed]).toBe(0);
        expect(summary.counts[IssueExecutionOutcomeKind.HandOff]).toBe(1);
        expect(summary.counts[IssueExecutionOutcomeKind.Skipped]).toBe(1);
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

    test("hands off genuine outcomes but leaves dependency-blocked issues untouched", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        const blockedIssue: GitHubIssue = {
            ...firstIssue,
            number: 44,
            body: '<!-- ralphie:decomposition root=7 parent=35 key="blocked" depth=2 -->\n\nBlocked work.\n\n## Dependencies\n\n- #42 (prerequisite)',
        };
        const handOffs: Array<{
            readonly issueNumber: number;
            readonly input: GitHubHandOffInput;
        }> = [];
        const summary = await workflow(
            baseOptions,
            testRuntime(calls, states, {
                issueLists: [[firstIssue, blockedIssue]],
                outcomes: [
                    {
                        kind: IssueExecutionOutcomeKind.HandOff,
                        reason: HandOffReason.MissingInformation,
                        summary: "The prerequisite needs an answer.",
                        evidence: ["The prerequisite is unanswered."],
                        questions: ["What is the answer?"],
                        route: "hand-off",
                    },
                ],
                handOffService: {
                    handOff: async (_repo, issueNumber, input) => {
                        handOffs.push({ issueNumber, input });
                        return { comment: "created" };
                    },
                },
            }),
        );

        expect(summary.counts[IssueExecutionOutcomeKind.HandOff]).toBe(1);
        expect(summary.counts[IssueExecutionOutcomeKind.Skipped]).toBe(1);
        expect(handOffs.map(({ issueNumber }) => issueNumber)).toEqual([
            firstIssue.number,
        ]);
        expect(states.at(-1)?.status).toBe(RunStateStatus.Complete);
    });

    test.each([
        [HandOffReason.MissingInformation, "needs-info", "## Triage Notes"],
        [
            HandOffReason.ConflictingRequirements,
            "needs-info",
            "## Triage Notes",
        ],
        [HandOffReason.CannotReproduce, "needs-info", "## Triage Notes"],
        [HandOffReason.OutdatedPremise, "needs-info", "## Triage Notes"],
        [HandOffReason.ExternalDependency, "ready-for-human", "## Hand-off"],
        [
            HandOffReason.ImplementationExhausted,
            "ready-for-human",
            "## Hand-off",
        ],
        [
            HandOffReason.DecompositionLimitReached,
            "ready-for-human",
            "## Hand-off",
        ],
    ] as const)(
        "hands off %s to %s with the AI disclaimer first",
        async (reason, label, heading) => {
            const calls: string[] = [];
            const handOffs: GitHubHandOffInput[] = [];
            await workflow(
                {
                    ...baseOptions,
                    handOffLabels: {
                        "needs-info": "needs-info",
                        "ready-for-human": "ready-for-human",
                        replaces: [
                            "ready-for-agent",
                            "needs-info",
                            "ready-for-human",
                        ],
                    },
                },
                testRuntime(calls, [], {
                    outcomes: [
                        {
                            kind: IssueExecutionOutcomeKind.HandOff,
                            reason,
                            summary: "Why the issue was handed off.",
                            evidence: ["What was established."],
                            questions: ["What happens next?"],
                            diagnosticsPath: "/tmp/diagnostics/issue-42",
                        },
                    ],
                    handOffService: {
                        handOff: async (_repo, _issueNumber, input) => {
                            handOffs.push(input);
                            return { comment: "created" };
                        },
                    },
                }),
            );

            expect(handOffs).toHaveLength(1);
            const [handOff] = handOffs;
            expect(handOff?.label).toBe(label);
            expect(handOff?.replaceLabels).toEqual([
                "ready-for-agent",
                "needs-info",
                "ready-for-human",
            ]);
            expect(
                handOff?.body.startsWith(
                    "> *This was generated by AI during triage.*",
                ),
            ).toBe(true);
            expect(handOff?.body).toContain(heading);
            expect(handOff?.body).toContain("What happens next?");
            if (label === "ready-for-human") {
                expect(handOff?.body).toContain("/tmp/diagnostics/issue-42");
            }
        },
    );

    test("persists the hand-off outcome before continuing to the next issue", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        const events: ProgressUpdate[] = [];
        const executor = groundedRouteExecutor(calls, {
            42: "hand-off",
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
                                        IssueExecutionOutcomeKind.HandOff,
                            )
                        ) {
                            savedOutcome = true;
                            calls.push("save:hand-off");
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
            throw new Error("Missing persisted hand-off state");
        }
        expect(pendingState).toMatchObject({
            status: RunStateStatus.Active,
            runId: "test-run",
            activeIssue: { issueNumber: 42, stage: "hand-off" },
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
        if (outcome42?.kind !== IssueExecutionOutcomeKind.HandOff) {
            throw new Error("Expected a hand-off outcome for #42.");
        }
        expect(
            "artifactPath" in outcome42 && outcome42.artifactPath,
        ).toBeString();
        expectCallOrder(calls, [
            `artifact:42:${IssueArtifactKind.HandOffDecision}`,
            "save:hand-off",
        ]);
        expect(summary.counts[IssueExecutionOutcomeKind.HandOff]).toBe(1);
        expect(summary.counts.completed).toBe(1);
        expect(calls).toContain("preflight:43");
        expect(calls).toContain("closeIssue:43");
        expect(calls).not.toContain("closeIssue:42");
        expect(states.at(-1)?.status).toBe(RunStateStatus.Complete);
        expect(events.some(({ status }) => status === "failed")).toBeFalse();
    });

    test("passes the configured attempt budgets to the issue executor", async () => {
        const contexts: IssueExecutionContext[] = [];

        await workflow(
            {
                ...baseOptions,
                implementationAttempts: 4,
                reviewRounds: 6,
                verificationFixes: 2,
            },
            testRuntime([], [], { executionContexts: contexts }),
        );

        expect(contexts[0]).toMatchObject({
            implementationAttempts: 4,
            reviewRounds: 6,
            verificationFixes: 2,
        });
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

    test("a deferred issue halts the queue, changes nothing and names the reset time", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        await expect(
            workflow(
                baseOptions,
                testRuntime(calls, states, {
                    issueLists: [[firstIssue, secondIssue]],
                    outcomes: [
                        {
                            kind: IssueExecutionOutcomeKind.Deferred,
                            reason: "You've hit your session limit",
                            cause: "transient",
                            resetHint: "3:10pm",
                        },
                    ],
                }),
            ),
        ).rejects.toMatchObject({
            message: expect.stringMatching(
                /Run halted at issue #\d+.*left untouched.*resets 3:10pm/,
            ),
        });
        expect(
            exitCodeForError(
                new RunHaltedError({ message: "x" }),
                new AbortController().signal,
            ),
        ).toBe(RalphieExitCode.Halted);
        // The command boundary wraps errors; the halt must survive the wrap.
        expect(
            exitCodeForError(
                new Error("wrapped", {
                    cause: new RunHaltedError({ message: "x" }),
                }),
                new AbortController().signal,
            ),
        ).toBe(RalphieExitCode.Halted);
        expect(
            calls.filter((call) => call.startsWith("executeIssue:")),
        ).toHaveLength(1);
        expect(calls).toContain("restoreCheckout");
        expect(calls.some((call) => /handOff|close|label/i.test(call))).toBe(
            false,
        );
        expect(states.at(-1)?.status).toBe(RunStateStatus.Complete);
        expect(states.at(-1)?.outcomes[0]).toMatchObject({
            outcome: { kind: IssueExecutionOutcomeKind.Deferred },
        });
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
            expect(
                calls.filter((call) => call === "removeWorkspace:/tmp/ralphie"),
            ).toHaveLength(1);
            expect(states).toHaveLength(0);
        },
    );

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
        ).toEqual(["executeIssue:42:/tmp/ralphie/repo:develop:claude"]);
        expect(calls).not.toContain(
            "executeIssue:51:/tmp/ralphie/repo:develop:claude",
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

    test("reports the discovered queue and each skipped issue to progress subscribers", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        const events: ProgressUpdate[] = [];
        await workflow(
            baseOptions,
            testRuntime(
                calls,
                states,
                {
                    issueLists: [[firstIssue, secondIssue]],
                    refreshIssues: [
                        { ...firstIssue, state: "closed" },
                        secondIssue,
                    ],
                },
                events,
            ),
        );

        const queueReady = events.find(
            ({ stage, status }) => stage === "issue-queue" && status === "info",
        );
        expect(queueReady).toMatchObject({
            message: "Issue queue ready with 2 issues.",
            details: {
                issues: [
                    { number: 42, title: "Test issue" },
                    { number: 43, title: "Second test issue" },
                ],
            },
        });
        const skipped = events.find(
            ({ stage, status }) =>
                stage === "issue-queue" && status === "skipped",
        );
        expect(skipped).toMatchObject({
            issue: { number: 42, title: "Test issue" },
            message:
                "Live reconciliation found that the issue is no longer open.",
        });
    });

    test("stops the queue after the active issue when the run control requests it", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        const events: ProgressUpdate[] = [];
        let stopRequested = false;
        const summary = await workflow(
            {
                ...baseOptions,
                control: {
                    waitForQueue: async () => {},
                    stopAfterCurrent: () => stopRequested,
                },
            },
            testRuntime(
                calls,
                states,
                {
                    issueLists: [[firstIssue, secondIssue]],
                    executeGate: async (context) => {
                        if (context.issue.number === 42) {
                            stopRequested = true;
                        }
                    },
                },
                events,
            ),
        );

        expect(calls).toContainEqual(
            expect.stringContaining("executeIssue:42"),
        );
        expect(calls).not.toContainEqual(
            expect.stringContaining("executeIssue:43"),
        );
        expect(summary.outcomes.map(({ issueNumber }) => issueNumber)).toEqual([
            42,
        ]);
        expect(states.at(-1)?.status).toBe(RunStateStatus.Complete);
        expect(events.at(-1)).toMatchObject({
            stage: "run",
            status: "succeeded",
            message: expect.stringContaining("Run stopped by request"),
        });
    });

    test("waits for the run control before starting the next issue", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        let paused = true;
        const waiters: Array<() => void> = [];
        const control: RunControl = {
            waitForQueue: () =>
                paused
                    ? new Promise<void>((resolve) => {
                          waiters.push(resolve);
                      })
                    : Promise.resolve(),
            stopAfterCurrent: () => false,
        };
        const running = workflow(
            { ...baseOptions, control },
            testRuntime(calls, states, {
                issueLists: [[firstIssue, secondIssue]],
            }),
        );

        let reachedGate = false;
        for (let attempt = 0; attempt < 1000 && !reachedGate; attempt += 1) {
            reachedGate = waiters.length > 0;
            if (!reachedGate) await Bun.sleep(0);
        }
        expect(reachedGate).toBe(true);
        expect(calls).not.toContainEqual(
            expect.stringContaining("executeIssue:42"),
        );

        paused = false;
        for (const resolve of waiters.splice(0)) resolve();

        const summary = await running;
        expect(calls).toContainEqual(
            expect.stringContaining("executeIssue:42"),
        );
        expect(calls).toContainEqual(
            expect.stringContaining("executeIssue:43"),
        );
        expect(summary.outcomes.map(({ issueNumber }) => issueNumber)).toEqual([
            42, 43,
        ]);
    });

    test("cancels a paused queue instead of waiting for the gate", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        const controller = new AbortController();
        let gateCalls = 0;
        const control: RunControl = {
            waitForQueue: () => {
                gateCalls += 1;
                return new Promise<void>(() => {});
            },
            stopAfterCurrent: () => false,
        };
        const running = workflow(
            { ...baseOptions, control, signal: controller.signal },
            testRuntime(calls, states, {
                issueLists: [[firstIssue, secondIssue]],
            }),
        );

        for (let attempt = 0; attempt < 1000 && gateCalls === 0; attempt += 1) {
            await Bun.sleep(0);
        }
        expect(gateCalls).toBeGreaterThan(0);

        controller.abort();
        await expect(running).rejects.toThrow("Run cancelled");
        expect(calls).not.toContainEqual(
            expect.stringContaining("executeIssue:42"),
        );
    });

    test("hands the harness and the resolved role assignments to the executor and the run state", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        const contexts: IssueExecutionContext[] = [];
        const roles = resolveRoleAssignments({
            harnesses: { claude: { model: "opus", effort: "high" } },
            roles: {
                reviewer: { harness: "claude", model: "sonnet" },
            },
        });
        await workflow(
            { ...baseOptions, roles },
            testRuntime(calls, states, { executionContexts: contexts }),
        );

        expect(contexts).toHaveLength(1);
        expect(contexts[0]?.agent.roles).toEqual(roles);
        expect(contexts[0]?.agent.roles["spec-reviewer"]).toEqual({
            harness: "claude",
            approval: "safe",
            model: "sonnet",
            effort: "high",
        });
        expect(states.at(-1)?.roles).toEqual(roles);
    });

    test("reports the role assignments when the run starts", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        const events: ProgressUpdate[] = [];
        await workflow(baseOptions, testRuntime(calls, states, {}, events));

        const started = events.find(
            ({ stage, status }) => stage === "run" && status === "info",
        );
        expect(started?.details?.roles).toEqual(baseOptions.roles);
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
            body: "Decomposed work.",
            subIssueCount: 2,
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
        expect(calls.indexOf("commentIssue:43")).toBeGreaterThan(-1);
        expect(calls.indexOf("commentIssue:43")).toBeLessThan(
            calls.indexOf("closeIssue:43"),
        );
        expect(states.at(-1)?.status).toBe(RunStateStatus.Complete);
    });

    test("keeps a decomposed parent open while its sub-issues are open", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        const decomposedParent: GitHubIssue = {
            ...firstIssue,
            number: 43,
            title: "Decomposed parent",
            body: "Decomposed work.",
            subIssueCount: 2,
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
describe("workflow AFK triage", () => {
    const stateLabels = {
        "needs-triage": "needs-triage",
        "needs-info": "needs-info",
        "ready-for-agent": "ready-for-agent",
        "ready-for-human": "ready-for-human",
        wontfix: "wontfix",
    } as const;
    const triageOptions = { labels: stateLabels, requireLabels: [] } as const;
    const readyIssue: GitHubIssue = { ...firstIssue, labels: ["bug"] };
    const candidate = (number: number, labels: string[]): GitHubIssue => ({
        ...firstIssue,
        number,
        title: `Candidate ${number}`,
        labels,
    });

    type TriageCall = { readonly issue: number; readonly bucket: string };

    const scriptedTriage = (
        results: Readonly<Record<number, TriageResult>>,
        seen: TriageCall[] = [],
    ): TriageService => ({
        triage: async ({ context, bucket }) => {
            seen.push({ issue: context.issue.number, bucket });
            const result = results[context.issue.number];
            if (result === undefined) throw new Error("unscripted triage");
            return result;
        },
    });

    const brief = "## Agent Brief\n\n**Summary:** Do the thing.";

    test("does not triage unless it is enabled", async () => {
        const calls: string[] = [];
        await workflow(
            baseOptions,
            testRuntime(calls, [], {
                issueLists: [[readyIssue, candidate(50, [])]],
            }),
        );

        expect(calls.filter((call) => call.startsWith("listIssues"))).toEqual([
            "listIssues:owner/repo:bug:created:asc",
        ]);
    });

    test("triages only the three buckets", async () => {
        const seen: TriageCall[] = [];
        const notes = {
            id: 1,
            author: "ralphie",
            body: "> *This was generated by AI during triage.*\n\n## Triage Notes",
            updatedAt: "2026-08-28T00:00:00.000Z",
        };
        const reply = {
            id: 2,
            author: "reporter",
            body: "More detail.",
            updatedAt: "2026-08-28T00:00:00.000Z",
        };
        const waiting = {
            ...candidate(53, ["needs-info"]),
            author: "reporter",
            comments: [notes],
        };
        const answered = {
            ...candidate(54, ["needs-info"]),
            author: "reporter",
            comments: [notes, reply],
        };
        const handOff = {
            kind: "hand-off",
            reason: HandOffReason.NeedsHumanJudgment,
            summary: "A design call.",
            evidence: [],
            questions: ["Decide."],
        } as const;
        await workflow(
            { ...baseOptions, triage: triageOptions },
            testRuntime([], [], {
                issueLists: [
                    [],
                    [
                        candidate(49, ["bug", "ready-for-agent"]),
                        candidate(50, []),
                        candidate(51, ["needs-triage"]),
                        candidate(52, ["ready-for-human"]),
                        waiting,
                        answered,
                        candidate(55, ["wontfix"]),
                    ],
                ],
                triageService: scriptedTriage(
                    { 50: handOff, 51: handOff, 54: handOff },
                    seen,
                ),
            }),
        );

        expect(seen).toEqual([
            { issue: 50, bucket: "unlabelled" },
            { issue: 51, bucket: "needs-triage" },
            { issue: 54, bucket: "needs-info-reply" },
        ]);
    });

    test("lists triage candidates with only the required labels", async () => {
        const calls: string[] = [];
        await workflow(
            {
                ...baseOptions,
                triage: { ...triageOptions, requireLabels: ["backend"] },
            },
            testRuntime(calls, [], { issueLists: [[]] }),
        );

        expect(calls.filter((call) => call.startsWith("listIssues"))).toEqual([
            "listIssues:owner/repo:bug:created:asc",
            "listIssues:owner/repo:backend:created:asc",
        ]);
    });

    test("a promoted issue gets its brief and is implemented in the same run", async () => {
        const calls: string[] = [];
        const promotions: Array<{
            readonly issue: number;
            readonly input: GitHubHandOffInput;
        }> = [];
        const promoted = candidate(50, ["bug", "ready-for-agent"]);
        const summary = await workflow(
            { ...baseOptions, triage: triageOptions },
            testRuntime(calls, [], {
                issueLists: [[], [candidate(50, [])], [promoted]],
                refreshedIssues: { 50: promoted },
                triageService: scriptedTriage({
                    50: { kind: "promote", brief },
                }),
                githubTriage: {
                    promote: async (_repo, issue, input) => {
                        calls.push(`promote:${issue}`);
                        promotions.push({ issue, input });
                        return { comment: "created" };
                    },
                    explainImplemented: async () => ({ comment: "created" }),
                },
            }),
        );

        expect(promotions).toHaveLength(1);
        const input = promotions[0]!.input;
        expect(
            input.body.startsWith(
                "> *This was generated by AI during triage.*\n\n## Agent Brief",
            ),
        ).toBe(true);
        expect(input.label).toBe("ready-for-agent");
        expect(input.replaceLabels).toEqual(Object.values(stateLabels));
        expectCallOrder(calls, [
            "promote:50",
            "executeIssue:50:/tmp/ralphie/repo:develop:claude",
            "closeIssue:50",
        ]);
        expect(summary.counts.completed).toBe(1);
    });

    test("hand-offs go to the matching state label and are recorded", async () => {
        const handOffs: GitHubHandOffInput[] = [];
        const summary = await workflow(
            { ...baseOptions, triage: triageOptions },
            testRuntime([], [], {
                issueLists: [[], [candidate(50, []), candidate(51, [])]],
                triageService: scriptedTriage({
                    50: {
                        kind: "hand-off",
                        reason: HandOffReason.MissingInformation,
                        summary: "Unclear.",
                        evidence: ["src/a.ts"],
                        questions: ["Which version?"],
                    },
                    51: {
                        kind: "hand-off",
                        reason: HandOffReason.NeedsHumanJudgment,
                        summary: "A design call.",
                        evidence: [],
                        questions: ["Decide."],
                    },
                }),
                handOffService: {
                    handOff: async (_repo, _issue, input) => {
                        handOffs.push(input);
                        return { comment: "created" };
                    },
                },
            }),
        );

        expect(handOffs.map(({ label }) => label)).toEqual([
            "needs-info",
            "ready-for-human",
        ]);
        expect(handOffs[0]?.body).toContain("## Triage Notes");
        expect(
            handOffs.every(({ label }) => label !== stateLabels.wontfix),
        ).toBe(true);
        expect(summary.counts["hand-off"]).toBe(2);
    });

    test("an already implemented issue is explained and closed as completed", async () => {
        const calls: string[] = [];
        const comments: string[] = [];
        const summary = await workflow(
            { ...baseOptions, triage: triageOptions },
            testRuntime(calls, [], {
                issueLists: [[], [candidate(50, [])]],
                triageService: scriptedTriage({
                    50: {
                        kind: "already-implemented",
                        summary: "It lives in src/thing.ts.",
                        evidence: ["src/thing.ts"],
                    },
                }),
                githubTriage: {
                    promote: async () => ({ comment: "created" }),
                    explainImplemented: async (_repo, issue, body) => {
                        calls.push(`explain:${issue}`);
                        comments.push(body);
                        return { comment: "created" };
                    },
                },
            }),
        );

        expectCallOrder(calls, ["explain:50", "closeIssue:50"]);
        expect(
            comments[0]?.startsWith(
                "> *This was generated by AI during triage.*",
            ),
        ).toBe(true);
        expect(comments[0]).toContain("src/thing.ts");
        expect(summary.counts.completed).toBe(1);
        expect(summary.outcomes[0]?.outcome).toMatchObject({
            completion: "already-resolved",
        });
    });

    test("a failed triage session fails that issue and the run continues", async () => {
        const calls: string[] = [];
        const states: RunState[] = [];
        await expect(
            workflow(
                { ...baseOptions, triage: triageOptions },
                testRuntime(calls, states, {
                    issueLists: [[readyIssue], [candidate(50, [])]],
                    triageService: {
                        triage: async () => {
                            throw new RalphieError({
                                message: "model is down",
                            });
                        },
                    },
                }),
            ),
        ).rejects.toThrow("Run drained with issue failures");

        expect(calls.some((call) => call.startsWith("executeIssue:42"))).toBe(
            true,
        );
        expect(
            states
                .at(-1)
                ?.outcomes.find(({ issueNumber }) => issueNumber === 50)
                ?.outcome,
        ).toMatchObject({ kind: "failed" });
    });
});