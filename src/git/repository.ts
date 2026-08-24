import { Context, Effect, Layer } from "effect";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import simpleGit from "simple-git";

import { parseRepositorySlug } from "../github/repository.ts";
import { CommandRunner, requireSuccessfulCommand } from "../process/command-runner.ts";
import { RalphieError } from "../shared/error.ts";
import { resolveWorkspacePath } from "../workspace/workspace.ts";

export type PreparedRepository = {
  readonly path: string;
  readonly cloned: boolean;
  readonly branchChanged: boolean;
  readonly cleaned: boolean;
};

export type GitRepositoryService = {
  readonly verifyInstalled: Effect.Effect<void, RalphieError>;
  readonly prepare: (
    repository: string,
    branch: string,
    workspace: string,
  ) => Effect.Effect<PreparedRepository, RalphieError>;
};

export const GitRepository = Context.GenericTag<GitRepositoryService>(
  "ralphie/GitRepository",
);

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
};

export const GitRepositoryLive = Layer.effect(
  GitRepository,
  Effect.gen(function* () {
    const runner = yield* CommandRunner;

    return {
      verifyInstalled: requireSuccessfulCommand(
        runner,
        "git",
        ["--version"],
        "Git is not installed or is not available on PATH.",
      ).pipe(Effect.asVoid),

      prepare: (repository, branch, workspace) =>
        Effect.gen(function* () {
          const parsed = yield* Effect.try({
            try: () => parseRepositorySlug(repository),
            catch: (cause) =>
              cause instanceof RalphieError
                ? cause
                : new RalphieError({
                    message: `Invalid GitHub repository: ${repository}.`,
                    cause,
                  }),
          });
          const workspacePath = resolveWorkspacePath(workspace);
          const repositoryPath = join(workspacePath, parsed.owner, parsed.name);

          const exists = yield* Effect.tryPromise({
            try: async () => {
              await mkdir(workspacePath, { recursive: true });
              return pathExists(repositoryPath);
            },
            catch: (cause) =>
              new RalphieError({
                message: `Failed to prepare workspace: ${workspacePath}`,
                cause,
              }),
          });

          if (!exists) {
            const clone = yield* runner.run("gh", [
              "repo",
              "clone",
              parsed.slug,
              repositoryPath,
            ]);
            if (clone.exitCode !== 0) {
              const detail = clone.stderr ? `\n${clone.stderr}` : "";
              return yield* new RalphieError({
                message: `Failed to clone ${parsed.slug}.${detail}`,
              });
            }
          }

          const repositoryState = yield* Effect.tryPromise({
            try: async () => {
              const git = simpleGit(repositoryPath);
              if (!(await git.checkIsRepo())) {
                throw new Error(`${repositoryPath} is not a Git repository.`);
              }

              const remotes = await git.getRemotes(true);
              const origin = remotes.find((remote) => remote.name === "origin");
              const originUrl = origin?.refs.fetch;
              if (!originUrl) {
                throw new Error(`${repositoryPath} has no origin remote.`);
              }

              const originSlug = parseRepositorySlug(originUrl).slug;
              if (originSlug.toLowerCase() !== parsed.slug.toLowerCase()) {
                throw new Error(
                  `${repositoryPath} contains ${originSlug}, not ${parsed.slug}.`,
                );
              }

              if (exists) {
                await git.raw(["fetch", "--prune", "origin"]);
              }

              const status = await git.status();
              const cleaned = exists && !status.isClean();
              if (cleaned) {
                await git.raw(["reset", "--hard"]);
                await git.raw(["clean", "-fd"]);
              }

              const currentBranch = (
                await git.revparse(["--abbrev-ref", "HEAD"])
              ).trim();
              const branchChanged = currentBranch !== branch;
              if (branchChanged) {
                await git.checkout(branch);
              }

              if (cleaned) {
                await git.raw(["reset", "--hard", `origin/${branch}`]);
                await git.raw(["clean", "-fd"]);
              }

              return { branchChanged, cleaned };
            },
            catch: (cause) =>
              new RalphieError({
                message: `Failed to prepare ${parsed.slug} on branch ${branch}.`,
                cause,
              }),
          });

          return {
            path: repositoryPath,
            cloned: !exists,
            ...repositoryState,
          };
        }),
    };
  }),
);
