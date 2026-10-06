import { describe, expect, test } from "bun:test";

import type { GitHubIssue } from "../../src/github/domain.ts";
import type {
    GitHubIssueMutationService,
    GitHubIssueRelationshipService,
    GitHubIssuesService,
} from "../../src/github/ports.ts";
import { makeParentCompletionService } from "../../src/issues/app/parent-completion.ts";
import { AI_DISCLAIMER } from "../../src/issues/domain/hand-off.ts";

const REPOSITORY = "owner/repo";

const issue = (overrides: Partial<GitHubIssue>): GitHubIssue => ({
    number: 1,
    title: "Issue",
    url: "https://github.com/owner/repo/issues/1",
    body: "Untouched body without any Ralphie marker.",
    labels: [],
    state: "open",
    comments: [],
    ...overrides,
});

const parent = (overrides: Partial<GitHubIssue> = {}): GitHubIssue =>
    issue({ number: 43, title: "Parent", subIssueCount: 2, ...overrides });

const child = (number: number, state: "open" | "closed"): GitHubIssue =>
    issue({
        number,
        title: `Child ${number}`,
        state,
        body: `<!-- ralphie:decomposition root=43 parent=43 key="c${number}" depth=1 -->`,
    });

const setup = (options: {
    readonly parent: GitHubIssue;
    readonly children: ReadonlyArray<GitHubIssue>;
    readonly nativeParent?: GitHubIssue;
}) => {
    const calls: string[] = [];
    const comments: string[] = [];
    const issues = {
        refresh: async () => options.parent,
    } as unknown as GitHubIssuesService;
    const relationships = {
        listSubIssues: async () => options.children,
        parentOf: async () => options.nativeParent,
    } as unknown as GitHubIssueRelationshipService;
    const mutations = {
        comment: async (_repository: string, number: number, body: string) => {
            calls.push(`comment:${number}`);
            comments.push(body);
        },
        close: async (_repository: string, number: number, reason: string) => {
            calls.push(`close:${number}:${reason}`);
            return options.parent;
        },
    } as unknown as GitHubIssueMutationService;
    return {
        service: makeParentCompletionService({
            issues,
            relationships,
            mutations,
        }),
        calls,
        comments,
    };
};

describe("parent completion", () => {
    test("comments with the disclaimer, then closes as completed when every child is closed", async () => {
        const { service, calls, comments } = setup({
            parent: parent(),
            children: [child(101, "closed"), child(102, "closed")],
        });
        expect(await service.reconcileParent(REPOSITORY, 43)).toBe(true);
        expect(calls).toEqual(["comment:43", "close:43:completed"]);
        expect(comments[0]).toStartWith(AI_DISCLAIMER);
        expect(comments[0]).toContain("#101 Child 101");
        expect(comments[0]).toContain("#102 Child 102");
    });

    test("skips the comment when the marker comment already exists", async () => {
        const { service, calls } = setup({
            parent: parent({
                comments: [
                    {
                        id: 1,
                        body: "done\n<!-- ralphie:parent-completed -->",
                        updatedAt: "2026-01-01T00:00:00.000Z",
                    },
                ],
            }),
            children: [child(101, "closed"), child(102, "closed")],
        });
        expect(await service.reconcileParent(REPOSITORY, 43)).toBe(true);
        expect(calls).toEqual(["close:43:completed"]);
    });

    test("stays open while a child is open", async () => {
        const { service, calls } = setup({
            parent: parent(),
            children: [child(101, "closed"), child(102, "open")],
        });
        expect(await service.reconcileParent(REPOSITORY, 43)).toBe(false);
        expect(calls).toEqual([]);
    });

    test("stays open when GitHub reports no native children", async () => {
        const { service, calls } = setup({
            parent: parent(),
            children: [],
        });
        expect(await service.reconcileParent(REPOSITORY, 43)).toBe(false);
        expect(calls).toEqual([]);
    });

    test("never closes a parent whose children carry no Ralphie marker", async () => {
        const { service, calls } = setup({
            parent: parent(),
            children: [
                issue({ number: 101, state: "closed" }),
                issue({ number: 102, state: "closed" }),
            ],
        });
        expect(await service.reconcileParent(REPOSITORY, 43)).toBe(false);
        expect(calls).toEqual([]);
    });

    test("ignores an issue that was not decomposed", async () => {
        const { service, calls } = setup({
            parent: parent({ subIssueCount: 0 }),
            children: [child(101, "closed")],
        });
        expect(await service.reconcileParent(REPOSITORY, 43)).toBe(false);
        expect(calls).toEqual([]);
    });

    test("reports an already closed parent without mutating it", async () => {
        const { service, calls } = setup({
            parent: parent({ state: "closed" }),
            children: [child(101, "closed")],
        });
        expect(await service.reconcileParent(REPOSITORY, 43)).toBe(true);
        expect(calls).toEqual([]);
    });

    test("reconciles through the native parent of a completed child", async () => {
        const { service, calls } = setup({
            parent: parent(),
            children: [child(101, "closed"), child(102, "closed")],
            nativeParent: parent(),
        });
        expect(
            await service.reconcileAfterChildCompletion(
                REPOSITORY,
                101,
                "no marker here",
            ),
        ).toBe(true);
        expect(calls).toEqual(["comment:43", "close:43:completed"]);
    });

    test("falls back to the child's marker when GitHub reports no native parent", async () => {
        const { service, calls } = setup({
            parent: parent(),
            children: [child(101, "closed"), child(102, "closed")],
        });
        expect(
            await service.reconcileAfterChildCompletion(
                REPOSITORY,
                101,
                child(101, "closed").body,
            ),
        ).toBe(true);
        expect(calls).toEqual(["comment:43", "close:43:completed"]);
    });

    test("does nothing for a child without any parent", async () => {
        const { service, calls } = setup({
            parent: parent(),
            children: [],
        });
        expect(
            await service.reconcileAfterChildCompletion(REPOSITORY, 101, null),
        ).toBe(false);
        expect(calls).toEqual([]);
    });
});