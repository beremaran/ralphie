import { Context, Effect, Layer } from "effect";
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
  ) => Effect.Effect<ReadonlyArray<GitHubIssue>, RalphieError>;
  readonly listDecompositionChildren: (
    client: Octokit,
    repository: string,
    query: DecompositionChildrenQuery,
  ) => Effect.Effect<ReadonlyArray<GitHubDecompositionChild>, RalphieError>;
};

export const GitHubIssues =
  Context.GenericTag<GitHubIssuesService>("ralphie/GitHubIssues");

export const GitHubIssuesLive = Layer.succeed(GitHubIssues, {
  listOpen: (client, repository, filters) =>
    Effect.tryPromise({
      try: async () => {
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
            labels: issue.labels.flatMap((label) =>
              typeof label === "string" ? [label] : label.name ? [label.name] : [],
            ),
          }));
      },
      catch: (cause) =>
        cause instanceof RalphieError
          ? cause
          : new RalphieError({
              message: `Failed to fetch open issues for ${repository}.`,
              cause,
      }),
    }),

  listDecompositionChildren: (client, repository, query) =>
    Effect.tryPromise({
      try: async () => {
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
          if (typeof decompositionKey !== "string" || decompositionKey.length === 0) {
            return [];
          }

          return [
            {
              number: issue.number,
              title: issue.title,
              url: issue.html_url,
              body,
              labels: issue.labels.flatMap((label) =>
                typeof label === "string" ? [label] : label.name ? [label.name] : [],
              ),
              decompositionKey,
            },
          ];
        });
      },
      catch: (cause) =>
        cause instanceof RalphieError
          ? cause
          : new RalphieError({
              message: `Failed to discover decomposed child issues for ${repository}.`,
              cause,
            }),
    }),
});
