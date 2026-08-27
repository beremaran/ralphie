import { IssueStageKind } from "../issues/stage.ts";
import { StructuredOutputName } from "../agent/session.ts";

export enum GitIssueAction {
    CaptureIssueBase = "capture-issue-base",
    StageAll = "stage-all",
    Commit = "commit",
    Push = "push",
}

export const GitIssueOutput = "issue-base" as const;
export type GitIssueOutput = typeof GitIssueOutput;

export type GitIssueStage =
    | {
          readonly kind: IssueStageKind.GitTask;
          readonly action: GitIssueAction.CaptureIssueBase;
          readonly output: GitIssueOutput;
      }
    | {
          readonly kind: IssueStageKind.GitTask;
          readonly action: GitIssueAction.StageAll | GitIssueAction.Push;
      }
    | {
          readonly kind: IssueStageKind.GitTask;
          readonly action: GitIssueAction.Commit;
          readonly messageFrom: StructuredOutputName.CommitMessageDecision;
      };