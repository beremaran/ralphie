import { describe, expect, test } from "bun:test";

import {
    createMaintainableComment,
    createMaintainableThread,
} from "../src/maintain-issues-snapshot.ts";
import {
    THREAD_PROMPT_OMISSION_MARKER,
    THREAD_PROMPT_TRUNCATION_MARKER,
    projectCommentPrompt,
    projectThreadPrompt,
    validateThreadPromptLimit,
} from "../src/maintain-thread-projection.ts";

const TRUNC = THREAD_PROMPT_TRUNCATION_MARKER;
const OMIT = THREAD_PROMPT_OMISSION_MARKER;

const commentInput = (id: number, body: string | null = "body") => ({
    id,
    nodeId: `C${id}`,
    url: `https://example.test/c/${id}`,
    author: null,
    authorAssociation: "NONE",
    body,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
});

const threadInput = (comments: Array<unknown>) =>
    createMaintainableThread({
        comments,
        totalCount: comments.length,
        complete: true,
        availability: { kind: "available", reason: null, detail: null },
    });

const LOWER_CASE = "abcdefghijklmnopqrstuvwxyz";

describe("maintain-thread projection limit validation", () => {
    test("rejects NaN, infinities, negatives, and fractional limits", () => {
        const invalid: ReadonlyArray<number> = [
            NaN,
            Number.POSITIVE_INFINITY,
            Number.NEGATIVE_INFINITY,
            -1,
            -0.5,
            0.5,
            3.5,
        ];
        for (const value of invalid) {
            expect(() =>
                validateThreadPromptLimit("test limit", value),
            ).toThrow(RangeError);
            expect(() =>
                projectThreadPrompt({
                    thread: threadInput([commentInput(1, "x")]),
                    commentPromptLimit: value,
                    threadPromptLimit: 100,
                    aggregatePromptLimit: 100,
                }),
            ).toThrow(RangeError);
            expect(() =>
                projectThreadPrompt({
                    thread: threadInput([commentInput(1, "x")]),
                    commentPromptLimit: 100,
                    threadPromptLimit: value,
                    aggregatePromptLimit: 100,
                }),
            ).toThrow(RangeError);
            expect(() =>
                projectThreadPrompt({
                    thread: threadInput([commentInput(1, "x")]),
                    commentPromptLimit: 100,
                    threadPromptLimit: 100,
                    aggregatePromptLimit: value,
                }),
            ).toThrow(RangeError);
        }
    });

    test("accepts zero and finite non-negative integer limits", () => {
        expect(validateThreadPromptLimit("test limit", 0)).toBe(0);
        expect(validateThreadPromptLimit("test limit", 100)).toBe(100);
        expect(validateThreadPromptLimit("test limit", 1e20)).toBe(1e20);
        expect(
            validateThreadPromptLimit("test limit", Number.MAX_SAFE_INTEGER),
        ).toBe(Number.MAX_SAFE_INTEGER);

        const result = projectThreadPrompt({
            thread: threadInput([commentInput(1, "finite body")]),
            commentPromptLimit: 1e20,
            threadPromptLimit: Number.MAX_SAFE_INTEGER,
            aggregatePromptLimit: 1e20,
        });
        expect(result.comments[0]?.state).toBe("retained");
        expect(result.comments[0]?.content).toBe("finite body");
        expect(result.thread.omittedCount).toBe(0);
        expect(result.aggregate.truncated).toBe(false);
        expect(result.aggregate.omitted).toBe(false);
    });
});

describe("maintain-thread per-comment projection", () => {
    test("retains a body that fits the per-comment budget", () => {
        const projected = projectCommentPrompt(
            createMaintainableComment(commentInput(1, "hello")),
            10,
        );
        expect(projected.state).toBe("retained");
        expect(projected.content).toBe("hello");
        expect(projected.retainedLength).toBe(5);
        expect(projected.omittedLength).toBe(0);
        expect(projected.truncatedLength).toBe(0);
        expect(projected.marker).toBeNull();
    });

    test("per-comment exhaustion truncates an over-budget body with the stable marker", () => {
        const projected = projectCommentPrompt(
            createMaintainableComment(commentInput(2, LOWER_CASE)),
            15,
        );
        expect(projected.state).toBe("truncated");
        // keep = 15 - marker.length = 4, so a 4-character head plus the marker.
        expect(projected.content).toBe(`abcd${TRUNC}`);
        expect(projected.content).toHaveLength(15);
        expect(projected.limit).toBe(15);
        expect(projected.originalLength).toBe(26);
        expect(projected.retainedLength).toBe(15);
        expect(projected.truncatedLength).toBe(22);
        expect(projected.omittedLength).toBe(0);
        expect(projected.marker).toBe(TRUNC);
    });

    test("marker.length + 1 boundary keeps one head character and never the tail", () => {
        const limit = TRUNC.length + 1;
        const projected = projectCommentPrompt(
            createMaintainableComment(commentInput(3, LOWER_CASE)),
            limit,
        );
        expect(projected.state).toBe("truncated");
        // The classic slice(-0) bug would append the whole tail here; the
        // emitted content must be exactly one head character plus the marker.
        expect(projected.content).toBe(`a${TRUNC}`);
        expect(projected.content).toHaveLength(limit);
        expect(projected.content).toEndWith(TRUNC);
        expect(projected.content).not.toContain("b");
    });

    test("marker.length boundary emits the truncation marker alone", () => {
        const projected = projectCommentPrompt(
            createMaintainableComment(commentInput(4, LOWER_CASE)),
            TRUNC.length,
        );
        expect(projected.state).toBe("truncated");
        expect(projected.content).toBe(TRUNC);
        expect(projected.retainedLength).toBe(TRUNC.length);
        expect(projected.truncatedLength).toBe(26);
        expect(projected.marker).toBe(TRUNC);
    });

    test("limits smaller than the truncation marker omit content with a stable metadata marker", () => {
        // The omission marker still fits this budget.
        const withOmissionContent = projectCommentPrompt(
            createMaintainableComment(commentInput(5, LOWER_CASE)),
            TRUNC.length - 1,
        );
        expect(withOmissionContent.state).toBe("omitted");
        expect(withOmissionContent.content).toBe(OMIT);
        expect(withOmissionContent.content.length).toBeLessThanOrEqual(
            TRUNC.length - 1,
        );
        expect(withOmissionContent.marker).toBe(OMIT);
        expect(withOmissionContent.omittedLength).toBe(26);
        expect(withOmissionContent.truncatedLength).toBe(0);

        // Even the omission marker cannot fit: content is empty but the
        // stable metadata marker is retained.
        const emptyContent = projectCommentPrompt(
            createMaintainableComment(commentInput(6, LOWER_CASE)),
            OMIT.length - 1,
        );
        expect(emptyContent.state).toBe("omitted");
        expect(emptyContent.content).toBe("");
        expect(emptyContent.marker).toBe(OMIT);
        expect(emptyContent.omittedLength).toBe(26);
    });

    test("observed empty bodies stay empty even with a zero budget", () => {
        const zero = projectCommentPrompt(
            createMaintainableComment(commentInput(7, "")),
            0,
        );
        expect(zero.state).toBe("empty");
        expect(zero.content).toBe("");
        expect(zero.originalLength).toBe(0);
        expect(zero.omittedLength).toBe(0);
        expect(zero.truncatedLength).toBe(0);
        expect(zero.marker).toBeNull();
    });

    test("null bodies are unavailable, never empty or omitted", () => {
        const projected = projectCommentPrompt(
            createMaintainableComment(commentInput(8, null)),
            0,
        );
        expect(projected.state).toBe("unavailable");
        expect(projected.content).toBe("");
        expect(projected.originalLength).toBe(0);
        expect(projected.marker).toBeNull();
    });
});

describe("maintain-thread thread and aggregate projection", () => {
    test("thread exhaustion drops trailing entries while preserving identity and order", () => {
        const result = projectThreadPrompt({
            thread: threadInput([
                commentInput(10, "alpha"),
                commentInput(20, "beta"),
                commentInput(30, "gamma"),
            ]),
            commentPromptLimit: 100,
            threadPromptLimit: 15,
            aggregatePromptLimit: 200,
        });
        expect(result.thread.text).toBe("#10: alpha");
        expect(result.thread.limit).toBe(15);
        expect(result.thread.originalCount).toBe(3);
        expect(result.thread.includedCount).toBe(1);
        expect(result.thread.omittedCount).toBe(2);
        expect(result.thread.omittedIds).toEqual([20, 30]);
        expect(result.thread.retainedLength).toBe(10);
        expect(result.thread.originalLength).toBe(31);
        expect(result.thread.omittedLength).toBe(21);
        expect(result.thread.truncatedLength).toBe(0);
        expect(result.thread.marker).toBe(OMIT);
        // Identity and original order survive even when text is omitted.
        expect(result.comments.map((comment) => comment.id)).toEqual([
            10, 20, 30,
        ]);
        expect(result.comments[1]?.state).toBe("retained");
    });

    test("thread exhaustion with a zero budget never relabels an empty comment", () => {
        const result = projectThreadPrompt({
            thread: threadInput([
                commentInput(1, ""),
                commentInput(2, "non-empty"),
            ]),
            commentPromptLimit: 10,
            threadPromptLimit: 0,
            aggregatePromptLimit: 100,
        });
        expect(result.thread.text).toBe("");
        expect(result.thread.omittedIds).toEqual([1, 2]);
        expect(result.comments[0]?.state).toBe("empty");
        expect(result.comments[0]?.content).toBe("");
        expect(result.comments[1]?.state).toBe("retained");
    });

    test("aggregate exhaustion truncates the summary within the budget", () => {
        const result = projectThreadPrompt({
            thread: threadInput([commentInput(1, "a"), commentInput(2, "b")]),
            commentPromptLimit: 10,
            threadPromptLimit: 200,
            aggregatePromptLimit: TRUNC.length + 1,
        });
        const aggregate = result.aggregate;
        expect(aggregate.truncated).toBe(true);
        expect(aggregate.omitted).toBe(false);
        expect(aggregate.text).toEndWith(TRUNC);
        expect(aggregate.text).toHaveLength(aggregate.limit);
        expect(aggregate.retainedLength).toBe(aggregate.text.length);
        expect(aggregate.omittedLength).toBe(0);
        expect(aggregate.truncatedLength).toBeGreaterThan(0);
        expect(aggregate.marker).toBe(TRUNC);
        // The comment-state counts survive the truncated summary.
        expect(aggregate.originalCount).toBe(2);
        expect(aggregate.retainedCount).toBe(2);
        expect(aggregate.truncatedCount).toBe(0);
    });

    test("aggregate exhaustion with a zero budget omits the summary but keeps metadata", () => {
        const result = projectThreadPrompt({
            thread: threadInput([commentInput(1, "non-empty")]),
            commentPromptLimit: 10,
            threadPromptLimit: 200,
            aggregatePromptLimit: 0,
        });
        const aggregate = result.aggregate;
        expect(aggregate.truncated).toBe(false);
        expect(aggregate.omitted).toBe(true);
        expect(aggregate.text).toBe("");
        expect(aggregate.retainedLength).toBe(0);
        expect(aggregate.omittedLength).toBeGreaterThan(0);
        expect(aggregate.marker).toBe(OMIT);
        expect(aggregate.originalCount).toBe(1);
        expect(aggregate.retainedCount).toBe(1);
        expect(aggregate.omittedCount).toBe(0);
    });

    test("aggregate records stable per-state counts and exact summary text", () => {
        const result = projectThreadPrompt({
            thread: threadInput([
                commentInput(1, "fits"),
                commentInput(2, LOWER_CASE),
                commentInput(3, LOWER_CASE),
                commentInput(4, ""),
                commentInput(5, null),
            ]),
            commentPromptLimit: TRUNC.length + 1,
            threadPromptLimit: 1_000,
            aggregatePromptLimit: 1_000,
        });
        const aggregate = result.aggregate;
        expect(aggregate.truncated).toBe(false);
        expect(aggregate.omitted).toBe(false);
        expect(aggregate.originalCount).toBe(5);
        expect(aggregate.retainedCount).toBe(1);
        expect(aggregate.truncatedCount).toBe(2);
        expect(aggregate.omittedCount).toBe(0);
        expect(aggregate.emptyCount).toBe(1);
        expect(aggregate.unavailableCount).toBe(1);
        expect(aggregate.text).toBe(
            "comments 5 retained 1 truncated 2 omitted 0 empty 1 unavailable 1",
        );
        expect(aggregate.text).toHaveLength(aggregate.originalLength);
        expect(aggregate.retainedLength).toBe(aggregate.text.length);
    });

    test("repeated projection of the same thread is deterministic", () => {
        const make = () => ({
            thread: threadInput([
                commentInput(1, "first body"),
                commentInput(2, "second body is longer"),
                commentInput(3, ""),
                commentInput(4, null),
            ]),
            commentPromptLimit: 8,
            threadPromptLimit: 40,
            aggregatePromptLimit: 30,
        });
        const first = projectThreadPrompt(make());
        const second = projectThreadPrompt(make());
        expect(second).toEqual(first);
        // Interleave a drastically different projection to prove there is no
        // shared mutable state between calls.
        projectThreadPrompt({
            thread: threadInput([commentInput(99, "x".repeat(500))]),
            commentPromptLimit: 0,
            threadPromptLimit: 0,
            aggregatePromptLimit: 0,
        });
        expect(projectThreadPrompt(make())).toEqual(first);
    });

    test("a bounded projection never downgrades a complete fetched thread", () => {
        const input = threadInput([
            commentInput(1, "a very long first comment body"),
            commentInput(2, "another long body"),
        ]);
        const before = createMaintainableThread({
            comments: input.comments.map((comment) => ({ ...comment })),
            totalCount: input.totalCount,
            complete: input.complete,
            availability: { ...input.availability },
        });
        const result = projectThreadPrompt({
            thread: input,
            commentPromptLimit: 4,
            threadPromptLimit: 10,
            aggregatePromptLimit: 10,
        });
        expect(result.fetchedThread).toBe(input);
        expect(input).toEqual(before);
        expect(input.complete).toBe(true);
        expect(input.comments.map((comment) => comment.body)).toEqual([
            "a very long first comment body",
            "another long body",
        ]);
        // Bounded output never rewrites the fetched bodies.
        expect(result.comments[0]?.content.length).toBeLessThanOrEqual(4);
        expect(result.fetchedThread.complete).toBe(true);
    });

    test("projecting a partial or locked thread leaves availability intact", () => {
        const partial = createMaintainableThread({
            comments: [commentInput(1, "only fetched comment")],
            totalCount: 3,
            complete: false,
            availability: {
                kind: "partial",
                reason: "partial",
                detail: "truncated fetch",
            },
        });
        const result = projectThreadPrompt({
            thread: partial,
            commentPromptLimit: 100,
            threadPromptLimit: 100,
            aggregatePromptLimit: 100,
        });
        expect(result.fetchedThread).toBe(partial);
        expect(result.fetchedThread.complete).toBe(false);
        expect(result.fetchedThread.availability.kind).toBe("partial");
        expect(result.comments).toHaveLength(1);
    });
});