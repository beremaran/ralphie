import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { GitHubIssue } from "../github/issues.ts";
import {
  IssuePipeline,
  IssuePipelineLive,
  selectIssues,
} from "./pipeline.ts";

const issues: GitHubIssue[] = [
  { number: 1, title: "One", url: "issue/1", body: null, labels: [] },
  { number: 2, title: "Two", url: "issue/2", body: null, labels: [] },
  { number: 3, title: "Three", url: "issue/3", body: null, labels: [] },
];

describe("issue pipeline", () => {
  test("defines mixed OpenCode, Git, and GitHub stages", async () => {
    const plan = await Effect.gen(function* () {
      const pipeline = yield* IssuePipeline;
      return yield* pipeline.plan({
        issue: issues[0]!,
        repositoryPath: "/workspace/repository",
        baseBranch: "main",
      });
    }).pipe(Effect.provide(IssuePipelineLive), Effect.runPromise);

    expect(plan.issueBranch).toBe("ralphie/issue-1");
    expect(plan.stages).toEqual([
      { kind: "git-task", action: "prepare-branch" },
      { kind: "github-task", action: "mark-in-progress" },
      { kind: "opencode-session", purpose: "plan" },
      { kind: "opencode-session", purpose: "implement" },
      { kind: "git-task", action: "validate" },
      { kind: "git-task", action: "commit" },
      { kind: "github-task", action: "publish-result" },
    ]);
  });

  test("selects all issues by default", () => {
    expect(selectIssues(issues)).toEqual(issues);
  });

  test("honors the maximum issue count", () => {
    expect(selectIssues(issues, 2)).toEqual(issues.slice(0, 2));
  });
});
