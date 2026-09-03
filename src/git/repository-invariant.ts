import {
    CommandRunnerLive,
    type CommandRunnerService,
} from "../process/command-runner.ts";
import { RalphieError } from "../shared/error.ts";
import { runGit } from "./run-git.ts";

export type GitRepositoryInvariant = {
    readonly branch: string;
    readonly head: string;
};

export type GitRepositoryInvariantService = {
    readonly capture: (
        repositoryPath: string,
        signal?: AbortSignal,
    ) => Promise<GitRepositoryInvariant>;
    readonly verify: (
        repositoryPath: string,
        expected: GitRepositoryInvariant,
        signal?: AbortSignal,
    ) => Promise<void>;
};

const readInvariant = async (
    runner: CommandRunnerService,
    repositoryPath: string,
    signal?: AbortSignal,
): Promise<GitRepositoryInvariant> => {
    const branch = await runGit(
        runner,
        repositoryPath,
        ["rev-parse", "--abbrev-ref", "HEAD"],
        "Failed to read the repository branch",
        true,
        signal,
    );
    const head = await runGit(
        runner,
        repositoryPath,
        ["rev-parse", "HEAD"],
        "Failed to read the repository HEAD",
        true,
        signal,
    );

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

export const GitRepositoryInvariantLive = makeGitRepositoryInvariantService;