import { createOpencodeServer } from "@opencode-ai/sdk";
import { Context, Data, Effect, Layer } from "effect";

export class RalphieError extends Data.TaggedError("RalphieError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type CommandResult = {
  readonly exitCode: number;
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
          stdout: "ignore",
          stderr: "pipe",
        });

        return {
          exitCode: result.exitCode,
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

export const LiveRuntime = Layer.merge(CommandRunnerLive, OpenCodeLive);
