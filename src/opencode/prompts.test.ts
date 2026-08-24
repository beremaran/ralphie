import { describe, expect, test } from "bun:test";

import { buildComplexityPrompt } from "./prompts.ts";

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
});
