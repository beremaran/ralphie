import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { GitHubIssue } from "../github/issues.ts";
import {
  IssuePipeline,
  IssuePipelineLive,
  selectIssues,
  selectWorkflow,
} from "./pipeline.ts";

const issues: GitHubIssue[] = [
  { number: 1, title: "One", url: "issue/1", body: null, labels: [] },
  { number: 2, title: "Two", url: "issue/2", body: null, labels: [] },
  { number: 3, title: "Three", url: "issue/3", body: null, labels: [] },
];

const makePlan = () =>
  Effect.gen(function* () {
    const pipeline = yield* IssuePipeline;
    return yield* pipeline.plan({
      issue: issues[0]!,
      repositoryPath: "/workspace/repository",
      targetBranch: "main",
    });
  }).pipe(Effect.provide(IssuePipelineLive), Effect.runPromise);

describe("issue pipeline", () => {
  test("assesses complexity and works directly on the requested branch", async () => {
    const plan = await makePlan();

    expect(plan.targetBranch).toBe("main");
    expect(plan).not.toHaveProperty("issueBranch");
    expect(plan.assessment).toEqual({
      kind: "opencode-session",
      purpose: "assess-complexity",
      output: "complexity-decision",
    });
  });

  test("routes complexity 0-3 through the bounded review workflow", async () => {
    const plan = await makePlan();

    for (const complexity of [0, 1, 2, 3]) {
      expect(selectWorkflow(plan, complexity)?.kind).toBe("implementation");
    }

    expect(selectWorkflow(plan, 3)?.stages).toEqual([
      { kind: "opencode-session", purpose: "implement" },
      {
        kind: "review-loop",
        maxIterations: 5,
        onExhausted: "fail",
        convergeWhen: {
          output: "review-decision",
          verdict: "approved",
        },
        stageChanges: { kind: "git-task", action: "stage-all" },
        review: {
          kind: "opencode-session",
          purpose: "review-diff",
          output: "review-decision",
        },
        onChangesRequested: {
          kind: "opencode-session",
          purpose: "address-review",
          context: "fresh",
          input: "review-decision",
        },
      },
      {
        kind: "opencode-session",
        purpose: "generate-commit-message",
        output: "commit-message-decision",
      },
      {
        kind: "git-task",
        action: "commit",
        messageFrom: "commit-message-decision",
      },
      { kind: "git-task", action: "push" },
    ]);
  });

  test("routes complexity 4-5 through dependency-aware decomposition", async () => {
    const plan = await makePlan();

    for (const complexity of [4, 5]) {
      expect(selectWorkflow(plan, complexity)?.kind).toBe("decomposition");
    }
    expect(selectWorkflow(plan, 4)?.stages).toEqual([
      {
        kind: "opencode-session",
        purpose: "decompose-issue",
        output: "issue-breakdown-decision",
      },
      {
        kind: "github-task",
        action: "create-breakdown-issues",
        input: "issue-breakdown-decision",
        links: "original-and-siblings",
        includeDependencies: true,
      },
      {
        kind: "github-task",
        action: "rewrite-original-as-duplicate",
        input: "issue-breakdown-decision",
      },
      { kind: "github-task", action: "close-original-as-duplicate" },
    ]);
  });

  test("does not route invalid complexity values", async () => {
    const plan = await makePlan();

    expect(selectWorkflow(plan, -1)).toBeUndefined();
    expect(selectWorkflow(plan, 2.5)).toBeUndefined();
    expect(selectWorkflow(plan, 6)).toBeUndefined();
  });

  test("selects all issues by default", () => {
    expect(selectIssues(issues)).toEqual(issues);
  });

  test("honors the maximum issue count", () => {
    expect(selectIssues(issues, 2)).toEqual(issues.slice(0, 2));
  });
});
