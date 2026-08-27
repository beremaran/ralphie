export type IssueStageKind =
    | "git-task"
    | "github-task"
    | "pi-session"
    | "review-loop";

export type IssueWorkflowKind = "implementation" | "decomposition";

export const ReviewLoopExhaustion = "escalate-to-decomposition" as const;
export type ReviewLoopExhaustion = typeof ReviewLoopExhaustion;

export const CheckoutRestorePoint = "issue-base" as const;
export type CheckoutRestorePoint = typeof CheckoutRestorePoint;

export const IssueQueueResumeStrategy = "refresh-open-issues" as const;
export type IssueQueueResumeStrategy = typeof IssueQueueResumeStrategy;

export const REVIEW_ITERATION_LIMIT = 5;