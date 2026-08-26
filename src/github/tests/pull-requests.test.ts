import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import type { Octokit } from "octokit";

import { ReviewVerdict } from "../../issues/decisions.ts";
import {
  GitHubPullRequests,
  GitHubPullRequestsLive,
  reviewAttemptMarker,
} from "../pull-requests.ts";

const service = Effect.runSync(
  Effect.provide(GitHubPullRequests, GitHubPullRequestsLive),
);

const pullRequest = (
  number: number,
  head: string,
  base: string,
  merged = false,
) => ({
  number,
  html_url: `https://github.com/owner/repository/pull/${number}`,
  head: {
    ref: head,
  },
  base: {
    ref: base,
  },
  state: merged ? "closed" : "open",
  merged,
  merged_at: merged ? "2026-08-25T00:00:00Z" : null,
});

const review = (attempt: number) => ({
  attempt,
  sessionID: `review-${attempt}`,
  decision: {
    verdict: ReviewVerdict.Approved,
    summary: `Review ${attempt} approved.`,
    findings: [],
  },
});

describe("GitHub pull requests", () => {
  test("finds an existing pull request by exact head and base", async () => {
    let created = false;
    let request: Record<string, unknown> | undefined;
    const client = {
      rest: {
        pulls: {
          list: Symbol("list"),
          create: async () => {
            created = true;
            return {
              data: pullRequest(99, "feature", "main"),
            };
          },
        },
      },
      paginate: async (
        _method: unknown,
        parameters: Record<string, unknown>,
      ) => {
        request = parameters;
        return [pullRequest(42, "feature", "main")];
      },
    } as unknown as Octokit;

    const result = await service
      .createOrFind(client, "https://github.com/owner/repository.git", {
        title: "Implement feature",
        body: "Implementation details",
        issueNumber: 17,
        head: "feature",
        base: "main",
      })
      .pipe(Effect.runPromise);

    expect(request).toEqual({
      owner: "owner",
      repo: "repository",
      state: "all",
      head: "owner:feature",
      base: "main",
      per_page: 100,
    });
    expect(created).toBeFalse();
    expect(result).toEqual({
      number: 42,
      url: "https://github.com/owner/repository/pull/42",
      merged: false,
    });
  });

  test("creates a pull request with the automatic issue-closing reference", async () => {
    let request: Record<string, unknown> | undefined;
    const client = {
      rest: {
        pulls: {
          list: Symbol("list"),
          create: async (parameters: Record<string, unknown>) => {
            request = parameters;
            return {
              data: pullRequest(43, "feature", "main"),
            };
          },
        },
      },
      paginate: async () => [],
    } as unknown as Octokit;

    await service
      .createOrFind(client, "owner/repository", {
        title: "Implement feature",
        body: "Implementation details",
        issueNumber: 18,
        head: "feature",
        base: "main",
      })
      .pipe(Effect.runPromise);

    expect(request).toEqual({
      owner: "owner",
      repo: "repository",
      title: "Implement feature",
      body: "Implementation details\n\nCloses #18",
      head: "feature",
      base: "main",
    });
  });

  test("publishes review attempts once using deterministic comment markers", async () => {
    const comments: Array<{
      body: string;
    }> = [
      {
        body: `${reviewAttemptMarker(1)}\nold`,
      },
    ];
    const created: Record<string, unknown>[] = [];
    const client = {
      rest: {
        issues: {
          listComments: Symbol("listComments"),
          createComment: async (parameters: Record<string, unknown>) => {
            created.push(parameters);
            comments.push({
              body: String(parameters.body),
            });
            return {
              data: {},
            };
          },
        },
      },
      paginate: async () => comments,
    } as unknown as Octokit;

    await service
      .publishReviewAttempts(client, "owner/repository", 42, [
        review(1),
        review(2),
      ])
      .pipe(Effect.runPromise);
    await service
      .publishReviewAttempts(client, "owner/repository", 42, [
        review(1),
        review(2),
      ])
      .pipe(Effect.runPromise);

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      owner: "owner",
      repo: "repository",
      issue_number: 42,
    });
    expect(created[0]?.body).toContain(reviewAttemptMarker(2));
    expect(created[0]?.body).toContain('"verdict": "approved"');
  });

  test("merges only when necessary and verifies the merged state", async () => {
    let mergeCalls = 0;
    let reads = 0;
    const client = {
      rest: {
        pulls: {
          get: async () => {
            reads += 1;
            return {
              data:
                reads === 1
                  ? pullRequest(44, "feature", "main")
                  : pullRequest(44, "feature", "main", true),
            };
          },
          merge: async () => {
            mergeCalls += 1;
            return {
              data: {
                merged: true,
              },
            };
          },
        },
      },
    } as unknown as Octokit;

    const result = await service
      .merge(client, "owner/repository", 44)
      .pipe(Effect.runPromise);

    expect(mergeCalls).toBe(1);
    expect(result).toEqual({
      number: 44,
      url: "https://github.com/owner/repository/pull/44",
      merged: true,
    });
  });

  test("returns an error when GitHub does not confirm a merge", async () => {
    const client = {
      rest: {
        pulls: {
          get: async () => ({
            data: pullRequest(45, "feature", "main"),
          }),
          merge: async () => ({
            data: {
              merged: false,
            },
          }),
        },
      },
    } as unknown as Octokit;

    const exit = await service
      .merge(client, "owner/repository", 45)
      .pipe(Effect.runPromiseExit);
    expect(Exit.isFailure(exit)).toBeTrue();
  });
});