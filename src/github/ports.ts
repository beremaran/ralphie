import { RalphieError } from "../shared/error.ts";
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

/** Outbound port for the user that `gh` is authenticated as. */
export type GitHubViewerService = {
    readonly login: () => Promise<string>;
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
    /** Labels applied at creation. */
    readonly labels?: ReadonlyArray<string>;
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
    /** Post a new comment on an issue. */
    readonly comment: (
        repository: string,
        issueNumber: number,
        body: string,
    ) => Promise<void>;
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

export type GitHubHandOffInput = {
    /** The full comment text; it already starts with the AI disclaimer. */
    readonly body: string;
    /** The triage state label the issue moves to. */
    readonly label: string;
    /** Every triage state label; all but `label` are removed from the issue. */
    readonly replaceLabels: ReadonlyArray<string>;
};

export type GitHubHandOffResult = {
    readonly comment: "created" | "updated" | "unchanged";
};

export type GitHubHandOffService = {
    /**
     * Post the hand-off comment (once per issue, updated when it changed) and
     * replace the issue's triage state label.
     */
    readonly handOff: (
        repository: string,
        issueNumber: number,
        input: GitHubHandOffInput,
    ) => Promise<GitHubHandOffResult>;
};

export type GitHubTriageCommentResult = {
    readonly comment: "created" | "unchanged";
};

/** Posts the comments and label moves AFK triage decides on. */
export type GitHubTriageService = {
    /**
     * Post the Agent Brief as a new comment (a repeat of the same text is a
     * no-op, so a restart never duplicates it) and move the issue to the
     * ready-for-agent state label. `input.body` already starts with the AI
     * disclaimer.
     */
    readonly promote: (
        repository: string,
        issueNumber: number,
        input: GitHubHandOffInput,
    ) => Promise<GitHubTriageCommentResult>;
    /**
     * Post the comment that points to where a request already lives, once.
     * The caller closes the issue afterwards.
     */
    readonly explainImplemented: (
        repository: string,
        issueNumber: number,
        body: string,
    ) => Promise<GitHubTriageCommentResult>;
};