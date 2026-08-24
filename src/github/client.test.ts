import { describe, expect, test } from "bun:test";
import { Effect, Exit, Layer } from "effect";
import { Octokit } from "octokit";

import { GitHubClient, GitHubClientLive } from "./client.ts";
import {
  CommandRunner,
  type CommandResult,
} from "../process/command-runner.ts";

const testLayer = (calls: string[], results: CommandResult[]) =>
  GitHubClientLive.pipe(
    Layer.provide(
      Layer.succeed(CommandRunner, {
        run: (command, args) => {
          calls.push(`${command} ${args.join(" ")}`);
          return Effect.succeed(
            results.shift() ?? { exitCode: 0, stdout: "", stderr: "" },
          );
        },
      }),
    ),
  );

const initialize = Effect.gen(function* () {
  const github = yield* GitHubClient;
  return yield* github.initialize;
});

describe("GitHub client", () => {
  test("checks auth, retrieves the token, and initializes Octokit", async () => {
    const calls: string[] = [];
    const client = await initialize.pipe(
      Effect.provide(
        testLayer(calls, [
          { exitCode: 0, stdout: "", stderr: "" },
          { exitCode: 0, stdout: "test-token", stderr: "" },
        ]),
      ),
      Effect.runPromise,
    );

    expect(client).toBeInstanceOf(Octokit);
    expect(calls).toEqual(["gh auth status", "gh auth token"]);
  });

  test("stops when authentication fails", async () => {
    const calls: string[] = [];
    const exit = await initialize.pipe(
      Effect.provide(
        testLayer(calls, [
          { exitCode: 1, stdout: "", stderr: "not logged in" },
        ]),
      ),
      Effect.runPromiseExit,
    );

    expect(Exit.isFailure(exit)).toBeTrue();
    expect(calls).toEqual(["gh auth status"]);
  });

  test("rejects an empty token", async () => {
    const calls: string[] = [];
    const exit = await initialize.pipe(
      Effect.provide(
        testLayer(calls, [
          { exitCode: 0, stdout: "", stderr: "" },
          { exitCode: 0, stdout: "", stderr: "" },
        ]),
      ),
      Effect.runPromiseExit,
    );

    expect(Exit.isFailure(exit)).toBeTrue();
    expect(calls).toEqual(["gh auth status", "gh auth token"]);
  });
});
