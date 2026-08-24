export type GitHubIssueStage =
  | {
      readonly kind: "github-task";
      readonly action: "create-breakdown-issues";
      readonly input: "issue-breakdown-decision";
      readonly links: "original-and-siblings";
      readonly includeDependencies: true;
    }
  | {
      readonly kind: "github-task";
      readonly action: "rewrite-original-as-duplicate";
      readonly input: "issue-breakdown-decision";
    }
  | {
      readonly kind: "github-task";
      readonly action: "close-original-as-duplicate";
    };
