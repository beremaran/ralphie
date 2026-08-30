import type { Octokit } from "octokit";

import { RalphieError } from "../shared/error.ts";
import { parseRepositorySlug } from "./repository.ts";

export type DecompositionChildrenQuery = {
    readonly rootIssueNumber: number;
    readonly parentIssueNumber: number;
    readonly depth: number;
};

export type GitHubDecompositionChild = GitHubIssue & {
    readonly decompositionKey: string;
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

export type GitHubIssuesService = {
    readonly listOpen: (
        client: Octokit,
        repository: string,
        filters: IssueFilters,
    ) => Promise<ReadonlyArray<GitHubIssue>>;
    readonly refresh: (
        client: Octokit,
        repository: string,
        issueNumber: number,
    ) => Promise<GitHubIssue>;
    readonly listDecompositionChildren: (
        client: Octokit,
        repository: string,
        query: DecompositionChildrenQuery,
    ) => Promise<ReadonlyArray<GitHubDecompositionChild>>;
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

const issueLabels = (
    labels: ReadonlyArray<
        | string
        | {
              readonly name?: string | null;
          }
    > = [],
): string[] =>
    labels.flatMap((label) =>
        typeof label === "string" ? [label] : label.name ? [label.name] : [],
    );

export type GitHubIssueRecord = {
    readonly number: number;
    readonly title: string;
    readonly html_url: string;
    readonly body?: string | null;
    readonly state?: string;
    readonly updated_at?: string;
    readonly comments?: number;
    readonly pull_request?: unknown;
    readonly labels?: ReadonlyArray<
        | string
        | {
              readonly name?: string | null;
          }
    >;
};

type GitHubIssueCommentRecord = {
    readonly id: number;
    readonly body?: string | null;
    readonly updated_at: string;
};

const issueState = (state: string | undefined): GitHubIssueState => {
    if (state === "open" || state === "closed") return state;
    throw new RalphieError({
        message: `GitHub returned an unsupported issue state: ${state ?? "missing"}.`,
    });
};

const isoTimestamp = (value: string | undefined): string | undefined => {
    if (
        value !== undefined &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
            value,
        ) &&
        !Number.isNaN(Date.parse(value))
    ) {
        return value;
    }
    return undefined;
};

const issueUpdatedAt = (updatedAt: string | undefined): string => {
    const timestamp = isoTimestamp(updatedAt);
    if (timestamp !== undefined) return timestamp;
    throw new RalphieError({
        message: "GitHub returned an issue without a valid updated timestamp.",
    });
};

const truncateCommentBody = (body: string): string => {
    if (body.length <= MAX_ISSUE_COMMENT_BODY_LENGTH) return body;

    const marker = "\n...[issue comment body truncated]...\n";
    const available = Math.max(
        0,
        MAX_ISSUE_COMMENT_BODY_LENGTH - marker.length,
    );
    const headLength = Math.ceil(available / 2);
    const tailLength = available - headLength;
    return `${body.slice(0, headLength)}${marker}${tailLength > 0 ? body.slice(-tailLength) : ""}`;
};

const latestCommentUpdatedAt = (
    comments: ReadonlyArray<GitHubIssueCommentRecord>,
): string | undefined =>
    comments.reduce<string | undefined>((latest, comment) => {
        const updatedAt = issueUpdatedAt(comment.updated_at);
        return latest === undefined ||
            Date.parse(updatedAt) > Date.parse(latest)
            ? updatedAt
            : latest;
    }, undefined);

const mapIssueComments = (
    comments: ReadonlyArray<GitHubIssueCommentRecord>,
): {
    readonly comments: ReadonlyArray<GitHubIssueComment>;
    readonly commentVersion: string;
} => {
    const boundedComments = comments
        .slice(-MAX_ISSUE_COMMENTS)
        .map((comment) => ({
            id: comment.id,
            body: truncateCommentBody(comment.body ?? ""),
            updatedAt: issueUpdatedAt(comment.updated_at),
        }));
    return {
        comments: boundedComments,
        commentVersion: latestCommentUpdatedAt(comments) ?? "",
    };
};

export const mapGitHubIssue = (
    issue: GitHubIssueRecord,
    rawComments: ReadonlyArray<GitHubIssueCommentRecord> = [],
): GitHubIssue => {
    const updatedAt = issueUpdatedAt(issue.updated_at);
    const mappedComments = mapIssueComments(rawComments);
    return {
        number: issue.number,
        title: issue.title,
        url: issue.html_url,
        body: issue.body ?? null,
        labels: issueLabels(issue.labels),
        state: issueState(issue.state),
        updatedAt,
        comments: mappedComments.comments,
        commentCount: issue.comments ?? rawComments.length,
        commentVersion: mappedComments.commentVersion || updatedAt,
    };
};

const repositoryParameters = (repository: string) => {
    const { owner, name } = parseRepositorySlug(repository);
    return { owner, repo: name };
};

const readIssueComments = async (
    client: Octokit,
    parameters: ReturnType<typeof repositoryParameters> & {
        readonly issue_number: number;
    },
): Promise<ReadonlyArray<GitHubIssueCommentRecord>> => {
    // Keeping this guard makes lightweight Octokit test doubles and older
    // callers that only expose issue listing remain usable. Real Octokit
    // clients always provide listComments.
    if (client.rest.issues.listComments === undefined) return [];
    return client.paginate(client.rest.issues.listComments, {
        ...parameters,
        per_page: 100,
    });
};

type ParsedDecompositionMarker = {
    readonly body: string;
    readonly decompositionKey: string;
};

const parseDecompositionMarker = (
    issue: GitHubIssueRecord,
    query: DecompositionChildrenQuery,
    markerPattern: RegExp,
): ParsedDecompositionMarker | undefined => {
    const body = issue.body;
    if (issue.pull_request || body == null) return undefined;

    const marker = body.match(markerPattern);
    if (marker === null) return undefined;
    const rootIssueNumber = Number(marker[1]);
    const parentIssueNumber = Number(marker[2]);
    const depth = Number(marker[4]);
    if (
        rootIssueNumber !== query.rootIssueNumber ||
        parentIssueNumber !== query.parentIssueNumber ||
        depth !== query.depth
    ) {
        return undefined;
    }

    try {
        const decompositionKey = JSON.parse(marker[3]!);
        return typeof decompositionKey === "string" &&
            decompositionKey.length > 0
            ? { body, decompositionKey }
            : undefined;
    } catch {
        return undefined;
    }
};

const mapDecompositionChild = (
    issue: GitHubIssueRecord,
    query: DecompositionChildrenQuery,
    markerPattern: RegExp,
): ReadonlyArray<GitHubDecompositionChild> => {
    const marker = parseDecompositionMarker(issue, query, markerPattern);
    if (marker === undefined) return [];

    return [
        {
            ...mapGitHubIssue(issue),
            body: marker.body,
            decompositionKey: marker.decompositionKey,
        },
    ];
};

export const makeGitHubIssuesService = (): GitHubIssuesService => ({
    listOpen: async (client, repository, filters) => {
        try {
            const { owner, repo } = repositoryParameters(repository);
            const data = await client.paginate(client.rest.issues.listForRepo, {
                owner,
                repo,
                state: "open",
                sort: filters.sort,
                direction: filters.order,
                per_page: 100,
                ...(filters.labels.length > 0
                    ? { labels: filters.labels.join(",") }
                    : {}),
            });
            const issues = data.filter((issue) => !issue.pull_request);
            return Promise.all(
                issues.map(async (issue) => {
                    const comments = await readIssueComments(client, {
                        owner,
                        repo,
                        issue_number: issue.number,
                    });
                    return mapGitHubIssue(issue, comments);
                }),
            );
        } catch (cause) {
            if (cause instanceof RalphieError) throw cause;
            throw new RalphieError({
                message: `Failed to fetch open issues for ${repository}.`,
                cause,
            });
        }
    },

    refresh: async (client, repository, issueNumber) => {
        try {
            const parameters = {
                ...repositoryParameters(repository),
                issue_number: issueNumber,
            };
            const response = await client.rest.issues.get(parameters);
            if (response.data.pull_request) {
                throw new RalphieError({
                    message: `Issue #${issueNumber} in ${repository} is a pull request.`,
                });
            }
            const comments = await readIssueComments(client, parameters);
            return mapGitHubIssue(response.data, comments);
        } catch (cause) {
            if (cause instanceof RalphieError) throw cause;
            throw new RalphieError({
                message: `Failed to refresh issue #${issueNumber} for ${repository}.`,
                cause,
            });
        }
    },

    listDecompositionChildren: async (client, repository, query) => {
        try {
            const { owner, repo } = repositoryParameters(repository);
            const data = await client.paginate(client.rest.issues.listForRepo, {
                owner,
                repo,
                state: "all",
                per_page: 100,
            });

            const markerPattern =
                /<!-- ralphie:decomposition root=(\d+) parent=(\d+) key=("(?:\\.|[^"\\])*") depth=(\d+) -->/;
            return data.flatMap((issue) =>
                mapDecompositionChild(issue, query, markerPattern),
            );
        } catch (cause) {
            if (cause instanceof RalphieError) throw cause;
            throw new RalphieError({
                message: `Failed to discover decomposed child issues for ${repository}.`,
                cause,
            });
        }
    },
});

export const GitHubIssuesLive = makeGitHubIssuesService;