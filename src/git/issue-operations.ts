import { Context, Data, Effect, Layer } from "effect";

import type { CommitMessageDecision } from "../issues/decisions.ts";
import type { CommandRunnerService } from "../process/command-runner.ts";
import { CommandRunner } from "../process/command-runner.ts";
import { RalphieError } from "../shared/error.ts";

export enum GitPushFailureKind {
  NonFastForward = "non-fast-forward",
  Other = "other",
}

/** Remote movement is deliberately halted until a future policy is chosen. */
export enum GitRemoteMovementPolicy {
  Halt = "halt",
}

export class GitPushError extends Data.TaggedError("GitPushError")<{
  readonly kind: GitPushFailureKind;
  readonly policy: GitRemoteMovementPolicy.Halt;
  readonly branch: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type GitIssueOperationError = RalphieError | GitPushError;

export type GitCommitResult = {
  readonly sha: string;
  readonly treeSha: string;
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

const validCommitMessage = (message: CommitMessageDecision): boolean =>
  message.subject.trim().length > 0 &&
  message.subject.length <= 72 &&
  (message.body === undefined || message.body.trim().length > 0);

const isNonFastForward = (output: string): boolean =>
  /non-fast-forward|fetch first|failed to push some refs|rejected/i.test(output);

export const GitIssueOperationsLive = Layer.effect(
  GitIssueOperations,
  Effect.gen(function* () {
    const runner = yield* CommandRunner;

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
            return yield* new GitPushError({
              kind,
              policy: GitRemoteMovementPolicy.Halt,
              branch,
              message: `Failed to push issue commit to origin/${branch}; remote movement policy is halt.${
                result.stderr ? ` ${result.stderr}` : ""
              }`,
              cause: result.stderr,
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
    } satisfies GitIssueOperationsService;
  }),
);
