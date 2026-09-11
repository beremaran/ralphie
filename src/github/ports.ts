import { RalphieError } from "../shared/error.ts";
import type { NeedsAttentionReason } from "../issues/domain/decisions.ts";
import type {
    DecompositionChildrenQuery,
    GitHubDecompositionChild,
    GitHubIssue,
    IssueFilters,
} from "./domain.ts";

/** Outbound port for authenticating against GitHub exactly once per run. */
export type GitHubConnectionService = {
    readonly connect: () => Promise<void>;
};

export type GitHubIssuesService = {
    readonly listOpen: (
        repository: string,
        filters: IssueFilters,
    ) => Promise<ReadonlyArray<GitHubIssue>>;
    readonly refresh: (
        repository: string,
        issueNumber: number,
    ) => Promise<GitHubIssue>;
    readonly listDecompositionChildren: (
        repository: string,
        query: DecompositionChildrenQuery,
    ) => Promise<ReadonlyArray<GitHubDecompositionChild>>;
};

/** Reasons accepted by GitHub when closing an issue. */
export type GitHubIssueCloseReason = "completed" | "not_planned" | "duplicate";

export const GitHubMutationRecoveryOutcome = "recovery-required" as const;
export type GitHubMutationRecoveryOutcome =
    typeof GitHubMutationRecoveryOutcome;

/** A mutation may have reached GitHub even though its response was lost. */
export class GitHubMutationRecoveryError extends RalphieError {
    readonly outcome = GitHubMutationRecoveryOutcome;
    readonly operation: string;

    constructor(input: {
        readonly message: string;
        readonly operation: string;
        readonly cause?: unknown;
    }) {
        super(input);
        this.name = "GitHubMutationRecoveryError";
        this.operation = input.operation;
    }
}

export type CreateGitHubIssueInput = {
    readonly title: string;
    readonly body: string;
};

export type UpdateGitHubIssueInput = {
    readonly title?: string;
    readonly body?: string;
};

export type GitHubIssueMutationService = {
    readonly create: (
        repository: string,
        input: CreateGitHubIssueInput,
    ) => Promise<GitHubIssue>;
    readonly update: (
        repository: string,
        issueNumber: number,
        input: UpdateGitHubIssueInput,
    ) => Promise<GitHubIssue>;
    readonly close: (
        repository: string,
        issueNumber: number,
        reason: GitHubIssueCloseReason,
    ) => Promise<GitHubIssue>;
};

export type GitHubIssueRelationshipService = {
    /** List the native sub-issues currently attached to an issue. */
    readonly listSubIssues: (
        repository: string,
        issueNumber: number,
    ) => Promise<ReadonlyArray<GitHubIssue>>;
    /** The native parent of an issue, or `undefined` when it has none. */
    readonly parentOf: (
        repository: string,
        issueNumber: number,
    ) => Promise<GitHubIssue | undefined>;
    /**
     * Attach a child to a parent as a native sub-issue. Idempotent when the
     * child is already attached to the same parent; a child attached to a
     * different parent fails closed instead of being silently reparented.
     */
    readonly attachSubIssue: (
        repository: string,
        parentIssueNumber: number,
        childIssueNumber: number,
    ) => Promise<void>;
    /** List the native issues blocking the given issue. */
    readonly listBlockedBy: (
        repository: string,
        issueNumber: number,
    ) => Promise<ReadonlyArray<GitHubIssue>>;
    /**
     * Add a native `blocked_by` relationship. Idempotent when the dependency
     * already exists.
     */
    readonly addBlockedBy: (
        repository: string,
        issueNumber: number,
        blockerIssueNumber: number,
    ) => Promise<void>;
};

export type NeedsAttentionNotificationInput = {
    readonly reason: NeedsAttentionReason;
    readonly summary: string;
    readonly evidence: ReadonlyArray<string>;
    readonly questions: ReadonlyArray<string>;
    readonly labelName?: string;
};

export type NeedsAttentionNotificationResult = {
    readonly comment: "created" | "updated" | "unchanged";
    readonly label: "applied" | "not-configured";
};

export type GitHubNeedsAttentionNotificationService = {
    readonly notify: (
        repository: string,
        sourceIssueNumber: number,
        input: NeedsAttentionNotificationInput,
        labelName?: string,
    ) => Promise<NeedsAttentionNotificationResult>;
};