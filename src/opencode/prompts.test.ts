import { describe, expect, test } from "bun:test";

import {
  ReviewFindingSeverity,
  ReviewVerdict,
} from "../issues/decisions.ts";
import {
  buildCommitMessagePrompt,
  buildComplexityPrompt,
  buildImplementationPrompt,
  buildReviewFixPrompt,
  buildReviewPrompt,
} from "./prompts.ts";

describe("OpenCode prompts", () => {
  test("builds a complexity prompt with the complete rubric and issue context", () => {
    const prompt = buildComplexityPrompt({
      issue: {
        number: 42,
        title: "Fix refresh behavior",
        url: "https://github.com/owner/repo/issues/42",
        body: "Refresh expired tokens.",
        labels: ["bug", "auth"],
      },
      repositoryPath: "/workspace/repo",
      targetBranch: "main",
    });

    for (const level of [0, 1, 2, 3, 4, 5]) {
      expect(prompt).toContain(`${level}:`);
    }
    expect(prompt).toContain('Issue title: "Fix refresh behavior"');
    expect(prompt).toContain('Issue labels: ["bug","auth"]');
    expect(prompt).toContain('Issue body: "Refresh expired tokens."');
    expect(prompt).toContain('Repository path: "/workspace/repo"');
    expect(prompt).toContain('Target branch: "main"');
    expect(prompt).toContain("Do not modify files, Git, or GitHub.");
  });

  test("builds an implementation prompt with deterministic-operation restrictions", () => {
    const prompt = buildImplementationPrompt({
      issue: {
        number: 7,
        title: "Add validation",
        url: "issue/7",
        body: "Validate the input.",
        labels: [],
      },
      repositoryPath: "/workspace/repo",
      targetBranch: "develop",
    });

    expect(prompt).toContain("implement the smallest\ncomplete solution");
    expect(prompt).toContain("must\nnot create commits, push, switch branches");
    expect(prompt).toContain("Leave all resulting changes in the working tree");
    expect(prompt).toContain('Issue title: "Add validation"');
  });

  test("builds a review prompt from only issue, metadata, and staged diff", () => {
    const prompt = buildReviewPrompt({
      issue: {
        number: 19,
        title: "Fix parser edge case",
        url: "issue/19",
        body: "Handle empty input.",
        labels: [],
      },
      repositoryPath: "/workspace/repo",
      targetBranch: "main",
      stagedDiff: "diff --git a/src/parser.ts b/src/parser.ts\n+return null;",
    });

    expect(prompt).toContain("Base your review only on the issue and the staged diff");
    expect(prompt).toContain('Repository path: "/workspace/repo"');
    expect(prompt).toContain('Target branch: "main"');
    expect(prompt).toContain('Issue title: "Fix parser edge case"');
    expect(prompt).toContain("diff --git a/src/parser.ts b/src/parser.ts");
    expect(prompt).toContain("Do not edit files, stage or unstage changes");
    expect(prompt).toContain("create commits, push, switch branches");
  });

  test("builds a fresh-context review-fix prompt with the structured review", () => {
    const prompt = buildReviewFixPrompt({
      issue: {
        number: 20,
        title: "Add validation",
        url: "issue/20",
        body: null,
        labels: [],
      },
      repositoryPath: "/workspace/repo",
      targetBranch: "develop",
      stagedDiff: "diff --git a/src/input.ts b/src/input.ts",
      review: {
        verdict: ReviewVerdict.ChangesRequested,
        summary: "Missing empty-input validation.",
        findings: [
          {
            severity: ReviewFindingSeverity.Blocking,
            description: "Reject empty input before parsing.",
            file: "src/input.ts",
            line: 12,
          },
        ],
      },
    });

    expect(prompt).toContain("You are starting with fresh context");
    expect(prompt).toContain('"verdict": "changes_requested"');
    expect(prompt).toContain("Reject empty input before parsing.");
    expect(prompt).toContain("leave the resulting changes in the working tree");
    expect(prompt).toContain("must not create commits, push");
    expect(prompt).toContain('Issue body: ""');
  });

  test("builds a commit-message prompt with final staged diff restrictions", () => {
    const prompt = buildCommitMessagePrompt({
      issue: {
        number: 21,
        title: "Improve cache handling",
        url: "issue/21",
        body: "Avoid stale entries.",
        labels: ["bug"],
      },
      repositoryPath: "/workspace/repo",
      targetBranch: "main",
      stagedDiff: "diff --git a/src/cache.ts b/src/cache.ts",
    });

    expect(prompt).toContain("Generate a concise commit message");
    expect(prompt).toContain("must be imperative");
    expect(prompt).toContain("no longer than 72 characters");
    expect(prompt).toContain("Final staged diff:");
    expect(prompt).toContain("diff --git a/src/cache.ts b/src/cache.ts");
    expect(prompt).toContain("Do not edit files, stage or");
    expect(prompt).toContain("create commits, push, switch branches");
  });
});
