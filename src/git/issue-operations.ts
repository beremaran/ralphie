import { Context, Effect, Layer } from "effect";

import type { CommandRunnerService } from "../process/command-runner.ts";
import { CommandRunner } from "../process/command-runner.ts";
import { RalphieError } from "../shared/error.ts";

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
          const result = yield* runner.run(
            "git",
            ["-C", repositoryPath, "diff", "--cached", "--quiet"],
          );
          if (result.exitCode === 0) return false;
          if (result.exitCode === 1) return true;
          const detail = result.stderr ? ` ${result.stderr}` : "";
          return yield* new RalphieError({
            message: `Failed to inspect staged issue changes.${detail}`,
          });
        }),
    } satisfies GitIssueOperationsService;
  }),
);
