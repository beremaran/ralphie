import { describe, expect, test } from "bun:test";

import type { Octokit } from "octokit";

import {
    collectMaintainReaderLists,
    mapMaintainRepositoryIdentity,
} from "../../src/maintain/github-reader/lists.ts";

const response = (data: unknown, link?: string): unknown => ({
    data,
    status: 200,
    headers: link === undefined ? {} : { link },
});

const next =
    '<https://api.github.com/repos/o/r/issues?page=2>; rel="next", <https://api.github.com/repos/o/r/issues?page=2>; rel="last"';

const issue = (
    number: number,
    extra: Record<string, unknown> = {},
): unknown => ({
    number,
    node_id: `I_${String(number)}`,
    title: `issue-${String(number)}`,
    html_url: `https://github.com/o/r/issues/${String(number)}`,
    state: "open",
    user: { login: `user-${String(number)}`, type: "User" },
    labels: [{ name: number === 1 ? "z" : "a" }],
    updated_at: "2026-09-01T00:00:00Z",
    ...extra,
});

const makeClient = (
    calls: Array<{ name: string; parameters: Record<string, unknown> }>,
): Octokit => {
    const repos = {
        get: async (parameters: Record<string, unknown>) => {
            calls.push({ name: "repos.get", parameters });
            return response({
                full_name: "o/r",
                default_branch: "main",
                html_url: "https://github.com/o/r",
                unknown_field: { retained: true },
            });
        },
    };
    const issues = {
        listLabelsForRepo: async (parameters: Record<string, unknown>) => {
            calls.push({ name: "labels", parameters });
            return parameters.page === 1
                ? response([{ name: "z", color: "fff" }], next)
                : response([{ name: "a", description: "first" }]);
        },
        listForRepo: async (parameters: Record<string, unknown>) => {
            calls.push({ name: "issues", parameters });
            return parameters.page === 1
                ? response(
                      [issue(2), issue(1), issue(8, { pull_request: {} })],
                      next,
                  )
                : response([
                      issue(1),
                      issue(3, { state: "future-state", user: null }),
                  ]);
        },
    };
    return { rest: { repos, issues } } as unknown as Octokit;
};

describe("maintenance GitHub reader list collection", () => {
    test("maps identity, paginates each list once, filters PRs, and orders results", async () => {
        const calls: Array<{
            name: string;
            parameters: Record<string, unknown>;
        }> = [];
        const result = await collectMaintainReaderLists(
            makeClient(calls),
            "o/r",
        );

        expect(result.repository).toMatchObject({
            fullName: "o/r",
            defaultBranch: "main",
            rawDefaultBranch: "main",
        });
        expect(result.repository.raw.unknown_field).toEqual({ retained: true });
        expect(result.labels.map((label) => label.name)).toEqual(["a", "z"]);
        expect(result.openIssueSummaries.map((value) => value.number)).toEqual([
            1, 2, 3,
        ]);
        expect(result.openIssueSummaries[0]?.state).toEqual("open");
        expect(result.openIssueSummaries[2]?.state).toEqual({
            kind: "unknown",
            value: "future-state",
        });
        expect(result.openIssueSummaries[2]?.author).toBeNull();
        expect(calls.map((call) => call.name)).toEqual([
            "repos.get",
            "labels",
            "labels",
            "issues",
            "issues",
        ]);
        expect(calls[0]?.parameters).toEqual({ owner: "o", repo: "r" });
        expect(calls[1]?.parameters).toEqual({
            owner: "o",
            repo: "r",
            page: 1,
            per_page: 100,
        });
        expect(calls[3]?.parameters).toEqual({
            owner: "o",
            repo: "r",
            state: "open",
            page: 1,
            per_page: 100,
        });
    });

    test("filters a pull request by key presence even when the value is undefined", async () => {
        const calls: Array<{
            name: string;
            parameters: Record<string, unknown>;
        }> = [];
        const client = makeClient(calls);
        const result = await collectMaintainReaderLists(client, "o/r");
        expect(
            result.openIssueSummaries.some((value) => value.number === 8),
        ).toBe(false);
    });

    test("preserves null and malformed identity values without throwing", () => {
        const identity = mapMaintainRepositoryIdentity(
            {
                full_name: null,
                default_branch: { future: true },
                html_url: null,
            },
            "o/r",
        );
        expect(identity.fullName).toBe("o/r");
        expect(identity.defaultBranch).toBe("");
        expect(identity.rawDefaultBranch).toEqual({ future: true });
        expect(Object.isFrozen(identity)).toBe(true);
        expect(Object.isFrozen(identity.raw)).toBe(true);
    });

    test("abort between phases prevents later list requests", async () => {
        const controller = new AbortController();
        const calls: Array<{
            name: string;
            parameters: Record<string, unknown>;
        }> = [];
        const client = makeClient(calls) as unknown as {
            rest: {
                issues: {
                    listLabelsForRepo: (
                        parameters: Record<string, unknown>,
                    ) => Promise<unknown>;
                };
            };
        };
        const original = client.rest.issues.listLabelsForRepo;
        client.rest.issues.listLabelsForRepo = async (parameters) => {
            const result = await original(parameters);
            if (parameters.page === 1) controller.abort(new Error("cancelled"));
            return result;
        };
        const error = await collectMaintainReaderLists(
            client as unknown as Octokit,
            "o/r",
            controller.signal,
        ).catch((caught) => caught);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("cancelled");
        expect(calls.map((call) => call.name)).toEqual(["repos.get", "labels"]);
    });
});