import { describe, expect, test } from "bun:test";

import {
    buildImplementationPrompt,
    PROMPT_ISSUE_COMMENT_BODY_LIMIT,
    PROMPT_ISSUE_COMMENT_COUNT_LIMIT,
} from "../../src/agent/prompts.ts";
import type {
    GitHubIssue,
    GitHubIssueComment,
} from "../../src/github/domain.ts";

const comment = (id: number, body: string): GitHubIssueComment => ({
    id,
    body,
    updatedAt: "2026-08-28T00:00:00.000Z",
});

const issueWith = (
    comments: ReadonlyArray<GitHubIssueComment>,
): GitHubIssue => ({
    number: 7,
    title: "Add a thing",
    url: "https://github.com/owner/repo/issues/7",
    body: "Original body text.",
    labels: [],
    comments,
    commentCount: comments.length,
});

const promptFor = (issue: GitHubIssue): string =>
    buildImplementationPrompt({
        issue,
        repositoryPath: "/work/repo",
        targetBranch: "main",
        implementInvocation: "/implement",
    });

describe("implementation prompt", () => {
    test("invokes the implement skill with the overlay", () => {
        const prompt = promptFor(issueWith([]));
        expect(prompt).toContain("/implement");
        expect(prompt).toMatch(/do not commit/i);
        expect(prompt).toMatch(/skip the closing code review/i);
        expect(prompt).toContain("commitMessage");
        expect(prompt).toContain("needs_attention");
    });

    test("uses the issue body as the contract without an Agent Brief", () => {
        const prompt = promptFor(issueWith([comment(1, "just chatting")]));
        expect(prompt).toContain("<contract>");
        expect(prompt).toContain("Original body text.");
        expect(prompt).not.toContain("Agent Brief");
    });

    test("includes the latest Agent Brief in full even past every comment limit", () => {
        const longBrief = `## Agent Brief\n\n${"detail line\n".repeat(PROMPT_ISSUE_COMMENT_BODY_LIMIT)}END-OF-BRIEF`;
        const comments = [
            comment(1, "## Agent Brief\n\nOLD-BRIEF"),
            comment(2, longBrief),
            ...Array.from(
                { length: PROMPT_ISSUE_COMMENT_COUNT_LIMIT + 5 },
                (_, index) => comment(10 + index, `chatter ${index}`),
            ),
        ];
        const prompt = promptFor(issueWith(comments));
        expect(prompt).toContain("END-OF-BRIEF");
        expect(prompt).not.toContain("OLD-BRIEF");
        expect(prompt).not.toContain("issue comment body truncated");
        expect(prompt.indexOf("<agent-brief>")).toBeLessThan(
            prompt.indexOf("Original body text."),
        );
    });
});