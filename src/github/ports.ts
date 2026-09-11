import type { Octokit } from "octokit";

import { RalphieError } from "../shared/error.ts";
import type { NeedsAttentionReason } from "../issues/domain/decisions.ts";
import type {
    DecompositionChildrenQuery,
    GitHubDecompositionChild,
    GitHubIssue,
    IssueFilters,
} from "./domain.ts";

/**
 * Opaque GitHub API handle flowing through the core.
 *
 * The SDK type is confined to this port; application code passes the handle
 * to adapters without knowing the concrete client.
 */
export type GitHubApiClient = Octokit;

/** Outbound port for GitHub authentication and client initialization. */
export type GitHubClientService = {
    readonly initialize: () => Promise<GitHubApiClient>;
};

export type GitHubIssuesService = {
    readonly listOpen: (
        client: GitHubApiClient,
        repository: string,
        filters: IssueFilters,
    ) => Promise<ReadonlyArray<GitHubIssue>>;
    readonly refresh: (
        client: GitHubApiClient,
        repository: string,
        issueNumber: number,
    ) => Promise<GitHubIssue>;
    readonly listDecompositionChildren: (
        client: GitHubApiClient,
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
        client: GitHubApiClient,
        repository: string,
        input: CreateGitHubIssueInput,
    ) => Promise<GitHubIssue>;
    readonly update: (
        client: GitHubApiClient,
        repository: string,
        issueNumber: number,
        input: UpdateGitHubIssueInput,
    ) => Promise<GitHubIssue>;
    readonly close: (
        client: GitHubApiClient,
        repository: string,
        issueNumber: number,
        reason: GitHubIssueCloseReason,
    ) => Promise<GitHubIssue>;
};

export type GitHubIssueRelationshipService = {
    /** List the native sub-issues currently attached to an issue. */
    readonly listSubIssues: (
        client: GitHubApiClient,
        repository: string,
        issueNumber: number,
    ) => Promise<ReadonlyArray<GitHubIssue>>;
    /** The native parent of an issue, or `undefined` when it has none. */
    readonly parentOf: (
        client: GitHubApiClient,
        repository: string,
        issueNumber: number,
    ) => Promise<GitHubIssue | undefined>;
    /**
     * Attach a child to a parent as a native sub-issue. Idempotent when the
     * child is already attached to the same parent; a child attached to a
     * different parent fails closed instead of being silently reparented.
     */
    readonly attachSubIssue: (
        client: GitHubApiClient,
        repository: string,
        parentIssueNumber: number,
        childIssueNumber: number,
    ) => Promise<void>;
    /** List the native issues blocking the given issue. */
    readonly listBlockedBy: (
        client: GitHubApiClient,
        repository: string,
        issueNumber: number,
    ) => Promise<ReadonlyArray<GitHubIssue>>;
    /**
     * Add a native `blocked_by` relationship. Idempotent when the dependency
     * already exists.
     */
    readonly addBlockedBy: (
        client: GitHubApiClient,
        repository: string,
        issueNumber: number,
        blockerIssueNumber: number,
    ) => Promise<void>;
};

export type ParentCompletionService = {
    /**
     * Close a decomposed parent as `completed` when every native sub-issue is
     * closed. Returns true when the parent is completed (possibly already),
     * false when it must stay open.
     */
    readonly reconcileParent: (
        client: GitHubApiClient,
        repository: string,
        parentIssueNumber: number,
    ) => Promise<boolean>;
    /**
     * Reconcile the parent of a just-completed child. The parent is resolved
     * from the native sub-issue relationship, falling back to the child's
     * stable decomposition marker.
     */
    readonly reconcileAfterChildCompletion: (
        client: GitHubApiClient,
        repository: string,
        childIssueNumber: number,
        childBody: string | null,
    ) => Promise<boolean>;
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
        client: GitHubApiClient,
        repository: string,
        sourceIssueNumber: number,
        input: NeedsAttentionNotificationInput,
        labelName?: string,
    ) => Promise<NeedsAttentionNotificationResult>;
};