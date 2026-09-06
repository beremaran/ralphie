import { describe, expect, test } from "bun:test";
import type { Octokit } from "octokit";

import {
    executeMaintenanceLifecycle,
    type MaintenanceLifecycleReport,
} from "../src/maintain-issues-lifecycle.ts";
import type { MaintenanceCandidateAnalysis } from "../src/maintain-issues-candidates.ts";
import type { MaintenancePlanRunResult } from "../src/maintain-issues-plan.ts";
import { maintenanceActionKey } from "../src/maintain-issues-plan.ts";
import type { MaintenanceSnapshot } from "../src/maintain-issues-snapshot-service.ts";
import type {
    MaintenanceIssueState,
    MaintenanceRunState,
} from "../src/maintain-issues-state.ts";
import type { GitHubIssueMaintenanceService } from "../src/github/issue-maintenance.ts";
import { IssueOrder, IssueSort } from "../src/github/issues.ts";
import {
    makeProgressRecorder,
    type ProgressUpdate,
} from "../src/progress/progress.ts";
import {
    DuplicateAction,
    ExecutionMode,
    resolveRalphieConfig,
} from "../src/options.ts";

const timestamp = "2026-09-05T00:00:00.000Z";

const action = {
    action: "add-labels" as const,
    issueNumber: 1,
    rationale: "The issue is ready for the catalog label.",
    labels: ["ready"],
    actionKey: "",
};
const actionKey = maintenanceActionKey(action);
const plan = {
    issueNumber: 1,
    snapshotFingerprint: "snapshot-1",
    summary: "Apply the ready label.",
    actions: [{ ...action, actionKey }],
};

const candidates: MaintenanceCandidateAnalysis = {
    status: "analyzed",
    subjectIssueNumber: 1,
    snapshotFingerprint: "snapshot-1",
    candidates: [],
    skips: [],
};

const snapshot = (): MaintenanceSnapshot => {
    const selectedIssue = {
        number: 1,
        title: "Keep the maintenance runner safe",
        url: "https://github.com/owner/repository/issues/1",
        body: "A bounded maintenance issue.",
        labels: [],
        assignees: [],
        state: "open" as const,
        isOpen: true,
        availability: { kind: "available" as const },
        selectedThread: { comments: [], fetchedCount: 0, truncated: false },
    };
    const summary = {
        number: 1,
        nodeId: "issue-node-1",
        title: selectedIssue.title,
        url: selectedIssue.url,
        htmlUrl: selectedIssue.url,
        labels: [],
        author: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        commentCount: 0,
        state: "open" as const,
        isOpen: true,
        raw: {},
    };
    const selection = {
        issueLabels: [],
        issueSort: IssueSort.Created,
        issueOrder: IssueOrder.Ascending,
    };
    const metadata = {
        schemaVersion: 1,
        capturedAt: timestamp,
        runId: null,
        repository: "owner/repository",
        branch: "main",
        selection,
        budgets: {
            commentPromptLimit: 1,
            threadPromptLimit: 1,
            aggregatePromptLimit: 1,
            guidancePerFileByteLimit: 1,
            guidanceAggregateByteLimit: 1,
        },
        sources: {
            github: "complete" as const,
            grounding: "skipped" as const,
            guidance: "unavailable" as const,
        },
        counts: {
            labelCount: 1,
            openIssueSummaryCount: 1,
            selectedIssueCount: 1,
            fetchedCommentCount: 0,
            issueSkipCount: 0,
            guidanceFileCount: 0,
            guidanceByteCount: 0,
        },
    };
    return {
        schemaVersion: 1,
        fingerprint: "snapshot-1",
        capturedAt: timestamp,
        runId: null,
        metadata,
        capture: metadata,
        repository: {
            fullName: "owner/repository",
            defaultBranch: "main",
            htmlUrl: "https://github.com/owner/repository",
            rawDefaultBranch: "main",
            raw: {},
        },
        labels: [
            {
                name: "ready",
                description: "Ready for work",
                color: "00ff00",
                raw: {},
            },
        ],
        openIssueSummaries: [summary],
        selectedIssueNumbers: [1],
        selectedDetails: [],
        selectedIssues: [selectedIssue],
        skips: [],
        selection,
        grounding: undefined,
        groundingOutcome: {
            status: "skipped",
            skip: { reason: "unreadable-repository", detail: "test" },
        },
        groundingSkip: { reason: "unreadable-repository", detail: "test" },
        groundingStatus: "skipped",
        guidance: undefined,
    } as unknown as MaintenanceSnapshot;
};

const configFor = (workspace: string) => {
    const config = resolveRalphieConfig({
        repo: "owner/repository",
        mode: ExecutionMode.MaintainIssues,
        branch: "main",
        workspace,
        dryRun: false,
    });
    if (config.mode !== ExecutionMode.MaintainIssues) {
        throw new Error("test config did not resolve to maintenance mode");
    }
    return config;
};

const acceptedPlan = (): MaintenancePlanRunResult =>
    ({
        status: "accepted",
        sessionID: "session-1",
        plan,
        candidates,
        skips: [],
    }) as MaintenancePlanRunResult;

const initialState = (
    issues: ReadonlyArray<MaintenanceIssueState> = [
        {
            issueNumber: 1,
            status: "pending",
            replanCount: 0,
            replanRequested: false,
            skips: [],
            actions: [],
            updatedAt: timestamp,
        },
    ],
): MaintenanceRunState => ({
    version: 1,
    mode: "maintain-issues",
    status: "active",
    runId: "run-1",
    repository: "owner/repository",
    branch: "main",
    duplicateAction: DuplicateAction.Link,
    dryRun: false,
    selection: {
        agent: "test-agent",
        issueLabels: [],
        issueSort: IssueSort.Created,
        issueOrder: IssueOrder.Ascending,
    },
    selectedIssueNumbers: [1],
    nextIssueIndex: 0,
    snapshotFingerprint: "snapshot-1",
    plans: [],
    issues: [...issues],
    reconciliationResults: [],
    skips: [],
    createdAt: timestamp,
    updatedAt: timestamp,
});

const runLifecycle = (input: {
    readonly events: ProgressUpdate[];
    readonly saved: MaintenanceRunState[];
    readonly reports: MaintenanceLifecycleReport[];
    readonly planner?: { plan: () => Promise<MaintenancePlanRunResult> };
    readonly mutation?: GitHubIssueMaintenanceService;
    readonly initial?: MaintenanceRunState;
    readonly signal?: AbortSignal;
    readonly dryRun?: boolean;
    readonly duplicateAction?: DuplicateAction;
}) => {
    const config = configFor("/tmp/maintenance-lifecycle");
    const planner = input.planner ?? { plan: async () => acceptedPlan() };
    const mutation =
        input.mutation ??
        ({
            reconcile: async () => ({
                actionKey,
                issueNumber: 1,
                status: "applied",
                mutation: "labels-added",
                changed: true,
                detail: "ready label added",
                labels: ["ready"],
            }),
        } as GitHubIssueMaintenanceService);
    return executeMaintenanceLifecycle({
        config,
        runtime: {
            maintenanceMutation: mutation,
            gitRepositoryInvariant: {
                capture: async () => ({ branch: "main", head: "test-head" }),
                verify: async () => {},
            },
        },
        signal: input.signal,
        actualRunId: "run-1",
        duplicateAction: input.duplicateAction ?? DuplicateAction.Link,
        dryRun: input.dryRun ?? false,
        selection: initialState().selection,
        branch: "main",
        repositoryPath: "/tmp/ralphie-maintenance-test/owner/repository",
        client: {} as Octokit,
        snapshot: snapshot(),
        planner,
        selectedIssueNumbers: [1],
        initialState: input.initial ?? initialState(),
        reports: input.reports,
        emit: async (update) => {
            await makeProgressRecorder(input.events).emit(update);
        },
        persist: async (next) => {
            input.saved.push(structuredClone(next));
        },
    });
};

describe("maintenance lifecycle", () => {
    test("completes a planned action and persists each transition", async () => {
        const events: ProgressUpdate[] = [];
        const saved: MaintenanceRunState[] = [];
        const reports: MaintenanceLifecycleReport[] = [];
        const outcome = await runLifecycle({ events, saved, reports });

        expect(outcome.state.issues[0]?.status).toBe("complete");
        expect(outcome.state.nextIssueIndex).toBe(1);
        expect(reports.map((report) => report.status)).toEqual(["applied"]);
        expect(saved.length).toBeGreaterThanOrEqual(4);
        expect(
            saved.some((state) =>
                state.issues.some((issue) =>
                    issue.actions.some(
                        (entry) => entry.status === "in-progress",
                    ),
                ),
            ),
        ).toBeTrue();
        expect(saved.at(-1)?.issues[0]?.actions[0]?.status).toBe("applied");
        expect(
            events.some(({ stage }) => stage === "maintenance-planning"),
        ).toBeTrue();
        expect(
            events.some(({ stage }) => stage === "maintenance-validation"),
        ).toBeTrue();
        expect(
            events.some(({ stage }) => stage === "maintenance-outcome"),
        ).toBeTrue();
    });

    test("replans after a stale live result and persists the replan", async () => {
        const events: ProgressUpdate[] = [];
        const saved: MaintenanceRunState[] = [];
        const reports: MaintenanceLifecycleReport[] = [];
        const plans: MaintenancePlanRunResult[] = [
            acceptedPlan(),
            {
                status: "accepted",
                sessionID: "session-2",
                plan: { ...plan, actions: [] },
                candidates,
                skips: [],
            } as MaintenancePlanRunResult,
        ];
        let plannerCalls = 0;
        const outcome = await runLifecycle({
            events,
            saved,
            reports,
            planner: { plan: async () => plans[plannerCalls++] ?? plans[1]! },
            mutation: {
                reconcile: async () => ({
                    actionKey,
                    issueNumber: 1,
                    status: "skipped",
                    reason: "stale-fingerprint",
                    changed: false,
                    detail: "the issue changed while planning",
                }),
            },
        });

        expect(plannerCalls).toBe(2);
        expect(outcome.state.issues[0]?.replanCount).toBe(1);
        expect(outcome.state.issues[0]?.status).toBe("complete");
        expect(
            events.filter(({ stage }) => stage === "maintenance-replan").length,
        ).toBeGreaterThan(0);
    });

    test("resumes a reconciled action without repeating the mutation", async () => {
        const events: ProgressUpdate[] = [];
        const saved: MaintenanceRunState[] = [];
        const reports: MaintenanceLifecycleReport[] = [];
        let mutationCalls = 0;
        const resumed = await runLifecycle({
            events,
            saved,
            reports,
            mutation: {
                reconcile: async () => {
                    mutationCalls += 1;
                    throw new Error("the applied action was repeated");
                },
            },
            initial: {
                ...initialState(),
                plans: [
                    {
                        issueNumber: 1,
                        snapshotFingerprint: "snapshot-1",
                        plan,
                        candidates,
                        skips: [],
                        replanCount: 0,
                        recordedAt: timestamp,
                    },
                ],
                issues: [
                    {
                        issueNumber: 1,
                        status: "planned",
                        replanCount: 0,
                        replanRequested: false,
                        plan,
                        candidates,
                        skips: [],
                        actions: [
                            {
                                actionKey,
                                action: { ...action, actionKey },
                                status: "applied",
                                attempts: 1,
                                replanCount: 0,
                                result: {
                                    actionKey,
                                    issueNumber: 1,
                                    status: "applied",
                                    detail: "already reconciled",
                                },
                                updatedAt: timestamp,
                            },
                        ],
                        updatedAt: timestamp,
                    },
                ],
                reconciliationResults: [
                    {
                        actionKey,
                        issueNumber: 1,
                        status: "applied",
                        result: {
                            actionKey,
                            issueNumber: 1,
                            status: "applied",
                            detail: "already reconciled",
                        },
                        recordedAt: timestamp,
                    },
                ],
            },
        });

        expect(mutationCalls).toBe(0);
        expect(resumed.state.issues[0]?.status).toBe("complete");
        expect(resumed.state.nextIssueIndex).toBe(1);
    });

    test("persists the authoritative result before observing interruption", async () => {
        const events: ProgressUpdate[] = [];
        const saved: MaintenanceRunState[] = [];
        const reports: MaintenanceLifecycleReport[] = [];
        const controller = new AbortController();
        await expect(
            runLifecycle({
                events,
                saved,
                reports,
                signal: controller.signal,
                mutation: {
                    reconcile: async () => {
                        controller.abort();
                        return {
                            actionKey,
                            issueNumber: 1,
                            status: "applied",
                            mutation: "labels-added",
                            changed: true,
                            detail: "accepted before cancellation",
                        };
                    },
                },
            }),
        ).rejects.toThrow();
        expect(saved.at(-1)?.issues[0]?.actions[0]?.status).toBe("applied");
        expect(reports.map((report) => report.status)).toEqual(["applied"]);
    });

    test("dry-run never calls a mutation adapter", async () => {
        const events: ProgressUpdate[] = [];
        const saved: MaintenanceRunState[] = [];
        const reports: MaintenanceLifecycleReport[] = [];
        const outcome = await runLifecycle({
            events,
            saved,
            reports,
            dryRun: true,
            mutation: {
                reconcile: async () => {
                    throw new Error("dry-run called a mutation adapter");
                },
            },
        });

        expect(outcome.state.issues[0]?.status).toBe("complete");
        expect(reports.map((report) => report.status)).toEqual(["skipped"]);
        expect(saved.length).toBeGreaterThan(0);
    });
});