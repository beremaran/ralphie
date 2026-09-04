import { describe, expect, test } from "bun:test";

import {
    createMaintainableComment,
    createMaintainableIssue,
    createMaintainableThread,
    isRalphieManaged,
    maintainMarker,
    normalizeMaintainableAvailability,
    parseRalphieMarker,
} from "../src/maintain-issues-snapshot.ts";
import { renderMaintenanceActionComment } from "../src/github/issue-maintenance.ts";

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

        const maintenanceActionBody = renderMaintenanceActionComment({
            action: {
                action: "ask-question",
                issueNumber: 12,
                question: "Which deployment is affected?",
                rationale: "The issue does not identify one.",
            },
        });
        expect(parseRalphieMarker(maintenanceActionBody)).toMatchObject({
            kind: "maintenance-action",
            issue: 12,
            action: "ask-question",
            actionKey: expect.any(String),
            version: 1,
            bodySha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        });
        expect(isRalphieManaged(maintenanceActionBody)).toBe(true);

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

describe("maintain-snapshot thread availability", () => {
    const commentInput = (id: number, body: unknown = "body") => ({
        id,
        nodeId: `C${id}`,
        url: `https://example.test/c/${id}`,
        author: null,
        authorAssociation: "NONE",
        body,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const baseIssueInput = () => ({
        number: 12,
        nodeId: "I_node",
        title: "Issue title",
        body: "Issue body",
        url: "https://example.test/owner/repo/issues/12",
        state: "open",
        author: { login: "octocat", type: "User", nodeId: "U_node" },
        authorAssociation: "MEMBER",
        labels: [],
        assignees: [],
        milestone: null,
        locked: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
    });

    test("omitted thread input never invents a complete zero-comment thread", () => {
        const omitted = createMaintainableThread({});
        expect(omitted.comments).toHaveLength(0);
        expect(omitted.fetchedCount).toBe(0);
        expect(omitted.complete).toBe(false);
        expect(["unavailable", "partial"]).toContain(omitted.availability.kind);
        expect(omitted.availability.reason).not.toBeNull();

        const omittedComments = createMaintainableThread({
            totalCount: 0,
            complete: false,
        });
        expect(omittedComments.complete).toBe(false);
        expect(omittedComments.availability.kind).not.toBe("available");
        expect(omittedComments.availability.reason).not.toBeNull();

        const omittedIssue = createMaintainableIssue({
            ...baseIssueInput(),
        } as unknown as Parameters<typeof createMaintainableIssue>[0]);
        expect(omittedIssue.selectedThread.comments).toHaveLength(0);
        expect(omittedIssue.selectedThread.complete).toBe(false);
        expect(omittedIssue.selectedThread.availability.kind).not.toBe(
            "available",
        );
        expect(omittedIssue.selectedThread.availability.reason).not.toBeNull();
    });

    test("explicitly fetched zero comments are complete only with a known total of zero", () => {
        const fetchedZero = createMaintainableThread({
            comments: [],
            totalCount: 0,
            complete: true,
            availability: { kind: "available", reason: null, detail: null },
        });
        expect(fetchedZero.comments).toHaveLength(0);
        expect(fetchedZero.fetchedCount).toBe(0);
        expect(fetchedZero.totalCount).toBe(0);
        expect(fetchedZero.complete).toBe(true);
        expect(fetchedZero.availability.kind).toBe("available");
        expect(fetchedZero.availability.reason).toBeNull();

        const fetchedZeroUnknown = createMaintainableThread({
            comments: [],
        });
        expect(fetchedZeroUnknown.complete).toBe(false);
        expect(fetchedZeroUnknown.availability.kind).not.toBe("available");
        expect(fetchedZeroUnknown.availability.reason).not.toBeNull();
    });

    test("known total greater than fetched forces an incomplete partial thread", () => {
        const thread = createMaintainableThread({
            comments: [commentInput(1, "hello")],
            fetchedCount: 99,
            totalCount: 5,
            complete: true,
            availability: { kind: "available", reason: null, detail: null },
        });
        expect(thread.comments).toHaveLength(1);
        expect(thread.comments[0]?.id).toBe(1);
        expect(thread.fetchedCount).toBe(1);
        expect(thread.totalCount).toBe(5);
        expect(thread.complete).toBe(false);
        expect(["partial", "unavailable"]).toContain(thread.availability.kind);
        expect(thread.availability.reason).not.toBeNull();
    });

    test("skip metadata propagates so skipped records are never available", () => {
        for (const reason of [
            "transferred",
            "deleted",
            "inaccessible",
        ] as const) {
            const snapshot = createMaintainableIssue({
                ...baseIssueInput(),
                selectedThread: {
                    comments: [commentInput(1, "hello")],
                    totalCount: 1,
                    complete: true,
                    availability: {
                        kind: "available",
                        reason: null,
                        detail: null,
                    },
                },
                availability: {
                    kind: "available",
                    reason: null,
                    detail: null,
                },
                skip: { reason, detail: `${reason} detail` },
            } as unknown as Parameters<typeof createMaintainableIssue>[0]);
            expect(snapshot.skip?.reason).toBe(reason);
            expect(snapshot.availability.kind).toBe("unavailable");
            expect(snapshot.availability.reason).toBe(reason);
            expect(snapshot.selectedThread.availability.kind).toBe(
                "unavailable",
            );
            expect(snapshot.selectedThread.availability.reason).toBe(reason);
            expect(snapshot.selectedThread.complete).toBe(false);
            expect(snapshot.selectedThread.comments).toHaveLength(1);
        }
    });

    test("contradictory available state with blocking reasons fails closed", () => {
        for (const reason of [
            "inaccessible",
            "deleted",
            "transferred",
            "null-author",
            "unavailable",
        ] as const) {
            const availability = normalizeMaintainableAvailability({
                kind: "available",
                reason,
                detail: null,
            });
            expect(availability.kind).toBe("unavailable");
            expect(availability.reason).toBe(reason);
        }
        for (const reason of ["partial", "locked"] as const) {
            const availability = normalizeMaintainableAvailability({
                kind: "available",
                reason,
                detail: null,
            });
            expect(availability.kind).toBe("partial");
            expect(availability.reason).toBe(reason);
        }
        const unknownKind = normalizeMaintainableAvailability({
            kind: "future-kind",
            reason: null,
            detail: null,
        });
        expect(unknownKind.kind).toBe("unavailable");
        expect(unknownKind.reason).not.toBeNull();

        const partialWithoutReason = normalizeMaintainableAvailability({
            kind: "partial",
            reason: null,
            detail: null,
        });
        expect(partialWithoutReason.reason).not.toBeNull();
        const unavailableWithoutReason = normalizeMaintainableAvailability({
            kind: "unavailable",
            reason: null,
            detail: null,
        });
        expect(unavailableWithoutReason.reason).not.toBeNull();

        const contradictoryThread = createMaintainableThread({
            comments: [commentInput(1, "hello")],
            totalCount: 1,
            complete: true,
            availability: {
                kind: "available",
                reason: "deleted",
                detail: null,
            },
        });
        expect(contradictoryThread.complete).toBe(false);
        expect(contradictoryThread.availability.kind).toBe("unavailable");
    });

    test("missing or null comment bodies stay null while empty strings stay empty", () => {
        const missing = createMaintainableComment({
            ...commentInput(1),
            body: undefined,
        } as unknown as Parameters<typeof createMaintainableComment>[0]);
        expect(missing.body).toBeNull();
        expect(missing.content).toBeNull();

        const nil = createMaintainableComment(commentInput(2, null));
        expect(nil.body).toBeNull();
        expect(nil.content).toBeNull();

        const empty = createMaintainableComment(commentInput(3, ""));
        expect(empty.body).toBe("");
        expect(empty.content).toBe("");
    });

    test("locked and partial records are preserved instead of dropped", () => {
        const locked = createMaintainableIssue({
            ...baseIssueInput(),
            locked: true,
            author: null,
            selectedThread: {
                comments: [commentInput(1, "first"), commentInput(2, "second")],
                totalCount: 2,
                complete: true,
                availability: {
                    kind: "available",
                    reason: null,
                    detail: null,
                },
            },
            availability: { kind: "available", reason: null, detail: null },
        } as unknown as Parameters<typeof createMaintainableIssue>[0]);
        expect(locked.locked).toBe(true);
        expect(locked.author).toBeNull();
        expect(locked.selectedThread.comments).toHaveLength(2);
        expect(locked.selectedThread.comments[0]?.id).toBe(1);
        expect(locked.selectedThread.comments[1]?.id).toBe(2);
        expect(locked.availability.kind).not.toBe("available");
        expect(locked.selectedThread.availability.kind).not.toBe("available");
        expect(locked.selectedThread.availability.reason).not.toBeNull();

        const partial = createMaintainableIssue({
            ...baseIssueInput(),
            selectedThread: {
                comments: [commentInput(7, "kept")],
                totalCount: 3,
                complete: false,
                availability: {
                    kind: "partial",
                    reason: "partial",
                    detail: "truncated",
                },
            },
            availability: {
                kind: "partial",
                reason: "partial",
                detail: "truncated",
            },
        } as unknown as Parameters<typeof createMaintainableIssue>[0]);
        expect(partial.selectedThread.comments).toHaveLength(1);
        expect(partial.selectedThread.comments[0]?.id).toBe(7);
        expect(partial.selectedThread.complete).toBe(false);
        expect(partial.selectedThread.availability.kind).toBe("partial");
        expect(partial.availability.kind).toBe("partial");

        const nullAuthorComment = createMaintainableComment(
            commentInput(9, "ghost"),
        );
        expect(nullAuthorComment.author).toBeNull();
        expect(nullAuthorComment.body).toBe("ghost");
    });

    test("complete fetched thread retains identity and order", () => {
        const thread = createMaintainableThread({
            comments: [
                commentInput(30, "third"),
                commentInput(10, "first"),
                commentInput(20, "second"),
            ],
            totalCount: 3,
            complete: true,
            availability: { kind: "available", reason: null, detail: null },
        });
        expect(thread.comments.map((comment) => comment.id)).toEqual([
            30, 10, 20,
        ]);
        expect(thread.comments.map((comment) => comment.body)).toEqual([
            "third",
            "first",
            "second",
        ]);
        expect(thread.fetchedCount).toBe(3);
        expect(thread.complete).toBe(true);
        expect(thread.availability.kind).toBe("available");
    });

    test("unknown API values fail closed without throwing", () => {
        const snapshot = createMaintainableIssue({
            ...baseIssueInput(),
            state: "future-state",
            authorAssociation: "FUTURE_ROLE",
            author: { login: "mystery", type: "FutureBot", nodeId: null },
            availability: { kind: "future-kind", reason: null, detail: null },
            skip: { reason: "future-skip", detail: null },
            selectedThread: {
                comments: [commentInput(1, "hello")],
                totalCount: "many",
                fetchedCount: "many",
                complete: "yes",
                availability: {
                    kind: "future-kind",
                    reason: "future-reason",
                    detail: null,
                },
            },
        } as unknown as Parameters<typeof createMaintainableIssue>[0]);
        expect(snapshot.state).toEqual({
            kind: "unknown",
            value: "future-state",
        });
        expect(snapshot.availability.kind).not.toBe("available");
        expect(snapshot.availability.reason).not.toBeNull();
        expect(snapshot.selectedThread.complete).toBe(false);
        expect(snapshot.selectedThread.availability.kind).not.toBe("available");
        expect(snapshot.selectedThread.fetchedCount).toBe(1);
        expect(snapshot.selectedThread.totalCount).toBeNull();
        expect(snapshot.skip?.reason).toEqual({
            kind: "unknown",
            value: "future-skip",
        });
    });
});