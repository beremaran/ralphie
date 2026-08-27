import { describe, expect, test } from "bun:test";

import { makeGitRepositoryInvariantService } from "../../src/git/repository-invariant.ts";

const runner = (outputs: ReadonlyArray<string>) => {
    let index = 0;
    return {
        run: async () => ({
            exitCode: 0,
            stdout: outputs[index++] ?? "",
            stderr: "",
        }),
    };
};

describe("Git repository invariants", () => {
    test("captures branch and HEAD", async () => {
        const invariant = await makeGitRepositoryInvariantService(
            runner(["main", "abc123"]),
        ).capture("/workspace/repo");

        expect(invariant).toEqual({ branch: "main", head: "abc123" });
    });

    test("fails when branch or HEAD changes", async () => {
        await expect(
            makeGitRepositoryInvariantService(
                runner(["feature", "abc123"]),
            ).verify("/workspace/repo", { branch: "main", head: "abc123" }),
        ).rejects.toThrow("Repository branch changed");
    });
});