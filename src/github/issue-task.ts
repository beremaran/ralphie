import { IssueStageKind } from "../issues/stage.ts";
import { StructuredOutputName } from "../agent/session.ts";

export enum GitHubIssueAction {
    CreateBreakdownIssues = "create-breakdown-issues",
    RewriteOriginalAsDuplicate = "rewrite-original-as-duplicate",
    CloseOriginalAsDuplicate = "close-original-as-duplicate",
}

export const IssueLinkStrategy = "original-and-siblings" as const;
export type IssueLinkStrategy = typeof IssueLinkStrategy;

export type GitHubIssueStage =
    | {
          readonly kind: IssueStageKind.GitHubTask;
          readonly action: GitHubIssueAction.CreateBreakdownIssues;
          readonly input: StructuredOutputName.IssueBreakdownDecision;
          readonly links: IssueLinkStrategy;
          readonly includeDependencies: true;
      }
    | {
          readonly kind: IssueStageKind.GitHubTask;
          readonly action: GitHubIssueAction.RewriteOriginalAsDuplicate;
          readonly input: StructuredOutputName.IssueBreakdownDecision;
      }
    | {
          readonly kind: IssueStageKind.GitHubTask;
          readonly action: GitHubIssueAction.CloseOriginalAsDuplicate;
      };