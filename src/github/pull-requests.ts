import { Context, Effect, Layer } from "effect";
import type { Octokit } from "octokit";

import type { ReviewAttempt } from "../issues/recovery.ts";
import { RalphieError } from "../shared/error.ts";
import { parseRepositorySlug } from "./repository.ts";

export type CreateGitHubPullRequestInput = {
  readonly title: string;
  readonly body?: string;
  readonly issueNumber: number;
  /** Defaults to true. Supporting cross-repository PRs only reference the issue. */
  readonly closesIssue?: boolean;
  readonly issueRepository?: string;
  readonly head: string;
  readonly base: string;
};

export type GitHubPullRequest = {
  readonly number: number;
  readonly url: string;
  readonly merged: boolean;
};

export type GitHubPullRequestService = {
  /** Find a matching pull request, creating it only when none exists. */
  readonly createOrFind: (
    client: Octokit,
    repository: string,
    input: CreateGitHubPullRequestInput,
  ) => Effect.Effect<GitHubPullRequest, RalphieError>;
  /** Publish each review attempt at most once using its deterministic marker. */
  readonly publishReviewAttempts: (
    client: Octokit,
    repository: string,
    pullRequestNumber: number,
    attempts: ReadonlyArray<ReviewAttempt>,
  ) => Effect.Effect<void, RalphieError>;
  /** Merge a pull request when needed and verify the authoritative merged state. */
  readonly merge: (
    client: Octokit,
    repository: string,
    pullRequestNumber: number,
  ) => Effect.Effect<GitHubPullRequest, RalphieError>;
};

export const GitHubPullRequests = Context.GenericTag<GitHubPullRequestService>(
  "ralphie/GitHubPullRequests",
);

const repositoryParameters = (repository: string) => {
  const { owner, name } = parseRepositorySlug(repository);
  return {
    owner,
    repo: name,
  };
};

const mutationError = (message: string, cause: unknown): RalphieError =>
  cause instanceof RalphieError
    ? cause
    : new RalphieError({
        message,
        cause,
      });

const isMerged = (pullRequest: {
  readonly merged?: boolean | null;
  readonly merged_at?: string | null;
}): boolean => pullRequest.merged === true || pullRequest.merged_at != null;

const mapPullRequest = (pullRequest: {
  readonly number: number;
  readonly html_url: string;
  readonly merged?: boolean | null;
  readonly merged_at?: string | null;
}): GitHubPullRequest => ({
  number: pullRequest.number,
  url: pullRequest.html_url,
  merged: isMerged(pullRequest),
});

const issueReference = (input: CreateGitHubPullRequestInput): string => {
  const issue = input.issueRepository
    ? `${parseRepositorySlug(input.issueRepository).slug}#${input.issueNumber}`
    : `#${input.issueNumber}`;
  return input.closesIssue === false ? `Tracks ${issue}` : `Closes ${issue}`;
};

const pullRequestBody = (input: CreateGitHubPullRequestInput): string => {
  const body = input.body?.trim() ?? "";
  const reference = issueReference(input);
  if (body.includes(reference)) return body;
  return body.length === 0 ? reference : `${body}\n\n${reference}`;
};

/** The marker is stable for an attempt, making retries safe after a lost response. */
export const reviewAttemptMarker = (attempt: number): string =>
  `<!-- ralphie:review-attempt=${attempt} -->`;

const reviewCommentBody = (attempt: ReviewAttempt): string =>
  `${reviewAttemptMarker(attempt.attempt)}\n### Ralphie review attempt ${attempt.attempt}\n\n\`\`\`json\n${JSON.stringify(attempt, null, 2)}\n\`\`\``;

const reviewAttemptFromComment = (
  body: string | null | undefined,
): number | undefined => {
  const match = body?.match(/<!-- ralphie:review-attempt=(\d+) -->/);
  if (!match) return undefined;
  const attempt = Number(match[1]);
  return Number.isInteger(attempt) && attempt > 0 ? attempt : undefined;
};

const findMatchingPullRequest = (
  pullRequests: ReadonlyArray<{
    readonly number: number;
    readonly html_url: string;
    readonly merged?: boolean | null;
    readonly merged_at?: string | null;
    readonly head?: {
      readonly ref?: string | null;
    } | null;
    readonly base?: {
      readonly ref?: string | null;
    } | null;
  }>,
  input: CreateGitHubPullRequestInput,
) =>
  pullRequests.find(
    (pullRequest) =>
      pullRequest.head?.ref === input.head &&
      pullRequest.base?.ref === input.base,
  );

export const GitHubPullRequestsLive = Layer.succeed(GitHubPullRequests, {
  createOrFind: (client, repository, input) =>
    Effect.tryPromise({
      try: async () => {
        const parameters = repositoryParameters(repository);
        const listMatching = async () => {
          const pullRequests = await client.paginate(client.rest.pulls.list, {
            ...parameters,
            state: "all",
            head: `${parameters.owner}:${input.head}`,
            base: input.base,
            per_page: 100,
          });
          return findMatchingPullRequest(pullRequests, input);
        };

        const matching = await listMatching();
        if (matching) return mapPullRequest(matching);

        try {
          const created = await client.rest.pulls.create({
            ...parameters,
            title: input.title,
            body: pullRequestBody(input),
            head: input.head,
            base: input.base,
          });
          return mapPullRequest(created.data);
        } catch (cause) {
          // A response can be lost after GitHub accepts the PR. Re-read the
          // matching head/base pair before surfacing the failure.
          const reconciled = await listMatching();
          if (reconciled) return mapPullRequest(reconciled);
          throw cause;
        }
      },
      catch: (cause) =>
        mutationError(
          `Failed to create or find a pull request in ${repository}.`,
          cause,
        ),
    }),

  publishReviewAttempts: (client, repository, pullRequestNumber, attempts) =>
    Effect.tryPromise({
      try: async () => {
        const parameters = {
          ...repositoryParameters(repository),
          issue_number: pullRequestNumber,
        };
        const comments = await client.paginate(
          client.rest.issues.listComments,
          {
            ...parameters,
            per_page: 100,
          },
        );
        const published = new Set(
          comments
            .map((comment) => reviewAttemptFromComment(comment.body))
            .filter((attempt): attempt is number => attempt !== undefined),
        );

        for (const attempt of attempts) {
          if (published.has(attempt.attempt)) continue;
          const body = reviewCommentBody(attempt);
          try {
            await client.rest.issues.createComment({
              ...parameters,
              body,
            });
          } catch (cause) {
            // A response can be lost after GitHub accepts the comment. Re-read
            // comments before surfacing the failure so this operation remains
            // safe to retry.
            const reconciled = await client.paginate(
              client.rest.issues.listComments,
              {
                ...parameters,
                per_page: 100,
              },
            );
            if (
              reconciled.some(
                (comment) =>
                  reviewAttemptFromComment(comment.body) === attempt.attempt,
              )
            ) {
              published.add(attempt.attempt);
              continue;
            }
            throw cause;
          }
          published.add(attempt.attempt);
        }
      },
      catch: (cause) =>
        mutationError(
          `Failed to publish review attempts on pull request #${pullRequestNumber} in ${repository}.`,
          cause,
        ),
    }),

  merge: (client, repository, pullRequestNumber) =>
    Effect.tryPromise({
      try: async () => {
        const parameters = {
          ...repositoryParameters(repository),
          pull_number: pullRequestNumber,
        };
        const current = await client.rest.pulls.get(parameters);
        if (isMerged(current.data)) return mapPullRequest(current.data);
        if (current.data.state !== "open") {
          throw new RalphieError({
            message: `Pull request #${pullRequestNumber} is closed but not merged.`,
          });
        }

        try {
          await client.rest.pulls.merge(parameters);
        } catch (cause) {
          // Reconcile a lost merge response before reporting a failure.
          const reconciled = await client.rest.pulls.get(parameters);
          if (isMerged(reconciled.data)) return mapPullRequest(reconciled.data);
          throw cause;
        }

        const merged = await client.rest.pulls.get(parameters);
        if (!isMerged(merged.data)) {
          throw new RalphieError({
            message: `Pull request #${pullRequestNumber} did not reach the merged state.`,
          });
        }
        return mapPullRequest(merged.data);
      },
      catch: (cause) =>
        mutationError(
          `Failed to merge pull request #${pullRequestNumber} in ${repository}.`,
          cause,
        ),
    }),
});