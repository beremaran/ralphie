import { type IssueStageKind } from "../issues/stage.ts";
import { type StructuredOutputName } from "../agent/session.ts";

export type GitHubIssueAction =
    | "create-breakdown-issues"
    | "rewrite-original-as-duplicate"
    | "close-original-as-duplicate";

export const IssueLinkStrategy = "original-and-siblings" as const;
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
          readonly action: "rewrite-original-as-duplicate";
          readonly input: "issue-breakdown-decision";
      }
    | {
          readonly kind: "github-task";
          readonly action: "close-original-as-duplicate";
      };