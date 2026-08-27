export enum IssueStageKind {
    GitTask = "git-task",
    GitHubTask = "github-task",
    PiSession = "pi-session",
    ReviewLoop = "review-loop",
}

export enum IssueWorkflowKind {
    Implementation = "implementation",
    Decomposition = "decomposition",
}

export enum ReviewLoopExhaustion {
    EscalateToDecomposition = "escalate-to-decomposition",
}

export enum CheckoutRestorePoint {
    IssueBase = "issue-base",
}

export enum IssueQueueResumeStrategy {
    RefreshOpenIssues = "refresh-open-issues",
}

export const REVIEW_ITERATION_LIMIT = 5;