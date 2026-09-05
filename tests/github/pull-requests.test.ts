import { describe, expect, test } from "bun:test";
import type { Octokit } from "octokit";

import {
    makeGitHubPullRequestService,
    type PullRequestMergeProof,
} from "../../src/github/pull-requests.ts";
import {
    ReviewVerdict,
    type ReviewDecision,
} from "../../src/issues/decisions.ts";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const MOVED_HEAD = "c".repeat(40);

const approved: ReviewDecision = {
    verdict: ReviewVerdict.Approved,
    summary: "The exact committed PR head is safe to merge.",
    findings: [],
};

const proofFor = (
    overrides: Partial<PullRequestMergeProof> = {},
): PullRequestMergeProof => ({
    pullRequestNumber: 7,
    baseSha: BASE,
    headSha: HEAD,
    review: {
        pullRequestNumber: 7,
        baseSha: BASE,
        reviewedHeadSha: HEAD,
        attempt: 1,
        sessionID: "review-session-1",
        decision: approved,
    },
    checks: {
        pullRequestNumber: 7,
        headSha: HEAD,
        status: "green",
    },
    ...overrides,
});

const pullRequestResponse = (input: {
    readonly headSha?: string;
    readonly baseSha?: string;
    readonly merged?: boolean;
    readonly state?: "open" | "closed";
}) => ({
    data: {
        number: 7,
        html_url: "https://github.com/owner/repository/pull/7",
        state: input.state ?? "open",
        merged: input.merged ?? false,
        merged_at: input.merged ? "2026-09-05T00:00:00Z" : null,
        mergeable: true,
        base: { ref: "main", sha: input.baseSha ?? BASE },
        head: { ref: "ralphie/issue-7", sha: input.headSha ?? HEAD },
    },
});

const makeClient = (
    responses: ReadonlyArray<ReturnType<typeof pullRequestResponse>>,
) => {
    const calls: string[] = [];
    let getIndex = 0;
    const client = {
        rest: {
            pulls: {
                get: async () => {
                    calls.push("get");
                    return responses[
                        Math.min(getIndex++, responses.length - 1)
                    ]!;
                },
                merge: async () => {
                    calls.push("merge");
                    return pullRequestResponse({
                        merged: true,
                        state: "closed",
                    });
                },
            },
        },
    } as unknown as Octokit;
    return { client, calls };
};

describe("GitHub pull-request merge proof", () => {
    test("requires approved structured review and green checks for the exact head", async () => {
        const service = makeGitHubPullRequestService();
        const { client, calls } = makeClient([
            pullRequestResponse({}),
            pullRequestResponse({}),
            pullRequestResponse({ merged: true, state: "closed" }),
        ]);

        const result = await service.mergeWithProof!(
            client,
            "owner/repository",
            proofFor(),
        );

        expect(result.merged).toBe(true);
        expect(calls).toEqual(["get", "get", "merge", "get"]);
    });

    test.each([
        {
            name: "missing proof",
            proof: undefined,
            message: "without a same-head approval",
        },
        {
            name: "pending checks",
            proof: proofFor({
                checks: {
                    pullRequestNumber: 7,
                    headSha: HEAD,
                    status: "pending",
                },
            }),
            message: "does not have a green-check proof",
        },
        {
            name: "failed checks",
            proof: proofFor({
                checks: {
                    pullRequestNumber: 7,
                    headSha: HEAD,
                    status: "failed",
                },
            }),
            message: "does not have a green-check proof",
        },
        {
            name: "stale approval",
            proof: proofFor({
                review: {
                    ...proofFor().review!,
                    reviewedHeadSha: MOVED_HEAD,
                },
            }),
            message: "review evidence does not match",
        },
    ])("does not call GitHub merge for $name", async ({ proof, message }) => {
        const service = makeGitHubPullRequestService();
        const { client, calls } = makeClient([pullRequestResponse({})]);

        await expect(
            service.mergeWithProof!(client, "owner/repository", proof),
        ).rejects.toThrow(message);
        expect(calls).not.toContain("merge");
    });

    test("rejects a PR head move after proof capture without merging", async () => {
        const service = makeGitHubPullRequestService();
        const { client, calls } = makeClient([
            pullRequestResponse({ headSha: MOVED_HEAD }),
        ]);

        await expect(
            service.mergeWithProof!(client, "owner/repository", proofFor()),
        ).rejects.toThrow("changed before merge");
        expect(calls).toEqual(["get"]);
    });

    test("rejects a PR base move during the final merge re-read without merging", async () => {
        const service = makeGitHubPullRequestService();
        const { client, calls } = makeClient([
            pullRequestResponse({}),
            pullRequestResponse({ baseSha: MOVED_HEAD }),
        ]);

        await expect(
            service.mergeWithProof!(client, "owner/repository", proofFor()),
        ).rejects.toThrow("base changed before merge");
        expect(calls).toEqual(["get", "get"]);
    });

    test("reconciles a lost merge response only after an authoritative merged read", async () => {
        const service = makeGitHubPullRequestService();
        const { client, calls } = makeClient([
            pullRequestResponse({}),
            pullRequestResponse({}),
            pullRequestResponse({ merged: true, state: "closed" }),
        ]);
        const pulls = client.rest.pulls as unknown as {
            merge: () => Promise<never>;
        };
        pulls.merge = async () => {
            calls.push("merge");
            throw new Error("response lost");
        };

        const result = await service.mergeWithProof!(
            client,
            "owner/repository",
            proofFor(),
        );

        expect(result.merged).toBe(true);
        expect(calls).toEqual(["get", "get", "merge", "get"]);
    });
});