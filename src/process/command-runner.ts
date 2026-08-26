import { Context, Effect, Layer } from "effect";

import { RalphieError } from "../shared/error.ts";

export type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type CommandRunOptions = {
  readonly trimStdout?: boolean;
};

export type CommandRunnerService = {
  readonly run: (
    command: string,
    args: ReadonlyArray<string>,
    options?: CommandRunOptions,
  ) => Effect.Effect<CommandResult, RalphieError>;
};

export const CommandRunner = Context.GenericTag<CommandRunnerService>(
  "ralphie/CommandRunner",
);

export const CommandRunnerLive = Layer.succeed(CommandRunner, {
  run: (command, args, options) =>
    Effect.try({
      try: () => {
        const result = Bun.spawnSync([command, ...args], {
          stdout: "pipe",
          stderr: "pipe",
        });

        return {
          exitCode: result.exitCode,
          stdout:
            options?.trimStdout === false
              ? result.stdout.toString()
              : result.stdout.toString().trim(),
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

export const requireSuccessfulCommand = (
  runner: CommandRunnerService,
  command: string,
  args: ReadonlyArray<string>,
  failureMessage: string,
) =>
  Effect.gen(function* () {
    const result = yield* runner.run(command, args);
    if (result.exitCode !== 0) {
      const detail = result.stderr ? `\n${result.stderr}` : "";
      return yield* new RalphieError({
        message: `${failureMessage}${detail}`,
      });
    }
    return result;
  });