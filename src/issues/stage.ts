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

export const ReviewLoopExhaustion = "escalate-to-decomposition" as const;
export type ReviewLoopExhaustion = typeof ReviewLoopExhaustion;

export const CheckoutRestorePoint = "issue-base" as const;
export type CheckoutRestorePoint = typeof CheckoutRestorePoint;

export const IssueQueueResumeStrategy = "refresh-open-issues" as const;
export type IssueQueueResumeStrategy = typeof IssueQueueResumeStrategy;

export const REVIEW_ITERATION_LIMIT = 5;