import {
    CommandRunnerLive,
    requireSuccess,
    type CommandRunnerService,
} from "../process/command-runner.ts";
import { RalphieError } from "../shared/error.ts";

export type IssueCheckpoint = {
    readonly branch: string;
    readonly sha: string;
};

export type GitIssueCheckpointService = {
    readonly capture: (
        repositoryPath: string,
        branch: string,
    ) => Promise<IssueCheckpoint>;
    /** Capture tracked and untracked changes without changing the checkout. */
    readonly createPatch: (repositoryPath: string) => Promise<string>;
    readonly restore: (
        repositoryPath: string,
        checkpoint: IssueCheckpoint,
    ) => Promise<void>;
};

const validGitSha = /^[0-9a-f]{40}([0-9a-f]{24})?$/i;

export const makeGitIssueCheckpointService = (
    runner: CommandRunnerService = CommandRunnerLive,
): GitIssueCheckpointService => {
    const currentBranch = (repositoryPath: string) =>
        requireSuccess(
            runner,
            "git",
            ["-C", repositoryPath, "rev-parse", "--abbrev-ref", "HEAD"],
            "Failed to read the current branch",
        ).then((result) => result.stdout);

    const status = (repositoryPath: string) =>
        requireSuccess(
            runner,
            "git",
            ["-C", repositoryPath, "status", "--porcelain=v1"],
            "Failed to inspect the repository status",
        ).then((result) => result.stdout);

    const untrackedFiles = (repositoryPath: string) =>
        requireSuccess(
            runner,
            "git",
            [
                "-C",
                repositoryPath,
                "ls-files",
                "--others",
                "--exclude-standard",
                "-z",
            ],
            "Failed to list untracked issue changes",
            { trimStdout: false },
        ).then((result) => result.stdout);

    const untrackedPatch = async (
        repositoryPath: string,
        path: string,
    ): Promise<string> => {
        const result = await runner.run(
            "git",
            [
                "-C",
                repositoryPath,
                "diff",
                "--no-index",
                "--binary",
                "--no-ext-diff",
                "--",
                "/dev/null",
                path,
            ],
            { trimStdout: false },
        );
        if (result.exitCode === 0 || result.exitCode === 1) {
            return result.stdout;
        }
        const detail = result.stderr ? ` ${result.stderr}` : "";
        throw new RalphieError({
            message: `Failed to capture the untracked issue change ${path}.${detail}`,
        });
    };

    const createPatch = async (repositoryPath: string): Promise<string> => {
        const staged = (
            await requireSuccess(
                runner,
                "git",
                [
                    "-C",
                    repositoryPath,
                    "diff",
                    "--cached",
                    "--binary",
                    "--no-ext-diff",
                ],
                "Failed to preserve the staged issue changes",
                { trimStdout: false },
            )
        ).stdout;
        const unstaged = (
            await requireSuccess(
                runner,
                "git",
                ["-C", repositoryPath, "diff", "--binary", "--no-ext-diff"],
                "Failed to preserve the unstaged issue changes",
                { trimStdout: false },
            )
        ).stdout;
        const paths = (await untrackedFiles(repositoryPath))
            .split("\0")
            .filter((path) => path.length > 0);
        const untracked = await Promise.all(
            paths.map((path) => untrackedPatch(repositoryPath, path)),
        );
        return staged + unstaged + untracked.join("");
    };

    return {
        capture: async (repositoryPath, branch) => {
            const actualBranch = await currentBranch(repositoryPath);
            if (actualBranch !== branch) {
                throw new RalphieError({
                    message: `Cannot checkpoint ${branch}; checkout is on ${actualBranch}.`,
                });
            }
            if ((await status(repositoryPath)) !== "") {
                throw new RalphieError({
                    message: "Cannot checkpoint a dirty issue checkout.",
                });
            }

            const sha = (
                await requireSuccess(
                    runner,
                    "git",
                    ["-C", repositoryPath, "rev-parse", "HEAD"],
                    "Failed to capture the issue base commit",
                )
            ).stdout;
            if (!validGitSha.test(sha)) {
                throw new RalphieError({
                    message: `Git returned an invalid issue base commit: ${sha}.`,
                });
            }
            return { branch, sha };
        },

        createPatch,

        restore: async (repositoryPath, checkpoint) => {
            if (!validGitSha.test(checkpoint.sha)) {
                throw new RalphieError({
                    message: `Refusing to restore invalid Git commit: ${checkpoint.sha}.`,
                });
            }

            const branch = await currentBranch(repositoryPath);
            if (branch !== checkpoint.branch) {
                throw new RalphieError({
                    message: `Refusing to restore ${checkpoint.branch}; checkout is on ${branch}.`,
                });
            }

            (
                await requireSuccess(
                    runner,
                    "git",
                    ["-C", repositoryPath, "reset", "--hard", checkpoint.sha],
                    "Failed to restore the issue base commit",
                )
            ).stdout;
            (
                await requireSuccess(
                    runner,
                    "git",
                    ["-C", repositoryPath, "clean", "-fd"],
                    "Failed to remove files created by the unsuccessful implementation",
                )
            ).stdout;

            const restoredSha = (
                await requireSuccess(
                    runner,
                    "git",
                    ["-C", repositoryPath, "rev-parse", "HEAD"],
                    "Failed to verify the restored commit",
                )
            ).stdout;
            const restoredStatus = await status(repositoryPath);
            if (
                restoredSha.toLowerCase() !== checkpoint.sha.toLowerCase() ||
                restoredStatus !== ""
            ) {
                throw new RalphieError({
                    message:
                        "Issue checkout restoration did not produce the expected clean state.",
                });
            }
        },
    };
};