import { describe, expect, test } from "bun:test";
import type { Octokit } from "octokit";

import type { GitHubIssue } from "../../src/github/issues.ts";
import type { GitHubIssueMutationService } from "../../src/github/issue-mutations.ts";
import type { GitHubIssueRelationshipService } from "../../src/github/issue-relationships.ts";
import type { GitHubIssuesService } from "../../src/github/issues.ts";
import { makeParentCompletionService } from "../../src/github/parent-completion.ts";

const parent = (overrides: Partial<GitHubIssue> = {}): GitHubIssue => ({
    number: 43,
    title: "Decomposed parent",
    url: "issue/43",
    body: "<!-- ralphie:decomposition original=43 depth=1 -->\n\nDecomposed work.",
    labels: [],
    state: "open",
    updatedAt: "2026-08-28T00:00:00.000Z",
    comments: [],
    commentCount: 0,
    commentVersion: "2026-08-28T00:00:00.000Z",
    ...overrides,
});

const child = (number: number, state: "open" | "closed"): GitHubIssue => ({
    number,
    title: `Child ${number}`,
    url: `issue/${number}`,
    body: `<!-- ralphie:decomposition root=43 parent=43 key="child-${number}" depth=1 -->`,
    labels: [],
    state,
    updatedAt: "2026-08-28T00:00:00.000Z",
    comments: [],
    commentCount: 0,
    commentVersion: "2026-08-28T00:00:00.000Z",
});

type Fakes = {
    readonly issues: GitHubIssuesService;
    readonly relationships: GitHubIssueRelationshipService;
    readonly mutations: GitHubIssueMutationService;
};

const fakes = (input: {
    readonly parent?: GitHubIssue;
    readonly subIssues?: ReadonlyArray<GitHubIssue>;
    readonly nativeParent?: GitHubIssue;
}): Fakes & { readonly closed: number[] } => {
    const closed: number[] = [];
    return {
        closed,
        issues: {
            listOpen: async () => [],
            refresh: async () => input.parent ?? parent(),
            listDecompositionChildren: async () => [],
        },
        relationships: {
            listSubIssues: async () => input.subIssues ?? [],
            parentOf: async () => input.nativeParent,
            attachSubIssue: async () => {},
            listBlockedBy: async () => [],
            addBlockedBy: async () => {},
        },
        mutations: {
            create: async () => {
                throw new Error("unused");
            },
            update: async () => {
                throw new Error("unused");
            },
            close: async (_client, _repository, issueNumber) => {
                closed.push(issueNumber);
                return parent({ state: "closed" });
            },
        },
    };
};

const service = (fakes: Fakes) => makeParentCompletionService(fakes);

describe("parent completion service", () => {
    test("closes a decomposed parent as completed when every sub-issue is closed", async () => {
        const fake = fakes({
            subIssues: [child(101, "closed"), child(102, "closed")],
        });
        const completed = await service(fake).reconcileParent(
            {} as Octokit,
            "owner/repository",
            43,
        );
        expect(completed).toBe(true);
        expect(fake.closed).toEqual([43]);
    });

    test("keeps the parent open while any sub-issue is open", async () => {
        const fake = fakes({
            subIssues: [child(101, "closed"), child(102, "open")],
        });
        const completed = await service(fake).reconcileParent(
            {} as Octokit,
            "owner/repository",
            43,
        );
        expect(completed).toBe(false);
        expect(fake.closed).toEqual([]);
    });

    test("keeps a parent open while its sub-issues are not attached yet", async () => {
        const fake = fakes({ subIssues: [] });
        const completed = await service(fake).reconcileParent(
            {} as Octokit,
            "owner/repository",
            43,
        );
        expect(completed).toBe(false);
        expect(fake.closed).toEqual([]);
    });

    test("never touches an issue without the tracking marker", async () => {
        const fake = fakes({
            parent: parent({
                body: "A plain open issue with no decomposition marker.",
            }),
            subIssues: [child(101, "closed")],
        });
        const completed = await service(fake).reconcileParent(
            {} as Octokit,
            "owner/repository",
            43,
        );
        expect(completed).toBe(false);
        expect(fake.closed).toEqual([]);
    });

    test("is idempotent for an already-closed parent", async () => {
        const fake = fakes({
            parent: parent({ state: "closed" }),
            subIssues: [child(101, "closed")],
        });
        const completed = await service(fake).reconcileParent(
            {} as Octokit,
            "owner/repository",
            43,
        );
        expect(completed).toBe(true);
        expect(fake.closed).toEqual([]);
    });

    test("resolves the parent of a completed child from the native relationship", async () => {
        const fake = fakes({
            subIssues: [child(101, "closed")],
            nativeParent: parent(),
        });
        const completed = await service(fake).reconcileAfterChildCompletion(
            {} as Octokit,
            "owner/repository",
            101,
            null,
        );
        expect(completed).toBe(true);
        expect(fake.closed).toEqual([43]);
    });

    test("falls back to the child marker when no native parent exists", async () => {
        const fake = fakes({ subIssues: [child(101, "closed")] });
        const completed = await service(fake).reconcileAfterChildCompletion(
            {} as Octokit,
            "owner/repository",
            101,
            child(101, "closed").body,
        );
        expect(completed).toBe(true);
        expect(fake.closed).toEqual([43]);
    });

    test("does nothing for a child without a parent", async () => {
        const fake = fakes({});
        const completed = await service(fake).reconcileAfterChildCompletion(
            {} as Octokit,
            "owner/repository",
            101,
            "A plain issue body.",
        );
        expect(completed).toBe(false);
        expect(fake.closed).toEqual([]);
    });
});