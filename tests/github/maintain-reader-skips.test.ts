import { describe, expect, test } from "bun:test";

import {
    createMaintainableComment,
    createMaintainableIssue,
} from "../../src/maintain-issues-snapshot.ts";
import {
    classifyPullRequestRecord,
    classifyRecordUnavailable,
    isPullRequestRecord,
    isMaintainReaderPaginationFailure,
    mapMaintainableIssueRecord,
} from "../../src/maintain/github-reader/skips.ts";
import { MaintainGitHubReaderDiagnosticError } from "../../src/maintain/github-reader/diagnostics.ts";

const failure = (
    status: number,
    headers: Record<string, string> = {},
    message = "GitHub record failure",
): Error =>
    Object.assign(new Error(message), {
        status,
        response: { status, headers, data: { message } },
    });

describe("maintenance GitHub reader record skips", () => {
    test("maps transferred, deleted, inaccessible, and other failures", () => {
        const cases = [
            [failure(301), "transferred"],
            [failure(410), "deleted"],
            [failure(403, { "x-ratelimit-remaining": "1" }), "inaccessible"],
            [failure(404), "inaccessible"],
            [failure(500), "unavailable"],
        ] as const;
        for (const [cause, reason] of cases) {
            const skip = classifyRecordUnavailable(cause, 17, "o/r");
            expect(skip.reason).toBe(reason);
            expect(skip.issueNumber).toBe(17);
            expect(skip.detail).toContain("HTTP");
        }
    });

    test("does not classify rate limits as skips", () => {
        for (const cause of [
            failure(429),
            failure(403, { "x-ratelimit-remaining": "0" }),
        ]) {
            expect(() => classifyRecordUnavailable(cause, 17, "o/r")).toThrow(
                MaintainGitHubReaderDiagnosticError,
            );
        }
    });

    test("does not classify pagination failures as skips", () => {
        const cause = Object.assign(new Error("pagination failed on page 2"), {
            paginationFailure: true,
        });
        expect(isMaintainReaderPaginationFailure(cause)).toBe(true);
        expect(() => classifyRecordUnavailable(cause, 17, "o/r")).toThrow(
            MaintainGitHubReaderDiagnosticError,
        );
    });

    test("pull-request-shaped records are skipped by key presence", () => {
        expect(isPullRequestRecord({ pull_request: undefined })).toBe(true);
        const skip = classifyPullRequestRecord({ pull_request: {} }, 22);
        expect(skip).toMatchObject({
            reason: "unavailable",
            issueNumber: 22,
        });
        expect(skip?.detail).toContain("pull request");
    });

    test("null authors and future enum values remain safe contract values", () => {
        const issue = createMaintainableIssue({
            number: 22,
            title: "null author",
            author: null,
            authorAssociation: "FUTURE_ASSOCIATION",
            state: "future-state",
            labels: [],
            assignees: [],
            selectedThread: { comments: [] },
        });
        const comment = createMaintainableComment({
            id: 3,
            author: null,
            authorAssociation: "FUTURE_ASSOCIATION",
            body: "comment",
        });
        expect(issue.author).toBeNull();
        expect(issue.state).toEqual({ kind: "unknown", value: "future-state" });
        expect(issue.authorAssociation).toEqual({
            kind: "unknown",
            value: "FUTURE_ASSOCIATION",
        });
        expect(comment.author).toBeNull();
        expect(
            mapMaintainableIssueRecord({ author: null }, 23).author,
        ).toBeNull();
    });
});