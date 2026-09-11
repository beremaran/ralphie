import type { IssueCheckpoint } from "../git/ports.ts";

/** Application-level GitHub parent completion, composed from GitHub ports. */
export type ParentCompletionService = {
    /**
     * Close a decomposed parent as `completed` when every native sub-issue is
     * closed. Returns true when the parent is completed (possibly already),
     * false when it must stay open.
     */
    readonly reconcileParent: (
        repository: string,
        parentIssueNumber: number,
    ) => Promise<boolean>;
    /**
     * Reconcile the parent of a just-completed child. The parent is resolved
     * from the native sub-issue relationship, falling back to the child's
     * stable decomposition marker.
     */
    readonly reconcileAfterChildCompletion: (
        repository: string,
        childIssueNumber: number,
        childBody: string | null,
    ) => Promise<boolean>;
};

export type IssuePreparationInput = {
    readonly issueNumber: number;
    readonly repositoryPath: string;
    readonly branch: string;
    readonly signal?: AbortSignal;
};

export type GitIssuePreparationService = {
    /** Capture and persist the clean issue base before agent work starts. */
    readonly prepare: (
        input: IssuePreparationInput,
    ) => Promise<IssueCheckpoint>;
};