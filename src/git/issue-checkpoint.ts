import { Context, Effect, Layer } from "effect";

import type { CommandRunnerService } from "../process/command-runner.ts";
import { CommandRunner } from "../process/command-runner.ts";
import { RalphieError } from "../shared/error.ts";

export type IssueCheckpoint = {
  readonly branch: string;
  readonly sha: string;
};

export type GitIssueCheckpointService = {
  readonly capture: (
    repositoryPath: string,
    branch: string,
  ) => Effect.Effect<IssueCheckpoint, RalphieError>;
  readonly createPatch: (
    repositoryPath: string,
  ) => Effect.Effect<string, RalphieError>;
  readonly restore: (
    repositoryPath: string,
    checkpoint: IssueCheckpoint,
  ) => Effect.Effect<void, RalphieError>;
};

export const GitIssueCheckpoint = Context.GenericTag<GitIssueCheckpointService>(
  "ralphie/GitIssueCheckpoint",
);

const runGit = (
  runner: CommandRunnerService,
  repositoryPath: string,
  args: ReadonlyArray<string>,
  failureMessage: string,
  trimStdout = true,
) =>
  Effect.gen(function* () {
    const result = yield* runner.run(
      "git",
      ["-C", repositoryPath, ...args],
      { trimStdout },
    );
    if (result.exitCode !== 0) {
      const detail = result.stderr ? ` ${result.stderr}` : "";
      return yield* new RalphieError({ message: `${failureMessage}.${detail}` });
    }
    return result.stdout;
  });

const validGitSha = /^[0-9a-f]{40}([0-9a-f]{24})?$/i;

export const GitIssueCheckpointLive = Layer.effect(
  GitIssueCheckpoint,
  Effect.gen(function* () {
    const runner = yield* CommandRunner;

    const currentBranch = (repositoryPath: string) =>
      runGit(
        runner,
        repositoryPath,
        ["rev-parse", "--abbrev-ref", "HEAD"],
        "Failed to read the current branch",
      );

    const status = (repositoryPath: string) =>
      runGit(
        runner,
        repositoryPath,
        ["status", "--porcelain=v1"],
        "Failed to inspect the repository status",
      );

    return {
      capture: (repositoryPath, branch) =>
        Effect.gen(function* () {
          const actualBranch = yield* currentBranch(repositoryPath);
          if (actualBranch !== branch) {
            return yield* new RalphieError({
              message: `Cannot checkpoint ${branch}; checkout is on ${actualBranch}.`,
            });
          }
          if ((yield* status(repositoryPath)) !== "") {
            return yield* new RalphieError({
              message: "Cannot checkpoint a dirty issue checkout.",
            });
          }

          const sha = yield* runGit(
            runner,
            repositoryPath,
            ["rev-parse", "HEAD"],
            "Failed to capture the issue base commit",
          );
          if (!validGitSha.test(sha)) {
            return yield* new RalphieError({
              message: `Git returned an invalid issue base commit: ${sha}.`,
            });
          }
          return { branch, sha };
        }),

      createPatch: (repositoryPath) =>
        runGit(
          runner,
          repositoryPath,
          ["diff", "--cached", "--binary"],
          "Failed to preserve the unsuccessful implementation patch",
          false,
        ),

      restore: (repositoryPath, checkpoint) =>
        Effect.gen(function* () {
          if (!validGitSha.test(checkpoint.sha)) {
            return yield* new RalphieError({
              message: `Refusing to restore invalid Git commit: ${checkpoint.sha}.`,
            });
          }

          const branch = yield* currentBranch(repositoryPath);
          if (branch !== checkpoint.branch) {
            return yield* new RalphieError({
              message: `Refusing to restore ${checkpoint.branch}; checkout is on ${branch}.`,
            });
          }

          yield* runGit(
            runner,
            repositoryPath,
            ["reset", "--hard", checkpoint.sha],
            "Failed to restore the issue base commit",
          );
          yield* runGit(
            runner,
            repositoryPath,
            ["clean", "-fd"],
            "Failed to remove files created by the unsuccessful implementation",
          );

          const restoredSha = yield* runGit(
            runner,
            repositoryPath,
            ["rev-parse", "HEAD"],
            "Failed to verify the restored commit",
          );
          const restoredStatus = yield* status(repositoryPath);
          if (
            restoredSha.toLowerCase() !== checkpoint.sha.toLowerCase() ||
            restoredStatus !== ""
          ) {
            return yield* new RalphieError({
              message: "Issue checkout restoration did not produce the expected clean state.",
            });
          }
        }),
    };
  }),
);
