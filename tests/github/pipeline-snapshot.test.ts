import { describe, expect, test } from "bun:test";
import {
    classifyPipelineState,
    classifyPipelineStatus,
    haveSamePipelineSnapshot,
    isPipelineGreenCandidate,
    normalizePipelineSnapshot,
    PIPELINE_CHECK_SUITE_FALLBACK_NAME,
    type JsonObject,
    type PipelineSnapshotRequest,
} from "../../src/github/pipeline-snapshot.ts";

const sha = "a".repeat(40);
const request: PipelineSnapshotRequest = {
    repository: "owner/repository",
    branch: "main",
    commitSha: sha,
};

const checkRun = (overrides: JsonObject = {}) => ({
    kind: "check-run" as const,
    provider: "github-actions",
    name: "build",
    sha,
    branch: "main",
    status: "completed",
    conclusion: "success",
    ...overrides,
});

describe("pipeline snapshot normalization", () => {
    test("classifies every supported state", () => {
        for (const state of [
            "queued",
            "requested",
            "waiting",
            "pending",
            "in-progress",
        ]) {
            expect(classifyPipelineStatus(state)).toBe("pending");
        }
        expect(classifyPipelineStatus("success")).toBe("passing");
        for (const state of ["neutral", "skipped"])
            expect(classifyPipelineStatus(state)).toBe("acceptable");
        for (const state of [
            "failure",
            "timed_out",
            "error",
            "action_required",
            "startup_failure",
        ]) {
            expect(classifyPipelineStatus(state)).toBe("failing");
        }
        for (const state of ["cancelled", "stale", "superseded"])
            expect(classifyPipelineStatus(state)).toBe("cancelled");
    });

    test("rejects prototype, future, malformed, and contradictory states", () => {
        for (const state of [
            "__proto__",
            "constructor",
            "toString",
            "future",
        ]) {
            expect(classifyPipelineStatus(state)).toBe("unknown");
        }
        expect(classifyPipelineState({ status: 42 })).toBe("unknown");
        expect(
            classifyPipelineState({
                status: "in_progress",
                conclusion: "success",
            }),
        ).toBe("unknown");
        expect(
            classifyPipelineState({
                status: "future_status",
                conclusion: "success",
            }),
        ).toBe("unknown");
        expect(
            classifyPipelineState({
                status: "completed",
                state: "failure",
                conclusion: "success",
            }),
        ).toBe("unknown");
        expect(classifyPipelineState({ status: "completed" })).toBe("unknown");
        expect(
            classifyPipelineState({
                status: "completed",
                conclusion: "pending",
            }),
        ).toBe("unknown");
    });

    test("keeps only observations for the requested exact SHA and branch", () => {
        const snapshot = normalizePipelineSnapshot({
            ...request,
            observations: [
                checkRun({ checkRunId: 1 }),
                checkRun({ sha: "b".repeat(40), checkRunId: 2 }),
                checkRun({ branch: "release", checkRunId: 3 }),
                checkRun({ branch: ["main", "release"], checkRunId: 4 }),
            ],
        });

        expect(snapshot.items).toHaveLength(1);
        expect(snapshot.items[0]?.diagnostic.checkRunId).toBe(1);
        expect(
            snapshot.diagnostics.filter(
                (diagnostic) => diagnostic.disposition === "out-of-scope",
            ),
        ).toHaveLength(2);
        expect(
            snapshot.diagnostics.find(
                (diagnostic) => diagnostic.rawValues.sha === "b".repeat(40),
            ),
        ).toBeDefined();
        expect(snapshot.completenessErrors).toContain("ambiguous branch");
        expect(snapshot.greenCandidate).toBe(false);
    });

    test("does not merge equal names from different providers", () => {
        const snapshot = normalizePipelineSnapshot({
            ...request,
            observations: [
                checkRun({ provider: "provider-a", checkRunId: 1 }),
                checkRun({ provider: "provider-b", checkRunId: 2 }),
            ],
        });

        expect(snapshot.items).toHaveLength(2);
        expect(snapshot.items.map(({ provider }) => provider)).toEqual([
            "provider-a",
            "provider-b",
        ]);
    });

    test("uses a stable check-suite fallback instead of its suite ID", () => {
        const snapshot = normalizePipelineSnapshot({
            ...request,
            checkSuites: [
                {
                    suiteId: 123,
                    sha,
                    branch: "main",
                    status: "completed",
                    conclusion: "success",
                },
            ],
        });

        expect(snapshot.items[0]?.name).toBe(
            PIPELINE_CHECK_SUITE_FALLBACK_NAME,
        );
        expect(snapshot.items[0]?.diagnostic.suiteId).toBe(123);
    });

    test("normalizes check-runs, suites, status contexts, and workflow runs", () => {
        const snapshot = normalizePipelineSnapshot({
            ...request,
            checkRuns: [checkRun({ name: "check" })],
            checkSuites: [
                {
                    name: "suite",
                    sha,
                    branch: "main",
                    status: "completed",
                    conclusion: "neutral",
                },
            ],
            statusContexts: [
                {
                    context: "legacy",
                    sha,
                    branch: "main",
                    state: "success",
                },
            ],
            workflowRuns: [
                {
                    name: "workflow",
                    sha,
                    branch: "main",
                    status: "completed",
                    conclusion: "skipped",
                },
            ],
        });

        expect(new Set(snapshot.items.map(({ name }) => name))).toEqual(
            new Set(["check", "legacy", "suite", "workflow"]),
        );
        expect(new Set(snapshot.items.map(({ status }) => status))).toEqual(
            new Set(["passing", "acceptable"]),
        );
        expect(snapshot.reason).toBe("failure");
        expect(snapshot.greenCandidate).toBe(false);
    });

    test("keeps Check Runs and legacy statuses distinct even with one provider and name", () => {
        const snapshot = normalizePipelineSnapshot({
            ...request,
            observations: [
                checkRun({ provider: "ci", name: "build", checkRunId: 1 }),
                {
                    kind: "status-context",
                    provider: "ci",
                    context: "build",
                    id: 2,
                    sha,
                    branch: "main",
                    state: "failure",
                },
            ],
        });

        expect(snapshot.items).toHaveLength(2);
        expect(snapshot.items.map(({ source }) => source)).toEqual([
            "check-run",
            "status-context",
        ]);
        expect(snapshot.reason).toBe("failure");
    });

    test("gives terminal failure precedence over pending independent of input order", () => {
        const observations = [
            checkRun({ name: "pending", status: "queued", conclusion: null }),
            checkRun({ name: "failed", conclusion: "failure" }),
        ];
        const forward = normalizePipelineSnapshot({
            ...request,
            observations,
        });
        const reverse = normalizePipelineSnapshot({
            ...request,
            observations: [...observations].reverse(),
        });

        expect(forward.reason).toBe("failure");
        expect(reverse.reason).toBe("failure");
        expect(haveSamePipelineSnapshot(forward, reverse)).toBe(true);
    });

    test("deduplicates legacy contexts using timestamp then numeric status ID", () => {
        const legacy = (id: number, state: string, createdAt: string) => ({
            kind: "status-context" as const,
            provider: "legacy-ci",
            context: "build",
            id,
            sha,
            branch: "main",
            state,
            createdAt,
        });
        const snapshot = normalizePipelineSnapshot({
            ...request,
            observations: [
                legacy(8, "failure", "2024-01-01T00:00:00Z"),
                legacy(9, "pending", "2024-02-01T00:00:00Z"),
                legacy(10, "success", "2024-02-01T00:00:00Z"),
            ],
        });

        expect(snapshot.items).toHaveLength(1);
        expect(snapshot.items[0]).toMatchObject({
            source: "status-context",
            status: "passing",
            createdAt: "2024-02-01T00:00:00Z",
            diagnostic: { statusId: 10 },
        });
        expect(snapshot.reason).toBe("success");
    });

    test("orders distinct workflow runs before same-run attempts", () => {
        const snapshot = normalizePipelineSnapshot({
            ...request,
            observations: [
                checkRun({
                    runId: 10,
                    runAttempt: 99,
                    checkRunId: 100,
                    conclusion: "failure",
                }),
                checkRun({
                    runId: 11,
                    runAttempt: 1,
                    checkRunId: 101,
                    conclusion: "success",
                }),
                checkRun({
                    runId: 11,
                    runAttempt: 2,
                    checkRunId: 102,
                    conclusion: "neutral",
                }),
            ],
        });

        expect(snapshot.items[0]?.status).toBe("acceptable");
        expect(snapshot.items[0]?.diagnostic.runId).toBe(11);
        expect(snapshot.items[0]?.diagnostic.runAttempt).toBe(2);
        expect(snapshot.items[0]?.diagnostic.checkRunId).toBe(102);
    });

    test("orders cross-workflow observations by global recency, not run number", () => {
        const snapshot = normalizePipelineSnapshot({
            ...request,
            observations: [
                checkRun({
                    workflowRunId: 100,
                    workflowId: "workflow-a",
                    runNumber: 100,
                    createdAt: "2024-01-01T00:00:00Z",
                    checkRunId: 1,
                    conclusion: "failure",
                }),
                checkRun({
                    workflowRunId: 200,
                    workflowId: "workflow-b",
                    runNumber: 1,
                    createdAt: "2024-02-01T00:00:00Z",
                    checkRunId: 2,
                    conclusion: "success",
                }),
            ],
        });

        expect(snapshot.items[0]?.status).toBe("passing");
        expect(snapshot.items[0]?.diagnostic.runId).toBe(200);
        expect(snapshot.items[0]?.diagnostic.checkRunId).toBe(2);
    });

    test("uses numeric Check Run IDs when timestamps are identical", () => {
        const snapshot = normalizePipelineSnapshot({
            ...request,
            observations: [
                checkRun({
                    checkRunId: 9,
                    createdAt: "2024-02-01T00:00:00Z",
                    updatedAt: "2024-02-01T01:00:00Z",
                    conclusion: "failure",
                }),
                checkRun({
                    checkRunId: 10,
                    createdAt: "2024-02-01T00:00:00Z",
                    updatedAt: "2024-02-01T01:00:00Z",
                    conclusion: "success",
                }),
            ],
        });

        expect(snapshot.items[0]).toMatchObject({
            status: "passing",
            createdAt: "2024-02-01T00:00:00Z",
            updatedAt: "2024-02-01T01:00:00Z",
            diagnostic: { checkRunId: 10 },
        });
    });

    test("keeps workflow-run and check-suite IDs in separate namespaces", () => {
        const snapshot = normalizePipelineSnapshot({
            ...request,
            observations: [
                checkRun({
                    workflowRunId: 42,
                    runAttempt: 99,
                    checkRunId: 100,
                    createdAt: "2024-01-01T00:00:00Z",
                    conclusion: "failure",
                }),
                {
                    kind: "check-suite",
                    provider: "github-actions",
                    name: "build",
                    suiteId: 42,
                    runAttempt: 1,
                    createdAt: "2024-02-01T00:00:00Z",
                    sha,
                    branch: "main",
                    status: "completed",
                    conclusion: "neutral",
                },
            ],
        });

        expect(snapshot.items).toHaveLength(2);
        const suite = snapshot.items.find(
            ({ source }) => source === "check-suite",
        );
        expect(suite?.status).toBe("acceptable");
        expect(suite?.diagnostic.suiteId).toBe(42);
        expect(suite?.diagnostic.runId).toBeUndefined();
        expect(suite?.diagnostic.checkRunId).toBeUndefined();
    });

    test("classifies only the selected observation's own state fields", () => {
        const snapshot = normalizePipelineSnapshot({
            ...request,
            observations: [
                checkRun({
                    workflowRun: {
                        status: "in_progress",
                        conclusion: null,
                    },
                }),
            ],
        });

        expect(snapshot.items[0]?.status).toBe("passing");
        expect(snapshot.items[0]?.rawState).toEqual({
            status: "completed",
            conclusion: "success",
        });
    });

    test("correlates identifiers and branch only within the selected run", () => {
        const snapshot = normalizePipelineSnapshot({
            ...request,
            observations: [
                checkRun({
                    workflowRunId: 20,
                    runAttempt: 2,
                    checkRunId: 55,
                    suiteId: 7,
                    branch: null,
                }),
                {
                    kind: "workflow-run",
                    name: "workflow",
                    id: 20,
                    workflowId: 9,
                    runNumber: 4,
                    sha,
                    branch: "main",
                    status: "completed",
                    conclusion: "success",
                },
                checkRun({
                    workflowRunId: 19,
                    checkRunId: 999,
                    branch: "release",
                }),
            ],
        });

        const item = snapshot.items.find((entry) => entry.name === "build");
        expect(item?.status).toBe("passing");
        expect(item?.diagnostic.runId).toBe(20);
        expect(item?.diagnostic.workflowId).toBe(9);
        expect(item?.diagnostic.runNumber).toBe(4);
        expect(item?.diagnostic.checkRunId).toBe(55);
        expect(item?.diagnostic.suiteId).toBe(7);
        expect(item?.diagnostic.runAttempt).toBe(2);
        expect(item?.diagnostic.checkRunId).not.toBe(999);
    });

    test("makes empty and incomplete snapshots explicitly non-green", () => {
        const empty = normalizePipelineSnapshot(request, []);
        expect(empty.state).toBe("empty");
        expect(empty.reason).toBe("no-checks");
        expect(empty.greenCandidate).toBe(false);

        const incomplete = normalizePipelineSnapshot({
            ...request,
            observations: [checkRun({ branch: null })],
        });
        expect(incomplete.state).toBe("empty");
        expect(incomplete.completenessErrors).toContain("missing branch");
        expect(incomplete.reason).toBe("unknown");
        expect(incomplete.greenCandidate).toBe(false);
    });

    test("requires every item to pass and maps terminal outcomes to audit reasons", () => {
        const passing = normalizePipelineSnapshot({
            ...request,
            observations: [checkRun()],
        });
        expect(passing.greenCandidate).toBe(true);
        expect(passing.reason).toBe("success");
        expect(isPipelineGreenCandidate(passing)).toBe(true);

        for (const { conclusion, reason } of [
            { conclusion: "neutral", reason: "failure" },
            { conclusion: "skipped", reason: "failure" },
            { conclusion: "pending", reason: "pending" },
            { conclusion: "failure", reason: "failure" },
            { conclusion: "timed_out", reason: "timeout" },
            { conclusion: "error", reason: "error" },
            { conclusion: "cancelled", reason: "cancelled" },
            { conclusion: "future", reason: "unknown" },
        ] as const) {
            const candidate = normalizePipelineSnapshot({
                ...request,
                observations: [
                    checkRun({
                        status:
                            conclusion === "pending" ? conclusion : "completed",
                        conclusion:
                            conclusion === "pending" ? null : conclusion,
                    }),
                ],
            });
            expect(candidate.greenCandidate).toBe(false);
            expect(candidate.reason).toBe(reason);
        }

        const withSourceError = normalizePipelineSnapshot({
            ...request,
            observations: [checkRun()],
            sourceErrors: [{ source: "checks", message: "timed out" }],
        });
        expect(withSourceError.greenCandidate).toBe(false);
        expect(withSourceError.reason).toBe("timeout");
    });
});