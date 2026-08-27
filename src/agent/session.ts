import { IssueStageKind } from "../issues/stage.ts";

export enum StructuredOutputName {
    ComplexityDecision = "complexity-decision",
    ReviewDecision = "review-decision",
    CommitMessageDecision = "commit-message-decision",
    IssueBreakdownDecision = "issue-breakdown-decision",
}

export enum PiSessionPurpose {
    Implement = "implement",
    AddressReview = "address-review",
    AssessComplexity = "assess-complexity",
    ReviewDiff = "review-diff",
    GenerateCommitMessage = "generate-commit-message",
    DecomposeIssue = "decompose-issue",
}

export const PiSessionContext = "fresh" as const;
export type PiSessionContext = typeof PiSessionContext;

export type PiSessionStage =
    | {
          readonly kind: IssueStageKind.PiSession;
          readonly purpose: PiSessionPurpose.Implement;
      }
    | {
          readonly kind: IssueStageKind.PiSession;
          readonly purpose: PiSessionPurpose.AddressReview;
          readonly context: PiSessionContext;
          readonly input: StructuredOutputName.ReviewDecision;
      }
    | {
          readonly kind: IssueStageKind.PiSession;
          readonly purpose:
              | PiSessionPurpose.AssessComplexity
              | PiSessionPurpose.ReviewDiff
              | PiSessionPurpose.GenerateCommitMessage
              | PiSessionPurpose.DecomposeIssue;
          readonly output: StructuredOutputName;
      };