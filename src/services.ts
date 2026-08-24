import { createOpencodeServer } from "@opencode-ai/sdk";
import { Context, Data, Effect, Layer } from "effect";
import { mkdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, parse, resolve, sep } from "node:path";
import { Octokit } from "octokit";
import simpleGit from "simple-git";

export class RalphieError extends Data.TaggedError("RalphieError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type CommandRunnerService = {
  readonly run: (
    command: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<CommandResult, RalphieError>;
};

export const CommandRunner =
  Context.GenericTag<CommandRunnerService>("ralphie/CommandRunner");

export const CommandRunnerLive = Layer.succeed(CommandRunner, {
  run: (command, args) =>
    Effect.try({
      try: () => {
        const result = Bun.spawnSync([command, ...args], {
          stdout: "pipe",
          stderr: "pipe",
        });

        return {
          exitCode: result.exitCode,
          stdout: result.stdout.toString().trim(),
          stderr: result.stderr.toString().trim(),
        };
      },
      catch: (cause) =>
        new RalphieError({
          message: `Could not execute ${command}. Is it installed and available on PATH?`,
          cause,
        }),
    }),
});

export type OpenCodeServer = {
  readonly url: string;
  readonly close: () => void;
};

export type OpenCodeService = {
  readonly start: Effect.Effect<OpenCodeServer, RalphieError>;
};

export const OpenCode =
  Context.GenericTag<OpenCodeService>("ralphie/OpenCode");

export const OpenCodeLive = Layer.succeed(OpenCode, {
  start: Effect.tryPromise({
    try: () => createOpencodeServer(),
    catch: (cause) =>
      new RalphieError({
        message: "Failed to start the OpenCode server.",
        cause,
      }),
  }),
});

export type OctokitService = {
  readonly create: (
    authToken: string,
  ) => Effect.Effect<Octokit, RalphieError>;
};

export const OctokitClient =
  Context.GenericTag<OctokitService>("ralphie/OctokitClient");

export const OctokitLive = Layer.succeed(OctokitClient, {
  create: (authToken) =>
    Effect.try({
      try: () => new Octokit({ auth: authToken }),
      catch: (cause) =>
        new RalphieError({
          message: "Failed to initialize Octokit.",
          cause,
        }),
  }),
});

export const resolveWorkspacePath = (workspace: string): string => {
  if (workspace === "~") {
    return homedir();
  }
  if (workspace.startsWith("~/")) {
    return resolve(homedir(), workspace.slice(2));
  }
  if (workspace.startsWith("~")) {
    throw new RalphieError({
      message: `Unsupported workspace path: ${workspace}`,
    });
  }
  return resolve(workspace);
};

const assertSafeCleanupTarget = (workspace: string): string => {
  const target = resolveWorkspacePath(workspace);
  const currentDirectory = resolve(process.cwd());
  const protectedPaths = new Set([
    parse(target).root,
    resolve(homedir()),
    currentDirectory,
  ]);

  const containsCurrentDirectory = currentDirectory.startsWith(`${target}${sep}`);
  if (protectedPaths.has(target) || containsCurrentDirectory) {
    throw new RalphieError({
      message: `Refusing to clean up protected workspace path: ${target}`,
    });
  }

  return target;
};

export type WorkspaceService = {
  readonly remove: (workspace: string) => Effect.Effect<void, RalphieError>;
};

export const Workspace =
  Context.GenericTag<WorkspaceService>("ralphie/Workspace");

export const WorkspaceLive = Layer.succeed(Workspace, {
  remove: (workspace) =>
    Effect.tryPromise({
      try: () => rm(assertSafeCleanupTarget(workspace), { recursive: true, force: true }),
      catch: (cause) =>
        cause instanceof RalphieError
          ? cause
          : new RalphieError({
              message: `Failed to clean up workspace: ${workspace}`,
              cause,
            }),
    }),
});

type RepositorySlug = {
  readonly slug: string;
  readonly name: string;
};

export const parseRepositorySlug = (repository: string): RepositorySlug => {
  const value = repository.trim().replace(/\/$/, "").replace(/\.git$/, "");
  const match =
    value.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)$/i) ??
    value.match(/^git@github\.com:([^/]+)\/([^/]+)$/i) ??
    value.match(/^([^/\s]+)\/([^/\s]+)$/);

  const owner = match?.[1];
  const name = match?.[2];
  const safeSegment = /^[a-zA-Z0-9_.-]+$/;
  if (
    !owner ||
    !name ||
    !safeSegment.test(owner) ||
    !safeSegment.test(name) ||
    owner === "." ||
    owner === ".." ||
    name === "." ||
    name === ".."
  ) {
    throw new RalphieError({
      message: `Invalid GitHub repository: ${repository}. Expected owner/repository.`,
    });
  }

  return { slug: `${owner}/${name}`, name };
};

export type PreparedRepository = {
  readonly path: string;
  readonly cloned: boolean;
  readonly branchChanged: boolean;
};

export type RepositoryService = {
  readonly prepare: (
    repository: string,
    branch: string,
    workspace: string,
  ) => Effect.Effect<PreparedRepository, RalphieError>;
};

export const Repository =
  Context.GenericTag<RepositoryService>("ralphie/Repository");

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

export const RepositoryLive = Layer.effect(
  Repository,
  Effect.gen(function* () {
    const commandRunner = yield* CommandRunner;

    return {
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
          const repositoryPath = join(workspacePath, parsed.name);

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
            const clone = yield* commandRunner.run("gh", [
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

          const branchChanged = yield* Effect.tryPromise({
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

              const currentBranch = (
                await git.revparse(["--abbrev-ref", "HEAD"])
              ).trim();
              if (currentBranch === branch) {
                return false;
              }

              await git.checkout(branch);
              return true;
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
            branchChanged,
          };
        }),
    };
  }),
);

const RepositoryLiveWithCommandRunner = RepositoryLive.pipe(
  Layer.provide(CommandRunnerLive),
);

export const LiveRuntime = Layer.mergeAll(
  CommandRunnerLive,
  OctokitLive,
  OpenCodeLive,
  RepositoryLiveWithCommandRunner,
  WorkspaceLive,
);
