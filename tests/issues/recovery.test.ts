import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { IssueCheckpoint } from "../../src/git/issue-checkpoint.ts";
import type { GitHubIssue } from "../../src/github/issues.ts";
import {
    makeProgressRecorder,
    type ProgressUpdate,
    type ProgressStage,
    type ProgressStatus,
} from "../../src/progress/progress.ts";
import {
    ReviewFindingSeverity,
    ReviewVerdict,
} from "../../src/issues/decisions.ts";
import {
    makeIssueRecoveryService,
    REVIEW_DIAGNOSTIC_PATCH_LIMIT_BYTES,
    type ReviewExhaustionOutcome,
} from "../../src/issues/recovery.ts";
import {
    IssueQueueResumeStrategy,
    type IssueWorkflowKind,
    REVIEW_ITERATION_LIMIT,
} from "../../src/issues/stage.ts";

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

const recovery = (
    calls: string[],
    progressEvents: ProgressUpdate[],
    patch = "diff --git a/file b/file\n",
) =>
    makeIssueRecoveryService(
        {
            capture: async () => checkpoint,
            createPatch: async () => {
                calls.push("createPatch");
                return patch;
            },
            restore: async (_path, restoredCheckpoint) => {
                calls.push(`restore:${restoredCheckpoint.sha}`);
            },
        },
        makeProgressRecorder(progressEvents),
    );

describe("review exhaustion recovery", () => {
    test("refuses escalation before the review budget is exhausted", async () => {
        const calls: string[] = [];
        const progressEvents: ProgressUpdate[] = [];
        await expect(
            recovery(calls, progressEvents).handleReviewExhaustion({
                runId: "run-1",
                workspace: "/workspace",
                repositoryPath: "/workspace/repo",
                issue,
                checkpoint,
                reviews: reviews.slice(0, 4),
            }),
        ).rejects.toThrow("requires 5 ordered attempts");
        expect(calls).toEqual([]);
        expect(progressEvents).toEqual([]);
    });

    test("preserves diagnostics, restores the checkout, and resumes decomposition", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "ralphie-recovery-"));
        const calls: string[] = [];
        const progressEvents: ProgressUpdate[] = [];
        try {
            const result = await recovery(
                calls,
                progressEvents,
            ).handleReviewExhaustion({
                runId: "run/unsafe",
                repository: "owner/repo",
                workspace,
                repositoryPath: `${workspace}/repo`,
                issue,
                checkpoint,
                reviews,
            });
            expect(result).toEqual({
                outcome: "escalated-to-decomposition",
                diagnosticsPath: join(
                    workspace,
                    ".ralphie/runs/run_unsafe/issues/42/review-exhaustion",
                ),
                nextWorkflow: "decomposition",
                resume: IssueQueueResumeStrategy,
            });
            expect(calls).toEqual(["createPatch", `restore:${checkpoint.sha}`]);
            expect(
                await readFile(
                    join(result.diagnosticsPath, "changes.patch"),
                    "utf8",
                ),
            ).toBe("diff --git a/file b/file\n");
            const metadata = JSON.parse(
                await readFile(
                    join(result.diagnosticsPath, "metadata.json"),
                    "utf8",
                ),
            );
            expect(metadata.issue.number).toBe(42);
            expect(metadata.repository).toBe("owner/repo");
            expect(metadata.reviews).toEqual(reviews);
            expect(
                progressEvents.map(({ stage, status }) => ({ stage, status })),
            ).toEqual([
                {
                    stage: "review-exhaustion",
                    status: "info",
                },
                {
                    stage: "checkout-restore",
                    status: "started",
                },
                {
                    stage: "checkout-restore",
                    status: "succeeded",
                },
            ]);
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    test("does not restore when diagnostics cannot be preserved", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "ralphie-recovery-"));
        const calls: string[] = [];
        try {
            await writeFile(join(workspace, ".ralphie"), "not a directory");
            await expect(
                recovery(calls, []).handleReviewExhaustion({
                    runId: "run-1",
                    workspace,
                    repositoryPath: `${workspace}/repo`,
                    issue,
                    checkpoint,
                    reviews,
                }),
            ).rejects.toThrow("Failed to preserve review diagnostics");
            expect(calls).toEqual(["createPatch"]);
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    test("does not write or restore an oversized diagnostic patch", async () => {
        const calls: string[] = [];
        await expect(
            recovery(
                calls,
                [],
                "x".repeat(REVIEW_DIAGNOSTIC_PATCH_LIMIT_BYTES + 1),
            ).handleReviewExhaustion({
                runId: "run-1",
                workspace: "/workspace",
                repositoryPath: "/workspace/repo",
                issue,
                checkpoint,
                reviews,
            }),
        ).rejects.toThrow("exceeds");
        expect(calls).toEqual(["createPatch"]);
    });
});