import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import type { Octokit } from "octokit";

import {
  GitHubIssueCloseReason,
  GitHubIssueMutations,
  GitHubIssueMutationsLive,
} from "./issue-mutations.ts";

const mutations = Effect.runSync(
  Effect.provide(GitHubIssueMutations, GitHubIssueMutationsLive),
);

const runMutation = <T, E>(
  operation: (
    mutations: typeof GitHubIssueMutations.Service,
  ) => Effect.Effect<T, E>,
) => operation(mutations);

const issueResponse = (number: number, title: string, body: string | null) => ({
  data: {
    number,
    title,
    html_url: `https://github.com/owner/repository/issues/${number}`,
    body,
    labels: [{ name: "bug" }],
  },
});

describe("GitHub issue mutations", () => {
  test("creates an issue through Octokit using the normalized repository", async () => {
    let request: Record<string, unknown> | undefined;
    const client = {
      rest: {
        issues: {
          create: async (parameters: Record<string, unknown>) => {
            request = parameters;
            return issueResponse(31, "Child issue", "Child body");
          },
          update: async () => issueResponse(31, "Child issue", "Child body"),
        },
      },
    } as unknown as Octokit;

    const issue = await runMutation((mutations) =>
      mutations.create(client, "https://github.com/owner/repository.git", {
        title: "Child issue",
        body: "Child body",
      }),
    ).pipe(Effect.runPromise);

    expect(request).toEqual({
      owner: "owner",
      repo: "repository",
      title: "Child issue",
      body: "Child body",
    });
    expect(issue).toEqual({
      number: 31,
      title: "Child issue",
      url: "https://github.com/owner/repository/issues/31",
      body: "Child body",
      labels: ["bug"],
    });
  });

  test("updates title and body through Octokit", async () => {
    let request: Record<string, unknown> | undefined;
    const client = {
      rest: {
        issues: {
          create: async () => issueResponse(32, "Issue", "Body"),
          update: async (parameters: Record<string, unknown>) => {
            request = parameters;
            return issueResponse(32, "Updated title", "Updated body");
          },
        },
      },
    } as unknown as Octokit;

    await runMutation((mutations) =>
      mutations.update(client, "owner/repository", 32, {
        title: "Updated title",
        body: "Updated body",
      }),
    ).pipe(Effect.runPromise);

    expect(request).toEqual({
      owner: "owner",
      repo: "repository",
      issue_number: 32,
      title: "Updated title",
      body: "Updated body",
    });
  });

  test("closes an issue with the typed duplicate reason", async () => {
    let request: Record<string, unknown> | undefined;
    const client = {
      rest: {
        issues: {
          create: async () => issueResponse(33, "Issue", "Body"),
          update: async (parameters: Record<string, unknown>) => {
            request = parameters;
            return issueResponse(33, "Issue", "Body");
          },
        },
      },
    } as unknown as Octokit;

    await runMutation((mutations) =>
      mutations.close(
        client,
        "git@github.com:owner/repository.git",
        33,
        GitHubIssueCloseReason.Duplicate,
      ),
    ).pipe(Effect.runPromise);

    expect(request).toEqual({
      owner: "owner",
      repo: "repository",
      issue_number: 33,
      state: "closed",
      state_reason: "duplicate",
    });
  });

  test("maps Octokit failures into RalphieError", async () => {
    const client = {
      rest: {
        issues: {
          create: async () => {
            throw new Error("network failed");
          },
          update: async () => issueResponse(34, "Issue", "Body"),
        },
      },
    } as unknown as Octokit;

    const exit = await runMutation((mutations) =>
      mutations.create(client, "owner/repository", {
        title: "Issue",
        body: "Body",
      }),
    ).pipe(Effect.runPromiseExit);

    expect(Exit.isFailure(exit)).toBeTrue();
  });
});
