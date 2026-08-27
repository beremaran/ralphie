import { describe, expect, test } from "bun:test";
import {
    type IssueCompletionKind,
    IssueExecutionOutcomeKind,
} from "../../src/issues/execution.ts";
import {
    type RunReconciliationStatus,
    type RunStateCleanupAction,
    makeRunReconciliationService,
    planRunStateCleanup,
    reconcileRunState,
} from "../../src/run/reconciliation.ts";
import {
    RUN_STATE_VERSION,
    RunStateStatus,
    type RunState,
} from "../../src/run/state.ts";
import { type ProgressStage } from "../../src/progress/progress.ts";

const state: RunState = {
    version: RUN_STATE_VERSION,
    status: RunStateStatus.Active,
    runId: "run-1",
    repository: "owner/repo",
    branch: "main",
    selection: {
        agent: "build",
    },
    queue: {
        pending: [
            {
                number: 2,
                title: "Next",
                url: "issue/2",
                body: null,
                labels: [],
            },
        ],
        completedIssueNumbers: [1],
        processedCount: 1,
    },
    outcomes: [
        {
            issueNumber: 1,
            outcome: {
                kind: IssueExecutionOutcomeKind.Completed,
                completion: "pushed-commit",
                commitSha: "abc123",
            },
        },
    ],
    checkout: {
        branch: "main",
        head: "abc123",
    },
    updatedAt: "2026-08-24T00:00:00.000Z",
};

describe("run-state reconciliation", () => {
    test.each([
        [
            "repository",
            {
                repository: "other/repo",
                branch: "main",
            },
            "repository-mismatch",
        ],
        [
            "branch",
            {
                repository: "owner/repo",
                branch: "develop",
            },
            "branch-mismatch",
        ],
        [
            "Git checkout",
            {
                repository: "owner/repo",
                branch: "main",
                git: {
                    branch: "main",
                    head: "def456",
                },
            },
            "git-mismatch",
        ],
        [
            "GitHub queue",
            {
                repository: "owner/repo",
                branch: "main",
                github: {
                    openIssueNumbers: [],
                },
            },
            "github-mismatch",
        ],
    ])("rejects a %s mismatch", (_name, inputs, status) => {
        const result = reconcileRunState(state, inputs);
        expect(result.compatible).toBe(false);
        expect(result.status).toBe(status as RunReconciliationStatus);
        expect(result.reasons.length).toBeGreaterThan(0);
    });

    test("accepts matching Git and GitHub inputs", () => {
        expect(
            reconcileRunState(state, {
                repository: "owner/repo",
                branch: "main",
                git: {
                    branch: "main",
                    head: "abc123",
                },
                github: {
                    openIssueNumbers: [2, 3],
                },
            }),
        ).toEqual({
            compatible: true,
            status: "compatible",
            reasons: [],
        });
    });

    test("accepts a closed pending issue while recovering its closure stage", () => {
        const closingState: RunState = {
            ...state,
            queue: {
                pending: [
                    {
                        number: 1,
                        title: "Closing",
                        url: "issue/1",
                        body: null,
                        labels: [],
                    },
                ],
                completedIssueNumbers: [],
                processedCount: 0,
            },
            activeIssue: {
                issueNumber: 1,
                stage: "issue-closure",
            },
        };

        const result = reconcileRunState(closingState, {
            repository: "owner/repo",
            branch: "main",
            github: {
                openIssueNumbers: [],
            },
        });

        expect(result.compatible).toBeTrue();
    });

    test("detects stale active state", () => {
        const result = reconcileRunState(state, {
            repository: "owner/repo",
            branch: "main",
            now: new Date("2026-08-25T00:00:00.000Z"),
            maxAgeMs: 60_000,
        });
        expect(result.status).toBe("stale");
    });

    test("exposes reconciliation as an async service", async () => {
        const result = await makeRunReconciliationService().reconcile(state, {
            repository: "owner/repo",
            branch: "main",
        });
        expect(result.compatible).toBe(true);
    });

    test("preserves active state even when cleanup is requested", () => {
        expect(planRunStateCleanup(state, true)).toBe("preserve");
        expect(
            planRunStateCleanup(
                {
                    ...state,
                    status: RunStateStatus.Complete,
                },
                true,
            ),
        ).toBe("remove");
        expect(
            planRunStateCleanup(
                {
                    ...state,
                    status: RunStateStatus.Complete,
                },
                false,
            ),
        ).toBe("preserve");
    });
});