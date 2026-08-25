import { Context, Data, Effect, Layer } from "effect";

import type { CommitMessageDecision } from "../issues/decisions.ts";
import type { CommandRunnerService } from "../process/command-runner.ts";
import { CommandRunner } from "../process/command-runner.ts";
import { RalphieError } from "../shared/error.ts";

export enum GitPushFailureKind {
  NonFastForward = "non-fast-forward",
  Other = "other",
}

/** Push failures halt so their created commit can be reconciled on resume. */
export enum GitPushFailurePolicy {
  Halt = "halt",
}

export class GitPushError extends Data.TaggedError("GitPushError")<{
  readonly kind: GitPushFailureKind;
  readonly policy: GitPushFailurePolicy.Halt;
  readonly branch: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

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
  readonly stageAll: (repositoryPath: string) => Effect.Effect<void, RalphieError>;
  /** Read the complete staged patch, retaining Git's binary patch bytes/text. */
  readonly readStagedBinaryDiff: (
    repositoryPath: string,
  ) => Effect.Effect<string, RalphieError>;
  /** Check whether the index contains any staged changes. */
  readonly hasStagedChanges: (
    repositoryPath: string,
  ) => Effect.Effect<boolean, RalphieError>;
  /** Commit the validated generated message and verify the staged tree. */
  readonly commit: (
    repositoryPath: string,
    message: CommitMessageDecision,
  ) => Effect.Effect<GitCommitResult, RalphieError>;
  /** Push a commit to the configured branch without force and verify origin. */
  readonly push: (
    repositoryPath: string,
    branch: string,
    expectedCommitSha: string,
  ) => Effect.Effect<void, GitIssueOperationError>;
  /** Create or resume a feature branch anchored to an explicit base commit. */
  readonly createOrCheckoutFeatureBranch: (
    repositoryPath: string,
    branch: string,
    baseBranch: string,
    baseSha: string,
  ) => Effect.Effect<GitFeatureBranchResult, RalphieError>;
  /** Restore the checkout to the merged base branch from origin. */
  readonly restoreBaseCheckout: (
    repositoryPath: string,
    baseBranch: string,
  ) => Effect.Effect<void, RalphieError>;
};

export const GitIssueOperations = Context.GenericTag<GitIssueOperationsService>(
  "ralphie/GitIssueOperations",
);

const runGit = (
  runner: CommandRunnerService,
  repositoryPath: string,
  args: ReadonlyArray<string>,
  failureMessage: string,
  trimStdout = true,
) =>
  Effect.gen(function* () {
    const result = yield* runner.run("git", ["-C", repositoryPath, ...args], {
      trimStdout,
    });
    if (result.exitCode !== 0) {
      const detail = result.stderr ? ` ${result.stderr}` : "";
      return yield* new RalphieError({ message: `${failureMessage}.${detail}` });
    }
    return result.stdout;
  });

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

export const GitIssueOperationsLive = Layer.effect(
  GitIssueOperations,
  Effect.gen(function* () {
    const runner = yield* CommandRunner;

    const validateBranchName = (
      repositoryPath: string,
      branch: string,
      description: string,
    ) =>
      Effect.gen(function* () {
        if (!validBranch(branch) || branch !== branch.trim()) {
          return yield* new RalphieError({
            message: `${description} must be a non-empty Git branch name.`,
          });
        }
        const result = yield* runner.run("git", [
          "-C",
          repositoryPath,
          "check-ref-format",
          "--branch",
          branch,
        ]);
        if (result.exitCode !== 0) {
          const detail = result.stderr ? ` ${result.stderr}` : "";
          return yield* new RalphieError({
            message: `${description} is not a valid Git branch name.${detail}`,
          });
        }
      });

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

    const branchExists = (repositoryPath: string, branch: string) =>
      Effect.gen(function* () {
        const result = yield* runner.run("git", [
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
        return yield* new RalphieError({
          message: `Failed to inspect local branch ${branch}.${detail}`,
        });
      });

    const resolveCommit = (repositoryPath: string, sha: string) =>
      runGit(
        runner,
        repositoryPath,
        ["rev-parse", "--verify", `${sha}^{commit}`],
        "Failed to resolve the requested Git base commit",
      );

    return {
      stageAll: (repositoryPath) =>
        runGit(
          runner,
          repositoryPath,
          ["add", "--all"],
          "Failed to stage all issue changes",
        ).pipe(Effect.asVoid),

      readStagedBinaryDiff: (repositoryPath) =>
        runGit(
          runner,
          repositoryPath,
          ["diff", "--cached", "--binary"],
          "Failed to read the staged issue diff",
          false,
        ),

      hasStagedChanges: (repositoryPath) =>
        Effect.gen(function* () {
          const result = yield* runner.run("git", [
            "-C",
            repositoryPath,
            "diff",
            "--cached",
            "--quiet",
          ]);
          if (result.exitCode === 0) return false;
          if (result.exitCode === 1) return true;
          const detail = result.stderr ? ` ${result.stderr}` : "";
          return yield* new RalphieError({
            message: `Failed to inspect staged issue changes.${detail}`,
          });
        }),

      commit: (repositoryPath, message) =>
        Effect.gen(function* () {
          if (!validCommitMessage(message)) {
            return yield* new RalphieError({
              message:
                "Commit message subject must be non-empty and at most 72 characters; body must be non-empty when provided.",
            });
          }

          const expectedTree = yield* runGit(
            runner,
            repositoryPath,
            ["write-tree"],
            "Failed to capture the staged issue tree",
          );
          const commitArgs = ["commit", "-m", message.subject];
          if (message.body !== undefined) {
            commitArgs.push("-m", message.body);
          }
          yield* runGit(
            runner,
            repositoryPath,
            commitArgs,
            "Failed to commit the staged issue changes",
          );
          const sha = yield* runGit(
            runner,
            repositoryPath,
            ["rev-parse", "HEAD"],
            "Failed to read the created issue commit",
          );
          const actualTree = yield* runGit(
            runner,
            repositoryPath,
            ["rev-parse", "HEAD^{tree}"],
            "Failed to verify the created issue tree",
          );
          if (actualTree !== expectedTree) {
            return yield* new RalphieError({
              message: `Created issue commit ${sha} does not contain the expected staged tree.`,
            });
          }
          const status = yield* runGit(
            runner,
            repositoryPath,
            ["status", "--porcelain=v1"],
            "Failed to verify the issue checkout after commit",
          );
          if (status !== "") {
            return yield* new RalphieError({
              message: "Issue checkout is dirty after commit.",
            });
          }
          return { sha, treeSha: actualTree };
        }),

      push: (repositoryPath, branch, expectedCommitSha) =>
        Effect.gen(function* () {
          if (!validBranch(branch)) {
            return yield* new RalphieError({
              message: "Cannot push an issue commit to an empty branch name.",
            });
          }
          const result = yield* runner.run("git", [
            "-C",
            repositoryPath,
            "push",
            "--no-force",
            "origin",
            `HEAD:refs/heads/${branch}`,
          ]);
          if (result.exitCode !== 0) {
            const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
            const kind = isNonFastForward(output)
              ? GitPushFailureKind.NonFastForward
              : GitPushFailureKind.Other;
            const summary =
              kind === GitPushFailureKind.NonFastForward
                ? `Push to origin/${branch} was rejected because the remote branch moved; push failure policy is halt.`
                : `Push to origin/${branch} failed; push failure policy is halt.`;
            return yield* new GitPushError({
              kind,
              policy: GitPushFailurePolicy.Halt,
              branch,
              message:
                output.trim().length > 0 ? `${summary}\n${output.trim()}` : summary,
              cause: output,
            });
          }

          const remote = yield* runGit(
            runner,
            repositoryPath,
            ["ls-remote", "origin", `refs/heads/${branch}`],
            "Failed to verify the pushed issue commit",
          );
          const remoteSha = remote.split(/\s+/)[0] ?? "";
          if (remoteSha.toLowerCase() !== expectedCommitSha.toLowerCase()) {
            return yield* new RalphieError({
              message: `Remote origin/${branch} points to ${remoteSha || "no commit"}, expected ${expectedCommitSha}.`,
            });
          }
          const status = yield* runGit(
            runner,
            repositoryPath,
            ["status", "--porcelain=v1"],
            "Failed to verify the issue checkout after push",
          );
          if (status !== "") {
            return yield* new RalphieError({
              message: "Issue checkout is dirty after push.",
            });
          }
        }),

      createOrCheckoutFeatureBranch: (repositoryPath, branch, baseBranch, baseSha) =>
        Effect.gen(function* () {
          yield* validateBranchName(repositoryPath, branch, "Feature branch");
          yield* validateBranchName(repositoryPath, baseBranch, "Base branch");
          if (branch === baseBranch) {
            return yield* new RalphieError({
              message: "Feature branch must differ from the base branch.",
            });
          }
          if (!validGitSha.test(baseSha)) {
            return yield* new RalphieError({
              message: `Refusing to create a feature branch from invalid Git base commit: ${baseSha}.`,
            });
          }

          const resolvedBaseSha = yield* resolveCommit(repositoryPath, baseSha);
          if (resolvedBaseSha.toLowerCase() !== baseSha.toLowerCase()) {
            return yield* new RalphieError({
              message: `Requested Git base commit ${baseSha} resolved to ${resolvedBaseSha}.`,
            });
          }

          const exists = yield* branchExists(repositoryPath, branch);
          const actualBranch = yield* currentBranch(repositoryPath);
          if (exists) {
            const branchSha = yield* runGit(
              runner,
              repositoryPath,
              ["rev-parse", `refs/heads/${branch}^{commit}`],
              `Failed to read feature branch ${branch}`,
            );
            const ancestry = yield* runner.run("git", [
              "-C",
              repositoryPath,
              "merge-base",
              "--is-ancestor",
              baseSha,
              `refs/heads/${branch}`,
            ]);
            if (ancestry.exitCode !== 0) {
              if (ancestry.exitCode === 1) {
                return yield* new RalphieError({
                  message: `Existing feature branch ${branch} is not based on ${baseSha}; refusing to resume it.`,
                });
              }
              const detail = ancestry.stderr ? ` ${ancestry.stderr}` : "";
              return yield* new RalphieError({
                message: `Failed to verify the ancestry of feature branch ${branch}.${detail}`,
              });
            }

            if (actualBranch !== branch) {
              if ((yield* status(repositoryPath)) !== "") {
                return yield* new RalphieError({
                  message: `Cannot checkout feature branch ${branch}; the current checkout is dirty.`,
                });
              }
              yield* runGit(
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
          }

          if ((yield* status(repositoryPath)) !== "") {
            return yield* new RalphieError({
              message: `Cannot create feature branch ${branch}; the current checkout is dirty.`,
            });
          }
          yield* runGit(
            runner,
            repositoryPath,
            ["checkout", "-b", branch, baseSha],
            `Failed to create feature branch ${branch}`,
          );
          const headSha = yield* runGit(
            runner,
            repositoryPath,
            ["rev-parse", "HEAD"],
            "Failed to verify the created feature branch",
          );
          if (headSha.toLowerCase() !== baseSha.toLowerCase()) {
            return yield* new RalphieError({
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
        }),

      restoreBaseCheckout: (repositoryPath, baseBranch) =>
        Effect.gen(function* () {
          yield* validateBranchName(repositoryPath, baseBranch, "Base branch");
          if ((yield* status(repositoryPath)) !== "") {
            return yield* new RalphieError({
              message: "Cannot restore the base checkout while it is dirty.",
            });
          }
          yield* runGit(
            runner,
            repositoryPath,
            ["fetch", "--prune", "origin"],
            "Failed to fetch the merged base branch from origin",
          );
          const originSha = yield* runGit(
            runner,
            repositoryPath,
            ["rev-parse", "--verify", `refs/remotes/origin/${baseBranch}^{commit}`],
            `Failed to resolve origin/${baseBranch}`,
          );
          yield* runGit(
            runner,
            repositoryPath,
            ["checkout", "-B", baseBranch, `refs/remotes/origin/${baseBranch}`],
            `Failed to checkout base branch ${baseBranch}`,
          );
          yield* runGit(
            runner,
            repositoryPath,
            ["reset", "--hard", `refs/remotes/origin/${baseBranch}`],
            "Failed to reset the base checkout to origin",
          );
          yield* runGit(
            runner,
            repositoryPath,
            ["clean", "-fd"],
            "Failed to remove files left by the merged feature branch",
          );
          const restoredBranch = yield* currentBranch(repositoryPath);
          const restoredSha = yield* runGit(
            runner,
            repositoryPath,
            ["rev-parse", "HEAD"],
            "Failed to verify the restored base checkout",
          );
          if (
            restoredBranch !== baseBranch ||
            restoredSha.toLowerCase() !== originSha.toLowerCase() ||
            (yield* status(repositoryPath)) !== ""
          ) {
            return yield* new RalphieError({
              message: `Base checkout restoration did not produce a clean ${baseBranch} checkout at origin/${baseBranch}.`,
            });
          }
        }),
    } satisfies GitIssueOperationsService;
  }),
);
