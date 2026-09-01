import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    IssueArtifactKind,
    makeDurableIssueArtifactStore,
    makeIssueArtifactStore,
    makeIssueArtifactStoreService,
} from "../../src/issues/artifacts.ts";
import {
    ComplexityLevel,
    GroundingDisposition,
    ImplementationComplexityLevel,
    IssueResolutionStatus,
    NeedsAttentionReason,
    ReviewFindingSeverity,
    ReviewVerdict,
} from "../../src/issues/decisions.ts";

const checkpoint = {
    branch: "main",
    sha: "0123456789abcdef0123456789abcdef01234567",
} as const;

const fingerprint = {
    updatedAt: "2026-08-24T00:00:00.000Z",
    commentCount: 2,
} as const;

const complexityArtifact = (decision: {
    readonly complexity: ComplexityLevel;
    readonly rationale: string;
}) => ({ decision, fingerprint });

const pullRequestReview = (attempt: number, overrides = {}) => ({
    pullRequestNumber: 42,
    baseSha: "a".repeat(40),
    reviewedHeadSha: "b".repeat(40),
    attempt,
    sessionID: `pr-session-${attempt}`,
    decision: {
        verdict: ReviewVerdict.Approved,
        summary: "Approved.",
        findings: [],
    },
    ...overrides,
});

const review = (attempt: number) => ({
    attempt,
    sessionID: `session-${attempt}`,
    decision: {
        verdict: ReviewVerdict.ChangesRequested,
        summary: "A blocker remains.",
        findings: [
            {
                severity: ReviewFindingSeverity.Blocking,
                description: "The edge case is not handled.",
            },
        ],
    },
});

describe("per-issue artifact store", () => {
    test("stores and retrieves each typed artifact", async () => {
        const store = await makeIssueArtifactStore(42);
        const complexity = {
            complexity: ComplexityLevel.Level2,
            rationale: "The change is localized.",
        };
        const commitMessage = {
            subject: "Fix localized issue",
            body: "Cover the edge case.",
        };
        const breakdown = {
            rationale: "Split independent work.",
            issues: [
                {
                    key: "first",
                    title: "First task",
                    body: "Implement the first task.",
                    estimatedComplexity: ImplementationComplexityLevel.Level2,
                    dependsOn: [],
                },
                {
                    key: "second",
                    title: "Second task",
                    body: "Implement the second task.",
                    estimatedComplexity: ImplementationComplexityLevel.Level3,
                    dependsOn: ["first"],
                },
            ],
        };

        await store.write(
            IssueArtifactKind.ComplexityDecision,
            complexityArtifact(complexity),
        );
        await store.write(IssueArtifactKind.IssueCheckpoint, checkpoint);
        await store.appendReview(review(1));
        await store.write(
            IssueArtifactKind.CommitMessageDecision,
            commitMessage,
        );
        await store.write(IssueArtifactKind.CreatedCommit, {
            sha: "commit-sha",
            treeSha: "tree-sha",
        });
        await store.write(IssueArtifactKind.IssueBreakdownDecision, breakdown);
        await store.recordCreatedIssue("first", 101);
        await store.recordCreatedIssue("second", 102);

        expect(await store.read(IssueArtifactKind.ComplexityDecision)).toEqual(
            complexityArtifact(complexity),
        );
        expect(await store.read(IssueArtifactKind.IssueCheckpoint)).toEqual(
            checkpoint,
        );
        expect(await store.read(IssueArtifactKind.ReviewAttempts)).toEqual([
            review(1),
        ]);
        expect(
            await store.read(IssueArtifactKind.CommitMessageDecision),
        ).toEqual(commitMessage);
        expect(await store.read(IssueArtifactKind.CreatedCommit)).toEqual({
            sha: "commit-sha",
            treeSha: "tree-sha",
        });
        expect(
            await store.read(IssueArtifactKind.IssueBreakdownDecision),
        ).toEqual(breakdown);
        expect(await store.read(IssueArtifactKind.CreatedIssueNumbers)).toEqual(
            { first: 101, second: 102 },
        );
    });

    test("rejects reads before production and duplicate writes", async () => {
        const store = await makeIssueArtifactStore(42);
        await expect(
            store.read(IssueArtifactKind.IssueCheckpoint),
        ).rejects.toThrow("has not been produced");
        await store.write(IssueArtifactKind.ComplexityDecision, {
            decision: {
                complexity: ComplexityLevel.Level1,
                rationale: "First decision.",
            },
            fingerprint,
        });
        await expect(
            store.write(IssueArtifactKind.ComplexityDecision, {
                decision: {
                    complexity: ComplexityLevel.Level2,
                    rationale: "Replacement decision.",
                },
                fingerprint,
            }),
        ).rejects.toThrow("already been produced");
    });

    test("preserves review order and validates issue identifiers", async () => {
        const store = await makeIssueArtifactStore(42);
        await expect(store.appendReview(review(2))).rejects.toThrow(
            "appended in order",
        );
        await store.appendReview(review(1));
        const invalidReviewStore = await makeIssueArtifactStore(43);
        await expect(
            invalidReviewStore.write(IssueArtifactKind.ReviewAttempts, [
                review(2),
            ]),
        ).rejects.toThrow("ordered");
        await expect(store.recordCreatedIssue("", 100)).rejects.toThrow(
            "non-empty key",
        );
        await expect(store.recordCreatedIssue("child", 0)).rejects.toThrow(
            "positive issue number",
        );
        await expect(makeIssueArtifactStore(0)).rejects.toThrow(
            "Cannot create",
        );
    });

    test("persists ordered PR review evidence and rejects malformed histories", async () => {
        const store = await makeIssueArtifactStore(42);
        await store.appendPullRequestReview(pullRequestReview(1));
        await expect(
            store.appendPullRequestReview(
                pullRequestReview(2, { baseSha: "c".repeat(40) }),
            ),
        ).rejects.toThrow("does not match");
        await store.write(
            IssueArtifactKind.ApprovedPullRequestReviewEvidence,
            pullRequestReview(1),
        );
        expect(
            await store.read(
                IssueArtifactKind.ApprovedPullRequestReviewEvidence,
            ),
        ).toMatchObject({ reviewedHeadSha: "b".repeat(40) });

        await store.appendPullRequestReview(
            pullRequestReview(2, { reviewedHeadSha: "d".repeat(40) }),
        );
        expect(
            store.has(IssueArtifactKind.ApprovedPullRequestReviewEvidence),
        ).toBe(false);
    });

    test("rejects approval evidence that does not match a stored attempt", async () => {
        const store = await makeIssueArtifactStore(42);
        await store.appendPullRequestReview(pullRequestReview(1));
        await expect(
            store.write(
                IssueArtifactKind.ApprovedPullRequestReviewEvidence,
                pullRequestReview(1, {
                    reviewedHeadSha: "c".repeat(40),
                }),
            ),
        ).rejects.toThrow("must match a stored approved attempt");
    });

    test("rejects stale PR approval evidence when loading durable state", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "ralphie-artifacts-"));
        try {
            const artifactDirectory = join(
                workspace,
                ".ralphie",
                "runs",
                "stale-approval",
                "issues",
                "42",
            );
            await mkdir(artifactDirectory, { recursive: true });
            await writeFile(
                join(artifactDirectory, "artifacts.json"),
                JSON.stringify({
                    version: 3,
                    issueNumber: 42,
                    repository: "owner/repo",
                    artifacts: {
                        [IssueArtifactKind.PullRequestReviewAttempts]: [
                            pullRequestReview(1),
                        ],
                        [IssueArtifactKind.ApprovedPullRequestReviewEvidence]:
                            pullRequestReview(1, {
                                reviewedHeadSha: "c".repeat(40),
                            }),
                    },
                }),
            );
            await expect(
                makeDurableIssueArtifactStore(42, {
                    workspace,
                    runId: "stale-approval",
                    repository: "owner/repo",
                }),
            ).rejects.toThrow("Failed to load issue artifacts");
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    test("rejects malformed PR review histories when loading durable state", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "ralphie-artifacts-"));
        try {
            const artifactDirectory = join(
                workspace,
                ".ralphie",
                "runs",
                "malformed",
                "issues",
                "42",
            );
            await mkdir(artifactDirectory, { recursive: true });
            await writeFile(
                join(artifactDirectory, "artifacts.json"),
                JSON.stringify({
                    version: 3,
                    issueNumber: 42,
                    repository: "owner/repo",
                    artifacts: {
                        [IssueArtifactKind.PullRequestReviewAttempts]: [
                            pullRequestReview(1),
                            pullRequestReview(1, {
                                pullRequestNumber: 99,
                                baseSha: "c".repeat(40),
                            }),
                        ],
                    },
                }),
            );
            await expect(
                makeDurableIssueArtifactStore(42, {
                    workspace,
                    runId: "malformed",
                    repository: "owner/repo",
                }),
            ).rejects.toThrow("Failed to load issue artifacts");
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    test("keeps stores isolated by issue while reusing a store for that issue", async () => {
        const artifacts = makeIssueArtifactStoreService();
        const first = await artifacts.forIssue(1);
        await first.write(IssueArtifactKind.CreatedIssueNumbers, { child: 2 });
        const second = await artifacts.forIssue(1);
        const other = await artifacts.forIssue(2);
        expect(second).toBe(first);
        expect(first.has(IssueArtifactKind.CreatedIssueNumbers)).toBe(true);
        expect(other).not.toBe(first);
        expect(other.has(IssueArtifactKind.CreatedIssueNumbers)).toBe(false);
    });

    test("persists artifacts and reloads them in a fresh service", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "ralphie-artifacts-"));
        try {
            const scope = {
                workspace,
                runId: "run/restart",
                repository: "owner/repo",
            };
            const first = await makeDurableIssueArtifactStore(42, scope);
            const complexity = {
                complexity: ComplexityLevel.Level2,
                rationale: "The change is localized.",
            };
            await first.write(
                IssueArtifactKind.ComplexityDecision,
                complexityArtifact(complexity),
            );
            await first.appendReview(review(1));
            const persisted = await Bun.file(
                join(
                    workspace,
                    ".ralphie",
                    "runs",
                    "run_restart",
                    "issues",
                    "42",
                    "artifacts.json",
                ),
            ).json();
            expect(persisted).toMatchObject({ repository: "owner/repo" });

            const reloaded = await makeDurableIssueArtifactStore(42, scope);
            expect(
                await reloaded.read(IssueArtifactKind.ComplexityDecision),
            ).toEqual(complexityArtifact(complexity));
            expect(
                await reloaded.read(IssueArtifactKind.ReviewAttempts),
            ).toEqual([review(1)]);
            await reloaded.resetImplementationAttempt();
            const reset = await makeDurableIssueArtifactStore(42, scope);
            expect(reset.has(IssueArtifactKind.ReviewAttempts)).toBe(false);
            expect(
                await reset.read(IssueArtifactKind.ComplexityDecision),
            ).toEqual(complexityArtifact(complexity));
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    test("reloads and explicitly invalidates stale needs-attention decisions", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "ralphie-artifacts-"));
        try {
            const scope = {
                workspace,
                runId: "run-freshness",
                repository: "owner/repo",
            };
            const artifact = {
                decision: {
                    disposition: GroundingDisposition.NeedsAttention,
                    reason: NeedsAttentionReason.MissingInformation,
                    summary: "The issue omits the target runtime.",
                    evidence: ["The repository contains multiple runtimes."],
                    questions: ["Which runtime should be supported?"],
                },
                fingerprint,
            } as const;
            const first = await makeDurableIssueArtifactStore(42, scope);
            await first.write(
                IssueArtifactKind.NeedsAttentionDecision,
                artifact,
            );
            await first.write(IssueArtifactKind.NeedsAttentionHandoff, {
                request: {
                    reason: "missing_information",
                    message: "The target runtime is unspecified.",
                },
                fingerprint,
                checkpoint: { branch: "main", sha: "abc123" },
            });

            const reloaded = await makeDurableIssueArtifactStore(42, scope);
            expect(
                await reloaded.read(IssueArtifactKind.NeedsAttentionDecision),
            ).toEqual(artifact);
            expect(
                await reloaded.invalidateStaleNeedsAttentionDecision(
                    fingerprint,
                ),
            ).toBe(false);
            expect(
                await reloaded.invalidateStaleNeedsAttentionDecision({
                    ...fingerprint,
                    commentCount: 3,
                }),
            ).toBe(true);
            expect(reloaded.has(IssueArtifactKind.NeedsAttentionDecision)).toBe(
                false,
            );
            expect(reloaded.has(IssueArtifactKind.NeedsAttentionHandoff)).toBe(
                false,
            );
            const persisted = await Bun.file(
                join(
                    workspace,
                    ".ralphie",
                    "runs",
                    "run-freshness",
                    "issues",
                    "42",
                    "artifacts.json",
                ),
            ).json();
            expect(persisted.version).toBe(4);
            expect(persisted.artifacts).not.toHaveProperty(
                IssueArtifactKind.NeedsAttentionDecision,
            );
            expect(persisted.artifacts).not.toHaveProperty(
                IssueArtifactKind.NeedsAttentionHandoff,
            );
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    test("durably invalidates only stale issue-derived decisions", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "ralphie-artifacts-"));
        try {
            const scope = {
                workspace,
                runId: "run-decision-freshness",
                repository: "owner/repo",
            };
            const complexity = complexityArtifact({
                complexity: ComplexityLevel.Level2,
                rationale: "Previously assessed.",
            });
            const resolution = {
                decision: {
                    status: IssueResolutionStatus.Resolved,
                    summary: "The issue was already resolved.",
                    evidence: ["Focused verification passed."],
                },
                fingerprint,
            };
            const needsAttention = {
                decision: {
                    disposition: GroundingDisposition.NeedsAttention as const,
                    reason: NeedsAttentionReason.MissingInformation,
                    summary: "The target is unspecified.",
                    evidence: ["No target is named."],
                    questions: ["Which target should change?"],
                },
                fingerprint,
            };
            const handoff = {
                request: {
                    reason: "missing_information" as const,
                    message: "The target is unspecified.",
                },
                fingerprint,
                checkpoint,
            };
            const breakdown = {
                rationale: "Split the independent work.",
                issues: [
                    {
                        key: "child",
                        title: "Implement the child task",
                        body: "Implement the child task.",
                        estimatedComplexity:
                            ImplementationComplexityLevel.Level2,
                        dependsOn: [],
                    },
                    {
                        key: "dependent",
                        title: "Implement the dependent task",
                        body: "Implement the dependent task.",
                        estimatedComplexity:
                            ImplementationComplexityLevel.Level2,
                        dependsOn: ["child"],
                    },
                ],
            };
            const pullRequestEvidence = pullRequestReview(1);
            const first = await makeDurableIssueArtifactStore(42, scope);
            await first.write(IssueArtifactKind.ComplexityDecision, complexity);
            await first.write(
                IssueArtifactKind.IssueResolutionDecision,
                resolution,
            );
            await first.write(
                IssueArtifactKind.NeedsAttentionDecision,
                needsAttention,
            );
            await first.write(IssueArtifactKind.NeedsAttentionHandoff, handoff);
            await first.write(IssueArtifactKind.IssueCheckpoint, checkpoint);
            await first.appendReview(review(1));
            await first.appendPullRequestReview(pullRequestEvidence);
            await first.write(
                IssueArtifactKind.ApprovedPullRequestReviewEvidence,
                pullRequestEvidence,
            );
            await first.write(IssueArtifactKind.CommitMessageDecision, {
                subject: "Implement the child task",
                body: "Preserve recovery evidence.",
            });
            await first.write(IssueArtifactKind.CreatedCommit, {
                sha: "commit-sha",
                treeSha: "tree-sha",
            });
            await first.write(
                IssueArtifactKind.IssueBreakdownDecision,
                breakdown,
            );
            await first.recordCreatedIssue("child", 101);
            await first.recordCreatedIssue("dependent", 102);
            await first.write(IssueArtifactKind.CreatedIssueDependencies, {
                child: [],
                dependent: [101],
            });

            const matching = await makeDurableIssueArtifactStore(42, scope);
            expect(
                await matching.read(IssueArtifactKind.ComplexityDecision),
            ).toEqual(complexity);
            expect(
                await matching.read(IssueArtifactKind.IssueResolutionDecision),
            ).toEqual(resolution);
            expect(
                await matching.read(IssueArtifactKind.NeedsAttentionDecision),
            ).toEqual(needsAttention);
            expect(
                await matching.invalidateStaleIssueDecisions(fingerprint),
            ).toBe(false);

            const matchedReload = await makeDurableIssueArtifactStore(
                42,
                scope,
            );
            expect(
                await matchedReload.read(IssueArtifactKind.ComplexityDecision),
            ).toEqual(complexity);
            expect(
                await matchedReload.read(
                    IssueArtifactKind.IssueResolutionDecision,
                ),
            ).toEqual(resolution);
            expect(
                await matchedReload.read(
                    IssueArtifactKind.NeedsAttentionDecision,
                ),
            ).toEqual(needsAttention);
            expect(
                await matchedReload.invalidateStaleIssueDecisions({
                    ...fingerprint,
                    commentVersion: "2026-08-29T00:00:00.000Z",
                }),
            ).toBe(true);

            const reloaded = await makeDurableIssueArtifactStore(42, scope);
            expect(reloaded.has(IssueArtifactKind.ComplexityDecision)).toBe(
                false,
            );
            expect(
                reloaded.has(IssueArtifactKind.IssueResolutionDecision),
            ).toBe(false);
            expect(reloaded.has(IssueArtifactKind.NeedsAttentionDecision)).toBe(
                false,
            );
            expect(
                await reloaded.read(IssueArtifactKind.IssueCheckpoint),
            ).toEqual(checkpoint);
            expect(
                await reloaded.read(IssueArtifactKind.ReviewAttempts),
            ).toEqual([review(1)]);
            expect(
                await reloaded.read(
                    IssueArtifactKind.PullRequestReviewAttempts,
                ),
            ).toEqual([pullRequestEvidence]);
            expect(
                await reloaded.read(
                    IssueArtifactKind.ApprovedPullRequestReviewEvidence,
                ),
            ).toEqual(pullRequestEvidence);
            expect(
                await reloaded.read(IssueArtifactKind.NeedsAttentionHandoff),
            ).toEqual(handoff);
            expect(
                await reloaded.read(IssueArtifactKind.CommitMessageDecision),
            ).toEqual({
                subject: "Implement the child task",
                body: "Preserve recovery evidence.",
            });
            expect(
                await reloaded.read(IssueArtifactKind.CreatedCommit),
            ).toEqual({
                sha: "commit-sha",
                treeSha: "tree-sha",
            });
            expect(
                await reloaded.read(IssueArtifactKind.IssueBreakdownDecision),
            ).toEqual(breakdown);
            expect(
                await reloaded.read(IssueArtifactKind.CreatedIssueNumbers),
            ).toEqual({ child: 101, dependent: 102 });
            expect(
                await reloaded.read(IssueArtifactKind.CreatedIssueDependencies),
            ).toEqual({ child: [], dependent: [101] });
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    test("atomically removes legacy and invalid issue decisions on load", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "ralphie-artifacts-"));
        try {
            const path = join(
                workspace,
                ".ralphie",
                "runs",
                "run-invalid-freshness",
                "issues",
                "42",
                "artifacts.json",
            );
            await mkdir(join(path, ".."), { recursive: true });
            await writeFile(
                path,
                JSON.stringify({
                    version: 3,
                    issueNumber: 42,
                    artifacts: {
                        [IssueArtifactKind.ComplexityDecision]: {
                            complexity: ComplexityLevel.Level1,
                            rationale: "Keep this artifact.",
                        },
                        [IssueArtifactKind.NeedsAttentionDecision]: {
                            decision: {
                                disposition:
                                    GroundingDisposition.NeedsAttention,
                                reason: NeedsAttentionReason.MissingInformation,
                                summary: "The issue needs clarification.",
                                evidence: ["The target is unspecified."],
                                questions: [
                                    "Which target should be supported?",
                                ],
                            },
                            fingerprint: {
                                updatedAt: "2026-08-28T00:00:00.000Z",
                            },
                        },
                    },
                }),
            );

            const store = await makeDurableIssueArtifactStore(42, {
                workspace,
                runId: "run-invalid-freshness",
            });

            expect(store.has(IssueArtifactKind.NeedsAttentionDecision)).toBe(
                false,
            );
            expect(store.has(IssueArtifactKind.ComplexityDecision)).toBe(false);
            expect((await Bun.file(path).json()).artifacts).not.toHaveProperty(
                IssueArtifactKind.NeedsAttentionDecision,
            );
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    test("migrates version 2 artifacts without reusing legacy decisions", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "ralphie-artifacts-"));
        try {
            const path = join(
                workspace,
                ".ralphie",
                "runs",
                "run-legacy",
                "issues",
                "42",
                "artifacts.json",
            );
            await mkdir(join(path, ".."), { recursive: true });
            await writeFile(
                path,
                JSON.stringify({
                    version: 2,
                    issueNumber: 42,
                    artifacts: {
                        [IssueArtifactKind.ComplexityDecision]: {
                            complexity: ComplexityLevel.Level1,
                            rationale: "Legacy decision.",
                        },
                        [IssueArtifactKind.IssueCheckpoint]: checkpoint,
                    },
                }),
            );
            const loaded = await makeDurableIssueArtifactStore(42, {
                workspace,
                runId: "run-legacy",
            });
            expect(loaded.has(IssueArtifactKind.ComplexityDecision)).toBe(
                false,
            );
            expect(
                await loaded.read(IssueArtifactKind.IssueCheckpoint),
            ).toEqual(checkpoint);
            expect((await Bun.file(path).json()).version).toBe(4);
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    test("rejects corrupted, incompatible, and mismatched durable files", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "ralphie-artifacts-"));
        try {
            const path = join(
                workspace,
                ".ralphie",
                "runs",
                "run-1",
                "issues",
                "42",
                "artifacts.json",
            );
            await mkdir(join(path, ".."), { recursive: true });
            await Bun.write(path, "{not-json");
            await expect(
                makeDurableIssueArtifactStore(42, {
                    workspace,
                    runId: "run-1",
                }),
            ).rejects.toThrow("Failed to load");
            await writeFile(
                path,
                JSON.stringify({ version: 1, issueNumber: 42, artifacts: {} }),
            );
            await expect(
                makeDurableIssueArtifactStore(42, {
                    workspace,
                    runId: "run-1",
                }),
            ).rejects.toThrow("Failed to load");
            await writeFile(
                path,
                JSON.stringify({ version: 2, issueNumber: 99, artifacts: {} }),
            );
            await expect(
                makeDurableIssueArtifactStore(42, {
                    workspace,
                    runId: "run-1",
                }),
            ).rejects.toThrow("belong to issue");
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });
});