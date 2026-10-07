import { RalphieError } from "../shared/error.ts";

export type RepositorySlug = {
    readonly slug: string;
    readonly owner: string;
    readonly name: string;
};

const isSafeSegment = (segment: string): boolean =>
    /^[a-zA-Z0-9_.-]+$/.test(segment) && segment !== "." && segment !== "..";

export const parseRepositorySlug = (repository: string): RepositorySlug => {
    const value = repository
        .trim()
        .replace(/\/$/, "")
        .replace(/\.git$/, "");
    const match =
        value.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)$/i) ??
        value.match(/^git@github\.com:([^/]+)\/([^/]+)$/i) ??
        value.match(/^([^/\s]+)\/([^/\s]+)$/);

    const owner = match?.[1];
    const name = match?.[2];
    if (!owner || !name || !isSafeSegment(owner) || !isSafeSegment(name)) {
        throw new RalphieError({
            message: `Invalid GitHub repository: ${repository}. Expected owner/repository.`,
        });
    }

    return {
        slug: `${owner}/${name}`,
        owner,
        name,
    };
};
/** A repository argument: a full slug, or a bare name still needing an owner. */
export type RepositoryArgument =
    | { readonly kind: "slug"; readonly slug: RepositorySlug }
    | { readonly kind: "name"; readonly name: string };

/**
 * Classify the positional repository argument. `owner/repo` and clone URLs
 * are used as given; a bare name is returned for owner resolution.
 */
export const parseRepositoryArgument = (
    argument: string,
): RepositoryArgument => {
    const name = argument.trim();
    return isSafeSegment(name)
        ? { kind: "name", name }
        : { kind: "slug", slug: parseRepositorySlug(argument) };
};