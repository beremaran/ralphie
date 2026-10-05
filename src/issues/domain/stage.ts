export const IssueQueueResumeStrategy = "refresh-open-issues" as const;
export type IssueQueueResumeStrategy = typeof IssueQueueResumeStrategy;

export const REVIEW_ITERATION_LIMIT = 5;

/** Upper bound for a configured review budget; also bounds persisted review attempts. */
export const MAX_REVIEW_ROUNDS = 20;
/** Implementation attempts allowed when the issue yields no staged changes. */
export const DEFAULT_IMPLEMENTATION_ATTEMPTS = 3;