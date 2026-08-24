export type GitIssueAction = "prepare-branch" | "validate" | "commit";

export type GitIssueStage = {
  readonly kind: "git-task";
  readonly action: GitIssueAction;
};
