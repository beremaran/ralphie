export type StructuredOutputName =
  | "complexity-decision"
  | "review-decision"
  | "commit-message-decision"
  | "issue-breakdown-decision";

export type OpenCodeSessionStage =
  | {
      readonly kind: "opencode-session";
      readonly purpose: "implement";
    }
  | {
      readonly kind: "opencode-session";
      readonly purpose: "address-review";
      readonly context: "fresh";
      readonly input: "review-decision";
    }
  | {
      readonly kind: "opencode-session";
      readonly purpose:
        | "assess-complexity"
        | "review-diff"
        | "generate-commit-message"
        | "decompose-issue";
      readonly output: StructuredOutputName;
    };
