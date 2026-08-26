import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import type { Octokit } from "octokit";

import {
  GitHubIssueCloseReason,
  GitHubIssueMutations,
  GitHubIssueMutationsLive,
} from "../../src/github/issue-mutations.ts";

const mutations = Effect.runSync(
  Effect.provide(GitHubIssueMutations, GitHubIssueMutationsLive),
);

const runMutation = <T, E>(
  operation: (
    mutations: typeof GitHubIssueMutations.Service,
  ) => Effect.Effect<T, E>,
) => operation(mutations);

const issueResponse = (
  number: number,
  title: string,
  body: string | null,
  state = "open",
  stateReason: string | null = null,
) => ({
  data: {
    number,
    title,
    html_url: `https://github.com/owner/repository/issues/${number}`,
    body,
    labels: [
      {
        name: "bug",
      },
    ],
    state,
    state_reason: stateReason,
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
    let state = "open";
    let stateReason: string | null = null;
    const client = {
      rest: {
        issues: {
          create: async () => issueResponse(33, "Issue", "Body"),
          get: async () =>
            issueResponse(33, "Issue", "Body", state, stateReason),
          update: async (parameters: Record<string, unknown>) => {
            request = parameters;
            state = "closed";
            stateReason = GitHubIssueCloseReason.Duplicate;
            return issueResponse(33, "Issue", "Body", state, stateReason);
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

  test("treats an issue already closed for the requested reason as success", async () => {
    let updated = false;
    const client = {
      rest: {
        issues: {
          get: async () =>
            issueResponse(
              34,
              "Issue",
              "Body",
              "closed",
              GitHubIssueCloseReason.Completed,
            ),
          update: async () => {
            updated = true;
            return issueResponse(34, "Issue", "Body");
          },
        },
      },
    } as unknown as Octokit;

    const issue = await runMutation((mutations) =>
      mutations.close(
        client,
        "owner/repository",
        34,
        GitHubIssueCloseReason.Completed,
      ),
    ).pipe(Effect.runPromise);

    expect(issue.number).toBe(34);
    expect(updated).toBeFalse();
  });

  test("reconciles a lost close response from authoritative issue state", async () => {
    let reads = 0;
    const client = {
      rest: {
        issues: {
          get: async () => {
            reads += 1;
            return reads === 1
              ? issueResponse(35, "Issue", "Body")
              : issueResponse(
                  35,
                  "Issue",
                  "Body",
                  "closed",
                  GitHubIssueCloseReason.Completed,
                );
          },
          update: async () => {
            throw new Error("response lost");
          },
        },
      },
    } as unknown as Octokit;

    const issue = await runMutation((mutations) =>
      mutations.close(
        client,
        "owner/repository",
        35,
        GitHubIssueCloseReason.Completed,
      ),
    ).pipe(Effect.runPromise);

    expect(issue.number).toBe(35);
    expect(reads).toBe(2);
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