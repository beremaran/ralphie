import { IssueStageKind } from "../issues/stage.ts";
import { StructuredOutputName } from "../opencode/session.ts";

export enum GitIssueAction {
  CaptureIssueBase = "capture-issue-base",
  StageAll = "stage-all",
  Commit = "commit",
  Push = "push",
}

export enum GitIssueOutput {
  IssueBase = "issue-base",
}

export type GitIssueStage =
  | {
      readonly kind: IssueStageKind.GitTask;
      readonly action: GitIssueAction.CaptureIssueBase;
      readonly output: GitIssueOutput.IssueBase;
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
