import { createOpencodeServer } from "@opencode-ai/sdk";
import { Context, Data, Effect, Layer } from "effect";
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

export const LiveRuntime = Layer.mergeAll(
  CommandRunnerLive,
  OctokitLive,
  OpenCodeLive,
);
