import { describe, expect, test } from "bun:test";
import type { Octokit } from "octokit";

import { makeGitHubIssuesService } from "../../src/github/issues.ts";

describe("GitHub decomposition issue discovery", () => {
    test("finds matching generated children and ignores unrelated issues", async () => {
        let request: Record<string, unknown> | undefined;
        const client = {
            rest: { issues: { listForRepo: Symbol("listForRepo") } },
            paginate: async (
                _method: unknown,
                parameters: Record<string, unknown>,
            ) => {
                request = parameters;
                return [
                    {
                        number: 101,
                        title: "Storage",
                        html_url:
                            "https://github.com/owner/repository/issues/101",
                        body: '<!-- ralphie:decomposition root=42 parent=42 key="storage" depth=1 -->\nBody',
                        labels: [{ name: "generated" }],
                    },
                    {
                        number: 102,
                        title: "Other parent",
                        html_url:
                            "https://github.com/owner/repository/issues/102",
                        body: '<!-- ralphie:decomposition root=42 parent=99 key="other" depth=1 -->',
                        labels: [],
                    },
                    {
                        number: 103,
                        title: "Pull request",
                        html_url:
                            "https://github.com/owner/repository/pull/103",
                        body: '<!-- ralphie:decomposition root=42 parent=42 key="pr" depth=1 -->',
                        pull_request: {},
                        labels: [],
                    },
                ];
            },
        } as unknown as Octokit;

        const children =
            await makeGitHubIssuesService().listDecompositionChildren(
                client,
                "owner/repository",
                { rootIssueNumber: 42, parentIssueNumber: 42, depth: 1 },
            );

        expect(request).toEqual({
            owner: "owner",
            repo: "repository",
            state: "all",
            per_page: 100,
        });
        expect(children).toEqual([
            {
                number: 101,
                title: "Storage",
                url: "https://github.com/owner/repository/issues/101",
                body: '<!-- ralphie:decomposition root=42 parent=42 key="storage" depth=1 -->\nBody',
                labels: ["generated"],
                decompositionKey: "storage",
            },
        ]);
    });
});