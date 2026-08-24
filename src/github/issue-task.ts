export type GitHubIssueAction = "mark-in-progress" | "publish-result";

export type GitHubIssueStage = {
  readonly kind: "github-task";
  readonly action: GitHubIssueAction;
};
