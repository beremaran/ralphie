import { Context, Effect, Layer } from "effect";
import type { Octokit } from "octokit";

import { RalphieError } from "../shared/error.ts";
import { parseRepositorySlug } from "./repository.ts";

export const issueSortValues = ["created", "updated", "comments"] as const;
export const issueOrderValues = ["asc", "desc"] as const;

export type IssueSort = (typeof issueSortValues)[number];
export type IssueOrder = (typeof issueOrderValues)[number];

export type IssueFilters = {
  readonly labels: ReadonlyArray<string>;
  readonly sort: IssueSort;
  readonly order: IssueOrder;
};

export type GitHubIssue = {
  readonly number: number;
  readonly title: string;
  readonly url: string;
};

export type GitHubIssuesService = {
  readonly listOpen: (
    client: Octokit,
    repository: string,
    filters: IssueFilters,
  ) => Effect.Effect<ReadonlyArray<GitHubIssue>, RalphieError>;
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
});
