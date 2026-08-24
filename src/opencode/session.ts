import { IssueStageKind } from "../issues/stage.ts";

export enum StructuredOutputName {
  ComplexityDecision = "complexity-decision",
  ReviewDecision = "review-decision",
  CommitMessageDecision = "commit-message-decision",
  IssueBreakdownDecision = "issue-breakdown-decision",
}

export enum OpenCodeSessionPurpose {
  Implement = "implement",
  AddressReview = "address-review",
  AssessComplexity = "assess-complexity",
  ReviewDiff = "review-diff",
  GenerateCommitMessage = "generate-commit-message",
  DecomposeIssue = "decompose-issue",
}

export enum OpenCodeSessionContext {
  Fresh = "fresh",
}

export type OpenCodeSessionStage =
  | {
      readonly kind: IssueStageKind.OpenCodeSession;
      readonly purpose: OpenCodeSessionPurpose.Implement;
    }
  | {
      readonly kind: IssueStageKind.OpenCodeSession;
      readonly purpose: OpenCodeSessionPurpose.AddressReview;
      readonly context: OpenCodeSessionContext.Fresh;
      readonly input: StructuredOutputName.ReviewDecision;
    }
  | {
      readonly kind: IssueStageKind.OpenCodeSession;
      readonly purpose:
        | OpenCodeSessionPurpose.AssessComplexity
        | OpenCodeSessionPurpose.ReviewDiff
        | OpenCodeSessionPurpose.GenerateCommitMessage
        | OpenCodeSessionPurpose.DecomposeIssue;
      readonly output: StructuredOutputName;
    };
