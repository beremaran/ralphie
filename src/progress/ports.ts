/**
 * Domain-facing progress contract.
 *
 * Execution code (workflow, issue executors, agent sessions) depends only on
 * this module. It contains no rendering, terminal, or persistence concerns;
 * presentation adapters under `src/progress/` implement the contract and own
 * every formatting decision.
 */

export type ProgressStage =
    | "run"
    | "workspace-preparation"
    | "workspace-cleanup"
    | "github-authentication"
    | "git-verification"
    | "remote-safety"
    | "repository-discovery"
    | "repository-preparation"
    | "issue-discovery"
    | "agent-runtime"
    | "issue-planning"
    | "issue-execution"
    | "issue-queue"
    | "grounding"
    | "issue-grounding"
    | "complexity-assessment"
    | "implementation"
    | "change-staging"
    | "verification"
    | "verification-fix"
    | "resolution-verification"
    | "review"
    | "review-fix"
    | "review-exhaustion"
    | "checkout-restore"
    | "commit-message"
    | "commit"
    | "push"
    | "decomposition"
    | "issue-creation"
    | "issue-relationships"
    | "issue-closure"
    | "pr-gate"
    | "notification";

export type ProgressStatus =
    | "started"
    | "succeeded"
    | "failed"
    | "skipped"
    | "needs-attention"
    | "info";

export type ProgressIssue = {
    readonly number: number;
    readonly title: string;
};

/** One workflow progress update as reported by execution code. */
export type ProgressUpdate = {
    readonly stage: ProgressStage;
    readonly status: ProgressStatus;
    readonly message: string;
    readonly repository?: string;
    readonly issue?: ProgressIssue;
    readonly current?: number;
    readonly total?: number;
    readonly attempt?: number;
    readonly maxAttempts?: number;
    readonly details?: Readonly<Record<string, unknown>>;
};

/** A progress update stamped with run identity for audit and JSON output. */
export type ProgressEvent = ProgressUpdate & {
    readonly runId: string;
    readonly timestamp: string;
};

/** The execution-side port: report progress; rendering is an implementation detail. */
export type ProgressReporterService = {
    readonly emit: (update: ProgressUpdate) => Promise<void>;
};