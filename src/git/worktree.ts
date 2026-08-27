import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
    CommandRunnerLive,
    type CommandRunnerService,
} from "../process/command-runner.ts";
import { RalphieError } from "../shared/error.ts";
import { resolveWorkspacePath } from "../workspace/workspace.ts";
import { runGit } from "./run-git.ts";

export type RepositoryCheckout = {
    readonly repository: string;
    readonly repositoryPath: string;
    readonly branch: string;
};

export type PreparedIssueWorktree = RepositoryCheckout & {
    readonly path: string;
};

export type GitWorktreeService = {
    readonly prepareIssue: (input: {
        readonly workspace: string;
        readonly runId: string;
        readonly issueNumber: number;
        readonly branch: string;
        readonly repository: RepositoryCheckout;
        readonly baseSha: string;
    }) => Promise<PreparedIssueWorktree>;
    readonly removeIssue: (
        source: RepositoryCheckout,
        prepared: PreparedIssueWorktree,
    ) => Promise<void>;
};

export const makeGitWorktreeService = (
    runner: CommandRunnerService = CommandRunnerLive,
): GitWorktreeService => ({
    prepareIssue: async (input) => {
        const root = join(
            resolveWorkspacePath(input.workspace),
            ".ralphie",
            "worktrees",
            input.runId,
            `issue-${input.issueNumber}`,
        );
        const path = join(root, basename(input.repository.repositoryPath));
        try {
            await mkdir(dirname(path), { recursive: true });
        } catch (cause) {
            throw new RalphieError({
                message: `Failed to prepare ${path}.`,
                cause,
            });
        }

        const existing = await runner.run("git", [
            "-C",
            path,
            "rev-parse",
            "--is-inside-work-tree",
        ]);
        if (existing.exitCode !== 0) {
            const branchExists = await runner.run("git", [
                "-C",
                input.repository.repositoryPath,
                "show-ref",
                "--verify",
                "--quiet",
                `refs/heads/${input.branch}`,
            ]);
            await runGit(
                runner,
                input.repository.repositoryPath,
                branchExists.exitCode === 0
                    ? ["worktree", "add", path, input.branch]
                    : [
                          "worktree",
                          "add",
                          "-b",
                          input.branch,
                          path,
                          input.baseSha,
                      ],
                `Failed to create issue worktree for ${input.repository.repository}`,
            );
        }
        const branch = await runGit(
            runner,
            path,
            ["rev-parse", "--abbrev-ref", "HEAD"],
            `Failed to verify issue worktree for ${input.repository.repository}`,
        );
        if (branch !== input.branch) {
            throw new RalphieError({
                message: `Issue worktree for ${input.repository.repository} is on ${branch}, expected ${input.branch}.`,
            });
        }
        return {
            path: root,
            repository: input.repository.repository,
            repositoryPath: path,
            branch,
        };
    },

    removeIssue: (source, prepared) =>
        runGit(
            runner,
            source.repositoryPath,
            ["worktree", "remove", prepared.repositoryPath],
            `Failed to remove issue worktree for ${prepared.repository}`,
        ).then(() => undefined),
});

export const GitWorktreesLive = makeGitWorktreeService;