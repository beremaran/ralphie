import { type IssueStageKind } from "../issues/stage.ts";

export type StructuredOutputName =
    | "complexity-decision"
    | "review-decision"
    | "commit-message-decision"
    | "issue-breakdown-decision";

export type PiSessionPurpose =
    | "implement"
    | "address-review"
    | "assess-complexity"
    | "review-diff"
    | "generate-commit-message"
    | "decompose-issue";

export const PiSessionContext = "fresh" as const;
export type PiSessionContext = typeof PiSessionContext;

export type PiSessionStage =
    | {
          readonly kind: "pi-session";
          readonly purpose: "implement";
      }
    | {
          readonly kind: "pi-session";
          readonly purpose: "address-review";
          readonly context: PiSessionContext;
          readonly input: "review-decision";
      }
    | {
          readonly kind: "pi-session";
          readonly purpose:
              | "assess-complexity"
              | "review-diff"
              | "generate-commit-message"
              | "decompose-issue";
          readonly output: StructuredOutputName;
      };