import { IssueStageKind } from "../issues/stage.ts";
import { StructuredOutputName } from "../opencode/session.ts";

export enum GitIssueAction {
  StageAll = "stage-all",
  Commit = "commit",
  Push = "push",
}

export type GitIssueStage = {
  readonly kind: IssueStageKind.GitTask;
  readonly action: GitIssueAction;
  readonly messageFrom?: StructuredOutputName.CommitMessageDecision;
};
