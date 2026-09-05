export type GitHubIssueAction =
    | "create-breakdown-issues"
    | "attach-native-sub-issues"
    | "create-native-dependencies"
    | "rewrite-original";

export const IssueLinkStrategy = "native-sub-issues" as const;
export type IssueLinkStrategy = typeof IssueLinkStrategy;

export type GitHubIssueStage =
    | {
          readonly kind: "github-task";
          readonly action: "create-breakdown-issues";
          readonly input: "issue-breakdown-decision";
          readonly links: IssueLinkStrategy;
          readonly includeDependencies: true;
      }
    | {
          readonly kind: "github-task";
          readonly action: "attach-native-sub-issues";
      }
    | {
          readonly kind: "github-task";
          readonly action: "create-native-dependencies";
          readonly input: "issue-breakdown-decision";
      }
    | {
          readonly kind: "github-task";
          readonly action: "rewrite-original";
          readonly input: "issue-breakdown-decision";
      };