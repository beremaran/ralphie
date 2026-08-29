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
    GroundingDisposition,
    NeedsAttentionReason,
    ReviewFindingSeverity,
    ReviewVerdict,
    type NeedsAttentionDecision,
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

const groundingDecision: NeedsAttentionDecision = {
    disposition: GroundingDisposition.NeedsAttention,
    reason: NeedsAttentionReason.ExternalDependency,
    summary: "The required dependency is unavailable.",
    evidence: ["The repository does not contain the required dependency."],
    questions: ["Can the dependency be provided before retrying?"],
};

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

    test("captures needs-attention diagnostics before restoring and verifying the checkpoint", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "ralphie-recovery-"));
        const calls: string[] = [];
        const progressEvents: ProgressUpdate[] = [];
        try {
            const result = await recovery(
                calls,
                progressEvents,
            ).handleNeedsAttention({
                runId: "run-1",
                repository: "owner/repo",
                workspace,
                repositoryPath: `${workspace}/repo`,
                issue,
                checkpoint,
                decision: groundingDecision,
                request: {
                    reason: "external_dependency",
                    message: "The dependency is unavailable in the checkout.",
                },
                repositoryInvariant: {
                    capture: async () => ({
                        branch: checkpoint.branch,
                        head: checkpoint.sha,
                    }),
                    verify: async (_path, expected) => {
                        calls.push(
                            `verify:${expected.branch}:${expected.head}`,
                        );
                    },
                },
            });
            expect(result.diagnosticsPath).toBe(
                join(
                    workspace,
                    ".ralphie/runs/run-1/issues/42/needs-attention",
                ),
            );
            expect(calls).toEqual([
                "createPatch",
                `restore:${checkpoint.sha}`,
                `verify:${checkpoint.branch}:${checkpoint.sha}`,
            ]);
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
            expect(metadata.issue).toEqual(issue);
            expect(metadata.checkpoint).toEqual(checkpoint);
            expect(metadata.decision).toEqual(groundingDecision);
            expect(metadata.request.reason).toBe("external_dependency");
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    test("does not restore when needs-attention patch capture fails", async () => {
        const calls: string[] = [];
        const service = makeIssueRecoveryService(
            {
                capture: async () => checkpoint,
                createPatch: async () => {
                    calls.push("createPatch");
                    throw new Error("patch capture failed");
                },
                restore: async () => {
                    calls.push("restore");
                },
            },
            makeProgressRecorder([]),
        );
        await expect(
            service.handleNeedsAttention({
                runId: "run-1",
                workspace: "/workspace",
                repositoryPath: "/workspace/repo",
                issue,
                checkpoint,
                decision: groundingDecision,
                repositoryInvariant: {
                    capture: async () => ({
                        branch: checkpoint.branch,
                        head: checkpoint.sha,
                    }),
                    verify: async () => {},
                },
            }),
        ).rejects.toThrow("Failed to capture needs-attention diagnostics");
        expect(calls).toEqual(["createPatch"]);
    });

    test("does not restore when needs-attention diagnostics cannot be written", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "ralphie-recovery-"));
        const calls: string[] = [];
        try {
            await writeFile(join(workspace, ".ralphie"), "not a directory");
            const service = makeIssueRecoveryService(
                {
                    capture: async () => checkpoint,
                    createPatch: async () => {
                        calls.push("createPatch");
                        return "patch";
                    },
                    restore: async () => {
                        calls.push("restore");
                    },
                },
                makeProgressRecorder([]),
            );
            await expect(
                service.handleNeedsAttention({
                    runId: "run-1",
                    workspace,
                    repositoryPath: `${workspace}/repo`,
                    issue,
                    checkpoint,
                    decision: groundingDecision,
                    repositoryInvariant: {
                        capture: async () => ({
                            branch: checkpoint.branch,
                            head: checkpoint.sha,
                        }),
                        verify: async () => {},
                    },
                }),
            ).rejects.toThrow("Failed to preserve needs-attention diagnostics");
            expect(calls).toEqual(["createPatch"]);
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    test("does not return success when restore or invariant verification fails", async () => {
        for (const failure of ["restore", "invariant"] as const) {
            const workspace = await mkdtemp(
                join(tmpdir(), "ralphie-recovery-"),
            );
            const calls: string[] = [];
            try {
                const service = makeIssueRecoveryService(
                    {
                        capture: async () => checkpoint,
                        createPatch: async () => {
                            calls.push("createPatch");
                            return "patch";
                        },
                        restore: async () => {
                            calls.push("restore");
                            if (failure === "restore") {
                                throw new Error("restore failed");
                            }
                        },
                    },
                    makeProgressRecorder([]),
                );
                await expect(
                    service.handleNeedsAttention({
                        runId: `run-${failure}`,
                        workspace,
                        repositoryPath: `${workspace}/repo`,
                        issue,
                        checkpoint,
                        decision: groundingDecision,
                        repositoryInvariant: {
                            capture: async () => ({
                                branch: checkpoint.branch,
                                head: checkpoint.sha,
                            }),
                            verify: async () => {
                                calls.push("verify");
                                if (failure === "invariant") {
                                    throw new Error("invariant failed");
                                }
                            },
                        },
                    }),
                ).rejects.toThrow(failure);
                expect(calls).toEqual(
                    failure === "restore"
                        ? ["createPatch", "restore"]
                        : ["createPatch", "restore", "verify"],
                );
            } finally {
                await rm(workspace, { recursive: true, force: true });
            }
        }
    });
});