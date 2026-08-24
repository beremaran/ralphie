import { Context, Effect, Layer } from "effect";

import type { GitIssueStage } from "../git/issue-task.ts";
import type { GitHubIssue } from "../github/issues.ts";
import type { GitHubIssueStage } from "../github/issue-task.ts";
import type { OpenCodeSessionStage } from "../opencode/session.ts";

export type IssueAtomicStage =
  | GitIssueStage
  | GitHubIssueStage
  | OpenCodeSessionStage;

export type ReviewLoopStage = {
  readonly kind: "review-loop";
  readonly maxIterations: 5;
  readonly onExhausted: "fail";
  readonly convergeWhen: {
    readonly output: "review-decision";
    readonly verdict: "approved";
  };
  readonly stageChanges: GitIssueStage;
  readonly review: OpenCodeSessionStage;
  readonly onChangesRequested: OpenCodeSessionStage;
};

export type IssueStage = IssueAtomicStage | ReviewLoopStage;

export type IssueWorkflow = {
  readonly kind: "implementation" | "decomposition";
  readonly complexity: {
    readonly min: number;
    readonly max: number;
  };
  readonly stages: ReadonlyArray<IssueStage>;
};

export type IssueExecutionPlan = {
  readonly issue: GitHubIssue;
  readonly repositoryPath: string;
  readonly targetBranch: string;
  readonly assessment: OpenCodeSessionStage;
  readonly workflows: readonly [IssueWorkflow, IssueWorkflow];
};

export type IssuePipelineService = {
  readonly plan: (input: {
    readonly issue: GitHubIssue;
    readonly repositoryPath: string;
    readonly targetBranch: string;
  }) => Effect.Effect<IssueExecutionPlan>;
};

export const IssuePipeline =
  Context.GenericTag<IssuePipelineService>("ralphie/IssuePipeline");

const assessment: OpenCodeSessionStage = {
  kind: "opencode-session",
  purpose: "assess-complexity",
  output: "complexity-decision",
};

const implementationWorkflow: IssueWorkflow = {
  kind: "implementation",
  complexity: { min: 0, max: 3 },
  stages: [
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
  ],
};

const decompositionWorkflow: IssueWorkflow = {
  kind: "decomposition",
  complexity: { min: 4, max: 5 },
  stages: [
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
  ],
};

export const IssuePipelineLive = Layer.succeed(IssuePipeline, {
  plan: ({ issue, repositoryPath, targetBranch }) =>
    Effect.succeed({
      issue,
      repositoryPath,
      targetBranch,
      assessment,
      workflows: [implementationWorkflow, decompositionWorkflow],
    }),
});

export const selectWorkflow = (
  plan: IssueExecutionPlan,
  complexity: number,
): IssueWorkflow | undefined =>
  Number.isInteger(complexity)
    ? plan.workflows.find(
        (workflow) =>
          complexity >= workflow.complexity.min &&
          complexity <= workflow.complexity.max,
      )
    : undefined;

export const selectIssues = (
  issues: ReadonlyArray<GitHubIssue>,
  maxIssues?: number,
): ReadonlyArray<GitHubIssue> =>
  maxIssues === undefined ? issues : issues.slice(0, maxIssues);
