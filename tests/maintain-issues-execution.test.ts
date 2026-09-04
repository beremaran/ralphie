import { describe, expect, test } from "bun:test";
import type { Octokit } from "octokit";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
    executeMaintenanceRun,
    type MaintainIssuesOptions,
} from "../src/maintain-issues.ts";
import type { MaintenanceCandidateAnalysis } from "../src/maintain-issues-candidates.ts";
import type { MaintenancePlanRunResult } from "../src/maintain-issues-plan.ts";
import { maintenanceActionKey } from "../src/maintain-issues-plan.ts";
import type { MaintenanceSnapshot } from "../src/maintain-issues-snapshot-service.ts";
import {
    MaintenanceRunStateStoreLive,
    MAINTENANCE_RUN_STATE_VERSION,
    type MaintenanceRunState,
    type MaintenanceRunStateStoreService,
} from "../src/maintain-issues-state.ts";
import type { GitHubIssueMaintenanceService } from "../src/github/issue-maintenance.ts";
import type { GitHubIssueMaintenanceRelationshipService } from "../src/github/issue-maintenance-relationships.ts";
import { IssueOrder, IssueSort } from "../src/github/issues.ts";
import {
    makeProgressRecorder,
    type ProgressUpdate,
} from "../src/progress/progress.ts";
import { ExecutionMode, resolveRalphieConfig } from "../src/options.ts";
import type { RalphieRuntime } from "../src/runtime.ts";

const timestamp = "2026-09-05T00:00:00.000Z";
const repositoryPath = "/tmp/ralphie-maintenance-test/owner/repository";

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
        selectedThread: {
            comments: [],
            fetchedCount: 0,
            truncated: false,
        },
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

const configFor = (workspace: string, dryRun = false) => {
    const config = resolveRalphieConfig({
        repo: "owner/repository",
        mode: ExecutionMode.MaintainIssues,
        branch: "main",
        workspace,
        dryRun,
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

const baseRuntime = (input: {
    readonly progressEvents: ProgressUpdate[];
    readonly snapshotService?: RalphieRuntime["maintenanceSnapshot"];
    readonly planner?: RalphieRuntime["maintenancePlanner"];
    readonly mutation?: GitHubIssueMaintenanceService;
    readonly relationships?: GitHubIssueMaintenanceRelationshipService;
    readonly stateStore?: MaintenanceRunStateStoreService;
    readonly calls?: string[];
}): RalphieRuntime => {
    const calls = input.calls ?? [];
    return {
        progress: makeProgressRecorder(input.progressEvents),
        githubClient: {
            initialize: async () => {
                calls.push("github-auth");
                return {} as Octokit;
            },
        },
        gitRepository: {
            verifyInstalled: async () => {
                calls.push("git-verify");
            },
            prepare: async () => ({
                path: repositoryPath,
                branch: "main",
                cloned: false,
                branchChanged: false,
                cleaned: false,
            }),
        },
        gitRepositoryInvariant: {
            capture: async () => ({ branch: "main", head: "test-head" }),
            verify: async () => {},
        },
        workspace: {
            prepare: async () => calls.push("workspace-prepare"),
            remove: async () => calls.push("workspace-remove"),
        },
        maintenanceSnapshot: input.snapshotService ?? {
            capture: async () => snapshot(),
            read: async () => snapshot(),
        },
        ...(input.planner === undefined
            ? {}
            : { maintenancePlanner: input.planner }),
        ...(input.mutation === undefined
            ? {}
            : { maintenanceMutation: input.mutation }),
        ...(input.relationships === undefined
            ? {}
            : { maintenanceRelationships: input.relationships }),
        ...(input.stateStore === undefined
            ? {}
            : { maintenanceRunStateStore: input.stateStore }),
    } as unknown as RalphieRuntime;
};

const appliedMutation = (calls: string[]): GitHubIssueMaintenanceService => ({
    reconcile: async (_client, _repository, request) => {
        calls.push(`mutate:${request.action.action}`);
        return {
            actionKey,
            issueNumber: 1,
            status: "applied",
            mutation: "labels-added",
            changed: true,
            detail: "ready label added",
            labels: ["ready"],
        };
    },
});

describe("maintain-issues execution", () => {
    test("persists an action before and after deterministic mutation", async () => {
        const events: ProgressUpdate[] = [];
        const calls: string[] = [];
        const saved: MaintenanceRunState[] = [];
        const stateStore: MaintenanceRunStateStoreService = {
            load: async () => {
                throw new Error("not used");
            },
            save: async (_path, state) => {
                saved.push(structuredClone(state));
            },
        };
        const planner = {
            plan: async () => acceptedPlan(),
        };
        const result = await executeMaintenanceRun(
            { config: configFor("/tmp/maintenance"), runId: "run-1" },
            baseRuntime({
                progressEvents: events,
                calls,
                planner,
                mutation: appliedMutation(calls),
                stateStore,
            }),
        );

        expect(result.counts.changed).toBe(1);
        expect(calls).toEqual([
            "workspace-prepare",
            "github-auth",
            "git-verify",
            "mutate:add-labels",
        ]);
        expect(saved.length).toBeGreaterThanOrEqual(6);
        const inProgress = saved.find((state) =>
            state.issues.some((issue) =>
                issue.actions.some((entry) => entry.status === "in-progress"),
            ),
        );
        expect(inProgress).toBeDefined();
        expect(saved.at(-1)?.issues[0]?.actions[0]?.status).toBe("applied");
        expect(
            events.some(({ stage }) => stage === "maintenance-observation"),
        ).toBeTrue();
        expect(
            events.some(({ stage }) => stage === "maintenance-validation"),
        ).toBeTrue();
        expect(
            events.some(({ stage }) => stage === "maintenance-outcome"),
        ).toBeTrue();
    });

    test("revalidates an accepted planner result before mutation", async () => {
        const events: ProgressUpdate[] = [];
        const saved: MaintenanceRunState[] = [];
        let mutationCalls = 0;
        const unsafeAction = {
            ...action,
            labels: ["not-in-the-catalog"],
        };
        const unsafePlan = {
            ...plan,
            actions: [
                {
                    ...unsafeAction,
                    actionKey: maintenanceActionKey(unsafeAction),
                },
            ],
        };
        const store: MaintenanceRunStateStoreService = {
            load: async () => {
                throw new Error("not used");
            },
            save: async (_path, state) => {
                saved.push(structuredClone(state));
            },
        };
        const result = await executeMaintenanceRun(
            { config: configFor("/tmp/maintenance"), runId: "run-validate" },
            baseRuntime({
                progressEvents: events,
                planner: {
                    plan: async () =>
                        ({
                            ...acceptedPlan(),
                            plan: unsafePlan,
                        }) as MaintenancePlanRunResult,
                },
                mutation: {
                    reconcile: async () => {
                        mutationCalls += 1;
                        throw new Error("unsafe plan reached mutation");
                    },
                },
                stateStore: store,
            }),
        );

        expect(result.counts.skipped).toBe(1);
        expect(mutationCalls).toBe(0);
        expect(saved.at(-1)?.issues[0]?.status).toBe("skipped");
        expect(
            events.some(
                ({ stage, details }) =>
                    stage === "maintenance-validation" &&
                    details?.status === "rejected",
            ),
        ).toBeTrue();
    });

    test("resumes an applied action without invoking the mutation twice", async () => {
        const events: ProgressUpdate[] = [];
        const saved: MaintenanceRunState[] = [];
        const controller = new AbortController();
        let mutationCalls = 0;
        const firstMutation: GitHubIssueMaintenanceService = {
            reconcile: async () => {
                mutationCalls += 1;
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
        };
        const store: MaintenanceRunStateStoreService = {
            load: async () => {
                throw new Error("not used");
            },
            save: async (_path, state) => {
                saved.push(structuredClone(state));
            },
        };
        await expect(
            executeMaintenanceRun(
                {
                    config: configFor("/tmp/maintenance"),
                    runId: "run-resume",
                    signal: controller.signal,
                },
                baseRuntime({
                    progressEvents: events,
                    planner: { plan: async () => acceptedPlan() },
                    mutation: firstMutation,
                    stateStore: store,
                }),
            ),
        ).rejects.toThrow();
        const failedState = saved.at(-1);
        expect(failedState?.status).toBe("failed");
        expect(failedState?.issues[0]?.actions[0]?.status).toBe("applied");

        const resumed = await executeMaintenanceRun(
            {
                config: configFor("/tmp/maintenance"),
                runId: "different-run-id",
                resumeState: failedState,
            },
            baseRuntime({
                progressEvents: [],
                planner: { plan: async () => acceptedPlan() },
                mutation: {
                    reconcile: async () => {
                        mutationCalls += 1;
                        throw new Error("the applied action was repeated");
                    },
                },
                stateStore: store,
            }),
        );

        expect(resumed.runId).toBe("run-resume");
        expect(mutationCalls).toBe(1);
        expect(resumed.counts.changed).toBe(1);
    });

    test("bounds stale replanning and records the replan event", async () => {
        const events: ProgressUpdate[] = [];
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
        const result = await executeMaintenanceRun(
            { config: configFor("/tmp/maintenance"), runId: "run-stale" },
            baseRuntime({
                progressEvents: events,
                planner: {
                    plan: async () => plans[plannerCalls++] ?? plans[1]!,
                },
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
            }),
        );

        expect(plannerCalls).toBe(2);
        expect(result.counts.replanned).toBe(1);
        expect(
            events.filter(({ stage }) => stage === "maintenance-replan").length,
        ).toBeGreaterThan(0);
    });

    test("retries a rate-limited snapshot a bounded number of times", async () => {
        const events: ProgressUpdate[] = [];
        let reads = 0;
        const snapshotService = {
            capture: async () => {
                reads += 1;
                if (reads < 3) {
                    throw Object.assign(new Error("rate limited"), {
                        status: 429,
                        retryAfterMs: 0,
                    });
                }
                return snapshot();
            },
            read: async () => snapshot(),
        };
        const result = await executeMaintenanceRun(
            { config: configFor("/tmp/maintenance"), runId: "run-rate" },
            baseRuntime({
                progressEvents: events,
                snapshotService,
                planner: {
                    plan: async () =>
                        ({
                            status: "accepted",
                            sessionID: "session-rate",
                            plan: { ...plan, actions: [] },
                            candidates,
                            skips: [],
                        }) as MaintenancePlanRunResult,
                },
            }),
        );

        expect(reads).toBe(3);
        expect(
            events.some(({ details }) => details?.kind === "rate-limit"),
        ).toBeTrue();
        expect(result.counts.unchanged).toBe(1);
    });

    test("dry-run does not prepare, mutate, persist state, or create a checkpoint", async () => {
        const directory = await mkdtemp(
            join(tmpdir(), "ralphie-maintenance-dry-run-"),
        );
        const events: ProgressUpdate[] = [];
        const calls: string[] = [];
        let saves = 0;
        const stateStore: MaintenanceRunStateStoreService = {
            load: async () => {
                throw new Error("not used");
            },
            save: async () => {
                saves += 1;
            },
        };
        try {
            const result = await executeMaintenanceRun(
                {
                    config: configFor(directory, true),
                    runId: "run-dry",
                },
                baseRuntime({
                    progressEvents: events,
                    calls,
                    planner: { plan: async () => acceptedPlan() },
                    mutation: {
                        reconcile: async () => {
                            throw new Error(
                                "dry-run called a mutation adapter",
                            );
                        },
                    },
                    stateStore,
                }),
            );

            expect(result.dryRun).toBeTrue();
            expect(result.counts.skipped).toBe(1);
            expect(calls).toEqual(["github-auth", "git-verify"]);
            expect(saves).toBe(0);
            expect(
                events.some(({ details }) => details?.kind === "mutation"),
            ).toBeTrue();
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});

describe("maintenance run state", () => {
    test("rejects a state file from another version", async () => {
        const directory = await mkdtemp(
            join(tmpdir(), "ralphie-maintenance-state-"),
        );
        const path = join(directory, "state.json");
        try {
            await writeFile(
                path,
                JSON.stringify({
                    version: MAINTENANCE_RUN_STATE_VERSION + 1,
                }),
            );
            await expect(
                MaintenanceRunStateStoreLive.load(path),
            ).rejects.toThrow("unsupported version");
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});