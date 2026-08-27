import type { CommitMessageDecision } from "../issues/decisions.ts";
import {
    CommandRunnerLive,
    type CommandResult,
    type CommandRunnerService,
} from "../process/command-runner.ts";
import { RalphieError } from "../shared/error.ts";
import { runGit } from "./run-git.ts";

export type GitPushFailureKind = "non-fast-forward" | "other";

/** Push failures halt so their created commit can be reconciled on resume. */
export const GitPushFailurePolicy = "halt" as const;
export type GitPushFailurePolicy = typeof GitPushFailurePolicy;

export class GitPushError extends RalphieError {
    override readonly _tag = "GitPushError";
    readonly kind: GitPushFailureKind;
    readonly policy: GitPushFailurePolicy;
    readonly branch: string;

    constructor(input: {
        readonly kind: GitPushFailureKind;
        readonly policy?: GitPushFailurePolicy;
        readonly branch: string;
        readonly message: string;
        readonly cause?: unknown;
    }) {
        super(input);
        this.name = "GitPushError";
        this.kind = input.kind;
        this.policy = input.policy ?? GitPushFailurePolicy;
        this.branch = input.branch;
    }
}

export type GitIssueOperationError = RalphieError | GitPushError;

export type GitCommitResult = {
    readonly sha: string;
    readonly treeSha: string;
};

export type GitFeatureBranchResult = {
    readonly branch: string;
    readonly baseBranch: string;
    readonly baseSha: string;
    readonly headSha: string;
    readonly created: boolean;
};

export type GitIssueOperationsService = {
    /** Stage tracked, untracked, and deleted files in the issue checkout. */
    readonly stageAll: (repositoryPath: string) => Promise<void>;
    /** Read the complete staged patch, retaining Git's binary patch bytes/text. */
    readonly readStagedBinaryDiff: (repositoryPath: string) => Promise<string>;
    /** Check whether the index contains any staged changes. */
    readonly hasStagedChanges: (repositoryPath: string) => Promise<boolean>;
    /** Commit the validated generated message and verify the staged tree. */
    readonly commit: (
        repositoryPath: string,
        message: CommitMessageDecision,
    ) => Promise<GitCommitResult>;
    /** Push a commit to the configured branch without force and verify origin. */
    readonly push: (
        repositoryPath: string,
        branch: string,
        expectedCommitSha: string,
    ) => Promise<void>;
    /** Create or resume a feature branch anchored to an explicit base commit. */
    readonly createOrCheckoutFeatureBranch: (
        repositoryPath: string,
        branch: string,
        baseBranch: string,
        baseSha: string,
    ) => Promise<GitFeatureBranchResult>;
    /** Restore the checkout to the merged base branch from origin. */
    readonly restoreBaseCheckout: (
        repositoryPath: string,
        baseBranch: string,
    ) => Promise<void>;
};

const validBranch = (branch: string): boolean => branch.trim().length > 0;
const validGitSha = /^[0-9a-f]{40}([0-9a-f]{24})?$/i;

const validCommitMessage = (message: CommitMessageDecision): boolean =>
    message.subject.trim().length > 0 &&
    message.subject.length <= 72 &&
    (message.body === undefined || message.body.trim().length > 0);

const isNonFastForward = (output: string): boolean =>
    /non-fast-forward|fetch first|remote contains work|tip of your current branch is behind/i.test(
        output,
    );

export const makeGitIssueOperationsService = (
    runner: CommandRunnerService = CommandRunnerLive,
): GitIssueOperationsService => {
    const validateBranchName = async (
        repositoryPath: string,
        branch: string,
        description: string,
    ): Promise<void> => {
        if (!validBranch(branch) || branch !== branch.trim()) {
            throw new RalphieError({
                message: `${description} must be a non-empty Git branch name.`,
            });
        }
        const result = await runner.run("git", [
            "-C",
            repositoryPath,
            "check-ref-format",
            "--branch",
            branch,
        ]);
        if (result.exitCode !== 0) {
            const detail = result.stderr ? ` ${result.stderr}` : "";
            throw new RalphieError({
                message: `${description} is not a valid Git branch name.${detail}`,
            });
        }
    };

    const currentBranch = (repositoryPath: string) =>
        runGit(
            runner,
            repositoryPath,
            ["rev-parse", "--abbrev-ref", "HEAD"],
            "Failed to read the current Git branch",
        );

    const status = (repositoryPath: string) =>
        runGit(
            runner,
            repositoryPath,
            ["status", "--porcelain=v1"],
            "Failed to inspect the Git checkout status",
        );

    const branchExists = async (
        repositoryPath: string,
        branch: string,
    ): Promise<boolean> => {
        const result = await runner.run("git", [
            "-C",
            repositoryPath,
            "show-ref",
            "--verify",
            "--quiet",
            `refs/heads/${branch}`,
        ]);
        if (result.exitCode === 0) return true;
        if (result.exitCode === 1) return false;
        const detail = result.stderr ? ` ${result.stderr}` : "";
        throw new RalphieError({
            message: `Failed to inspect local branch ${branch}.${detail}`,
        });
    };

    const resolveCommit = (repositoryPath: string, sha: string) =>
        runGit(
            runner,
            repositoryPath,
            ["rev-parse", "--verify", `${sha}^{commit}`],
            "Failed to resolve the requested Git base commit",
        );

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
        const remote = await runGit(
            runner,
            repositoryPath,
            ["ls-remote", "origin", `refs/heads/${branch}`],
            "Failed to verify the pushed issue commit",
        );
        const remoteSha = remote.split(/\s+/)[0] ?? "";
        if (remoteSha.toLowerCase() !== expectedCommitSha.toLowerCase()) {
            throw new RalphieError({
                message: `Remote origin/${branch} points to ${remoteSha || "no commit"}, expected ${expectedCommitSha}.`,
            });
        }

        const checkoutStatus = await runGit(
            runner,
            repositoryPath,
            ["status", "--porcelain=v1"],
            "Failed to verify the issue checkout after push",
        );
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
        const result = await runner.run("git", [
            "-C",
            repositoryPath,
            "push",
            "--no-force",
            "origin",
            `HEAD:refs/heads/${branch}`,
        ]);
        assertPushSucceeded(branch, result);
        await verifyPushedCommit(repositoryPath, branch, expectedCommitSha);
    };

    const validateFeatureBranchInput = async (
        repositoryPath: string,
        branch: string,
        baseBranch: string,
        baseSha: string,
    ): Promise<void> => {
        await validateBranchName(repositoryPath, branch, "Feature branch");
        await validateBranchName(repositoryPath, baseBranch, "Base branch");
        if (branch === baseBranch) {
            throw new RalphieError({
                message: "Feature branch must differ from the base branch.",
            });
        }
        if (!validGitSha.test(baseSha)) {
            throw new RalphieError({
                message: `Refusing to create a feature branch from invalid Git base commit: ${baseSha}.`,
            });
        }
    };

    const resolveFeatureBase = async (
        repositoryPath: string,
        baseSha: string,
    ): Promise<string> => {
        const resolvedBaseSha = await resolveCommit(repositoryPath, baseSha);
        if (resolvedBaseSha.toLowerCase() !== baseSha.toLowerCase()) {
            throw new RalphieError({
                message: `Requested Git base commit ${baseSha} resolved to ${resolvedBaseSha}.`,
            });
        }
        return resolvedBaseSha;
    };

    const verifyFeatureBranchAncestry = async (
        repositoryPath: string,
        branch: string,
        baseSha: string,
    ): Promise<void> => {
        const ancestry = await runner.run("git", [
            "-C",
            repositoryPath,
            "merge-base",
            "--is-ancestor",
            baseSha,
            `refs/heads/${branch}`,
        ]);
        if (ancestry.exitCode === 0) return;
        if (ancestry.exitCode === 1) {
            throw new RalphieError({
                message: `Existing feature branch ${branch} is not based on ${baseSha}; refusing to resume it.`,
            });
        }
        const detail = ancestry.stderr ? ` ${ancestry.stderr}` : "";
        throw new RalphieError({
            message: `Failed to verify the ancestry of feature branch ${branch}.${detail}`,
        });
    };

    const resumeFeatureBranch = async (
        repositoryPath: string,
        branch: string,
        baseBranch: string,
        baseSha: string,
        resolvedBaseSha: string,
        actualBranch: string,
    ): Promise<GitFeatureBranchResult> => {
        const branchSha = await runGit(
            runner,
            repositoryPath,
            ["rev-parse", `refs/heads/${branch}^{commit}`],
            `Failed to read feature branch ${branch}`,
        );
        await verifyFeatureBranchAncestry(repositoryPath, branch, baseSha);
        if (actualBranch !== branch) {
            if ((await status(repositoryPath)) !== "") {
                throw new RalphieError({
                    message: `Cannot checkout feature branch ${branch}; the current checkout is dirty.`,
                });
            }
            await runGit(
                runner,
                repositoryPath,
                ["checkout", branch],
                `Failed to checkout existing feature branch ${branch}`,
            );
        }
        return {
            branch,
            baseBranch,
            baseSha: resolvedBaseSha,
            headSha: branchSha,
            created: false,
        };
    };

    const createFeatureBranch = async (
        repositoryPath: string,
        branch: string,
        baseBranch: string,
        baseSha: string,
        resolvedBaseSha: string,
    ): Promise<GitFeatureBranchResult> => {
        if ((await status(repositoryPath)) !== "") {
            throw new RalphieError({
                message: `Cannot create feature branch ${branch}; the current checkout is dirty.`,
            });
        }
        await runGit(
            runner,
            repositoryPath,
            ["checkout", "-b", branch, baseSha],
            `Failed to create feature branch ${branch}`,
        );
        const headSha = await runGit(
            runner,
            repositoryPath,
            ["rev-parse", "HEAD"],
            "Failed to verify the created feature branch",
        );
        if (headSha.toLowerCase() !== baseSha.toLowerCase()) {
            throw new RalphieError({
                message: `Created feature branch ${branch} at ${headSha}, expected base commit ${baseSha}.`,
            });
        }
        return {
            branch,
            baseBranch,
            baseSha: resolvedBaseSha,
            headSha,
            created: true,
        };
    };

    return {
        stageAll: async (repositoryPath) => {
            await runGit(
                runner,
                repositoryPath,
                ["add", "--all"],
                "Failed to stage all issue changes",
            );
        },

        readStagedBinaryDiff: (repositoryPath) =>
            runGit(
                runner,
                repositoryPath,
                ["diff", "--cached", "--binary"],
                "Failed to read the staged issue diff",
                false,
            ),

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

        commit: async (repositoryPath, message) => {
            if (!validCommitMessage(message)) {
                throw new RalphieError({
                    message:
                        "Commit message subject must be non-empty and at most 72 characters; body must be non-empty when provided.",
                });
            }

            const expectedTree = await runGit(
                runner,
                repositoryPath,
                ["write-tree"],
                "Failed to capture the staged issue tree",
            );
            const commitArgs = ["commit", "-m", message.subject];
            if (message.body !== undefined) commitArgs.push("-m", message.body);
            await runGit(
                runner,
                repositoryPath,
                commitArgs,
                "Failed to commit the staged issue changes",
            );
            const sha = await runGit(
                runner,
                repositoryPath,
                ["rev-parse", "HEAD"],
                "Failed to read the created issue commit",
            );
            const actualTree = await runGit(
                runner,
                repositoryPath,
                ["rev-parse", "HEAD^{tree}"],
                "Failed to verify the created issue tree",
            );
            if (actualTree !== expectedTree) {
                throw new RalphieError({
                    message: `Created issue commit ${sha} does not contain the expected staged tree.`,
                });
            }
            const checkoutStatus = await runGit(
                runner,
                repositoryPath,
                ["status", "--porcelain=v1"],
                "Failed to verify the issue checkout after commit",
            );
            if (checkoutStatus !== "") {
                throw new RalphieError({
                    message: "Issue checkout is dirty after commit.",
                });
            }
            return { sha, treeSha: actualTree };
        },

        push: (repositoryPath, branch, expectedCommitSha) =>
            pushIssueCommit(repositoryPath, branch, expectedCommitSha),

        createOrCheckoutFeatureBranch: async (
            repositoryPath,
            branch,
            baseBranch,
            baseSha,
        ) => {
            await validateFeatureBranchInput(
                repositoryPath,
                branch,
                baseBranch,
                baseSha,
            );
            const resolvedBaseSha = await resolveFeatureBase(
                repositoryPath,
                baseSha,
            );
            const exists = await branchExists(repositoryPath, branch);
            const actualBranch = await currentBranch(repositoryPath);
            return exists
                ? resumeFeatureBranch(
                      repositoryPath,
                      branch,
                      baseBranch,
                      baseSha,
                      resolvedBaseSha,
                      actualBranch,
                  )
                : createFeatureBranch(
                      repositoryPath,
                      branch,
                      baseBranch,
                      baseSha,
                      resolvedBaseSha,
                  );
        },

        restoreBaseCheckout: async (repositoryPath, baseBranch) => {
            await validateBranchName(repositoryPath, baseBranch, "Base branch");
            if ((await status(repositoryPath)) !== "") {
                throw new RalphieError({
                    message:
                        "Cannot restore the base checkout while it is dirty.",
                });
            }
            await runGit(
                runner,
                repositoryPath,
                ["fetch", "--prune", "origin"],
                "Failed to fetch the merged base branch from origin",
            );
            const originSha = await runGit(
                runner,
                repositoryPath,
                [
                    "rev-parse",
                    "--verify",
                    `refs/remotes/origin/${baseBranch}^{commit}`,
                ],
                `Failed to resolve origin/${baseBranch}`,
            );
            await runGit(
                runner,
                repositoryPath,
                [
                    "checkout",
                    "-B",
                    baseBranch,
                    `refs/remotes/origin/${baseBranch}`,
                ],
                `Failed to checkout base branch ${baseBranch}`,
            );
            await runGit(
                runner,
                repositoryPath,
                ["reset", "--hard", `refs/remotes/origin/${baseBranch}`],
                "Failed to reset the base checkout to origin",
            );
            await runGit(
                runner,
                repositoryPath,
                ["clean", "-fd"],
                "Failed to remove files left by the merged feature branch",
            );
            const restoredBranch = await currentBranch(repositoryPath);
            const restoredSha = await runGit(
                runner,
                repositoryPath,
                ["rev-parse", "HEAD"],
                "Failed to verify the restored base checkout",
            );
            if (
                restoredBranch !== baseBranch ||
                restoredSha.toLowerCase() !== originSha.toLowerCase() ||
                (await status(repositoryPath)) !== ""
            ) {
                throw new RalphieError({
                    message: `Base checkout restoration did not produce a clean ${baseBranch} checkout at origin/${baseBranch}.`,
                });
            }
        },
    };
};

export const GitIssueOperationsLive = makeGitIssueOperationsService;