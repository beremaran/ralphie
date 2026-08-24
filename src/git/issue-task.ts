export type GitIssueAction = "stage-all" | "commit" | "push";

export type GitIssueStage = {
  readonly kind: "git-task";
  readonly action: GitIssueAction;
  readonly messageFrom?: "commit-message-decision";
};
