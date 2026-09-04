import { describe, expect, test } from "bun:test";

import {
    createMaintainableComment,
    createMaintainableIssue,
    createMaintainableThread,
    isRalphieManaged,
    maintainMarker,
    parseRalphieMarker,
} from "../src/maintain-issues-snapshot.ts";

const issueInput = () => ({
    number: 12,
    nodeId: "I_node",
    title: "Issue title",
    body: "Issue body",
    url: "https://example.test/owner/repo/issues/12",
    state: "open",
    author: { login: "octocat", type: "User", nodeId: "U_node" },
    authorAssociation: "MEMBER",
    labels: [{ name: "bug", description: "A bug", color: "ff0000" }],
    assignees: [{ login: "assignee", type: "User", nodeId: null }],
    milestone: null,
    locked: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    selectedThread: {
        comments: [
            {
                id: 901,
                nodeId: "C_node",
                url: "https://example.test/comment/901",
                author: { login: "octocat", type: "User", nodeId: null },
                authorAssociation: "MEMBER",
                body: "hello",
                createdAt: "2026-01-03T00:00:00.000Z",
                updatedAt: "2026-01-03T00:00:00.000Z",
            },
        ],
        fetchedCount: 1,
        totalCount: 1,
        complete: true,
        availability: { kind: "available", reason: null, detail: null },
    },
    availability: { kind: "available", reason: null, detail: null },
});

describe("maintain-issues-snapshot value boundary", () => {
    test("deep-copies nested arrays and records without retaining references", () => {
        const input = issueInput();
        const snapshot = createMaintainableIssue(input);

        expect(snapshot.labels).not.toBe(input.labels);
        expect(snapshot.labels[0]).not.toBe(input.labels[0]);
        expect(snapshot.assignees).not.toBe(input.assignees);
        expect(snapshot.selectedThread).not.toBe(input.selectedThread);
        expect(snapshot.selectedThread.comments).not.toBe(
            input.selectedThread.comments,
        );
        expect(snapshot.selectedThread.comments[0]).not.toBe(
            input.selectedThread.comments[0],
        );

        (input.labels as Array<Record<string, unknown>>).push({
            name: "injected",
        });
        ((input.labels[0] as Record<string, unknown>).name as string) =
            "mutated";
        (input.selectedThread.comments as Array<Record<string, unknown>>).push({
            id: 999,
        });

        expect(snapshot.labels).toHaveLength(1);
        expect(snapshot.labels[0]?.name).toBe("bug");
        expect(snapshot.selectedThread.comments).toHaveLength(1);
        expect(snapshot.selectedThread.comments[0]?.id).toBe(901);
    });

    test("mutating a returned snapshot cannot affect a fresh copy of the input", () => {
        const input = issueInput();
        const first = createMaintainableIssue(input);
        const second = createMaintainableIssue(input);

        expect(first).toEqual(second);
        expect(first).not.toBe(second);
        expect(first.labels).not.toBe(second.labels);
        expect(first.selectedThread.comments).not.toBe(
            second.selectedThread.comments,
        );
    });

    test("comment boundary copies without retaining actor references", () => {
        const author = { login: "octocat", type: "User", nodeId: null };
        const comment = createMaintainableComment({
            id: 1,
            nodeId: "C1",
            url: "https://example.test/c/1",
            author,
            authorAssociation: "OWNER",
            body: "body",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
        });
        author.login = "mutated";
        expect(comment.author?.login).toBe("octocat");
        expect(comment.body).toBe("body");
        expect(comment.content).toBe("body");
    });

    test("thread boundary copies comment entries", () => {
        const comments = [
            {
                id: 1,
                nodeId: "C1",
                url: "https://example.test/c/1",
                author: null,
                authorAssociation: "NONE",
                body: "one",
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
            },
        ];
        const thread = createMaintainableThread({ comments });
        expect(thread.comments).not.toBe(comments);
        expect(thread.comments[0]).not.toBe(comments[0]);
        (comments as Array<unknown>).push({
            id: 2,
            nodeId: "C2",
            url: "https://example.test/c/2",
            author: null,
            authorAssociation: "NONE",
            body: "two",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
        });
        expect(thread.comments).toHaveLength(1);
    });

    test("nullable fields survive without throwing", () => {
        const snapshot = createMaintainableIssue({
            number: 7,
            nodeId: "I_7",
            title: "Nullable",
            body: null,
            url: "https://example.test/issues/7",
            state: "open",
            author: null,
            authorAssociation: "NONE",
            labels: [],
            assignees: [],
            milestone: null,
            locked: false,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            selectedThread: { comments: [] },
        });
        expect(snapshot.body).toBeNull();
        expect(snapshot.author).toBeNull();
        expect(snapshot.milestone).toBeUndefined();

        const comment = createMaintainableComment({
            id: 5,
            nodeId: "C5",
            url: "https://example.test/c/5",
            author: null,
            authorAssociation: "NONE",
            body: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
        });
        expect(comment.author).toBeNull();
        expect(comment.body).toBeNull();
        expect(comment.content).toBeNull();
    });

    test("future and unknown enum and actor values use an explicit unknown shape", () => {
        const snapshot = createMaintainableIssue({
            ...(issueInput() as Record<string, unknown>),
            state: "future-state",
            authorAssociation: "FUTURE_ROLE",
            author: { login: "mystery", type: "FutureBot", nodeId: null },
        } as unknown as Parameters<typeof createMaintainableIssue>[0]);
        expect(snapshot.state).toEqual({
            kind: "unknown",
            value: "future-state",
        });
        expect(snapshot.isOpen).toBe(false);
        expect(snapshot.open).toBe(false);
        expect(snapshot.authorAssociation).toEqual({
            kind: "unknown",
            value: "FUTURE_ROLE",
        });
        expect(snapshot.author?.login).toBe("mystery");
        expect(snapshot.author?.type).toEqual({
            kind: "unknown",
            value: "FutureBot",
        });
    });

    test("only exact managed markers count", () => {
        const exact = maintainMarker(12);
        expect(parseRalphieMarker(exact)?.kind).toBe("maintain");
        expect(parseRalphieMarker(exact)?.normalized).toBe(exact);
        expect(isRalphieManaged(`before\n${exact}\nafter`)).toBe(true);

        const nearMatches: ReadonlyArray<string | null> = [
            null,
            "",
            "ralphie:maintain issue=12",
            "<!-- ralphie:maintain issue=12 -- >",
            "<!--ralphie:maintain issue=12 -->",
            "<!--  ralphie:maintain issue=12 -->",
            "<!-- RALPHIE:maintain issue=12 -->",
            "<!-- ralphie:Maintain issue=12 -->",
            "<!-- ralphie:maintain issue =12 -->",
            "<!-- ralphie:maintain issue= -->",
            "<!-- ralphie:maintain -->",
            "<!-- ralphie:maintain issue=12-->",
            "arbitrary text without a marker",
        ];
        for (const body of nearMatches) {
            expect(parseRalphieMarker(body)).toBeUndefined();
            expect(isRalphieManaged(body)).toBe(false);
        }

        const managedComment = createMaintainableComment({
            id: 9,
            nodeId: "C9",
            url: "https://example.test/c/9",
            author: null,
            authorAssociation: "NONE",
            body: exact,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
        });
        expect(managedComment.isRalphieManaged).toBe(true);

        const plainComment = createMaintainableComment({
            id: 10,
            nodeId: "C10",
            url: "https://example.test/c/10",
            author: null,
            authorAssociation: "NONE",
            body: "mentions ralphie:maintain issue=12 in prose",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
        });
        expect(plainComment.isRalphieManaged).toBe(false);
    });
});