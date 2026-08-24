export enum IssueStageKind {
  GitTask = "git-task",
  GitHubTask = "github-task",
  OpenCodeSession = "opencode-session",
  ReviewLoop = "review-loop",
}

export enum IssueWorkflowKind {
  Implementation = "implementation",
  Decomposition = "decomposition",
}

export enum ReviewLoopExhaustion {
  Fail = "fail",
}
