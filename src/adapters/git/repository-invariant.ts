import {
    CommandRunnerLive,
    requireSuccess,
} from "../process/command-runner.ts";
import { type CommandRunnerService } from "../../core/ports/process.ts";
import type {
    GitRepositoryInvariant,
    GitRepositoryInvariantService,
} from "../../core/ports/git.ts";
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
    runner: CommandRunnerService = CommandRunnerLive,
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