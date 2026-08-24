import { Context, Effect, Layer } from "effect";
import type { Octokit } from "octokit";

import { RalphieError } from "../shared/error.ts";
import type { GitHubIssue } from "./issues.ts";
import { parseRepositorySlug } from "./repository.ts";

/** Reasons accepted by GitHub when closing an issue. */
export enum GitHubIssueCloseReason {
  Completed = "completed",
  NotPlanned = "not_planned",
  Duplicate = "duplicate",
}

export enum GitHubMutationRecoveryOutcome {
  RecoveryRequired = "recovery-required",
}

/** A mutation may have reached GitHub even though its response was lost. */
export class GitHubMutationRecoveryError extends RalphieError {
  readonly outcome = GitHubMutationRecoveryOutcome.RecoveryRequired;
  readonly operation: string;

  constructor(input: {
    readonly message: string;
    readonly operation: string;
    readonly cause?: unknown;
  }) {
    super(input);
    this.operation = input.operation;
  }
}

export type CreateGitHubIssueInput = {
  readonly title: string;
  readonly body: string;
};

export type UpdateGitHubIssueInput = {
  readonly title?: string;
  readonly body?: string;
};

export type GitHubIssueMutationService = {
  readonly create: (
    client: Octokit,
    repository: string,
    input: CreateGitHubIssueInput,
  ) => Effect.Effect<GitHubIssue, RalphieError>;
  readonly update: (
    client: Octokit,
    repository: string,
    issueNumber: number,
    input: UpdateGitHubIssueInput,
  ) => Effect.Effect<GitHubIssue, RalphieError>;
  readonly close: (
    client: Octokit,
    repository: string,
    issueNumber: number,
    reason: GitHubIssueCloseReason,
  ) => Effect.Effect<GitHubIssue, RalphieError>;
};

export const GitHubIssueMutations =
  Context.GenericTag<GitHubIssueMutationService>(
    "ralphie/GitHubIssueMutations",
  );

const mapIssue = (issue: {
  readonly number: number;
  readonly title: string;
  readonly html_url: string;
  readonly body?: string | null;
  readonly labels?: ReadonlyArray<string | { readonly name?: string | null }>;
}): GitHubIssue => ({
  number: issue.number,
  title: issue.title,
  url: issue.html_url,
  body: issue.body ?? null,
  labels:
    issue.labels?.flatMap((label) => {
      if (typeof label === "string") return [label];
      return label.name ? [label.name] : [];
    }) ?? [],
});

const repositoryParameters = (repository: string) => {
  const { slug } = parseRepositorySlug(repository);
  const [owner, repo] = slug.split("/") as [string, string];
  return { owner, repo };
};

const mutationError = (message: string, cause: unknown): RalphieError =>
  cause instanceof RalphieError
    ? cause
    : new RalphieError({ message, cause });

export const GitHubIssueMutationsLive = Layer.succeed(GitHubIssueMutations, {
  create: (client, repository, input) =>
    Effect.tryPromise({
      try: async () => {
        const response = await client.rest.issues.create({
          ...repositoryParameters(repository),
          title: input.title,
          body: input.body,
        });
        return mapIssue(response.data);
      },
      catch: (cause) =>
        mutationError(`Failed to create an issue in ${repository}.`, cause),
    }),

  update: (client, repository, issueNumber, input) =>
    Effect.tryPromise({
      try: async () => {
        if (input.title === undefined && input.body === undefined) {
          throw new RalphieError({
            message: "Issue update requires a title or body.",
          });
        }

        const response = await client.rest.issues.update({
          ...repositoryParameters(repository),
          issue_number: issueNumber,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.body === undefined ? {} : { body: input.body }),
        });
        return mapIssue(response.data);
      },
      catch: (cause) =>
        mutationError(
          `Failed to update issue #${issueNumber} in ${repository}.`,
          cause,
        ),
    }),

  close: (client, repository, issueNumber, reason) =>
    Effect.tryPromise({
      try: async () => {
        const response = await client.rest.issues.update({
          ...repositoryParameters(repository),
          issue_number: issueNumber,
          state: "closed",
          state_reason: reason,
        });
        return mapIssue(response.data);
      },
      catch: (cause) =>
        mutationError(
          `Failed to close issue #${issueNumber} in ${repository}.`,
          cause,
        ),
    }),
});
