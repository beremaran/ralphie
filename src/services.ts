import { createOpencodeServer } from "@opencode-ai/sdk";
import { Context, Data, Effect, Layer } from "effect";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { parse, resolve, sep } from "node:path";
import { Octokit } from "octokit";

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

export const LiveRuntime = Layer.mergeAll(
  CommandRunnerLive,
  OctokitLive,
  OpenCodeLive,
  WorkspaceLive,
);
