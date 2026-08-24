import { RalphieError } from "../shared/error.ts";

export type RepositorySlug = {
  readonly slug: string;
  readonly name: string;
};

export const parseRepositorySlug = (repository: string): RepositorySlug => {
  const value = repository.trim().replace(/\/$/, "").replace(/\.git$/, "");
  const match =
    value.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)$/i) ??
    value.match(/^git@github\.com:([^/]+)\/([^/]+)$/i) ??
    value.match(/^([^/\s]+)\/([^/\s]+)$/);

  const owner = match?.[1];
  const name = match?.[2];
  const safeSegment = /^[a-zA-Z0-9_.-]+$/;
  if (
    !owner ||
    !name ||
    !safeSegment.test(owner) ||
    !safeSegment.test(name) ||
    owner === "." ||
    owner === ".." ||
    name === "." ||
    name === ".."
  ) {
    throw new RalphieError({
      message: `Invalid GitHub repository: ${repository}. Expected owner/repository.`,
    });
  }

  return { slug: `${owner}/${name}`, name };
};
