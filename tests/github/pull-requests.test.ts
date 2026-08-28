import { describe, expect, test } from "bun:test";
import type { Octokit } from "octokit";

import { ReviewVerdict } from "../../src/issues/decisions.ts";
import {
    makeGitHubPullRequestService,
    pullRequestReviewMarker,
    reviewAttemptMarker,
} from "../../src/github/pull-requests.ts";

const service = makeGitHubPullRequestService();

const pullRequest = (
    number: number,
    head: string,
    base: string,
    merged = false,
) => ({
    number,
    html_url: `https://github.com/owner/repository/pull/${number}`,
    head: { ref: head, sha: `${head}-sha` },
    base: { ref: base },
    state: merged ? "closed" : "open",
    mergeable: true,
    merged,
    merged_at: merged ? "2026-08-25T00:00:00Z" : null,
});

const prReview = (attempt: number, head = "b".repeat(40)) => ({
    pullRequestNumber: 42,
    baseSha: "a".repeat(40),
    reviewedHeadSha: head,
    attempt,
    sessionID: `pr-review-${attempt}`,
    decision: {
        verdict: ReviewVerdict.Approved,
        summary: "Approved.",
        findings: [],
    },
});

const review = (attempt: number) => ({
    attempt,
    sessionID: `review-${attempt}`,
    decision: {
        verdict: ReviewVerdict.Approved,
        summary: `Review ${attempt} approved.`,
        findings: [],
    },
});

describe("GitHub pull requests", () => {
    test("finds an existing pull request by exact head and base", async () => {
        let created = false;
        let request: Record<string, unknown> | undefined;
        const client = {
            rest: {
                pulls: {
                    list: Symbol("list"),
                    create: async () => {
                        created = true;
                        return { data: pullRequest(99, "feature", "main") };
                    },
                },
            },
            paginate: async (
                _method: unknown,
                parameters: Record<string, unknown>,
            ) => {
                request = parameters;
                return [pullRequest(42, "feature", "main")];
            },
        } as unknown as Octokit;

        const result = await service.createOrFind(
            client,
            "https://github.com/owner/repository.git",
            {
                title: "Implement feature",
                body: "Implementation details",
                issueNumber: 17,
                head: "feature",
                base: "main",
            },
        );

        expect(request).toEqual({
            owner: "owner",
            repo: "repository",
            state: "all",
            head: "owner:feature",
            base: "main",
            per_page: 100,
        });
        expect(created).toBeFalse();
        expect(result).toEqual({
            number: 42,
            url: "https://github.com/owner/repository/pull/42",
            merged: false,
            headSha: "feature-sha",
        });
    });

    test("creates a pull request with the automatic issue-closing reference", async () => {
        let request: Record<string, unknown> | undefined;
        const client = {
            rest: {
                pulls: {
                    list: Symbol("list"),
                    create: async (parameters: Record<string, unknown>) => {
                        request = parameters;
                        return { data: pullRequest(43, "feature", "main") };
                    },
                },
            },
            paginate: async () => [],
        } as unknown as Octokit;

        await service.createOrFind(client, "owner/repository", {
            title: "Implement feature",
            body: "Implementation details",
            issueNumber: 18,
            head: "feature",
            base: "main",
        });

        expect(request).toEqual({
            owner: "owner",
            repo: "repository",
            title: "Implement feature",
            body: "Implementation details\n\nCloses #18",
            head: "feature",
            base: "main",
        });
    });

    test("publishes review attempts once using deterministic comment markers", async () => {
        const comments: Array<{ body: string }> = [
            { body: `${reviewAttemptMarker(1)}\nold` },
        ];
        const created: Record<string, unknown>[] = [];
        const client = {
            rest: {
                issues: {
                    listComments: Symbol("listComments"),
                    createComment: async (
                        parameters: Record<string, unknown>,
                    ) => {
                        created.push(parameters);
                        comments.push({ body: String(parameters.body) });
                        return { data: {} };
                    },
                },
            },
            paginate: async () => comments,
        } as unknown as Octokit;

        await service.publishReviewAttempts(client, "owner/repository", 42, [
            review(1),
            review(2),
        ]);
        await service.publishReviewAttempts(client, "owner/repository", 42, [
            review(1),
            review(2),
        ]);

        expect(created).toHaveLength(1);
        expect(created[0]).toMatchObject({
            owner: "owner",
            repo: "repository",
            issue_number: 42,
        });
        expect(created[0]?.body).toContain(reviewAttemptMarker(2));
        expect(created[0]?.body).toContain('"verdict": "approved"');
    });

    test("captures exact PR SHAs and rejects a changed base on reread", async () => {
        let baseSha = "a".repeat(40);
        const client = {
            rest: {
                pulls: {
                    get: async () => ({
                        data: {
                            ...pullRequest(42, "feature", "main"),
                            base: { ref: "main", sha: baseSha },
                            head: { ref: "feature", sha: "b".repeat(40) },
                        },
                    }),
                },
            },
        } as unknown as Octokit;
        const snapshot = await service.readSnapshot(
            client,
            "owner/repository",
            42,
        );
        expect(snapshot).toMatchObject({
            number: 42,
            baseSha: "a".repeat(40),
            headSha: "b".repeat(40),
        });
        baseSha = "c".repeat(40);
        await expect(
            service.rereadMatchingSnapshot(
                client,
                "owner/repository",
                snapshot,
            ),
        ).rejects.toThrow("no longer matches");
    });

    test("validates head-scoped markers and reconciles a lost create response", async () => {
        const attempt = prReview(1);
        const comments: Array<{ body: string }> = [
            {
                body: `${pullRequestReviewMarker(42, attempt.reviewedHeadSha, 1)}\n\`\`\`json\n{}\n\`\`\``,
            },
        ];
        let creates = 0;
        const client = {
            rest: {
                issues: {
                    listComments: Symbol("listComments"),
                    createComment: async (
                        parameters: Record<string, unknown>,
                    ) => {
                        creates += 1;
                        comments.push({ body: String(parameters.body) });
                        throw new Error("response lost");
                    },
                },
            },
            paginate: async () => comments,
        } as unknown as Octokit;

        await service.publishPullRequestReviewAttempts(
            client,
            "owner/repository",
            [attempt],
        );
        expect(creates).toBe(1);
        await service.publishPullRequestReviewAttempts(
            client,
            "owner/repository",
            [attempt],
        );
        expect(creates).toBe(1);
    });

    test("does not reconcile conflicting valid payloads with the same marker", async () => {
        const attempt = prReview(1);
        const conflicting = {
            ...attempt,
            baseSha: "c".repeat(40),
            sessionID: "different-session",
            decision: {
                verdict: ReviewVerdict.Approved,
                summary: "A different approval.",
                findings: [],
            },
        };
        const comments = [
            {
                body: `${pullRequestReviewMarker(42, attempt.reviewedHeadSha, 1)}\n\`\`\`json\n${JSON.stringify(conflicting)}\n\`\`\``,
            },
        ];
        let creates = 0;
        const client = {
            rest: {
                issues: {
                    listComments: Symbol("listComments"),
                    createComment: async () => {
                        creates += 1;
                        throw new Error("response lost");
                    },
                },
            },
            paginate: async () => comments,
        } as unknown as Octokit;

        await expect(
            service.publishPullRequestReviewAttempts(
                client,
                "owner/repository",
                [attempt],
            ),
        ).rejects.toThrow("Failed to publish pull request review evidence");
        expect(creates).toBe(1);
    });

    test("passes the expected SHA and verifies authoritative merged state", async () => {
        const mergeRequests: Record<string, unknown>[] = [];
        let reads = 0;
        const client = {
            rest: {
                pulls: {
                    get: async () => {
                        reads += 1;
                        return {
                            data:
                                reads === 1
                                    ? pullRequest(44, "feature", "main")
                                    : pullRequest(44, "feature", "main", true),
                        };
                    },
                    merge: async (parameters: Record<string, unknown>) => {
                        mergeRequests.push(parameters);
                        return { data: { merged: true } };
                    },
                },
            },
        } as unknown as Octokit;

        const result = await service.merge(
            client,
            "owner/repository",
            44,
            "feature-sha",
        );
        expect(mergeRequests).toEqual([
            {
                owner: "owner",
                repo: "repository",
                pull_number: 44,
                sha: "feature-sha",
            },
        ]);
        expect(reads).toBe(2);
        expect(result).toEqual({
            number: 44,
            url: "https://github.com/owner/repository/pull/44",
            merged: true,
            headSha: "feature-sha",
        });
    });

    test("does not merge a closed pull request", async () => {
        let mergeCalls = 0;
        const closed = {
            ...pullRequest(45, "feature", "main"),
            state: "closed",
        };
        const client = {
            rest: {
                pulls: {
                    get: async () => ({ data: closed }),
                    merge: async () => {
                        mergeCalls += 1;
                    },
                },
            },
        } as unknown as Octokit;

        await expect(
            service.merge(client, "owner/repository", 45, "feature-sha"),
        ).rejects.toThrow("closed but not merged");
        expect(mergeCalls).toBe(0);
    });

    test.each([
        { mergeable: false, description: "unmergeable" },
        { mergeable: null, description: "unknown mergeability" },
    ])("does not merge an $description pull request", async ({ mergeable }) => {
        let mergeCalls = 0;
        const current = {
            ...pullRequest(46, "feature", "main"),
            mergeable,
        };
        const client = {
            rest: {
                pulls: {
                    get: async () => ({ data: current }),
                    merge: async () => {
                        mergeCalls += 1;
                    },
                },
            },
        } as unknown as Octokit;

        await expect(
            service.merge(client, "owner/repository", 46, "feature-sha"),
        ).rejects.toThrow("not definitively mergeable");
        expect(mergeCalls).toBe(0);
    });

    test("does not merge when the head SHA changed", async () => {
        let mergeCalls = 0;
        const client = {
            rest: {
                pulls: {
                    get: async () => ({
                        data: pullRequest(47, "updated-feature", "main"),
                    }),
                    merge: async () => {
                        mergeCalls += 1;
                    },
                },
            },
        } as unknown as Octokit;

        await expect(
            service.merge(client, "owner/repository", 47, "feature-sha"),
        ).rejects.toThrow(
            "head changed from feature-sha to updated-feature-sha",
        );
        expect(mergeCalls).toBe(0);
    });

    test("reconciles a lost merge response with an authoritative read", async () => {
        let reads = 0;
        const client = {
            rest: {
                pulls: {
                    get: async () => {
                        reads += 1;
                        return {
                            data: pullRequest(48, "feature", "main", reads > 1),
                        };
                    },
                    merge: async () => {
                        throw new Error("response lost");
                    },
                },
            },
        } as unknown as Octokit;

        const result = await service.merge(
            client,
            "owner/repository",
            48,
            "feature-sha",
        );
        expect(reads).toBe(2);
        expect(result.merged).toBeTrue();
    });

    test.each([
        { lostResponse: true, description: "lost-response reconciliation" },
        { lostResponse: false, description: "post-merge verification" },
    ])(
        "returns the authoritative changed head during $description",
        async ({ lostResponse }) => {
            let reads = 0;
            const client = {
                rest: {
                    pulls: {
                        get: async () => {
                            reads += 1;
                            return {
                                data: pullRequest(
                                    49,
                                    reads === 1 ? "feature" : "updated-feature",
                                    "main",
                                    reads > 1,
                                ),
                            };
                        },
                        merge: async () => {
                            if (lostResponse) throw new Error("response lost");
                            return { data: { merged: true } };
                        },
                    },
                },
            } as unknown as Octokit;

            const result = await service.merge(
                client,
                "owner/repository",
                49,
                "feature-sha",
            );
            expect(result.merged).toBeTrue();
            expect(result.headSha).toBe("updated-feature-sha");
        },
    );

    test("returns an already-merged pull request without merging again", async () => {
        let mergeCalls = 0;
        const client = {
            rest: {
                pulls: {
                    get: async () => ({
                        data: pullRequest(49, "updated-feature", "main", true),
                    }),
                    merge: async () => {
                        mergeCalls += 1;
                    },
                },
            },
        } as unknown as Octokit;

        const result = await service.merge(
            client,
            "owner/repository",
            49,
            "feature-sha",
        );
        expect(result.merged).toBeTrue();
        expect(result.headSha).toBe("updated-feature-sha");
        expect(mergeCalls).toBe(0);
    });

    test("returns an error when GitHub does not confirm a merge", async () => {
        const client = {
            rest: {
                pulls: {
                    get: async () => ({
                        data: pullRequest(45, "feature", "main"),
                    }),
                    merge: async () => ({ data: { merged: false } }),
                },
            },
        } as unknown as Octokit;

        await expect(
            service.merge(client, "owner/repository", 45, "feature-sha"),
        ).rejects.toThrow("did not reach the merged state");
    });
});