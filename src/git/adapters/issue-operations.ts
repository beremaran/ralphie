import type { CommitMessageDecision } from "../../issues/domain/decisions.ts";
import { requireSuccess } from "../../process/require-success.ts";
import {
    type CommandResult,
    type CommandRunnerService,
} from "../../process/ports.ts";
import {
    GitPushError,
    type GitCommitResult,
    type GitIssueOperationsService,
} from "../ports.ts";
import { RalphieError } from "../../shared/error.ts";

const validBranch = (branch: string): boolean => branch.trim().length > 0;

const validCommitMessage = (message: CommitMessageDecision): boolean =>
    message.subject.trim().length > 0 &&
    message.subject.length <= 72 &&
    (message.body === undefined || message.body.trim().length > 0);

/** Detect a rejected non-fast-forward push from the raw Git response. Shared by every push path. */
export const isNonFastForward = (output: string): boolean =>
    /non-fast-forward|fetch first|remote contains work|tip of your current branch is behind/i.test(
        output,
    );

export const makeGitIssueOperationsService = (
    runner: CommandRunnerService,
): GitIssueOperationsService => {
    const assertPushSucceeded = (
        branch: string,
        result: CommandResult,
    ): void => {
        if (result.exitCode === 0) return;

        const output = [result.stdout, result.stderr]
            .filter(Boolean)
            .join("\n");
        const kind = isNonFastForward(output) ? "non-fast-forward" : "other";
        const summary =
            kind === "non-fast-forward"
                ? `Push to origin/${branch} was rejected because the remote branch moved; push failure policy is halt.`
                : `Push to origin/${branch} failed; push failure policy is halt.`;
        throw new GitPushError({
            kind,
            branch,
            message:
                output.trim().length > 0
                    ? `${summary}\n${output.trim()}`
                    : summary,
            cause: output,
        });
    };

    const verifyPushedCommit = async (
        repositoryPath: string,
        branch: string,
        expectedCommitSha: string,
    ): Promise<void> => {
        const remote = (
            await requireSuccess(
                runner,
                "git",
                [
                    "-C",
                    repositoryPath,
                    "ls-remote",
                    "origin",
                    `refs/heads/${branch}`,
                ],
                "Failed to verify the pushed issue commit",
            )
        ).stdout;
        const remoteSha = remote.split(/\s+/)[0] ?? "";
        if (remoteSha.toLowerCase() !== expectedCommitSha.toLowerCase()) {
            throw new RalphieError({
                message: `Remote origin/${branch} points to ${remoteSha || "no commit"}, expected ${expectedCommitSha}.`,
            });
        }

        const checkoutStatus = (
            await requireSuccess(
                runner,
                "git",
                ["-C", repositoryPath, "status", "--porcelain=v1"],
                "Failed to verify the issue checkout after push",
            )
        ).stdout;
        if (checkoutStatus !== "") {
            throw new RalphieError({
                message: "Issue checkout is dirty after push.",
            });
        }
    };

    const pushIssueCommit = async (
        repositoryPath: string,
        branch: string,
        expectedCommitSha: string,
    ): Promise<void> => {
        if (!validBranch(branch)) {
            throw new RalphieError({
                message: "Cannot push an issue commit to an empty branch name.",
            });
        }
        // The workspace's push URL is disabled so sessions cannot push; the
        // delivery push names the fetch URL explicitly instead.
        const url = (
            await requireSuccess(
                runner,
                "git",
                ["-C", repositoryPath, "remote", "get-url", "origin"],
                "Failed to read the repository origin",
            )
        ).stdout.trim();
        const result = await runner.run("git", [
            "-C",
            repositoryPath,
            "push",
            "--no-force",
            url,
            `HEAD:refs/heads/${branch}`,
        ]);
        assertPushSucceeded(branch, result);
        await verifyPushedCommit(repositoryPath, branch, expectedCommitSha);
        await requireSuccess(
            runner,
            "git",
            [
                "-C",
                repositoryPath,
                "update-ref",
                `refs/remotes/origin/${branch}`,
                expectedCommitSha,
            ],
            `Failed to record the pushed commit as origin/${branch}`,
        );
    };

    const commitStaged = async (
        repositoryPath: string,
        message: CommitMessageDecision,
    ): Promise<GitCommitResult> => {
        if (!validCommitMessage(message)) {
            throw new RalphieError({
                message:
                    "Commit message subject must be non-empty and at most 72 characters; body must be non-empty when provided.",
            });
        }
        const git = async (args: string[], failure: string): Promise<string> =>
            (
                await requireSuccess(
                    runner,
                    "git",
                    ["-C", repositoryPath, ...args],
                    failure,
                )
            ).stdout;
        const expectedTree = await git(
            ["write-tree"],
            "Failed to capture the staged issue tree",
        );
        const commitArgs = ["commit", "-m", message.subject];
        if (message.body !== undefined) commitArgs.push("-m", message.body);
        await git(commitArgs, "Failed to commit the staged issue changes");
        const sha = await git(
            ["rev-parse", "HEAD"],
            "Failed to read the created issue commit",
        );
        const actualTree = await git(
            ["rev-parse", "HEAD^{tree}"],
            "Failed to verify the created issue tree",
        );
        if (actualTree !== expectedTree) {
            throw new RalphieError({
                message: `Created issue commit ${sha} does not contain the expected staged tree.`,
            });
        }
        const checkoutStatus = await git(
            ["status", "--porcelain=v1"],
            "Failed to verify the issue checkout after commit",
        );
        if (checkoutStatus !== "") {
            throw new RalphieError({
                message: "Issue checkout is dirty after commit.",
            });
        }
        return { sha, treeSha: actualTree };
    };

    return {
        stageAll: async (repositoryPath) => {
            (
                await requireSuccess(
                    runner,
                    "git",
                    ["-C", repositoryPath, "add", "--all"],
                    "Failed to stage all issue changes",
                )
            ).stdout;
        },

        readStagedBinaryDiff: (repositoryPath) =>
            requireSuccess(
                runner,
                "git",
                ["-C", repositoryPath, "diff", "--cached", "--binary"],
                "Failed to read the staged issue diff",
                { trimStdout: false },
            ).then((result) => result.stdout),

        hasStagedChanges: async (repositoryPath) => {
            const result = await runner.run("git", [
                "-C",
                repositoryPath,
                "diff",
                "--cached",
                "--quiet",
            ]);
            if (result.exitCode === 0) return false;
            if (result.exitCode === 1) return true;
            const detail = result.stderr ? ` ${result.stderr}` : "";
            throw new RalphieError({
                message: `Failed to inspect staged issue changes.${detail}`,
            });
        },

        commit: (repositoryPath, message) =>
            commitStaged(repositoryPath, message),

        commitCandidate: (repositoryPath, message) =>
            commitStaged(repositoryPath, message),

        readRangeDiff: (repositoryPath, base, head) =>
            requireSuccess(
                runner,
                "git",
                ["-C", repositoryPath, "diff", "--binary", `${base}..${head}`],
                "Failed to read the candidate commit range diff",
                { trimStdout: false },
            ).then((result) => result.stdout),

        squashCandidates: async (repositoryPath, baseSha) => {
            const tree = (
                await requireSuccess(
                    runner,
                    "git",
                    ["-C", repositoryPath, "rev-parse", "HEAD^{tree}"],
                    "Failed to read the candidate tree",
                )
            ).stdout;
            await requireSuccess(
                runner,
                "git",
                ["-C", repositoryPath, "reset", "--soft", baseSha],
                "Failed to squash the candidate commits",
            );
            const staged = (
                await requireSuccess(
                    runner,
                    "git",
                    ["-C", repositoryPath, "write-tree"],
                    "Failed to verify the squashed tree",
                )
            ).stdout;
            if (staged !== tree) {
                throw new RalphieError({
                    message:
                        "Squashing the candidate commits changed the staged tree.",
                });
            }
        },

        push: (repositoryPath, branch, expectedCommitSha) =>
            pushIssueCommit(repositoryPath, branch, expectedCommitSha),
    };
};