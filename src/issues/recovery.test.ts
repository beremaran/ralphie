import { describe, expect, test } from "bun:test";
import { Effect, Exit, Layer } from "effect";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GitIssueCheckpoint, type IssueCheckpoint } from "../git/issue-checkpoint.ts";
import type { GitHubIssue } from "../github/issues.ts";
import {
  makeProgressRecorderLayer,
  type ProgressUpdate,
  ProgressStage,
  ProgressStatus,
} from "../progress/progress.ts";
import { ReviewFindingSeverity, ReviewVerdict } from "./decisions.ts";
import {
  IssueRecovery,
  IssueRecoveryLive,
  REVIEW_DIAGNOSTIC_PATCH_LIMIT_BYTES,
  ReviewExhaustionOutcome,
} from "./recovery.ts";
import {
  IssueQueueResumeStrategy,
  IssueWorkflowKind,
  REVIEW_ITERATION_LIMIT,
} from "./stage.ts";

const checkpoint: IssueCheckpoint = {
  branch: "main",
  sha: "0123456789abcdef0123456789abcdef01234567",
};

const issue: GitHubIssue = {
  number: 42,
  title: "Fix issue",
  url: "https://github.com/owner/repo/issues/42",
  body: "Issue body",
  labels: [],
};

const reviews = Array.from({ length: REVIEW_ITERATION_LIMIT }, (_, index) => ({
  attempt: index + 1,
  sessionID: `session-${index + 1}`,
  decision: {
    verdict: ReviewVerdict.ChangesRequested,
    summary: "One blocker remains.",
    findings: [
      {
        severity: ReviewFindingSeverity.Blocking,
        description: "The edge case still fails.",
      },
    ],
  },
}));

const recoveryLayer = (
  calls: string[],
  progressEvents: ProgressUpdate[],
  patch = "diff --git a/file b/file\n",
) =>
  IssueRecoveryLive.pipe(
    Layer.provide(
      Layer.merge(
        Layer.succeed(GitIssueCheckpoint, {
          capture: () => Effect.succeed(checkpoint),
          createPatch: () =>
            Effect.sync(() => {
              calls.push("createPatch");
              return patch;
            }),
          restore: (_repositoryPath, restoredCheckpoint) =>
            Effect.sync(() => {
              calls.push(`restore:${restoredCheckpoint.sha}`);
            }),
        }),
        makeProgressRecorderLayer(progressEvents),
      ),
    ),
  );

describe("review exhaustion recovery", () => {
  test("refuses escalation before the review budget is exhausted", async () => {
    const calls: string[] = [];
    const progressEvents: ProgressUpdate[] = [];
    const exit = await Effect.gen(function* () {
      const recovery = yield* IssueRecovery;
      yield* recovery.handleReviewExhaustion({
        runId: "run-1",
        workspace: "/workspace",
        repositoryPath: "/workspace/repo",
        issue,
        checkpoint,
        reviews: reviews.slice(0, 4),
      });
    }).pipe(
      Effect.provide(recoveryLayer(calls, progressEvents)),
      Effect.runPromiseExit,
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(calls).toEqual([]);
    expect(progressEvents).toEqual([]);
  });

  test("preserves diagnostics, restores the checkout, and resumes decomposition", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralphie-recovery-"));
    const calls: string[] = [];
    const progressEvents: ProgressUpdate[] = [];

    try {
      const result = await Effect.gen(function* () {
        const recovery = yield* IssueRecovery;
        return yield* recovery.handleReviewExhaustion({
          runId: "run/unsafe",
          workspace,
          repositoryPath: `${workspace}/repo`,
          issue,
          checkpoint,
          reviews,
        });
      }).pipe(Effect.provide(recoveryLayer(calls, progressEvents)), Effect.runPromise);

      expect(result).toEqual({
        outcome: ReviewExhaustionOutcome.EscalatedToDecomposition,
        diagnosticsPath: join(
          workspace,
          ".ralphie/runs/run_unsafe/issues/42/review-exhaustion",
        ),
        nextWorkflow: IssueWorkflowKind.Decomposition,
        resume: IssueQueueResumeStrategy.RefreshOpenIssues,
      });
      expect(calls).toEqual(["createPatch", `restore:${checkpoint.sha}`]);
      expect(
        await readFile(join(result.diagnosticsPath, "changes.patch"), "utf8"),
      ).toBe("diff --git a/file b/file\n");
      const metadata = JSON.parse(
        await readFile(join(result.diagnosticsPath, "metadata.json"), "utf8"),
      );
      expect(metadata.issue.number).toBe(42);
      expect(metadata.reviews).toEqual(reviews);
      expect(progressEvents.map(({ stage, status }) => ({ stage, status }))).toEqual([
        {
          stage: ProgressStage.ReviewExhaustion,
          status: ProgressStatus.Info,
        },
        {
          stage: ProgressStage.CheckoutRestore,
          status: ProgressStatus.Started,
        },
        {
          stage: ProgressStage.CheckoutRestore,
          status: ProgressStatus.Succeeded,
        },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("does not restore when diagnostics cannot be preserved", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralphie-recovery-"));
    const calls: string[] = [];
    const progressEvents: ProgressUpdate[] = [];

    try {
      await writeFile(join(workspace, ".ralphie"), "not a directory");
      const exit = await Effect.gen(function* () {
        const recovery = yield* IssueRecovery;
        yield* recovery.handleReviewExhaustion({
          runId: "run-1",
          workspace,
          repositoryPath: `${workspace}/repo`,
          issue,
          checkpoint,
          reviews,
        });
      }).pipe(
        Effect.provide(recoveryLayer(calls, progressEvents)),
        Effect.runPromiseExit,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(calls).toEqual(["createPatch"]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("does not write or restore an oversized diagnostic patch", async () => {
    const calls: string[] = [];
    const progressEvents: ProgressUpdate[] = [];
    const exit = await Effect.gen(function* () {
      const recovery = yield* IssueRecovery;
      yield* recovery.handleReviewExhaustion({
        runId: "run-1",
        workspace: "/workspace",
        repositoryPath: "/workspace/repo",
        issue,
        checkpoint,
        reviews,
      });
    }).pipe(
      Effect.provide(
        recoveryLayer(
          calls,
          progressEvents,
          "x".repeat(REVIEW_DIAGNOSTIC_PATCH_LIMIT_BYTES + 1),
        ),
      ),
      Effect.runPromiseExit,
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(calls).toEqual(["createPatch"]);
  });
});
