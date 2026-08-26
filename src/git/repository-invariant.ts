import { Context, Effect, Layer } from "effect";

import {
  CommandRunner,
  type CommandRunnerService,
} from "../process/command-runner.ts";
import { RalphieError } from "../shared/error.ts";

export type GitRepositoryInvariant = {
  readonly branch: string;
  readonly head: string;
};

export type GitRepositoryInvariantService = {
  readonly capture: (
    repositoryPath: string,
  ) => Effect.Effect<GitRepositoryInvariant, RalphieError>;
  readonly verify: (
    repositoryPath: string,
    expected: GitRepositoryInvariant,
  ) => Effect.Effect<void, RalphieError>;
};

export const GitRepositoryInvariant =
  Context.GenericTag<GitRepositoryInvariantService>(
    "ralphie/GitRepositoryInvariant",
  );

const runGit = (
  runner: CommandRunnerService,
  repositoryPath: string,
  args: ReadonlyArray<string>,
  failureMessage: string,
) =>
  Effect.gen(function* () {
    const result = yield* runner.run("git", ["-C", repositoryPath, ...args]);
    if (result.exitCode !== 0) {
      const detail = result.stderr ? ` ${result.stderr}` : "";
      return yield* new RalphieError({
        message: `${failureMessage}.${detail}`,
      });
    }
    return result.stdout;
  });

const readInvariant = (
  runner: CommandRunnerService,
  repositoryPath: string,
): Effect.Effect<GitRepositoryInvariant, RalphieError> =>
  Effect.gen(function* () {
    const branch = yield* runGit(
      runner,
      repositoryPath,
      ["rev-parse", "--abbrev-ref", "HEAD"],
      "Failed to read the repository branch",
    );
    const head = yield* runGit(
      runner,
      repositoryPath,
      ["rev-parse", "HEAD"],
      "Failed to read the repository HEAD",
    );

    if (!branch || !head) {
      return yield* new RalphieError({
        message:
          "Git returned an empty branch or HEAD while checking the repository invariant.",
      });
    }

    return {
      branch,
      head,
    };
  });

export const makeGitRepositoryInvariantService = (
  runner: CommandRunnerService,
): GitRepositoryInvariantService => ({
  capture: (repositoryPath) => readInvariant(runner, repositoryPath),
  verify: (repositoryPath, expected) =>
    Effect.gen(function* () {
      const actual = yield* readInvariant(runner, repositoryPath);
      if (actual.branch !== expected.branch) {
        return yield* new RalphieError({
          message: `Repository branch changed from ${expected.branch} to ${actual.branch}.`,
        });
      }
      if (actual.head.toLowerCase() !== expected.head.toLowerCase()) {
        return yield* new RalphieError({
          message: `Repository HEAD changed from ${expected.head} to ${actual.head}.`,
        });
      }
    }),
});

export const GitRepositoryInvariantLive = Layer.effect(
  GitRepositoryInvariant,
  Effect.gen(function* () {
    return makeGitRepositoryInvariantService(yield* CommandRunner);
  }),
);