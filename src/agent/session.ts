import { type IssueStageKind } from "../issues/stage.ts";

export type StructuredOutputName =
    | "grounding-decision"
    | "issue-resolution-decision"
    | "complexity-decision"
    | "review-decision"
    | "commit-message-decision"
    | "issue-breakdown-decision";

export type AgentSessionPurpose =
    | "implement"
    | "address-review"
    | "assess-complexity"
    | "assess-grounding"
    | "verify-resolution"
    | "review-diff"
    | "generate-commit-message"
    | "decompose-issue";

export const AgentSessionContext = "fresh" as const;
export type AgentSessionContext = typeof AgentSessionContext;

export type AgentSessionStage =
    | {
          readonly kind: "agent-session";
          readonly purpose: "implement";
      }
    | {
          readonly kind: "agent-session";
          readonly purpose: "address-review";
          readonly context: AgentSessionContext;
          readonly input: "review-decision";
      }
    | {
          readonly kind: "agent-session";
          readonly purpose:
              | "assess-complexity"
              | "assess-grounding"
              | "verify-resolution"
              | "review-diff"
              | "generate-commit-message"
              | "decompose-issue";
          readonly output: StructuredOutputName;
      };