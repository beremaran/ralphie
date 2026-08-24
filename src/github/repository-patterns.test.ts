import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { Octokit } from "octokit";

import {
  GitHubRepositoryPatternsLive,
  parseRepositoryPattern,
  repositoryNameMatchesGlob,
  resolveRepositoryPattern,
} from "./repository-patterns.ts";

describe("GitHub repository patterns", () => {
  test("parses an explicit owner and repository glob", () => {
    expect(parseRepositoryPattern("beremaran/finance-*")).toEqual({
      owner: "beremaran",
      repositoryGlob: "finance-*",
    });
  });

  test.each([
    "beremaran",
    "/repositories",
    "beremaran/",
    "*/repositories",
    "beremaran/repositories/extra",
    "beremaran/repo name",
  ])("rejects malformed pattern %s", (pattern) => {
    expect(() => parseRepositoryPattern(pattern)).toThrow(
      "Expected owner/repository-glob",
    );
  });

  test("matches star and question-mark wildcards", () => {
    expect(repositoryNameMatchesGlob("finance-tracker", "*")).toBe(true);
    expect(repositoryNameMatchesGlob("finance-tracker", "finance-*")).toBe(true);
    expect(repositoryNameMatchesGlob("finance-tracker", "finance-???????")).toBe(true);
    expect(repositoryNameMatchesGlob("financetracker", "finance-*")).toBe(false);
  });

  test("lists all pages, filters by owner, excludes archived repositories, and sorts", async () => {
    const pages = [
      [
        {
          full_name: "beremaran/finance-zeta",
          owner: { login: "beremaran" },
          name: "finance-zeta",
          archived: false,
        },
        {
          full_name: "other/finance-alpha",
          owner: { login: "other" },
          name: "finance-alpha",
          archived: false,
        },
      ],
      [
        {
          full_name: "beremaran/finance-alpha",
          owner: { login: "BEREMARAN" },
          name: "finance-alpha",
          archived: false,
        },
        {
          full_name: "beremaran/finance-archived",
          owner: { login: "beremaran" },
          name: "finance-archived",
          archived: true,
        },
      ],
    ];
    let called = 0;
    const client = {
      rest: { repos: { listForAuthenticatedUser: () => undefined } },
      paginate: async () => {
        called += 1;
        return pages.flat();
      },
    } as unknown as Octokit;

    const result = await Effect.runPromise(
      resolveRepositoryPattern(client, "beremaran/finance-*").pipe(
        Effect.provide(GitHubRepositoryPatternsLive),
      ),
    );

    expect(called).toBe(1);
    expect(result.map(({ slug }) => slug)).toEqual([
      "beremaran/finance-alpha",
      "beremaran/finance-zeta",
    ]);
  });

  test("reports patterns with no active accessible matches", async () => {
    const client = {
      rest: { repos: { listForAuthenticatedUser: () => undefined } },
      paginate: async () => [
        {
          full_name: "beremaran/old-repo",
          owner: { login: "beremaran" },
          name: "old-repo",
          archived: true,
        },
      ],
    } as unknown as Octokit;

    await expect(
      Effect.runPromise(resolveRepositoryPattern(client, "beremaran/old-*")),
    ).rejects.toThrow("matched no accessible, non-archived repositories");
  });
});
