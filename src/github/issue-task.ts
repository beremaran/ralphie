import { IssueStageKind } from "../issues/stage.ts";
import { StructuredOutputName } from "../agent/session.ts";

export enum GitHubIssueAction {
    CreateBreakdownIssues = "create-breakdown-issues",
    RewriteOriginalAsDuplicate = "rewrite-original-as-duplicate",
    CloseOriginalAsDuplicate = "close-original-as-duplicate",
}

export enum IssueLinkStrategy {
    OriginalAndSiblings = "original-and-siblings",
}

export type GitHubIssueStage =
    | {
          readonly kind: IssueStageKind.GitHubTask;
          readonly action: GitHubIssueAction.CreateBreakdownIssues;
          readonly input: StructuredOutputName.IssueBreakdownDecision;
          readonly links: IssueLinkStrategy.OriginalAndSiblings;
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