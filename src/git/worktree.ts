import { Context, Effect, Layer } from "effect";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { CommandRunner, type CommandRunnerService } from "../process/command-runner.ts";
import { RalphieError } from "../shared/error.ts";
import { resolveWorkspacePath } from "../workspace/workspace.ts";

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
  }) => Effect.Effect<PreparedIssueWorktree, RalphieError>;
  readonly removeIssue: (
    source: RepositoryCheckout,
    prepared: PreparedIssueWorktree,
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
          const path = join(root, basename(input.repository.repositoryPath));
          yield* Effect.tryPromise({
            try: () => mkdir(dirname(path), { recursive: true }),
            catch: (cause) =>
              new RalphieError({ message: `Failed to prepare ${path}.`, cause }),
          });

          const existing = yield* runner.run("git", [
            "-C",
            path,
            "rev-parse",
            "--is-inside-work-tree",
          ]);
          if (existing.exitCode !== 0) {
            const branchExists = yield* runner.run("git", [
              "-C",
              input.repository.repositoryPath,
              "show-ref",
              "--verify",
              "--quiet",
              `refs/heads/${input.branch}`,
            ]);
            yield* runGit(
              runner,
              input.repository.repositoryPath,
              branchExists.exitCode === 0
                ? ["worktree", "add", path, input.branch]
                : ["worktree", "add", "-b", input.branch, path, input.baseSha],
              `Failed to create issue worktree for ${input.repository.repository}`,
            );
          }
          const branch = yield* runGit(
            runner,
            path,
            ["rev-parse", "--abbrev-ref", "HEAD"],
            `Failed to verify issue worktree for ${input.repository.repository}`,
          );
          if (branch !== input.branch) {
            return yield* new RalphieError({
              message: `Issue worktree for ${input.repository.repository} is on ${branch}, expected ${input.branch}.`,
            });
          }
          return {
            path: root,
            repository: input.repository.repository,
            repositoryPath: path,
            branch,
          };
        }),
      removeIssue: (source, prepared) =>
        runGit(
          runner,
          source.repositoryPath,
          ["worktree", "remove", prepared.repositoryPath],
          `Failed to remove issue worktree for ${prepared.repository}`,
        ).pipe(Effect.asVoid),
    } satisfies GitWorktreeService;
  }),
);
