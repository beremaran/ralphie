export type DecompositionChildrenQuery = {
    readonly rootIssueNumber: number;
    readonly parentIssueNumber: number;
    readonly depth: number;
};

export enum IssueSort {
    Created = "created",
    Updated = "updated",
    Comments = "comments",
}

export enum IssueOrder {
    Ascending = "asc",
    Descending = "desc",
}

export type IssueFilters = {
    readonly labels: ReadonlyArray<string>;
    readonly sort: IssueSort;
    readonly order: IssueOrder;
};

/** The largest number of comments retained in a live issue snapshot. */
export const MAX_ISSUE_COMMENTS = 20;

/** The largest body retained for any comment in a live issue snapshot. */
export const MAX_ISSUE_COMMENT_BODY_LENGTH = 4_000;

export type GitHubIssueState = "open" | "closed";

export type GitHubIssueComment = {
    readonly id: number;
    readonly body: string;
    readonly updatedAt: string;
};

export type GitHubIssue = {
    readonly number: number;
    readonly title: string;
    readonly url: string;
    readonly body: string | null;
    readonly labels: ReadonlyArray<string>;
    /** Present on all snapshots returned by the live issues service. */
    readonly state?: GitHubIssueState;
    /** Present on all snapshots returned by the live issues service. */
    readonly updatedAt?: string;
    /** Bounded comments from the comments endpoint. */
    readonly comments?: ReadonlyArray<GitHubIssueComment>;
    /** Present on all snapshots returned by the live issues service. */
    readonly commentCount?: number;
    /** The latest comment update timestamp, or the issue timestamp when empty. */
    readonly commentVersion?: string;
};

export type GitHubDecompositionChild = GitHubIssue & {
    readonly decompositionKey: string;
};

const normalizedLabel = (label: string): string => label.toLowerCase();

/** Apply the same all-label, open-state contract used for configured discovery. */
export const isIssueEligible = (
    issue: GitHubIssue,
    filters: IssueFilters,
): boolean => {
    if (issue.state !== "open") return false;
    const labels = new Set(issue.labels.map(normalizedLabel));
    return filters.labels.every((label) => labels.has(normalizedLabel(label)));
};