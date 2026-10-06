import { describe, expect, test } from "bun:test";
import type { Octokit } from "octokit";

import { makeGitHubIssueMutationsService } from "../../src/github/adapters/issue-mutations.ts";
import { mapGitHubIssue } from "../../src/github/adapters/issues.ts";
import type { GitHubIssue } from "../../src/github/domain.ts";
import {
    isDecomposedParent,
    parseGeneratedIssueDependencies,
    renderChildIssueBody,
} from "../../src/issues/domain/decomposition-markdown.ts";
import { toQueuedIssues } from "../../src/issues/domain/queue.ts";

const issue = (number: number, body: string | null = null): GitHubIssue => ({
    number,
    title: `Issue ${number}`,
    url: `https://github.com/owner/repo/issues/${number}`,
    body,
    labels: ["ready-for-agent"],
    state: "open",
});

describe("decomposition issue model", () => {
    test("renders and parses the Blocked by section", () => {
        const body = renderChildIssueBody({
            child: {
                key: "b",
                title: "B",
                whatToBuild: "Build B.",
                acceptanceCriteria: ["B works."],
                dependsOn: ["a"],
            },
            lineage: { rootIssueNumber: 7, parentIssueNumber: 7, depth: 1 },
            issueNumbers: { a: 11 },
        });
        expect(parseGeneratedIssueDependencies(issue(12, body))).toEqual([11]);
    });

    test("still parses the legacy Dependencies section", () => {
        const body =
            '<!-- ralphie:decomposition root=7 parent=7 key="b" depth=1 -->\n\nWork.\n\n## Dependencies\n\n- #11 (a)';
        expect(parseGeneratedIssueDependencies(issue(12, body))).toEqual([11]);
    });

    test("a parent is recognised by its native sub-issue count", () => {
        expect(isDecomposedParent({ ...issue(7), subIssueCount: 2 })).toBe(
            true,
        );
        expect(isDecomposedParent({ ...issue(7), subIssueCount: 0 })).toBe(
            false,
        );
        expect(isDecomposedParent(issue(7, "Untouched body."))).toBe(false);
    });

    test("the queue skips a parent named by an open child marker", () => {
        const parent = issue(7, "Untouched body.");
        const child = issue(
            11,
            '<!-- ralphie:decomposition root=7 parent=7 key="a" depth=1 -->',
        );
        expect(
            toQueuedIssues([parent, child]).map(({ issue }) => issue.number),
        ).toEqual([11]);
    });

    test("maps the native sub-issue count from GitHub", () => {
        expect(
            mapGitHubIssue({
                number: 7,
                title: "T",
                html_url: "u",
                sub_issues_summary: { total: 3 },
            }).subIssueCount,
        ).toBe(3);
        expect(
            mapGitHubIssue({ number: 7, title: "T", html_url: "u" })
                .subIssueCount,
        ).toBeUndefined();
    });

    test("creates issues with labels and posts comments", async () => {
        const requests: Array<Record<string, unknown>> = [];
        const client = {
            rest: {
                issues: {
                    create: async (parameters: Record<string, unknown>) => {
                        requests.push({ create: parameters });
                        return {
                            data: { number: 5, title: "T", html_url: "u" },
                        };
                    },
                    createComment: async (
                        parameters: Record<string, unknown>,
                    ) => {
                        requests.push({ comment: parameters });
                        return { data: {} };
                    },
                },
            },
        } as unknown as Octokit;
        const service = makeGitHubIssueMutationsService({
            client: () => client,
        });
        await service.create("owner/repo", {
            title: "T",
            body: "B",
            labels: ["ready-for-agent"],
        });
        await service.comment("owner/repo", 5, "Done.");
        expect(requests).toEqual([
            {
                create: {
                    owner: "owner",
                    repo: "repo",
                    title: "T",
                    body: "B",
                    labels: ["ready-for-agent"],
                },
            },
            {
                comment: {
                    owner: "owner",
                    repo: "repo",
                    issue_number: 5,
                    body: "Done.",
                },
            },
        ]);
    });
});