export type GitIssueAction =
    | "capture-issue-base"
    | "stage-all"
    | "commit"
    | "push";

export const GitIssueOutput = "issue-base" as const;
export type GitIssueOutput = typeof GitIssueOutput;

export type GitIssueStage =
    | {
          readonly kind: "git-task";
          readonly action: "capture-issue-base";
          readonly output: GitIssueOutput;
      }
    | {
          readonly kind: "git-task";
          readonly action: "stage-all" | "push";
      }
    | {
          readonly kind: "git-task";
          readonly action: "commit";
          readonly messageFrom: "commit-message-decision";
      };