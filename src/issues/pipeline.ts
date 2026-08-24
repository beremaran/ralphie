import { Context, Effect, Layer } from "effect";

import type { GitIssueStage } from "../git/issue-task.ts";
import type { GitHubIssue } from "../github/issues.ts";
import type { GitHubIssueStage } from "../github/issue-task.ts";
import type { OpenCodeSessionStage } from "../opencode/session.ts";

export type IssueStage =
  | GitIssueStage
  | GitHubIssueStage
  | OpenCodeSessionStage;

export type IssueExecutionPlan = {
  readonly issue: GitHubIssue;
  readonly repositoryPath: string;
  readonly baseBranch: string;
  readonly issueBranch: string;
  readonly stages: ReadonlyArray<IssueStage>;
};

export type IssuePipelineService = {
  readonly plan: (input: {
    readonly issue: GitHubIssue;
    readonly repositoryPath: string;
    readonly baseBranch: string;
  }) => Effect.Effect<IssueExecutionPlan>;
};

export const IssuePipeline =
  Context.GenericTag<IssuePipelineService>("ralphie/IssuePipeline");

const stages: ReadonlyArray<IssueStage> = [
  { kind: "git-task", action: "prepare-branch" },
  { kind: "github-task", action: "mark-in-progress" },
  { kind: "opencode-session", purpose: "plan" },
  { kind: "opencode-session", purpose: "implement" },
  { kind: "git-task", action: "validate" },
  { kind: "git-task", action: "commit" },
  { kind: "github-task", action: "publish-result" },
];

export const IssuePipelineLive = Layer.succeed(IssuePipeline, {
  plan: ({ issue, repositoryPath, baseBranch }) =>
    Effect.succeed({
      issue,
      repositoryPath,
      baseBranch,
      issueBranch: `ralphie/issue-${issue.number}`,
      stages,
    }),
});

export const selectIssues = (
  issues: ReadonlyArray<GitHubIssue>,
  maxIssues?: number,
): ReadonlyArray<GitHubIssue> =>
  maxIssues === undefined ? issues : issues.slice(0, maxIssues);
