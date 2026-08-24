import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { IssueExecutionOutcomeKind } from "../issues/execution.ts";
import {
  RunReconciliationStatus,
  RunStateCleanupAction,
  makeRunReconciliationService,
  planRunStateCleanup,
  reconcileRunState,
} from "./reconciliation.ts";
import { RUN_STATE_VERSION, RunStateStatus, type RunState } from "./state.ts";

const state: RunState = {
  version: RUN_STATE_VERSION,
  status: RunStateStatus.Active,
  runId: "run-1",
  repository: "owner/repo",
  branch: "main",
  selection: { agent: "build" },
  queue: {
    pending: [{ number: 2, title: "Next", url: "issue/2", body: null, labels: [] }],
    completedIssueNumbers: [1],
    processedCount: 1,
  },
  outcomes: [
    {
      issueNumber: 1,
      outcome: { kind: IssueExecutionOutcomeKind.Completed, commitSha: "abc123" },
    },
  ],
  checkout: { branch: "main", head: "abc123" },
  updatedAt: "2026-08-24T00:00:00.000Z",
};

describe("run-state reconciliation", () => {
  test.each([
    [
      "repository",
      { repository: "other/repo", branch: "main" },
      RunReconciliationStatus.RepositoryMismatch,
    ],
    [
      "branch",
      { repository: "owner/repo", branch: "develop" },
      RunReconciliationStatus.BranchMismatch,
    ],
    [
      "Git checkout",
      {
        repository: "owner/repo",
        branch: "main",
        git: { branch: "main", head: "def456" },
      },
      RunReconciliationStatus.GitMismatch,
    ],
    [
      "GitHub queue",
      { repository: "owner/repo", branch: "main", github: { openIssueNumbers: [] } },
      RunReconciliationStatus.GitHubMismatch,
    ],
  ])("rejects a %s mismatch", (_name, inputs, status) => {
    const result = reconcileRunState(state, inputs);
    expect(result.compatible).toBe(false);
    expect(result.status).toBe(status);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  test("accepts matching Git and GitHub inputs", () => {
    expect(
      reconcileRunState(state, {
        repository: "owner/repo",
        branch: "main",
        git: { branch: "main", head: "abc123" },
        github: { openIssueNumbers: [2, 3] },
      }),
    ).toEqual({
      compatible: true,
      status: RunReconciliationStatus.Compatible,
      reasons: [],
    });
  });

  test("detects stale active state", () => {
    const result = reconcileRunState(state, {
      repository: "owner/repo",
      branch: "main",
      now: new Date("2026-08-25T00:00:00.000Z"),
      maxAgeMs: 60_000,
    });
    expect(result.status).toBe(RunReconciliationStatus.Stale);
  });

  test("exposes reconciliation behind an Effect service", async () => {
    const result = await Effect.gen(function* () {
      const service = makeRunReconciliationService();
      return yield* service.reconcile(state, {
        repository: "owner/repo",
        branch: "main",
      });
    }).pipe(Effect.runPromise);
    expect(result.compatible).toBe(true);
  });

  test("preserves active state even when cleanup is requested", () => {
    expect(planRunStateCleanup(state, true)).toBe(RunStateCleanupAction.Preserve);
    expect(
      planRunStateCleanup({ ...state, status: RunStateStatus.Complete }, true),
    ).toBe(RunStateCleanupAction.Remove);
    expect(
      planRunStateCleanup({ ...state, status: RunStateStatus.Complete }, false),
    ).toBe(RunStateCleanupAction.Preserve);
  });
});
