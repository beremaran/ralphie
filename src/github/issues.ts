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

export type GitHubIssue = {
    readonly number: number;
    readonly title: string;
    readonly url: string;
    readonly body: string | null;
    readonly labels: ReadonlyArray<string>;
};

export type GitHubIssuesService = {
    readonly listOpen: (
        client: Octokit,
        repository: string,
        filters: IssueFilters,
    ) => Promise<ReadonlyArray<GitHubIssue>>;
    readonly listDecompositionChildren: (
        client: Octokit,
        repository: string,
        query: DecompositionChildrenQuery,
    ) => Promise<ReadonlyArray<GitHubDecompositionChild>>;
};

const issueLabels = (
    labels: ReadonlyArray<
        | string
        | {
              readonly name?: string | null;
          }
    >,
): string[] =>
    labels.flatMap((label) =>
        typeof label === "string" ? [label] : label.name ? [label.name] : [],
    );

export const makeGitHubIssuesService = (): GitHubIssuesService => ({
    listOpen: async (client, repository, filters) => {
        try {
            const { slug } = parseRepositorySlug(repository);
            const [owner, repo] = slug.split("/") as [string, string];
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

            return data
                .filter((issue) => !issue.pull_request)
                .map((issue) => ({
                    number: issue.number,
                    title: issue.title,
                    url: issue.html_url,
                    body: issue.body ?? null,
                    labels: issueLabels(issue.labels),
                }));
        } catch (cause) {
            if (cause instanceof RalphieError) throw cause;
            throw new RalphieError({
                message: `Failed to fetch open issues for ${repository}.`,
                cause,
            });
        }
    },

    listDecompositionChildren: async (client, repository, query) => {
        try {
            const { slug } = parseRepositorySlug(repository);
            const [owner, repo] = slug.split("/") as [string, string];
            const data = await client.paginate(client.rest.issues.listForRepo, {
                owner,
                repo,
                state: "all",
                per_page: 100,
            });

            const markerPattern =
                /<!-- ralphie:decomposition root=(\d+) parent=(\d+) key=("(?:\\.|[^"\\])*") depth=(\d+) -->/;
            return data.flatMap((issue) => {
                const body = issue.body;
                if (issue.pull_request || body == null) return [];
                const marker = body.match(markerPattern);
                if (marker === null) return [];
                const rootIssueNumber = Number(marker[1]);
                const parentIssueNumber = Number(marker[2]);
                const depth = Number(marker[4]);
                if (
                    rootIssueNumber !== query.rootIssueNumber ||
                    parentIssueNumber !== query.parentIssueNumber ||
                    depth !== query.depth
                ) {
                    return [];
                }

                let decompositionKey: unknown;
                try {
                    decompositionKey = JSON.parse(marker[3]!);
                } catch {
                    return [];
                }
                if (
                    typeof decompositionKey !== "string" ||
                    decompositionKey.length === 0
                ) {
                    return [];
                }

                return [
                    {
                        number: issue.number,
                        title: issue.title,
                        url: issue.html_url,
                        body,
                        labels: issueLabels(issue.labels),
                        decompositionKey,
                    },
                ];
            });
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