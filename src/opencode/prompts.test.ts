import { describe, expect, test } from "bun:test";

import {
  buildComplexityPrompt,
  buildImplementationPrompt,
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
});
