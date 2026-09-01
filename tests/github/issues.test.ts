import { describe, expect, test } from "bun:test";
import type { Octokit } from "octokit";

import {
    makeGitHubIssuesService,
    isIssueEligible,
    MAX_ISSUE_COMMENT_BODY_LENGTH,
    MAX_ISSUE_COMMENTS,
    IssueOrder,
    IssueSort,
} from "../../src/github/issues.ts";

const listOpen = (client: Octokit, labels: ReadonlyArray<string> = []) =>
    makeGitHubIssuesService().listOpen(client, "owner/repository", {
        labels,
        sort: IssueSort.Created,
        order: IssueOrder.Ascending,
    });

describe("GitHub issues", () => {
    test("requires an open issue with every configured label", () => {
        const issue = {
            number: 42,
            title: "Issue",
            url: "issue/42",
            body: null,
            labels: ["Bug", "Ready"],
            state: "open" as const,
        };
        const filters = {
            labels: ["bug", "READY"],
            sort: IssueSort.Created,
            order: IssueOrder.Ascending,
        };

        expect(isIssueEligible(issue, filters)).toBe(true);
        expect(isIssueEligible({ ...issue, state: "closed" }, filters)).toBe(
            false,
        );
        expect(isIssueEligible({ ...issue, labels: ["bug"] }, filters)).toBe(
            false,
        );
        expect(isIssueEligible({ ...issue, state: undefined }, filters)).toBe(
            false,
        );
    });

    test("paginates, applies filters, and excludes pull requests", async () => {
        let request: Record<string, unknown> | undefined;
        let commentRequest: Record<string, unknown> | undefined;
        const listForRepo = Symbol("listForRepo");
        const listComments = Symbol("listComments");
        const client = {
            rest: { issues: { listForRepo, listComments } },
            paginate: async (
                method: unknown,
                parameters: Record<string, unknown>,
            ) => {
                if (method === listComments) {
                    commentRequest = parameters;
                    return [
                        {
                            id: 901,
                            body: "A bounded comment",
                            updated_at: "2026-08-29T00:00:00.000Z",
                        },
                    ];
                }
                request = parameters;
                return [
                    {
                        number: 12,
                        title: "First issue",
                        html_url:
                            "https://github.com/owner/repository/issues/12",
                        body: "Issue body",
                        state: "open",
                        updated_at: "2026-08-28T00:00:00.000Z",
                        comments: 3,
                        labels: ["bug", { name: "priority" }, { name: null }],
                    },
                    {
                        number: 13,
                        title: "A pull request",
                        html_url: "https://github.com/owner/repository/pull/13",
                        pull_request: {},
                    },
                ];
            },
        } as unknown as Octokit;

        const issues = await listOpen(client, ["bug", "priority"]);

        expect(request).toEqual({
            owner: "owner",
            repo: "repository",
            state: "open",
            sort: IssueSort.Created,
            direction: IssueOrder.Ascending,
            per_page: 100,
            labels: "bug,priority",
        });
        expect(commentRequest).toEqual({
            owner: "owner",
            repo: "repository",
            issue_number: 12,
            per_page: 100,
        });
        expect(issues).toEqual([
            {
                number: 12,
                title: "First issue",
                url: "https://github.com/owner/repository/issues/12",
                body: "Issue body",
                labels: ["bug", "priority"],
                state: "open",
                updatedAt: "2026-08-28T00:00:00.000Z",
                comments: [
                    {
                        id: 901,
                        body: "A bounded comment",
                        updatedAt: "2026-08-29T00:00:00.000Z",
                    },
                ],
                commentCount: 3,
                commentVersion: "2026-08-29T00:00:00.000Z",
            },
        ]);
    });

    test("refreshes a closed issue and bounds its paginated comments", async () => {
        const listComments = Symbol("listComments");
        const comments = Array.from(
            { length: MAX_ISSUE_COMMENTS + 2 },
            (_, index) => ({
                id: index + 1,
                body:
                    index === MAX_ISSUE_COMMENTS + 1
                        ? "x".repeat(MAX_ISSUE_COMMENT_BODY_LENGTH + 100)
                        : `Comment ${index + 1}`,
                updated_at: `2026-08-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
            }),
        );
        const requests: Array<Record<string, unknown>> = [];
        const client = {
            rest: {
                issues: {
                    get: async (parameters: Record<string, unknown>) => {
                        requests.push(parameters);
                        return {
                            data: {
                                number: 12,
                                title: "Closed issue",
                                html_url:
                                    "https://github.com/owner/repository/issues/12",
                                body: "Issue body",
                                state: "closed",
                                updated_at: "2026-08-30T00:00:00.000Z",
                                comments: comments.length,
                                labels: [{ name: "bug" }, "priority"],
                            },
                        };
                    },
                    listComments,
                },
            },
            paginate: async (
                method: unknown,
                parameters: Record<string, unknown>,
            ) => {
                expect(method).toBe(listComments);
                requests.push(parameters);
                return comments;
            },
        } as unknown as Octokit;

        const issue = await makeGitHubIssuesService().refresh(
            client,
            "owner/repository",
            12,
        );

        expect(requests).toEqual([
            { owner: "owner", repo: "repository", issue_number: 12 },
            {
                owner: "owner",
                repo: "repository",
                issue_number: 12,
                per_page: 100,
            },
        ]);
        expect(issue.state).toBe("closed");
        expect(issue.labels).toEqual(["bug", "priority"]);
        expect(issue.commentCount).toBe(MAX_ISSUE_COMMENTS + 2);
        expect(issue.commentVersion).toBe("2026-08-22T00:00:00.000Z");
        expect(issue.comments).toHaveLength(MAX_ISSUE_COMMENTS);
        expect(issue.comments?.[0]?.id).toBe(3);
        expect(issue.comments?.at(-1)?.body.length).toBe(
            MAX_ISSUE_COMMENT_BODY_LENGTH,
        );
        expect(issue.comments?.at(-1)?.body).toContain(
            "[issue comment body truncated]",
        );
    });

    test("maps issue listing failures into the domain error", async () => {
        const client = {
            rest: { issues: { listForRepo: Symbol("listForRepo") } },
            paginate: async () => {
                throw new Error("network failed");
            },
        } as unknown as Octokit;

        await expect(listOpen(client)).rejects.toThrow(
            "Failed to fetch open issues",
        );
    });

    test("maps issue get failures without attempting comment pagination", async () => {
        const calls: string[] = [];
        const client = {
            rest: {
                issues: {
                    get: async () => {
                        calls.push("get");
                        throw new Error("issue unavailable");
                    },
                    listComments: Symbol("listComments"),
                },
            },
            paginate: async () => {
                calls.push("comments");
                return [];
            },
        } as unknown as Octokit;

        await expect(
            makeGitHubIssuesService().refresh(client, "owner/repository", 12),
        ).rejects.toThrow("Failed to refresh issue #12");
        expect(calls).toEqual(["get"]);
    });

    test("maps comment pagination failures after the issue get", async () => {
        const calls: string[] = [];
        const listComments = Symbol("listComments");
        const client = {
            rest: {
                issues: {
                    get: async () => {
                        calls.push("get");
                        return {
                            data: {
                                number: 12,
                                title: "Issue",
                                html_url:
                                    "https://github.com/owner/repository/issues/12",
                                body: null,
                                state: "open",
                                updated_at: "2026-08-28T00:00:00.000Z",
                                comments: 1,
                                labels: [],
                            },
                        };
                    },
                    listComments,
                },
            },
            paginate: async () => {
                calls.push("comments");
                throw new Error("comments unavailable");
            },
        } as unknown as Octokit;

        await expect(
            makeGitHubIssuesService().refresh(client, "owner/repository", 12),
        ).rejects.toThrow("Failed to refresh issue #12");
        expect(calls).toEqual(["get", "comments"]);
    });
});