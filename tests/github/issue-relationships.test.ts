import { describe, expect, test } from "bun:test";
import type { Octokit } from "octokit";

import { makeGitHubIssueRelationshipService } from "../../src/github/adapters/issue-relationships.ts";

const REPOSITORY = "owner/repository";

const record = (number: number, id = number * 10) => ({
    id,
    number,
    title: `Issue ${number}`,
    html_url: `https://github.com/owner/repository/issues/${number}`,
    body: null,
    labels: [],
    state: "open",
    updated_at: "2026-01-01T00:00:00Z",
    comments: 0,
});

type Handler = (parameters: Record<string, unknown>) => unknown;

/**
 * A fake Octokit keyed by route. Handlers may return data, throw, or be
 * absent (an unexpected request fails the test). Paginated routes serve the
 * handler's array split into pages of `pageSize`.
 */
const fakeClient = (
    routes: Record<string, Handler>,
    options: { readonly pageSize?: number } = {},
) => {
    const requests: Array<{
        readonly route: string;
        readonly parameters: Record<string, unknown>;
    }> = [];
    const call = (route: string, parameters: Record<string, unknown>) => {
        requests.push({ route, parameters });
        const handler = routes[route];
        if (handler === undefined) throw new Error(`Unexpected ${route}`);
        return handler(parameters);
    };
    const client = {
        rest: {
            issues: {
                get: async (parameters: Record<string, unknown>) => ({
                    data: await call("issues.get", parameters),
                }),
            },
        },
        request: async (
            route: string,
            parameters: Record<string, unknown>,
        ) => ({
            data: await call(route, parameters),
        }),
        paginate: async (
            route: string,
            parameters: Record<string, unknown>,
        ) => {
            const all = (await call(route, parameters)) as unknown[];
            const size = options.pageSize ?? all.length;
            const collected: unknown[] = [];
            for (let index = 0; index < all.length; index += size) {
                collected.push(...all.slice(index, index + size));
            }
            return collected;
        },
    } as unknown as Octokit;
    const service = makeGitHubIssueRelationshipService({
        client: () => client,
    });
    return { service, requests };
};

const PARENT = "GET /repos/{owner}/{repo}/issues/{issue_number}/parent";
const SUB_ISSUES = "GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues";
const ATTACH = "POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues";
const BLOCKED_BY =
    "GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by";
const ADD_BLOCKED_BY =
    "POST /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by";

const notFound = () => Object.assign(new Error("Not Found"), { status: 404 });

describe("GitHub issue relationships", () => {
    test("attach resolves the child's numeric id and posts it to the parent", async () => {
        const { service, requests } = fakeClient({
            [PARENT]: () => {
                throw notFound();
            },
            "issues.get": () => record(7, 777),
            [ATTACH]: () => ({}),
        });
        await service.attachSubIssue(REPOSITORY, 1, 7);
        const post = requests.find(({ route }) => route === ATTACH);
        expect(post?.parameters).toMatchObject({
            owner: "owner",
            repo: "repository",
            issue_number: 1,
            sub_issue_id: 777,
        });
    });

    test("attach is a no-op when the child is already attached to that parent", async () => {
        const { service, requests } = fakeClient({
            [PARENT]: () => record(1),
        });
        await service.attachSubIssue(REPOSITORY, 1, 7);
        expect(requests.map(({ route }) => route)).toEqual([PARENT]);
    });

    test("attach refuses a child that belongs to a different parent", async () => {
        const { service, requests } = fakeClient({
            [PARENT]: () => record(2),
        });
        await expect(service.attachSubIssue(REPOSITORY, 1, 7)).rejects.toThrow(
            "already a native sub-issue of #2, not #1",
        );
        expect(requests.some(({ route }) => route === ATTACH)).toBe(false);
    });

    test("attach reconciles a lost response when the child is now attached", async () => {
        let parentReads = 0;
        const { service } = fakeClient({
            [PARENT]: () => {
                parentReads += 1;
                if (parentReads === 1) throw notFound();
                return record(1);
            },
            "issues.get": () => record(7),
            [ATTACH]: () => {
                throw new Error("socket hang up");
            },
        });
        await service.attachSubIssue(REPOSITORY, 1, 7);
        expect(parentReads).toBe(2);
    });

    test("attach reports an actionable error when the attach failed for real", async () => {
        const { service } = fakeClient({
            [PARENT]: () => {
                throw notFound();
            },
            "issues.get": () => record(7),
            [ATTACH]: () => {
                throw new Error("forbidden");
            },
        });
        await expect(service.attachSubIssue(REPOSITORY, 1, 7)).rejects.toThrow(
            "Failed to attach issue #7 as a native sub-issue of #1",
        );
    });

    test("parentOf maps a 404 to no parent and other errors to a failure", async () => {
        const missing = fakeClient({
            [PARENT]: () => {
                throw notFound();
            },
        });
        expect(await missing.service.parentOf(REPOSITORY, 7)).toBeUndefined();
        const broken = fakeClient({
            [PARENT]: () => {
                throw Object.assign(new Error("boom"), { status: 500 });
            },
        });
        await expect(broken.service.parentOf(REPOSITORY, 7)).rejects.toThrow(
            "Failed to read the native parent of issue #7",
        );
    });

    test("listSubIssues follows every page", async () => {
        const { service, requests } = fakeClient(
            { [SUB_ISSUES]: () => [record(2), record(3), record(4)] },
            { pageSize: 2 },
        );
        const children = await service.listSubIssues(REPOSITORY, 1);
        expect(children.map(({ number }) => number)).toEqual([2, 3, 4]);
        expect(requests[0]?.parameters).toMatchObject({ per_page: 100 });
    });

    test("listBlockedBy follows every page", async () => {
        const { service } = fakeClient(
            { [BLOCKED_BY]: () => [record(2), record(3), record(4)] },
            { pageSize: 1 },
        );
        const blockers = await service.listBlockedBy(REPOSITORY, 1);
        expect(blockers.map(({ number }) => number)).toEqual([2, 3, 4]);
    });

    test("addBlockedBy posts the blocker's numeric id", async () => {
        const { service, requests } = fakeClient({
            [BLOCKED_BY]: () => [],
            "issues.get": () => record(5, 555),
            [ADD_BLOCKED_BY]: () => ({}),
        });
        await service.addBlockedBy(REPOSITORY, 1, 5);
        const post = requests.find(({ route }) => route === ADD_BLOCKED_BY);
        expect(post?.parameters).toMatchObject({
            issue_number: 1,
            issue_id: 555,
        });
    });

    test("addBlockedBy is idempotent when the dependency already exists", async () => {
        const { service, requests } = fakeClient({
            [BLOCKED_BY]: () => [record(5)],
        });
        await service.addBlockedBy(REPOSITORY, 1, 5);
        expect(requests.map(({ route }) => route)).toEqual([BLOCKED_BY]);
    });

    test("addBlockedBy reconciles a lost response", async () => {
        let reads = 0;
        const { service } = fakeClient({
            [BLOCKED_BY]: () => {
                reads += 1;
                return reads === 1 ? [] : [record(5)];
            },
            "issues.get": () => record(5),
            [ADD_BLOCKED_BY]: () => {
                throw new Error("socket hang up");
            },
        });
        await service.addBlockedBy(REPOSITORY, 1, 5);
        expect(reads).toBe(2);
    });

    test("addBlockedBy fails when the dependency never appeared", async () => {
        const { service } = fakeClient({
            [BLOCKED_BY]: () => [],
            "issues.get": () => record(5),
            [ADD_BLOCKED_BY]: () => {
                throw new Error("forbidden");
            },
        });
        await expect(service.addBlockedBy(REPOSITORY, 1, 5)).rejects.toThrow(
            "Failed to mark issue #1 as blocked by #5",
        );
    });
});