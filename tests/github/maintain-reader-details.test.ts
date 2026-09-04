import { describe, expect, test } from "bun:test";

import type { Octokit } from "octokit";

import {
    collectMaintainReaderDetails,
    DEFAULT_MAINTAIN_COMMENT_PROMPT_LIMIT,
} from "../../src/maintain/github-reader/details.ts";
import { MaintainGitHubReaderDiagnosticError } from "../../src/maintain/github-reader/diagnostics.ts";

const response = (data: unknown, link?: string, status = 200): unknown => ({
    data,
    status,
    headers: link === undefined ? {} : { link },
});

const next =
    '<https://api.github.com/repos/o/r/issues/7/comments?page=2>; rel="next", <https://api.github.com/repos/o/r/issues/7/comments?page=2>; rel="last"';

const issue = (): Record<string, unknown> => ({
    number: 7,
    node_id: "I_7",
    title: "Selected issue",
    body: "body\n<!-- ralphie:maintain issue=7 -->",
    html_url: "https://github.com/o/r/issues/7",
    url: "https://api.github.com/repos/o/r/issues/7",
    state: "open",
    user: { login: "owner", type: "User", node_id: "U_1" },
    author_association: "MEMBER",
    labels: [{ name: "bug", color: "ff0000" }],
    assignees: [{ login: "agent", type: "Bot" }],
    milestone: null,
    locked: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
});

const comment = (id: number, body: string): Record<string, unknown> => ({
    id,
    node_id: `C_${String(id)}`,
    url: `https://api.github.com/comments/${String(id)}`,
    html_url: `https://github.com/o/r#issuecomment-${String(id)}`,
    user: id === 2 ? null : { login: "commenter", type: "FutureActor" },
    author_association: "FUTURE_ASSOCIATION",
    body,
    created_at: "2026-01-03T00:00:00Z",
    updated_at: "2026-01-03T00:00:00Z",
});

const makeClient = (
    calls: Array<{ name: string; parameters: Record<string, unknown> }>,
): Octokit => {
    const issues = {
        get: async (parameters: Record<string, unknown>) => {
            calls.push({ name: "get", parameters });
            return response(issue());
        },
        listComments: async (parameters: Record<string, unknown>) => {
            calls.push({ name: "comments", parameters });
            return parameters.page === 1
                ? response(
                      [comment(1, "first <!-- ralphie:maintain issue=7 -->")],
                      next,
                  )
                : response([comment(2, "second")]);
        },
    };
    return { rest: { issues } } as unknown as Octokit;
};

describe("maintenance GitHub reader detail collection", () => {
    test("maps all issue/comment fields, markers, locked availability, and complete pages", async () => {
        const calls: Array<{
            name: string;
            parameters: Record<string, unknown>;
        }> = [];
        const result = await collectMaintainReaderDetails(
            makeClient(calls),
            "o/r",
            [7],
        );
        const detail = result.details[0];
        expect(detail?.issue).toMatchObject({
            number: 7,
            nodeId: "I_7",
            title: "Selected issue",
            body: "body\n<!-- ralphie:maintain issue=7 -->",
            url: "https://github.com/o/r/issues/7",
            htmlUrl: "https://github.com/o/r/issues/7",
            locked: true,
            isRalphieManaged: true,
        });
        expect(detail?.issue.author?.login).toBe("owner");
        expect(detail?.issue.availability).toMatchObject({
            kind: "partial",
            reason: "locked",
        });
        expect(detail?.thread.comments).toHaveLength(2);
        expect(detail?.thread.complete).toBe(false);
        expect(detail?.thread.totalCount).toBe(2);
        expect(detail?.thread.comments[0]?.isRalphieManaged).toBe(true);
        expect(detail?.thread.comments[1]?.author).toBeNull();
        expect(detail?.thread.comments[0]?.authorAssociation).toEqual({
            kind: "unknown",
            value: "FUTURE_ASSOCIATION",
        });
        expect(detail?.threadProjection.fetchedThread).toBe(detail?.thread);
        expect(detail?.threadProjection.commentLimit).toBe(
            DEFAULT_MAINTAIN_COMMENT_PROMPT_LIMIT,
        );
        expect(calls.map((call) => call.name)).toEqual([
            "get",
            "comments",
            "comments",
        ]);
        expect(calls[0]?.parameters).toEqual({
            owner: "o",
            repo: "r",
            issue_number: 7,
        });
        expect(calls[1]?.parameters).toEqual({
            owner: "o",
            repo: "r",
            issue_number: 7,
            page: 1,
            per_page: 100,
        });
    });

    test("record-level detail failures become typed skips", async () => {
        const calls: Array<{
            name: string;
            parameters: Record<string, unknown>;
        }> = [];
        const client = {
            rest: {
                issues: {
                    get: async (parameters: Record<string, unknown>) => {
                        calls.push({ name: "get", parameters });
                        throw Object.assign(new Error("gone"), {
                            status: 410,
                            response: { status: 410 },
                        });
                    },
                    listComments: async () => response([]),
                },
            },
        } as unknown as Octokit;
        const result = await collectMaintainReaderDetails(client, "o/r", [7]);
        expect(result.issues[0]?.skip?.reason).toBe("deleted");
        expect(result.skips[0]?.issueNumber).toBe(7);
        expect(calls).toHaveLength(1);
    });

    test("pull requests and hard diagnostics never become skips", async () => {
        const pullRequestClient = {
            rest: {
                issues: {
                    get: async () => response({ ...issue(), pull_request: {} }),
                    listComments: async () => response([]),
                },
            },
        } as unknown as Octokit;
        const pullRequest = await collectMaintainReaderDetails(
            pullRequestClient,
            "o/r",
            [7],
        );
        expect(pullRequest.issues[0]?.skip?.reason).toBe("unavailable");
        expect(pullRequest.issues[0]?.skip?.detail).toContain("pull request");

        const rateLimitedClient = {
            rest: {
                issues: {
                    get: async () => {
                        throw Object.assign(new Error("rate limited"), {
                            status: 403,
                            response: {
                                status: 403,
                                headers: { "x-ratelimit-remaining": "0" },
                            },
                        });
                    },
                    listComments: async () => response([]),
                },
            },
        } as unknown as Octokit;
        await expect(
            collectMaintainReaderDetails(rateLimitedClient, "o/r", [7]),
        ).rejects.toBeInstanceOf(MaintainGitHubReaderDiagnosticError);
    });

    test("abort between comment pages is propagated", async () => {
        const controller = new AbortController();
        const reason = new Error("stop comments");
        let calls = 0;
        const client = {
            rest: {
                issues: {
                    get: async () => response(issue()),
                    listComments: async (
                        parameters: Record<string, unknown>,
                    ) => {
                        calls += 1;
                        if (parameters.page === 1) {
                            controller.abort(reason);
                            return response([comment(1, "first")], next);
                        }
                        return response([comment(2, "second")]);
                    },
                },
            },
        } as unknown as Octokit;
        await expect(
            collectMaintainReaderDetails(client, "o/r", [7], controller.signal),
        ).rejects.toBe(reason);
        expect(calls).toBe(1);
    });
});