import { type IssueStageKind } from "../issues/stage.ts";

export type StructuredOutputName =
    | "grounding-decision"
    | "issue-resolution-decision"
    | "complexity-decision"
    | "review-decision"
    | "commit-message-decision"
    | "issue-breakdown-decision";

export type CodexSessionPurpose =
    | "implement"
    | "address-review"
    | "assess-complexity"
    | "assess-grounding"
    | "verify-resolution"
    | "review-diff"
    | "generate-commit-message"
    | "decompose-issue";

export const CodexSessionContext = "fresh" as const;
export type CodexSessionContext = typeof CodexSessionContext;

export type CodexSessionStage =
    | {
          readonly kind: "codex-session";
          readonly purpose: "implement";
      }
    | {
          readonly kind: "codex-session";
          readonly purpose: "address-review";
          readonly context: CodexSessionContext;
          readonly input: "review-decision";
      }
    | {
          readonly kind: "codex-session";
          readonly purpose:
              | "assess-complexity"
              | "assess-grounding"
              | "verify-resolution"
              | "review-diff"
              | "generate-commit-message"
              | "decompose-issue";
          readonly output: StructuredOutputName;
      };