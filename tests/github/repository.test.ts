import { describe, expect, test } from "bun:test";

import { parseRepositorySlug } from "../../src/github/repository.ts";

describe("GitHub repository parsing", () => {
    test.each([
        "owner/repository",
        "https://github.com/owner/repository.git",
        "git@github.com:owner/repository.git",
    ])("normalizes %s", (repository) => {
        expect(parseRepositorySlug(repository)).toEqual({
            slug: "owner/repository",
            owner: "owner",
            name: "repository",
        });
    });

    test.each(["repository", "../repository", "owner/..", "owner/repo/extra"])(
        "rejects invalid repository %s",
        (repository) => {
            expect(() => parseRepositorySlug(repository)).toThrow(
                "Expected owner/repository",
            );
        },
    );
});