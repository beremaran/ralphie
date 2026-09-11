import { requireSuccess } from "../../process/require-success.ts";
import { type CommandRunnerService } from "../../process/ports.ts";
import type {
    GitRepositoryInvariant,
    GitRepositoryInvariantService,
} from "../ports.ts";
import { RalphieError } from "../../shared/error.ts";

const readInvariant = async (
    runner: CommandRunnerService,
    repositoryPath: string,
    signal?: AbortSignal,
): Promise<GitRepositoryInvariant> => {
    const branch = (
        await requireSuccess(
            runner,
            "git",
            ["-C", repositoryPath, "rev-parse", "--abbrev-ref", "HEAD"],
            "Failed to read the repository branch",
            { signal },
        )
    ).stdout;
    const head = (
        await requireSuccess(
            runner,
            "git",
            ["-C", repositoryPath, "rev-parse", "HEAD"],
            "Failed to read the repository HEAD",
            { signal },
        )
    ).stdout;

    if (!branch || !head) {
        throw new RalphieError({
            message:
                "Git returned an empty branch or HEAD while checking the repository invariant.",
        });
    }

    return { branch, head };
};

export const makeGitRepositoryInvariantService = (
    runner: CommandRunnerService,
): GitRepositoryInvariantService => ({
    capture: (repositoryPath, signal) =>
        readInvariant(runner, repositoryPath, signal),
    verify: async (repositoryPath, expected, signal) => {
        const actual = await readInvariant(runner, repositoryPath, signal);
        if (actual.branch !== expected.branch) {
            throw new RalphieError({
                message: `Repository branch changed from ${expected.branch} to ${actual.branch}.`,
            });
        }
        if (actual.head.toLowerCase() !== expected.head.toLowerCase()) {
            throw new RalphieError({
                message: `Repository HEAD changed from ${expected.head} to ${actual.head}.`,
            });
        }
    },
});