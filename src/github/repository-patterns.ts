import { Context, Effect, Layer } from "effect";
import type { Octokit } from "octokit";

import { RalphieError } from "../shared/error.ts";
import type { RepositorySlug } from "./repository.ts";

/** A repository selector in the form `owner/repository-glob`. */
export type RepositoryPattern = {
  readonly owner: string;
  readonly repositoryGlob: string;
};

const repositorySegment = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const repositoryGlobSegment = /^[A-Za-z0-9._?*-]+$/;

/**
 * Parses the deliberately narrow pattern syntax used by config projects.
 * The owner is explicit; `*` and `?` are supported only in the repository
 * segment. This prevents a pattern from accidentally spanning organizations.
 */
export const parseRepositoryPattern = (pattern: string): RepositoryPattern => {
  const value = pattern.trim();
  const separator = value.indexOf("/");
  if (
    separator <= 0 ||
    separator !== value.lastIndexOf("/") ||
    separator === value.length - 1
  ) {
    throw new RalphieError({
      message: `Invalid repository pattern: ${pattern}. Expected owner/repository-glob.`,
    });
  }

  const owner = value.slice(0, separator);
  const repositoryGlob = value.slice(separator + 1);
  if (
    !repositorySegment.test(owner) ||
    !repositoryGlobSegment.test(repositoryGlob) ||
    repositoryGlob === "." ||
    repositoryGlob === ".."
  ) {
    throw new RalphieError({
      message: `Invalid repository pattern: ${pattern}. Expected owner/repository-glob.`,
    });
  }

  return { owner, repositoryGlob };
};

const escapeRegularExpression = (value: string): string =>
  value.replace(/[\\^$+{}.()|[\]]/g, "\\$&");

/** Matches a GitHub repository name against a parsed glob. */
export const repositoryNameMatchesGlob = (
  name: string,
  repositoryGlob: string,
): boolean => {
  const expression = [...repositoryGlob]
    .map((character) => {
      if (character === "*") return ".*";
      if (character === "?") return ".";
      return escapeRegularExpression(character);
    })
    .join("");
  return new RegExp(`^${expression}$`, "i").test(name);
};

export type GitHubRepositoryPatternsService = {
  readonly resolve: (
    client: Octokit,
    pattern: string,
  ) => Effect.Effect<ReadonlyArray<RepositorySlug>, RalphieError>;
};

export const GitHubRepositoryPatterns =
  Context.GenericTag<GitHubRepositoryPatternsService>(
    "ralphie/GitHubRepositoryPatterns",
  );

const repositorySlugFromResponse = (repository: {
  readonly full_name?: string;
  readonly owner?: { readonly login?: string | null } | null;
  readonly name?: string;
}): RepositorySlug | undefined => {
  const fullName = repository.full_name;
  const owner = repository.owner?.login;
  const name = repository.name;
  if (!fullName || !owner || !name) return undefined;
  return { slug: fullName, owner, name };
};

export const resolveRepositoryPattern = (
  client: Octokit,
  pattern: string,
): Effect.Effect<ReadonlyArray<RepositorySlug>, RalphieError> =>
  Effect.tryPromise({
    try: async () => {
      const parsed = parseRepositoryPattern(pattern);
      const repositories = await client.paginate(
        client.rest.repos.listForAuthenticatedUser,
        {
          affiliation: "owner,collaborator,organization_member",
          visibility: "all",
          per_page: 100,
        },
      );

      const matches = repositories
        // Archived repositories are intentionally excluded: Ralphie cannot
        // safely make progress on a repository that is no longer maintained.
        .filter((repository) => !repository.archived)
        .map(repositorySlugFromResponse)
        .filter((repository): repository is RepositorySlug => repository !== undefined)
        .filter(
          (repository) =>
            repository.owner.toLowerCase() === parsed.owner.toLowerCase() &&
            repositoryNameMatchesGlob(repository.name, parsed.repositoryGlob),
        )
        .sort((left, right) =>
          left.slug.localeCompare(right.slug, undefined, { sensitivity: "base" }),
        );

      if (matches.length === 0) {
        throw new RalphieError({
          message: `Repository pattern ${pattern} matched no accessible, non-archived repositories.`,
        });
      }
      return matches;
    },
    catch: (cause) =>
      cause instanceof RalphieError
        ? cause
        : new RalphieError({
            message: `Failed to resolve GitHub repository pattern ${pattern}.`,
            cause,
          }),
  });

export const GitHubRepositoryPatternsLive = Layer.succeed(GitHubRepositoryPatterns, {
  resolve: resolveRepositoryPattern,
});
