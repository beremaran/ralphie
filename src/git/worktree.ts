import { Context, Effect, Layer } from "effect";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { ProjectRepositoryCheckout } from "../project/project.ts";
import { CommandRunner, type CommandRunnerService } from "../process/command-runner.ts";
import { RalphieError } from "../shared/error.ts";
import { resolveWorkspacePath } from "../workspace/workspace.ts";

export type PreparedIssueWorktrees = {
  readonly path: string;
  readonly repositories: ReadonlyArray<ProjectRepositoryCheckout>;
};

export type GitWorktreeService = {
  readonly prepareIssue: (input: {
    readonly workspace: string;
    readonly runId: string;
    readonly issueNumber: number;
    readonly branch: string;
    readonly repositories: ReadonlyArray<ProjectRepositoryCheckout>;
    readonly baseShas: Readonly<Record<string, string>>;
  }) => Effect.Effect<PreparedIssueWorktrees, RalphieError>;
  readonly removeIssue: (
    sourceRepositories: ReadonlyArray<ProjectRepositoryCheckout>,
    prepared: PreparedIssueWorktrees,
  ) => Effect.Effect<void, RalphieError>;
};

export const GitWorktrees =
  Context.GenericTag<GitWorktreeService>("ralphie/GitWorktrees");

const runGit = (
  runner: CommandRunnerService,
  repositoryPath: string,
  args: ReadonlyArray<string>,
  message: string,
) =>
  Effect.gen(function* () {
    const result = yield* runner.run("git", ["-C", repositoryPath, ...args]);
    if (result.exitCode !== 0) {
      return yield* new RalphieError({
        message: `${message}.${result.stderr ? ` ${result.stderr}` : ""}`,
      });
    }
    return result.stdout;
  });

export const GitWorktreesLive = Layer.effect(
  GitWorktrees,
  Effect.gen(function* () {
    const runner = yield* CommandRunner;
    return {
      prepareIssue: (input) =>
        Effect.gen(function* () {
          const root = join(
            resolveWorkspacePath(input.workspace),
            ".ralphie",
            "worktrees",
            input.runId,
            `issue-${input.issueNumber}`,
          );
          yield* Effect.tryPromise({
            try: () => mkdir(root, { recursive: true }),
            catch: (cause) =>
              new RalphieError({ message: `Failed to prepare ${root}.`, cause }),
          });
          const repositories = yield* Effect.forEach(
            input.repositories,
            (repository) =>
              Effect.gen(function* () {
                const path = join(root, basename(repository.repositoryPath));
                const baseSha = input.baseShas[repository.repository];
                if (baseSha === undefined) {
                  return yield* new RalphieError({
                    message: `Missing worktree base for ${repository.repository}.`,
                  });
                }
                const existing = yield* runner.run("git", [
                  "-C",
                  path,
                  "rev-parse",
                  "--is-inside-work-tree",
                ]);
                if (existing.exitCode !== 0) {
                  yield* Effect.tryPromise({
                    try: () => mkdir(dirname(path), { recursive: true }),
                    catch: (cause) =>
                      new RalphieError({
                        message: `Failed to prepare ${path}.`,
                        cause,
                      }),
                  });
                  const branchExists = yield* runner.run("git", [
                    "-C",
                    repository.repositoryPath,
                    "show-ref",
                    "--verify",
                    "--quiet",
                    `refs/heads/${input.branch}`,
                  ]);
                  yield* runGit(
                    runner,
                    repository.repositoryPath,
                    branchExists.exitCode === 0
                      ? ["worktree", "add", path, input.branch]
                      : ["worktree", "add", "-b", input.branch, path, baseSha],
                    `Failed to create issue worktree for ${repository.repository}`,
                  );
                }
                const branch = yield* runGit(
                  runner,
                  path,
                  ["rev-parse", "--abbrev-ref", "HEAD"],
                  `Failed to verify issue worktree for ${repository.repository}`,
                );
                if (branch !== input.branch) {
                  return yield* new RalphieError({
                    message: `Issue worktree for ${repository.repository} is on ${branch}, expected ${input.branch}.`,
                  });
                }
                return {
                  repository: repository.repository,
                  repositoryPath: path,
                  branch,
                };
              }),
            { concurrency: "unbounded" },
          );
          return { path: root, repositories };
        }),
      removeIssue: (sources, prepared) =>
        Effect.forEach(
          prepared.repositories,
          (worktree) => {
            const source = sources.find(
              ({ repository }) =>
                repository.toLowerCase() === worktree.repository.toLowerCase(),
            );
            return source === undefined
              ? Effect.fail(
                  new RalphieError({
                    message: `Missing source checkout for ${worktree.repository}.`,
                  }),
                )
              : runGit(
                  runner,
                  source.repositoryPath,
                  ["worktree", "remove", worktree.repositoryPath],
                  `Failed to remove issue worktree for ${worktree.repository}`,
                ).pipe(Effect.asVoid);
          },
          { discard: true },
        ),
    } satisfies GitWorktreeService;
  }),
);
