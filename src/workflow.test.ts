import { describe, expect, test } from "bun:test";
import { Effect, Exit, Layer } from "effect";

import {
  CommandRunner,
  OpenCode,
  RalphieError,
  type CommandResult,
} from "./services.ts";
import { workflow } from "./workflow.ts";

type TestRuntimeOptions = {
  commandResults?: CommandResult[];
  startFailure?: RalphieError;
};

function testRuntime(calls: string[], options: TestRuntimeOptions = {}) {
  const commandResults = [...(options.commandResults ?? [])];

  return Layer.merge(
    Layer.succeed(CommandRunner, {
      run: (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        return Effect.succeed(
          commandResults.shift() ?? { exitCode: 0, stderr: "" },
        );
      },
    }),
    Layer.succeed(OpenCode, {
      start: options.startFailure
        ? Effect.fail(options.startFailure)
        : Effect.sync(() => {
            calls.push("startServer");
            return {
              url: "http://127.0.0.1:4096",
              close: () => calls.push("closeServer"),
            };
          }),
    }),
  );
}

describe("workflow", () => {
  test("checks dependencies, starts OpenCode, and releases it", async () => {
    const calls: string[] = [];

    await workflow("owner/repo", "develop").pipe(
      Effect.provide(testRuntime(calls)),
      Effect.runPromise,
    );

    expect(calls).toEqual([
      "gh auth status",
      "git --version",
      "startServer",
      "closeServer",
    ]);
  });

  test("stops when GitHub authentication fails", async () => {
    const calls: string[] = [];
    const exit = await workflow("owner/repo", "main").pipe(
      Effect.provide(
        testRuntime(calls, {
          commandResults: [{ exitCode: 1, stderr: "not logged in" }],
        }),
      ),
      Effect.runPromiseExit,
    );

    expect(Exit.isFailure(exit)).toBeTrue();
    expect(calls).toEqual(["gh auth status"]);
  });

  test("stops when git is unavailable", async () => {
    const calls: string[] = [];
    const exit = await workflow("owner/repo", "main").pipe(
      Effect.provide(
        testRuntime(calls, {
          commandResults: [
            { exitCode: 0, stderr: "" },
            { exitCode: 1, stderr: "" },
          ],
        }),
      ),
      Effect.runPromiseExit,
    );

    expect(Exit.isFailure(exit)).toBeTrue();
    expect(calls).toEqual(["gh auth status", "git --version"]);
  });
});
