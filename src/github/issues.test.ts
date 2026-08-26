import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import type { Octokit } from "octokit";

import {
  GitHubIssues,
  GitHubIssuesLive,
  IssueOrder,
  IssueSort,
} from "./issues.ts";

const listOpen = (client: Octokit, labels: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    const issues = yield* GitHubIssues;
    return yield* issues.listOpen(client, "owner/repository", {
      labels,
      sort: IssueSort.Created,
      order: IssueOrder.Ascending,
    });
  }).pipe(Effect.provide(GitHubIssuesLive));

describe("GitHub issues", () => {
  test("paginates, applies filters, and excludes pull requests", async () => {
    let request: Record<string, unknown> | undefined;
    const client = {
      rest: {
        issues: {
          listForRepo: Symbol("listForRepo"),
        },
      },
      paginate: async (
        _method: unknown,
        parameters: Record<string, unknown>,
      ) => {
        request = parameters;
        return [
          {
            number: 12,
            title: "First issue",
            html_url: "https://github.com/owner/repository/issues/12",
            body: "Issue body",
            labels: [
              "bug",
              {
                name: "priority",
              },
              {
                name: null,
              },
            ],
          },
          {
            number: 13,
            title: "A pull request",
            html_url: "https://github.com/owner/repository/pull/13",
            pull_request: {},
          },
        ];
      },
    } as unknown as Octokit;

    const issues = await listOpen(client, ["bug", "priority"]).pipe(
      Effect.runPromise,
    );

    expect(request).toEqual({
      owner: "owner",
      repo: "repository",
      state: "open",
      sort: IssueSort.Created,
      direction: IssueOrder.Ascending,
      per_page: 100,
      labels: "bug,priority",
    });
    expect(issues).toEqual([
      {
        number: 12,
        title: "First issue",
        url: "https://github.com/owner/repository/issues/12",
        body: "Issue body",
        labels: ["bug", "priority"],
      },
    ]);
  });

  test("maps GitHub failures into the domain error", async () => {
    const client = {
      rest: {
        issues: {
          listForRepo: Symbol("listForRepo"),
        },
      },
      paginate: async () => {
        throw new Error("network failed");
      },
    } as unknown as Octokit;

    const exit = await listOpen(client).pipe(Effect.runPromiseExit);

    expect(Exit.isFailure(exit)).toBeTrue();
  });
});