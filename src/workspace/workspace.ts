import { Context, Effect, Layer } from "effect";
import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { parse, resolve, sep } from "node:path";

import { RalphieError } from "../shared/error.ts";

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
  readonly prepare: (workspace: string) => Effect.Effect<void, RalphieError>;
  readonly remove: (workspace: string) => Effect.Effect<void, RalphieError>;
};

export const Workspace = Context.GenericTag<WorkspaceService>("ralphie/Workspace");

export const WorkspaceLive = Layer.succeed(Workspace, {
  prepare: (workspace) =>
    Effect.tryPromise({
      try: () =>
        mkdir(resolveWorkspacePath(workspace), { recursive: true }).then(() => {}),
      catch: (cause) =>
        new RalphieError({
          message: `Failed to initialize workspace: ${workspace}`,
          cause,
        }),
    }),
  remove: (workspace) =>
    Effect.tryPromise({
      try: () =>
        rm(assertSafeCleanupTarget(workspace), { recursive: true, force: true }),
      catch: (cause) =>
        cause instanceof RalphieError
          ? cause
          : new RalphieError({
              message: `Failed to clean up workspace: ${workspace}`,
              cause,
            }),
    }),
});
