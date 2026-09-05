import { describe, expect, test } from "bun:test";
import type { Octokit } from "octokit";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
    runCommand,
    type CommandOutput,
    type CommandRuntime,
} from "../../src/command.ts";
import {
    analyzeMaintenanceCandidates,
    type MaintenanceCandidate,
} from "../../src/maintain-issues-candidates.ts";
import {
    executeMaintenanceRun,
    type MaintenanceRunSummary,
} from "../../src/maintain-issues.ts";
import {
    maintenanceActionKey,
    validateIssueMaintenancePlan,
    type IssueMaintenanceAction,
    type MaintenancePlanRequest,
    type MaintenancePlanRunResult,
    type MaintenancePlanService,
} from "../../src/maintain-issues-plan.ts";
import {
    createMaintainableComment,
    createMaintainableIssue,
    type MaintainableIssue,
} from "../../src/maintain-issues-snapshot.ts";
import type { MaintenanceSnapshot } from "../../src/maintain-issues-snapshot-service.ts";
import type {
    MaintenanceMutationRequest,
    MaintenanceMutationResult,
    GitHubIssueMaintenanceService,
} from "../../src/github/issue-maintenance.ts";
import type {
    GitHubIssueMaintenanceRelationshipService,
    MaintenanceRelationshipMutationRequest,
    RelationshipMutationResult,
} from "../../src/github/issue-maintenance-relationships.ts";
import { IssueOrder, IssueSort } from "../../src/github/issues.ts";
import {
    DuplicateAction,
    ExecutionMode,
    resolveRalphieConfig,
} from "../../src/options.ts";
import { RalphieExitCode } from "../../src/process/exit-code.ts";
import {
    makeProgressRecorder,
    type ProgressReporterService,
} from "../../src/progress/progress.ts";
import type { MaintenanceRunStateStoreService } from "../../src/maintain-issues-state.ts";
import type { AgentClient } from "../../src/opencode/client.ts";
import type {
    OpenCodeRuntime,
    OpenCodeService,
} from "../../src/opencode/server.ts";
import type { RalphieRuntime } from "../../src/runtime.ts";

const REPOSITORY = "owner/repository";
const TIMESTAMP = "2026-09-05T00:00:00.000Z";
const HEAD = "test-head";

const issueUrl = (number: number): string =>
    `https://github.com/${REPOSITORY}/issues/${String(number)}`;

const commentUrl = (issueNumber: number, id: number): string =>
    `${issueUrl(issueNumber)}#issuecomment-${String(id)}`;

const label = (name: string) => ({
    name,
    description: null,
    color: null,
});

const issue = (input: {
    readonly number: number;
    readonly title: string;
    readonly body?: string | null;
    readonly labels?: ReadonlyArray<string>;
    readonly comments?: ReadonlyArray<
        ReturnType<typeof createMaintainableComment>
    >;
    readonly createdAt?: string;
}): MaintainableIssue => {
    const comments = input.comments ?? [];
    return createMaintainableIssue({
        number: input.number,
        nodeId: `issue-node-${String(input.number)}`,
        title: input.title,
        body: input.body ?? null,
        url: issueUrl(input.number),
        state: "open",
        labels: (input.labels ?? []).map(label),
        createdAt:
            input.createdAt ??
            `2026-01-${String(input.number).padStart(2, "0")}T00:00:00.000Z`,
        updatedAt: TIMESTAMP,
        selectedThread: {
            comments,
            totalCount: comments.length,
            complete: true,
        },
        availability: { kind: "available", reason: null, detail: null },
    });
};

const summaryFor = (value: MaintainableIssue) => ({
    number: value.number,
    nodeId: value.nodeId,
    title: value.title,
    url: value.url,
    htmlUrl: value.url,
    labels: value.labels,
    author: null,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    commentCount: value.selectedThread.comments.length,
    state: value.state,
    isOpen: value.isOpen,
    raw: {},
});

const makeSnapshot = (
    selectedIssues: ReadonlyArray<MaintainableIssue>,
    summaries: ReadonlyArray<MaintainableIssue> = selectedIssues,
    fingerprint = "integration-snapshot",
): MaintenanceSnapshot => {
    const selection = {
        issueLabels: [],
        issueSort: IssueSort.Created,
        issueOrder: IssueOrder.Ascending,
    };
    const metadata = {
        schemaVersion: 1,
        capturedAt: TIMESTAMP,
        runId: null,
        repository: REPOSITORY,
        branch: "main",
        selection,
        budgets: {
            commentPromptLimit: 16,
            threadPromptLimit: 64,
            aggregatePromptLimit: 128,
            guidancePerFileByteLimit: 4_000,
            guidanceAggregateByteLimit: 4_000,
        },
        sources: {
            github: "complete" as const,
            grounding: "skipped" as const,
            guidance: "unavailable" as const,
        },
        counts: {
            labelCount: 4,
            openIssueSummaryCount: summaries.length,
            selectedIssueCount: selectedIssues.length,
            fetchedCommentCount: selectedIssues.reduce(
                (total, value) => total + value.selectedThread.comments.length,
                0,
            ),
            issueSkipCount: 0,
            guidanceFileCount: 0,
            guidanceByteCount: 0,
        },
    };
    return {
        schemaVersion: 1,
        fingerprint,
        capturedAt: TIMESTAMP,
        runId: null,
        metadata,
        capture: metadata,
        repository: {
            fullName: REPOSITORY,
            defaultBranch: "main",
            htmlUrl: `https://github.com/${REPOSITORY}`,
            rawDefaultBranch: "main",
            raw: {},
        },
        labels: ["ready", "bug", "duplicate", "maintenance"].map(label),
        openIssueSummaries: summaries.map(summaryFor),
        selectedIssueNumbers: selectedIssues.map((value) => value.number),
        selectedDetails: selectedIssues.map((value) => ({
            issue: value,
            thread: value.selectedThread,
            threadProjection: {
                thread: {
                    text: value.selectedThread.comments
                        .map(
                            (comment) =>
                                `#${String(comment.id)}: ${comment.body ?? ""}`,
                        )
                        .join("\n"),
                },
            },
        })),
        selectedIssues,
        skips: [],
        selection,
        grounding: undefined,
        groundingOutcome: {
            status: "skipped",
            skip: {
                reason: "unreadable-repository",
                detail: "The offline integration fixture has no repository grounding.",
            },
        },
        groundingSkip: {
            reason: "unreadable-repository",
            detail: "The offline integration fixture has no repository grounding.",
        },
        groundingStatus: "skipped",
        guidance: undefined,
    } as unknown as MaintenanceSnapshot;
};

type PlanFactory = (
    input: MaintenancePlanRequest,
    call: number,
) => ReadonlyArray<IssueMaintenanceAction>;

const makePlanner = (
    factory: PlanFactory,
): { readonly service: MaintenancePlanService; readonly calls: number[] } => {
    const calls: number[] = [];
    return {
        calls,
        service: {
            plan: async (input) => {
                const call = calls.length;
                calls.push(input.subjectIssueNumber);
                const rawPlan = {
                    issueNumber: input.subjectIssueNumber,
                    snapshotFingerprint: input.snapshot.fingerprint,
                    summary:
                        "The offline stub produced a bounded maintenance plan.",
                    actions: factory(input, call),
                };
                const validation = validateIssueMaintenancePlan(
                    input.snapshot,
                    input.subjectIssueNumber,
                    rawPlan,
                );
                if (validation.status !== "accepted") {
                    throw new Error(
                        `integration fixture produced an invalid plan: ${JSON.stringify(validation.skips)}`,
                    );
                }
                return {
                    status: "accepted",
                    sessionID: `stub-pi-${String(call + 1)}`,
                    plan: validation.plan,
                    candidates: analyzeMaintenanceCandidates(
                        input.snapshot,
                        input.subjectIssueNumber,
                    ),
                    skips: [],
                } satisfies MaintenancePlanRunResult;
            },
        },
    };
};

type MemoryStateStore = {
    readonly service: MaintenanceRunStateStoreService;
    readonly history: Array<
        Awaited<ReturnType<MaintenanceRunStateStoreService["load"]>>
    >;
};

const makeMemoryStateStore = (): MemoryStateStore => {
    const byPath = new Map<
        string,
        Awaited<ReturnType<MaintenanceRunStateStoreService["load"]>>
    >();
    const history: MemoryStateStore["history"] = [];
    return {
        history,
        service: {
            load: async (path) => {
                const state = byPath.get(path);
                if (state === undefined)
                    throw new Error(`state not found: ${path}`);
                return structuredClone(state);
            },
            save: async (path, state) => {
                const copy = structuredClone(state);
                byPath.set(path, copy);
                history.push(copy);
            },
        },
    };
};

type FakeGitHubOptions = {
    readonly issueNumbers: ReadonlyArray<number>;
    readonly permissionDenied?: boolean;
    readonly ambiguousCreateOnce?: boolean;
    readonly interruptRelatedOnce?: boolean;
    readonly abortAfterFirstMutation?: () => void;
};

type FakeGitHub = {
    readonly mutation: GitHubIssueMaintenanceService;
    readonly relationships: GitHubIssueMaintenanceRelationshipService;
    readonly calls: string[];
    readonly labels: Map<number, Set<string>>;
    readonly comments: Map<
        number,
        Array<{ readonly actionKey: string; readonly body: string }>
    >;
    readonly links: Set<string>;
    readonly relatedSides: Set<string>;
    readonly closed: Set<number>;
};

const actionKeyOf = (action: IssueMaintenanceAction): string =>
    "actionKey" in action && typeof action.actionKey === "string"
        ? action.actionKey
        : maintenanceActionKey(action);

const relationshipEvidence = (
    request: MaintenanceRelationshipMutationRequest,
    candidate: MaintenanceCandidate | undefined,
) => ({
    candidateId: candidate?.candidateId ?? null,
    snapshotFingerprint: request.snapshotFingerprint ?? null,
    liveChecks: [],
});

const makeFakeGitHub = (options: FakeGitHubOptions): FakeGitHub => {
    const calls: string[] = [];
    const labels = new Map(
        options.issueNumbers.map((number) => [number, new Set<string>()]),
    );
    const comments = new Map(
        options.issueNumbers.map((number) => [
            number,
            [] as Array<{ readonly actionKey: string; readonly body: string }>,
        ]),
    );
    const links = new Set<string>();
    const relatedSides = new Set<string>();
    const closed = new Set<number>();
    let ambiguousCreate = options.ambiguousCreateOnce === true;
    let interruptRelated = options.interruptRelatedOnce === true;

    const reconcileLabels = (
        action: Extract<
            IssueMaintenanceAction,
            { readonly action: "add-labels" }
        >,
        actionKey: string,
    ): MaintenanceMutationResult => {
        const current = labels.get(action.issueNumber);
        if (current === undefined) throw new Error("unknown fixture issue");
        const missing = action.labels.filter((name) => !current.has(name));
        for (const name of missing) current.add(name);
        options.abortAfterFirstMutation?.();
        return missing.length === 0
            ? {
                  actionKey,
                  issueNumber: action.issueNumber,
                  status: "unchanged",
                  mutation: "none",
                  changed: false,
                  detail: "all requested labels were already present",
              }
            : {
                  actionKey,
                  issueNumber: action.issueNumber,
                  status: "applied",
                  mutation: "labels-added",
                  changed: true,
                  labels: missing,
                  detail: "missing labels added",
              };
    };

    const reconcileComment = (
        action:
            | Extract<
                  IssueMaintenanceAction,
                  { readonly action: "ask-question" }
              >
            | Extract<
                  IssueMaintenanceAction,
                  { readonly action: "answer-question" }
              >,
        actionKey: string,
    ): MaintenanceMutationResult => {
        const current = comments.get(action.issueNumber);
        if (current === undefined) throw new Error("unknown fixture issue");
        const body =
            action.action === "ask-question" ? action.question : action.answer;
        if (current.some((comment) => comment.actionKey === actionKey)) {
            return {
                actionKey,
                issueNumber: action.issueNumber,
                status: "unchanged",
                mutation: "none",
                changed: false,
                detail: "the managed comment is already present",
            };
        }
        current.push({ actionKey, body });
        options.abortAfterFirstMutation?.();
        if (ambiguousCreate) {
            ambiguousCreate = false;
            throw new Error("comment create response was ambiguous");
        }
        return {
            actionKey,
            issueNumber: action.issueNumber,
            status: "applied",
            mutation: "comment-created",
            changed: true,
            detail: "managed comment created",
        };
    };

    const reconcileMutation = async (
        _client: Octokit,
        _repository: string,
        request: MaintenanceMutationRequest,
    ): Promise<MaintenanceMutationResult> => {
        const action = request.action;
        const actionKey = actionKeyOf(action);
        calls.push(`mutation:${action.action}`);
        if (options.permissionDenied === true) {
            return {
                actionKey,
                issueNumber: action.issueNumber,
                status: "skipped",
                reason: "locked-comment-not-permitted",
                detail: "permission denied (locked-comment-not-permitted) by the offline GitHub fixture",
                changed: false,
            };
        }
        if (action.action === "add-labels") {
            return reconcileLabels(action, actionKey);
        }
        if (
            action.action === "ask-question" ||
            action.action === "answer-question"
        ) {
            return reconcileComment(action, actionKey);
        }
        return {
            actionKey,
            issueNumber: action.issueNumber,
            status: "skipped",
            reason: "unsupported-action",
            detail: "the fixture only models comment and label actions",
            changed: false,
        };
    };

    const mutation: GitHubIssueMaintenanceService = {
        reconcile: reconcileMutation,
    };

    const reconcileRelated = (
        action: Extract<
            IssueMaintenanceAction,
            { readonly action: "link-related" }
        >,
        actionKey: string,
        request: MaintenanceRelationshipMutationRequest,
        pair: string,
    ): RelationshipMutationResult => {
        if (interruptRelated) {
            interruptRelated = false;
            relatedSides.add(`${pair}:lower-issue`);
            calls.push("related:lower-issue");
            throw new Error("interrupted after the first related side");
        }
        if (!relatedSides.has(`${pair}:lower-issue`)) {
            relatedSides.add(`${pair}:lower-issue`);
            calls.push("related:lower-issue");
        }
        if (!relatedSides.has(`${pair}:higher-issue`)) {
            relatedSides.add(`${pair}:higher-issue`);
            calls.push("related:higher-issue");
        }
        return {
            actionKey,
            issueNumber: action.issueNumber,
            targetIssueNumber: action.targetIssueNumber,
            status: "applied",
            mutation: "related-pair-linked",
            changed: true,
            completedSides: ["lower-issue", "higher-issue"],
            detail: "both related relationship sides are present",
            evidence: relationshipEvidence(request, request.candidate),
        };
    };

    const reconcileDuplicateLink = (
        action: Extract<
            IssueMaintenanceAction,
            { readonly action: "link-duplicate" }
        >,
        actionKey: string,
        request: MaintenanceRelationshipMutationRequest,
        pair: string,
    ): RelationshipMutationResult => {
        if (links.has(pair)) {
            return {
                actionKey,
                issueNumber: action.issueNumber,
                targetIssueNumber: action.targetIssueNumber,
                status: "unchanged",
                mutation: "none",
                changed: false,
                detail: "duplicate link is already present",
                evidence: relationshipEvidence(request, request.candidate),
            };
        }
        links.add(pair);
        calls.push("duplicate:link");
        return {
            actionKey,
            issueNumber: action.issueNumber,
            targetIssueNumber: action.targetIssueNumber,
            status: "applied",
            mutation: "duplicate-linked",
            changed: true,
            detail: "duplicate link created",
            evidence: relationshipEvidence(request, request.candidate),
        };
    };

    const reconcileDuplicateClose = (
        action: Extract<
            IssueMaintenanceAction,
            { readonly action: "close-duplicate" }
        >,
        actionKey: string,
        request: MaintenanceRelationshipMutationRequest,
        pair: string,
    ): RelationshipMutationResult => {
        links.add(pair);
        calls.push("duplicate:link");
        labels.get(action.issueNumber)?.add("duplicate");
        calls.push("duplicate:label");
        closed.add(action.issueNumber);
        calls.push("duplicate:close");
        return {
            actionKey,
            issueNumber: action.issueNumber,
            targetIssueNumber: action.targetIssueNumber,
            status: "applied",
            mutation: "duplicate-closed",
            changed: true,
            detail: "duplicate link, label, and close reconciled in order",
            evidence: relationshipEvidence(request, request.candidate),
        };
    };

    const reconcileRelationship = async (
        _client: Octokit,
        _repository: string,
        request: MaintenanceRelationshipMutationRequest,
    ): Promise<RelationshipMutationResult> => {
        const action = request.action;
        const actionKey = actionKeyOf(action);
        const pair = `${String(action.issueNumber)}->${String(action.targetIssueNumber)}`;
        calls.push(`relationship:${action.action}`);
        if (options.permissionDenied === true) {
            return {
                actionKey,
                issueNumber: action.issueNumber,
                targetIssueNumber: action.targetIssueNumber,
                status: "skipped",
                reason: "locked-comment-not-permitted",
                detail: "permission denied (locked-comment-not-permitted) by the offline GitHub fixture",
                changed: false,
                evidence: relationshipEvidence(request, request.candidate),
            };
        }
        if (action.action === "link-related") {
            return reconcileRelated(action, actionKey, request, pair);
        }
        if (action.action === "link-duplicate") {
            return reconcileDuplicateLink(action, actionKey, request, pair);
        }
        return reconcileDuplicateClose(action, actionKey, request, pair);
    };

    const relationships: GitHubIssueMaintenanceRelationshipService = {
        reconcile: reconcileRelationship,
    };
    return {
        mutation,
        relationships,
        calls,
        labels,
        comments,
        links,
        relatedSides,
        closed,
    };
};

const makeStubPi = (calls: string[]): OpenCodeService => {
    const client = {
        session: {
            create: async () => ({ data: { id: "stub-pi-session" } }),
            prompt: async () => ({ data: { info: {}, parts: [] } }),
        },
        close: () => calls.push("pi-client-close"),
    } as unknown as AgentClient;
    const runtime = {
        url: "http://127.0.0.1:1",
        client,
        close: async () => calls.push("pi-close"),
    } as unknown as OpenCodeRuntime;
    return {
        start: async () => {
            calls.push("pi-start");
            return runtime;
        },
    };
};

const configFor = (
    workspace: string,
    input: {
        readonly duplicateAction?: DuplicateAction;
        readonly dryRun?: boolean;
    } = {},
) => {
    const config = resolveRalphieConfig({
        repo: REPOSITORY,
        mode: ExecutionMode.MaintainIssues,
        branch: "main",
        workspace,
        duplicateAction: input.duplicateAction,
        dryRun: input.dryRun,
    });
    if (config.mode !== ExecutionMode.MaintainIssues) {
        throw new Error("integration fixture did not resolve maintenance mode");
    }
    return config;
};

const makeRuntime = (input: {
    readonly snapshot: MaintenanceSnapshot;
    readonly planner: MaintenancePlanService;
    readonly github: FakeGitHub;
    readonly stateStore: MaintenanceRunStateStoreService;
    readonly calls: string[];
    readonly progress?: ProgressReporterService;
    readonly opencode?: OpenCodeService;
}): RalphieRuntime => {
    const progress = input.progress ?? makeProgressRecorder([]);
    const opencode = input.opencode ?? makeStubPi(input.calls);
    return {
        progress,
        opencode,
        githubClient: {
            initialize: async () => {
                input.calls.push("github-auth");
                return {} as Octokit;
            },
        },
        gitRepository: {
            verifyInstalled: async () => input.calls.push("git-verify"),
            prepare: async () => {
                input.calls.push("git-prepare");
                return {
                    path: "/tmp/ralphie-maintenance-integration/owner/repository",
                    branch: "main",
                    cloned: false,
                    branchChanged: false,
                    cleaned: false,
                };
            },
        },
        gitRepositoryInvariant: {
            capture: async () => {
                input.calls.push("git-invariant-read");
                return { branch: "main", head: HEAD };
            },
            verify: async () => {},
        },
        workspace: {
            prepare: async () => input.calls.push("workspace-prepare"),
            remove: async () => input.calls.push("workspace-remove"),
        },
        maintenanceSnapshot: {
            capture: async () => input.snapshot,
            read: async () => input.snapshot,
        },
        maintenancePlannerForAgent: () => input.planner,
        maintenanceMutation: input.github.mutation,
        maintenanceRelationships: input.github.relationships,
        maintenanceRunStateStore: input.stateStore,
    } as unknown as RalphieRuntime;
};

const runOffline = async (input: {
    readonly workspace: string;
    readonly snapshot: MaintenanceSnapshot;
    readonly planner: MaintenancePlanService;
    readonly github: FakeGitHub;
    readonly stateStore: MemoryStateStore;
    readonly runId: string;
    readonly duplicateAction?: DuplicateAction;
    readonly dryRun?: boolean;
    readonly signal?: AbortSignal;
    readonly resumeState?: Awaited<
        ReturnType<MaintenanceRunStateStoreService["load"]>
    >;
}): Promise<MaintenanceRunSummary> => {
    const calls = input.github.calls;
    return executeMaintenanceRun(
        {
            config: configFor(input.workspace, {
                duplicateAction: input.duplicateAction,
                dryRun: input.dryRun,
            }),
            runId: input.runId,
            signal: input.signal,
            resumeState: input.resumeState,
        },
        makeRuntime({
            snapshot: input.snapshot,
            planner: input.planner,
            github: input.github,
            stateStore: input.stateStore.service,
            calls,
        }),
    );
};

const addLabelsAction = (
    issueNumber: number,
    labels: ReadonlyArray<string> = ["ready"],
): IssueMaintenanceAction => ({
    action: "add-labels",
    issueNumber,
    labels: [...labels],
    rationale: "The labels are present in the repository catalog.",
});

const askAction = (
    issueNumber: number,
    question = "Which deployment is affected?",
): IssueMaintenanceAction => ({
    action: "ask-question",
    issueNumber,
    question,
    rationale: "The captured issue does not answer this question.",
});

const answerAction = (
    issueNumber: number,
    commentId: number,
    answer = "Use the blue deployment.",
): IssueMaintenanceAction => ({
    action: "answer-question",
    issueNumber,
    commentId,
    answer,
    rationale: "The captured source comment grounds this answer.",
    sourceUrl: commentUrl(issueNumber, commentId),
    sourceFingerprint: "integration-snapshot",
});

const relatedAction = (): IssueMaintenanceAction => ({
    action: "link-related",
    issueNumber: 1,
    targetIssueNumber: 2,
    targetUrl: issueUrl(2),
    candidateId: "issue:1->2",
    sourceFingerprint: "integration-snapshot",
    rationale: "The issues explicitly describe a related pair.",
});

const duplicateAction = (
    action: "link-duplicate" | "close-duplicate",
): IssueMaintenanceAction => {
    const base = {
        issueNumber: 2,
        targetIssueNumber: 1,
        targetUrl: issueUrl(1),
        candidateId: "issue:1->2",
        sourceFingerprint: "integration-snapshot",
        rationale: "The exact-title candidate identifies issue 1 as canonical.",
    };
    return action === "close-duplicate"
        ? { ...base, action, reason: "duplicate" }
        : { ...base, action };
};

const commentFor = (issueNumber: number, id: number, body: string) =>
    createMaintainableComment({
        id,
        nodeId: `comment-node-${String(id)}`,
        url: commentUrl(issueNumber, id),
        author: { login: "human", type: "User" },
        authorAssociation: "NONE",
        body,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
    });

describe("offline maintain-issues integration", () => {
    test("reports a well-maintained issue as unchanged", async () => {
        const workspace = await mkdtemp(
            join(tmpdir(), "ralphie-maintain-e2e-"),
        );
        try {
            const selected = issue({
                number: 1,
                title: "Healthy issue",
                labels: ["bug"],
            });
            const snapshot = makeSnapshot([selected]);
            const planner = makePlanner(() => []);
            const github = makeFakeGitHub({ issueNumbers: [1] });
            const stateStore = makeMemoryStateStore();
            const result = await runOffline({
                workspace,
                snapshot,
                planner: planner.service,
                github,
                stateStore,
                runId: "unchanged",
            });

            expect(result.counts).toMatchObject({
                unchanged: 1,
                changed: 0,
                skipped: 0,
            });
            expect(github.calls).not.toContain("mutation:add-labels");
            expect(github.calls).toContain("pi-start");
            expect(github.calls).toContain("pi-close");
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    test("adds a missing label and asks exactly one question when candidates are ambiguous", async () => {
        const workspace = await mkdtemp(
            join(tmpdir(), "ralphie-maintain-e2e-"),
        );
        try {
            const selected = issue({
                number: 1,
                title: "Deployment failure",
                body: "canonical #2 and canonical #3",
                labels: ["bug"],
            });
            const targetTwo = issue({
                number: 2,
                title: "Deployment failure",
                labels: ["bug"],
            });
            const targetThree = issue({
                number: 3,
                title: "Deployment failure",
                labels: ["bug"],
            });
            const snapshot = makeSnapshot(
                [selected],
                [selected, targetTwo, targetThree],
            );
            const planner = makePlanner(() => [
                addLabelsAction(1),
                askAction(1),
            ]);
            const github = makeFakeGitHub({ issueNumbers: [1, 2, 3] });
            const stateStore = makeMemoryStateStore();
            const result = await runOffline({
                workspace,
                snapshot,
                planner: planner.service,
                github,
                stateStore,
                runId: "ambiguous-question",
            });

            const candidates = analyzeMaintenanceCandidates(snapshot, 1);
            expect(
                candidates.skips.some(
                    (skip) => skip.reason === "ambiguous-canonical",
                ),
            ).toBeTrue();
            expect(result.counts.changed).toBe(2);
            expect(github.labels.get(1)).toEqual(new Set(["ready"]));
            expect(github.comments.get(1)).toHaveLength(1);
            expect(github.comments.get(1)?.[0]?.body).toBe(
                "Which deployment is affected?",
            );
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    test("creates a grounded managed answer and leaves an idempotent rerun unchanged", async () => {
        const workspace = await mkdtemp(
            join(tmpdir(), "ralphie-maintain-e2e-"),
        );
        try {
            const source = commentFor(1, 11, "Which deployment is affected?");
            const selected = issue({
                number: 1,
                title: "Deployment question",
                comments: [source],
            });
            const snapshot = makeSnapshot([selected]);
            const planner = makePlanner(() => [answerAction(1, 11)]);
            const github = makeFakeGitHub({ issueNumbers: [1] });
            const stateStore = makeMemoryStateStore();
            const first = await runOffline({
                workspace,
                snapshot,
                planner: planner.service,
                github,
                stateStore,
                runId: "answer-first",
            });
            const second = await runOffline({
                workspace,
                snapshot,
                planner: planner.service,
                github,
                stateStore,
                runId: "answer-second",
            });

            expect(first.counts.changed).toBe(1);
            expect(second.counts.unchanged).toBe(1);
            expect(github.comments.get(1)).toHaveLength(1);
            expect(
                github.calls.filter(
                    (call) => call === "mutation:answer-question",
                ),
            ).toHaveLength(2);
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    test("resumes reciprocal related links after interruption on the first side", async () => {
        const workspace = await mkdtemp(
            join(tmpdir(), "ralphie-maintain-e2e-"),
        );
        try {
            const selected = issue({
                number: 1,
                title: "Authentication timeout",
                body: "This issue remains related to #2.",
                labels: ["bug"],
            });
            const target = issue({
                number: 2,
                title: "Database timeout",
                labels: ["bug"],
            });
            const snapshot = makeSnapshot([selected], [selected, target]);
            const planner = makePlanner(() => [relatedAction()]);
            const github = makeFakeGitHub({
                issueNumbers: [1, 2],
                interruptRelatedOnce: true,
            });
            const stateStore = makeMemoryStateStore();
            await expect(
                runOffline({
                    workspace,
                    snapshot,
                    planner: planner.service,
                    github,
                    stateStore,
                    runId: "related-interrupted",
                }),
            ).rejects.toThrow("first related side");
            const failedState = stateStore.history.at(-1);
            expect(failedState?.issues[0]?.actions[0]?.status).toBe(
                "in-progress",
            );

            const resumed = await runOffline({
                workspace,
                snapshot,
                planner: planner.service,
                github,
                stateStore,
                runId: "different-id",
                resumeState: failedState,
            });

            expect(resumed.counts.changed).toBe(1);
            expect(github.relatedSides).toEqual(
                new Set(["1->2:lower-issue", "1->2:higher-issue"]),
            );
            expect(
                github.calls.filter(
                    (call) => call === "relationship:link-related",
                ),
            ).toHaveLength(2);
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    test("links open duplicates by default, and closes only with explicit opt-in in safe order", async () => {
        const workspace = await mkdtemp(
            join(tmpdir(), "ralphie-maintain-e2e-"),
        );
        try {
            const canonical = issue({
                number: 1,
                title: "Exact duplicate",
                createdAt: "2026-01-01T00:00:00.000Z",
            });
            const duplicate = issue({
                number: 2,
                title: "Exact duplicate",
                createdAt: "2026-01-02T00:00:00.000Z",
            });
            const snapshot = makeSnapshot([canonical], [canonical, duplicate]);
            const defaultPlanner = makePlanner(() => [
                duplicateAction("link-duplicate"),
            ]);
            const defaultGithub = makeFakeGitHub({ issueNumbers: [1, 2] });
            const defaultStore = makeMemoryStateStore();
            await runOffline({
                workspace,
                snapshot,
                planner: defaultPlanner.service,
                github: defaultGithub,
                stateStore: defaultStore,
                runId: "duplicate-link",
            });
            expect(defaultGithub.links).toEqual(new Set(["2->1"]));
            expect(defaultGithub.closed.size).toBe(0);

            const closePlanner = makePlanner(() => [
                duplicateAction("close-duplicate"),
            ]);
            const closeGithub = makeFakeGitHub({ issueNumbers: [1, 2] });
            const closeStore = makeMemoryStateStore();
            await runOffline({
                workspace,
                snapshot,
                planner: closePlanner.service,
                github: closeGithub,
                stateStore: closeStore,
                runId: "duplicate-close",
                duplicateAction: DuplicateAction.Close,
            });
            expect(
                closeGithub.calls.filter((call) =>
                    call.startsWith("duplicate:"),
                ),
            ).toEqual(["duplicate:link", "duplicate:label", "duplicate:close"]);
            expect(closeGithub.closed).toEqual(new Set([2]));
            expect(closeGithub.labels.get(2)).toEqual(new Set(["duplicate"]));
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    test("replans a stale issue and reconciles an ambiguous comment create on resume", async () => {
        const workspace = await mkdtemp(
            join(tmpdir(), "ralphie-maintain-e2e-"),
        );
        try {
            const selected = issue({
                number: 1,
                title: "Stale maintenance issue",
            });
            const snapshot = makeSnapshot([selected]);
            const stalePlanner = makePlanner((_input, call) =>
                call === 0 ? [addLabelsAction(1)] : [],
            );
            const staleGithub = makeFakeGitHub({ issueNumbers: [1] });
            const originalReconcile = staleGithub.mutation.reconcile;
            let stale = true;
            const staleMutation: GitHubIssueMaintenanceService = {
                reconcile: async (client, repository, request) => {
                    if (stale) {
                        stale = false;
                        return {
                            actionKey: actionKeyOf(request.action),
                            issueNumber: request.action.issueNumber,
                            status: "skipped",
                            reason: "stale-fingerprint",
                            changed: false,
                            detail: "the issue changed after the plan was captured",
                        };
                    }
                    return originalReconcile(client, repository, request);
                },
            };
            const staleResult = await runOffline({
                workspace,
                snapshot,
                planner: stalePlanner.service,
                github: { ...staleGithub, mutation: staleMutation },
                stateStore: makeMemoryStateStore(),
                runId: "stale",
            });
            expect(staleResult.counts.replanned).toBe(1);
            expect(stalePlanner.calls).toHaveLength(2);

            const questionPlanner = makePlanner(() => [
                askAction(1, "Which region is affected?"),
            ]);
            const questionGithub = makeFakeGitHub({
                issueNumbers: [1],
                ambiguousCreateOnce: true,
            });
            const questionStore = makeMemoryStateStore();
            await expect(
                runOffline({
                    workspace,
                    snapshot,
                    planner: questionPlanner.service,
                    github: questionGithub,
                    stateStore: questionStore,
                    runId: "ambiguous-create",
                }),
            ).rejects.toThrow("ambiguous");
            const failedState = questionStore.history.at(-1);
            expect(failedState?.issues[0]?.actions[0]?.status).toBe(
                "in-progress",
            );
            const resumed = await runOffline({
                workspace,
                snapshot,
                planner: questionPlanner.service,
                github: questionGithub,
                stateStore: questionStore,
                runId: "ambiguous-create-resume",
                resumeState: failedState,
            });
            expect(resumed.counts.unchanged).toBe(1);
            expect(questionGithub.comments.get(1)).toHaveLength(1);
            expect(
                questionGithub.calls.filter(
                    (call) => call === "mutation:ask-question",
                ),
            ).toHaveLength(2);
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    test("keeps permission skips in the audit result and resumes exactly after cancellation between mutations", async () => {
        const workspace = await mkdtemp(
            join(tmpdir(), "ralphie-maintain-e2e-"),
        );
        try {
            const selected = issue({
                number: 1,
                title: "Permission and cancellation fixture",
            });
            const snapshot = makeSnapshot([selected]);
            const deniedPlanner = makePlanner(() => [askAction(1)]);
            const deniedGithub = makeFakeGitHub({
                issueNumbers: [1],
                permissionDenied: true,
            });
            const deniedStore = makeMemoryStateStore();
            const deniedResult = await runOffline({
                workspace,
                snapshot,
                planner: deniedPlanner.service,
                github: deniedGithub,
                stateStore: deniedStore,
                runId: "permission",
            });
            expect(deniedResult.counts.skipped).toBe(1);
            expect(
                deniedResult.evidence.some((value) =>
                    JSON.stringify(value).includes(
                        "locked-comment-not-permitted",
                    ),
                ),
            ).toBeTrue();
            expect(deniedStore.history.at(-1)?.reconciliationResults).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        status: "skipped",
                        result: expect.objectContaining({
                            reason: "locked-comment-not-permitted",
                        }),
                    }),
                ]),
            );

            const controller = new AbortController();
            const cancellationPlanner = makePlanner(() => [
                addLabelsAction(1),
                askAction(1),
            ]);
            const cancellationGithub = makeFakeGitHub({
                issueNumbers: [1],
                abortAfterFirstMutation: () => controller.abort(),
            });
            const cancellationStore = makeMemoryStateStore();
            await expect(
                runOffline({
                    workspace,
                    snapshot,
                    planner: cancellationPlanner.service,
                    github: cancellationGithub,
                    stateStore: cancellationStore,
                    runId: "cancel-between-actions",
                    signal: controller.signal,
                }),
            ).rejects.toThrow();
            const failedState = cancellationStore.history.at(-1);
            expect(
                failedState?.issues[0]?.actions.map((action) => action.status),
            ).toEqual(["applied", "pending"]);
            const resumed = await runOffline({
                workspace,
                snapshot,
                planner: cancellationPlanner.service,
                github: cancellationGithub,
                stateStore: cancellationStore,
                runId: "cancel-between-actions-resume",
                resumeState: failedState,
            });
            expect(resumed.counts.changed).toBe(2);
            expect(
                cancellationGithub.calls.filter(
                    (call) => call === "mutation:add-labels",
                ),
            ).toHaveLength(1);
            expect(
                cancellationGithub.calls.filter(
                    (call) => call === "mutation:ask-question",
                ),
            ).toHaveLength(1);
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });
});

type Capture = CommandOutput & {
    readonly stdoutBytes: () => string;
    readonly stderrBytes: () => string;
};

const captureOutput = (): Capture => {
    let stdout = "";
    let stderr = "";
    return {
        stdout: (text) => {
            stdout += text;
        },
        stderr: (text) => {
            stderr += text;
        },
        stdoutBytes: () => stdout,
        stderrBytes: () => stderr,
    };
};

const runCommandMode = async (input: {
    readonly mode: "default" | "verbose" | "quiet" | "json";
    readonly workspace: string;
    readonly dryRun?: boolean;
    readonly permissionDenied?: boolean;
}): Promise<{
    readonly capture: Capture;
    readonly github: FakeGitHub;
    readonly calls: string[];
    readonly snapshot: MaintenanceSnapshot;
}> => {
    const selected = issue({ number: 1, title: "Command boundary fixture" });
    const snapshot = makeSnapshot([selected]);
    const planner = makePlanner(() => [askAction(1)]);
    const github = makeFakeGitHub({
        issueNumbers: [1],
        permissionDenied: input.permissionDenied,
    });
    const calls = github.calls;
    const stateStore = makeMemoryStateStore();
    const capture = captureOutput();
    const outputFlag = input.mode === "default" ? [] : ["--output", input.mode];
    const args = [
        REPOSITORY,
        "--mode",
        "maintain-issues",
        "--workspace",
        input.workspace,
        ...outputFlag,
        ...(input.dryRun ? ["--dry-run"] : []),
    ];
    await runCommand(args, {
        terminal: { isInteractive: false, isCI: true, width: 80 },
        output: capture,
        factories: {
            makeOpenCode: () => makeStubPi(calls),
            makeRuntime: ({ opencode, progress }) =>
                makeRuntime({
                    snapshot,
                    planner: planner.service,
                    github,
                    stateStore: stateStore.service,
                    calls,
                    opencode,
                    progress,
                }) as CommandRuntime,
        },
    });
    return { capture, github, calls, snapshot };
};

type CommandMode = "default" | "verbose" | "quiet" | "json";
type CommandModeResult = Awaited<ReturnType<typeof runCommandMode>>;

const assertJsonOutput = (capture: Capture): void => {
    expect(capture.stderrBytes()).toBe("");
    const records = capture
        .stdoutBytes()
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(
        records.some((record) => record.stage === "maintenance-mutation"),
    ).toBeTrue();
    expect(capture.stdoutBytes()).toContain("locked-comment-not-permitted");
};

const assertHumanOutput = (capture: Capture, verbose: boolean): void => {
    expect(capture.stdoutBytes()).toBe("");
    expect(capture.stderrBytes()).toContain("locked-comment-not-permitted");
    if (verbose) {
        expect(capture.stderrBytes()).toContain(
            '"reason":"locked-comment-not-permitted"',
        );
    }
};

const assertCommandModeOutput = (
    mode: CommandMode,
    result: CommandModeResult,
): void => {
    expect(result.github.calls).toContain("mutation:ask-question");
    if (mode === "json") {
        assertJsonOutput(result.capture);
    } else if (mode === "quiet") {
        expect(result.capture.stdoutBytes()).toBe("");
        expect(result.capture.stderrBytes()).toBe("");
    } else {
        assertHumanOutput(result.capture, mode === "verbose");
    }
};

describe("maintain-issues command boundary", () => {
    test("keeps human, verbose, quiet, and JSON output mode semantics equivalent", async () => {
        const modes = ["default", "verbose", "quiet", "json"] as const;
        for (const mode of modes) {
            const workspace = await mkdtemp(
                join(tmpdir(), "ralphie-maintain-command-"),
            );
            try {
                const result = await runCommandMode({
                    mode,
                    workspace,
                    permissionDenied: true,
                });
                assertCommandModeOutput(mode, result);
            } finally {
                await rm(workspace, { recursive: true, force: true });
                process.exitCode = 0;
            }
        }
    });

    test("dry-run produces complete JSON discovery without GitHub/Git/state-file mutation", async () => {
        const workspace = await mkdtemp(
            join(tmpdir(), "ralphie-maintain-dry-command-"),
        );
        try {
            const result = await runCommandMode({
                mode: "json",
                workspace,
                dryRun: true,
            });
            const statePath = join(
                workspace,
                ".ralphie",
                "runs",
                "unknown",
                "state.json",
            );
            expect(result.calls).toContain("github-auth");
            expect(result.calls).toContain("git-verify");
            expect(result.calls).toContain("git-invariant-read");
            expect(result.calls).not.toContain("workspace-prepare");
            expect(result.calls).not.toContain("git-prepare");
            expect(result.calls).not.toContain("mutation:ask-question");
            expect(result.capture.stderrBytes()).toBe("");
            expect(result.capture.stdoutBytes()).toContain("dry-run");
            expect(result.capture.stdoutBytes()).toContain("ask-question");
            expect(result.capture.stdoutBytes()).toContain(
                "selectedIssueNumbers",
            );
            await expect(readFile(statePath, "utf8")).rejects.toThrow();
            await expect(
                readFile(join(workspace, ".ralphie", "runs"), "utf8"),
            ).rejects.toThrow();
        } finally {
            await rm(workspace, { recursive: true, force: true });
            process.exitCode = 0;
        }
    });

    test("reports a maintenance failure with the ordinary failure exit code", async () => {
        const workspace = await mkdtemp(
            join(tmpdir(), "ralphie-maintain-failure-"),
        );
        try {
            const selected = issue({ number: 1, title: "Failure fixture" });
            const snapshot = makeSnapshot([selected]);
            const planner = makePlanner(() => [askAction(1)]);
            const github = makeFakeGitHub({ issueNumbers: [1] });
            const stateStore = makeMemoryStateStore();
            const failing: GitHubIssueMaintenanceService = {
                reconcile: async () => {
                    throw new Error("deterministic fixture failure");
                },
            };
            const capture = captureOutput();
            await expect(
                runCommand(
                    [
                        REPOSITORY,
                        "--mode",
                        "maintain-issues",
                        "--workspace",
                        workspace,
                    ],
                    {
                        terminal: {
                            isInteractive: false,
                            isCI: true,
                            width: 80,
                        },
                        output: capture,
                        factories: {
                            makeOpenCode: () => makeStubPi(github.calls),
                            makeRuntime: ({ opencode, progress }) =>
                                makeRuntime({
                                    snapshot,
                                    planner: planner.service,
                                    github: { ...github, mutation: failing },
                                    stateStore: stateStore.service,
                                    calls: github.calls,
                                    opencode,
                                    progress,
                                }) as CommandRuntime,
                        },
                    },
                ),
            ).rejects.toThrow("deterministic fixture failure");
            expect(process.exitCode).toBe(RalphieExitCode.Failure);
            expect(capture.stderrBytes()).toContain("Maintenance failed");
        } finally {
            await rm(workspace, { recursive: true, force: true });
            process.exitCode = 0;
        }
    });

    test("maps cancellation at the command boundary to the cancellation exit code", async () => {
        const workspace = await mkdtemp(
            join(tmpdir(), "ralphie-maintain-cancel-"),
        );
        try {
            const selected = issue({
                number: 1,
                title: "Cancellation fixture",
            });
            const snapshot = makeSnapshot([selected]);
            const planner = makePlanner(() => [addLabelsAction(1)]);
            const controller = new AbortController();
            const github = makeFakeGitHub({
                issueNumbers: [1],
                abortAfterFirstMutation: () => controller.abort(),
            });
            const stateStore = makeMemoryStateStore();
            const capture = captureOutput();
            await expect(
                runCommand(
                    [
                        REPOSITORY,
                        "--mode",
                        "maintain-issues",
                        "--workspace",
                        workspace,
                    ],
                    {
                        signal: controller.signal,
                        terminal: {
                            isInteractive: false,
                            isCI: true,
                            width: 80,
                        },
                        output: capture,
                        factories: {
                            makeOpenCode: () => makeStubPi(github.calls),
                            makeRuntime: ({ opencode, progress }) =>
                                makeRuntime({
                                    snapshot,
                                    planner: planner.service,
                                    github,
                                    stateStore: stateStore.service,
                                    calls: github.calls,
                                    opencode,
                                    progress,
                                }) as CommandRuntime,
                        },
                    },
                ),
            ).rejects.toThrow();
            expect(process.exitCode).toBe(RalphieExitCode.Cancelled);
        } finally {
            await rm(workspace, { recursive: true, force: true });
            process.exitCode = 0;
        }
    });
});