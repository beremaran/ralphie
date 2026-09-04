/**
 * Deterministic bounded comment-thread prompt projections.
 *
 * Pure read-model/planner surface over the full thread contract in
 * `maintain-issues-snapshot.ts` (`MaintainableSelectedThread`,
 * `MaintainableComment`). `projectThreadPrompt` bounds three explicit prompt
 * budgets - per comment, per thread transcript, and per aggregate summary -
 * with explicit truncation metadata, and never mutates the fetched thread:
 * the result carries the unchanged thread alongside its bounded projections,
 * so a bounded projection can never downgrade a complete fetch.
 *
 * Every public limit is validated as a finite non-negative integer before any
 * slicing: NaN, infinities, negatives, and fractional values are rejected with
 * a RangeError. Zero is a legal limit and always produces the deterministic
 * minimal form defined here. All output is frozen and fully
 * deterministic: identical input and limits always produce identical output,
 * comment identity and original order are preserved even when text is
 * omitted, and observed states are never conflated - an observed empty body
 * stays `empty` even at a zero budget, a null body stays `unavailable`, an
 * over-budget body is `truncated` when it can carry the truncation marker,
 * and otherwise it is `omitted` with a stable metadata marker. Truncated
 * content keeps a strictly positive head prefix and then appends the marker;
 * the positive guard is what rules out the classic `slice(-0)` mistake that
 * would otherwise append the entire tail at the `marker.length + 1`
 * boundary.
 *
 * This module performs no network, filesystem, Git, or GitHub work.
 */
import type {
    MaintainableComment,
    MaintainableSelectedThread,
} from "./maintain-issues-snapshot.ts";

/** Stable truncation marker appended to retained content when a body is cut. */
export const THREAD_PROMPT_TRUNCATION_MARKER = "[truncated]";

/** Stable omission marker carried in content or metadata when content is omitted. */
export const THREAD_PROMPT_OMISSION_MARKER = "[omitted]";

/**
 * Validate one public prompt limit as a finite non-negative integer. Throws a
 * RangeError for NaN, infinities (positive and negative), negatives, and
 * fractional values before any slice is calculated. Zero is accepted.
 */
export const validateThreadPromptLimit = (
    name: string,
    value: number,
): number => {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
        throw new RangeError(
            `${name} must be a finite non-negative integer; received ${String(value)}.`,
        );
    }
    return value;
};

export const validatePromptLimit = validateThreadPromptLimit;

export type CommentPromptProjectionState =
    | "unavailable"
    | "empty"
    | "retained"
    | "truncated"
    | "omitted";

export type CommentPromptProjection = {
    readonly id: number;
    readonly state: CommentPromptProjectionState;
    /** The stable per-comment prompt limit applied to `content`. */
    readonly limit: number;
    /** Emitted content; always satisfies `content.length <= limit`. */
    readonly content: string;
    /**
     * Stable marker applied to this comment: the truncation marker for a
     * `truncated` body, the omission marker for an `omitted` body (even when
     * the marker could not fit the content budget), and null otherwise. The
     * metadata marker survives regardless of the content budget.
     */
    readonly marker: string | null;
    /** Length of the original body in characters (0 when body is null). */
    readonly originalLength: number;
    /** Length of the emitted content in characters. */
    readonly retainedLength: number;
    /** Body characters omitted entirely (the state-`omitted` body length). */
    readonly omittedLength: number;
    /** Body characters cut away by truncation. */
    readonly truncatedLength: number;
};

type CommentContentProjection = {
    readonly state: CommentPromptProjectionState;
    readonly content: string;
    readonly marker: string | null;
    readonly omittedLength: number;
    readonly truncatedLength: number;
};

/**
 * Bound one text value to `limit` characters, distinguishing the observed
 * states. A null body is `unavailable`, an observed empty body is `empty`
 * (and never relabeled), a body that fits is `retained`, an over-budget body
 * that can carry the truncation marker is `truncated`, and an over-budget
 * body that cannot is `omitted` (its content becomes the omission marker when
 * that fits, otherwise the empty string, with the stable marker preserved in
 * the projection metadata).
 */
const projectCommentContent = (
    body: string | null,
    limit: number,
): CommentContentProjection => {
    if (body === null) {
        return {
            state: "unavailable",
            content: "",
            marker: null,
            omittedLength: 0,
            truncatedLength: 0,
        };
    }
    if (body.length === 0) {
        return {
            state: "empty",
            content: "",
            marker: null,
            omittedLength: 0,
            truncatedLength: 0,
        };
    }
    if (body.length <= limit) {
        return {
            state: "retained",
            content: body,
            marker: null,
            omittedLength: 0,
            truncatedLength: 0,
        };
    }
    const keep = limit - THREAD_PROMPT_TRUNCATION_MARKER.length;
    if (keep > 0) {
        // Retain a strictly positive head, then append the marker. The `> 0`
        // guard is what prevents a `slice(0, 0)` or `slice(-0)` path from
        // appending the entire tail at the `marker.length + 1` boundary.
        return {
            state: "truncated",
            content: `${body.slice(0, keep)}${THREAD_PROMPT_TRUNCATION_MARKER}`,
            marker: THREAD_PROMPT_TRUNCATION_MARKER,
            omittedLength: 0,
            truncatedLength: body.length - keep,
        };
    }
    if (limit >= THREAD_PROMPT_TRUNCATION_MARKER.length) {
        // Exactly the truncation marker fits (the `marker.length` boundary):
        // zero body characters are retained but the cut stays observable.
        return {
            state: "truncated",
            content: THREAD_PROMPT_TRUNCATION_MARKER,
            marker: THREAD_PROMPT_TRUNCATION_MARKER,
            omittedLength: 0,
            truncatedLength: body.length,
        };
    }
    // The truncation marker does not fit the budget: the non-empty body is
    // omitted. Emit the omission marker when it fits, otherwise emit an empty
    // string; either way the stable marker survives in the metadata.
    if (limit >= THREAD_PROMPT_OMISSION_MARKER.length) {
        return {
            state: "omitted",
            content: THREAD_PROMPT_OMISSION_MARKER,
            marker: THREAD_PROMPT_OMISSION_MARKER,
            omittedLength: body.length,
            truncatedLength: 0,
        };
    }
    return {
        state: "omitted",
        content: "",
        marker: THREAD_PROMPT_OMISSION_MARKER,
        omittedLength: body.length,
        truncatedLength: 0,
    };
};

export const projectCommentPrompt = (
    comment: MaintainableComment,
    limit: number,
): CommentPromptProjection => {
    const validated = validateThreadPromptLimit("comment prompt limit", limit);
    const body = comment.body;
    const originalLength = typeof body === "string" ? body.length : 0;
    const projected = projectCommentContent(body, validated);
    return Object.freeze({
        id: comment.id,
        state: projected.state,
        limit: validated,
        content: projected.content,
        marker: projected.marker,
        originalLength,
        retainedLength: projected.content.length,
        omittedLength: projected.omittedLength,
        truncatedLength: projected.truncatedLength,
    });
};

export const projectMaintainableCommentPrompt = projectCommentPrompt;

export type ThreadPromptProjection = {
    /** The stable per-thread prompt limit applied to `text`. */
    readonly limit: number;
    /**
     * Bounded thread transcript: `#<id>: <content>` entries joined by
     * newlines, in original order, always satisfying `text.length <= limit`.
     */
    readonly text: string;
    /** Stable omission marker when entries were dropped; otherwise null. */
    readonly marker: string | null;
    readonly originalCount: number;
    /** Number of entries carried by `text`. */
    readonly includedCount: number;
    /** Number of entries dropped because the thread budget was exhausted. */
    readonly omittedCount: number;
    /** Length of the transcript as if every entry fit. */
    readonly originalLength: number;
    /** Length of the emitted transcript text. */
    readonly retainedLength: number;
    /** Transcript characters omitted by the thread budget. */
    readonly omittedLength: number;
    /** Always zero: the transcript is a complete prefix, never mid-cut. */
    readonly truncatedLength: number;
    /** Ids of the dropped entries, in original order. */
    readonly omittedIds: ReadonlyArray<number>;
};

const renderThreadEntry = (id: number, content: string): string =>
    `#${id}: ${content}`;

const projectThreadTranscriptText = (
    comments: ReadonlyArray<CommentPromptProjection>,
    limit: number,
): {
    readonly text: string;
    readonly omittedIds: ReadonlyArray<number>;
    readonly originalLength: number;
} => {
    const entries = comments.map((comment) => ({
        id: comment.id,
        text: renderThreadEntry(comment.id, comment.content),
    }));
    const originalLength =
        entries.reduce((sum, entry) => sum + entry.text.length, 0) +
        (entries.length > 0 ? entries.length - 1 : 0);
    const omittedIds: number[] = [];
    const parts: string[] = [];
    let used = 0;
    for (const [index, entry] of entries.entries()) {
        const separator = index === 0 ? "" : "\n";
        const nextLength = used + separator.length + entry.text.length;
        if (nextLength > limit) {
            // The transcript is a prefix: once an entry cannot fit, every
            // later entry is omitted so the original order is never broken.
            for (const dropped of entries.slice(index)) {
                omittedIds.push(dropped.id);
            }
            break;
        }
        parts.push(entry.text);
        used = nextLength;
    }
    return {
        text: parts.join("\n"),
        omittedIds: Object.freeze(omittedIds),
        originalLength,
    };
};

const projectThreadTranscript = (
    comments: ReadonlyArray<CommentPromptProjection>,
    limit: number,
): ThreadPromptProjection => {
    const projected = projectThreadTranscriptText(comments, limit);
    const omittedIds = projected.omittedIds;
    return Object.freeze({
        limit,
        text: projected.text,
        marker: omittedIds.length > 0 ? THREAD_PROMPT_OMISSION_MARKER : null,
        originalCount: comments.length,
        includedCount: comments.length - omittedIds.length,
        omittedCount: omittedIds.length,
        originalLength: projected.originalLength,
        retainedLength: projected.text.length,
        omittedLength: projected.originalLength - projected.text.length,
        truncatedLength: 0,
        omittedIds,
    });
};

export type AggregatePromptProjection = {
    /** The stable aggregate prompt limit applied to `text`. */
    readonly limit: number;
    /** Bounded aggregate summary; always satisfies `text.length <= limit`. */
    readonly text: string;
    /** Stable marker when the summary itself was truncated or omitted. */
    readonly marker: string | null;
    /** True when the summary text was truncated. */
    readonly truncated: boolean;
    /** True when the summary text was omitted (could not fit a marker). */
    readonly omitted: boolean;
    /** Length of the unconstrained summary. */
    readonly originalLength: number;
    /** Length of the emitted summary text. */
    readonly retainedLength: number;
    /** Summary characters omitted entirely. */
    readonly omittedLength: number;
    /** Summary characters cut by truncation. */
    readonly truncatedLength: number;
    readonly originalCount: number;
    readonly retainedCount: number;
    readonly truncatedCount: number;
    readonly omittedCount: number;
    readonly emptyCount: number;
    readonly unavailableCount: number;
};

const renderAggregateSummary = (counts: {
    readonly originalCount: number;
    readonly retainedCount: number;
    readonly truncatedCount: number;
    readonly omittedCount: number;
    readonly emptyCount: number;
    readonly unavailableCount: number;
}): string =>
    [
        "comments",
        String(counts.originalCount),
        "retained",
        String(counts.retainedCount),
        "truncated",
        String(counts.truncatedCount),
        "omitted",
        String(counts.omittedCount),
        "empty",
        String(counts.emptyCount),
        "unavailable",
        String(counts.unavailableCount),
    ].join(" ");

const countState = (
    comments: ReadonlyArray<CommentPromptProjection>,
    state: CommentPromptProjectionState,
): number =>
    comments.reduce(
        (sum, comment) => (comment.state === state ? sum + 1 : sum),
        0,
    );

const projectAggregatePrompt = (
    comments: ReadonlyArray<CommentPromptProjection>,
    limit: number,
): AggregatePromptProjection => {
    const retainedCount = countState(comments, "retained");
    const truncatedCount = countState(comments, "truncated");
    const omittedCount = countState(comments, "omitted");
    const emptyCount = countState(comments, "empty");
    const unavailableCount = countState(comments, "unavailable");
    const summary = renderAggregateSummary({
        originalCount: comments.length,
        retainedCount,
        truncatedCount,
        omittedCount,
        emptyCount,
        unavailableCount,
    });
    const bounded = projectCommentContent(summary, limit);
    return Object.freeze({
        limit,
        text: bounded.content,
        marker: bounded.marker,
        truncated: bounded.state === "truncated",
        omitted: bounded.state === "omitted",
        originalLength: summary.length,
        retainedLength: bounded.content.length,
        omittedLength: bounded.omittedLength,
        truncatedLength: bounded.truncatedLength,
        originalCount: comments.length,
        retainedCount,
        truncatedCount,
        omittedCount,
        emptyCount,
        unavailableCount,
    });
};

export type MaintainableThreadPromptInput = {
    /** The unchanged full fetched thread from the snapshot contract. */
    readonly thread: MaintainableSelectedThread;
    /** Maximum characters emitted for each comment's content. */
    readonly commentPromptLimit: number;
    /** Maximum characters of the projected thread transcript text. */
    readonly threadPromptLimit: number;
    /** Maximum characters of the projected aggregate summary text. */
    readonly aggregatePromptLimit: number;
};

export type ThreadPromptProjectionResult = {
    /** The full fetched thread, unchanged: a bounded projection never downgrades a complete fetch. */
    readonly fetchedThread: MaintainableSelectedThread;
    /** One projection per fetched comment, identity and original order preserved. */
    readonly comments: ReadonlyArray<CommentPromptProjection>;
    /** The bounded thread transcript plus truncation metadata. */
    readonly thread: ThreadPromptProjection;
    /** The bounded aggregate summary plus truncation metadata. */
    readonly aggregate: AggregatePromptProjection;
    readonly commentLimit: number;
    readonly threadLimit: number;
    readonly aggregateLimit: number;
};

export const projectThreadPrompt = (
    input: MaintainableThreadPromptInput,
): ThreadPromptProjectionResult => {
    const commentLimit = validateThreadPromptLimit(
        "comment prompt limit",
        input.commentPromptLimit,
    );
    const threadLimit = validateThreadPromptLimit(
        "thread prompt limit",
        input.threadPromptLimit,
    );
    const aggregateLimit = validateThreadPromptLimit(
        "aggregate prompt limit",
        input.aggregatePromptLimit,
    );
    const comments = Object.freeze(
        input.thread.comments.map((comment) =>
            projectCommentPrompt(comment, commentLimit),
        ),
    );
    return Object.freeze({
        fetchedThread: input.thread,
        comments,
        thread: projectThreadTranscript(comments, threadLimit),
        aggregate: projectAggregatePrompt(comments, aggregateLimit),
        commentLimit,
        threadLimit,
        aggregateLimit,
    });
};

export const projectMaintainableThreadPrompt = projectThreadPrompt;