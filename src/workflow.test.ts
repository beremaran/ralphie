import { describe, expect, test } from "bun:test";
import { Effect, Exit, Layer } from "effect";
import type { Octokit } from "octokit";

import {
  CommandRunner,
  OctokitClient,
  OpenCode,
  RalphieError,
  Workspace,
  type CommandResult,
} from "./services.ts";
import { workflow } from "./workflow.ts";

type TestRuntimeOptions = {
  commandResults?: CommandResult[];
  startFailure?: RalphieError;
};

function testRuntime(calls: string[], options: TestRuntimeOptions = {}) {
  const commandResults = [...(options.commandResults ?? [])];

  return Layer.mergeAll(
    Layer.succeed(CommandRunner, {
      run: (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        return Effect.succeed(
          commandResults.shift() ?? {
            exitCode: 0,
            stdout: args[1] === "token" ? "test-token" : "",
            stderr: "",
          },
        );
      },
    }),
    Layer.succeed(OctokitClient, {
      create: (authToken) => {
        calls.push(`initializeOctokit:${authToken}`);
        return Effect.succeed({} as Octokit);
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
    Layer.succeed(Workspace, {
      remove: (workspace) =>
        Effect.sync(() => {
          calls.push(`removeWorkspace:${workspace}`);
        }),
    }),
  );
}

describe("workflow", () => {
  test("checks dependencies, starts OpenCode, and releases it", async () => {
    const calls: string[] = [];

    await workflow({
      repo: "owner/repo",
      branch: "develop",
      maxIssues: 5,
      workspace: "/tmp/ralphie",
      cleanup: true,
    }).pipe(
      Effect.provide(testRuntime(calls)),
      Effect.runPromise,
    );

    expect(calls).toEqual([
      "gh auth status",
      "gh auth token",
      "initializeOctokit:test-token",
      "git --version",
      "startServer",
      "closeServer",
      "removeWorkspace:/tmp/ralphie",
    ]);
  });

  test("stops when GitHub authentication fails", async () => {
    const calls: string[] = [];
    const exit = await workflow({
      repo: "owner/repo",
      branch: "main",
      workspace: "~/.ralphie",
      cleanup: true,
    }).pipe(
      Effect.provide(
        testRuntime(calls, {
          commandResults: [
            { exitCode: 1, stdout: "", stderr: "not logged in" },
          ],
        }),
      ),
      Effect.runPromiseExit,
    );

    expect(Exit.isFailure(exit)).toBeTrue();
    expect(calls).toEqual(["gh auth status"]);
  });

  test("stops when git is unavailable", async () => {
    const calls: string[] = [];
    const exit = await workflow({
      repo: "owner/repo",
      branch: "main",
      workspace: "~/.ralphie",
      cleanup: false,
    }).pipe(
      Effect.provide(
        testRuntime(calls, {
          commandResults: [
            { exitCode: 0, stdout: "", stderr: "" },
            { exitCode: 0, stdout: "test-token", stderr: "" },
            { exitCode: 1, stdout: "", stderr: "" },
          ],
        }),
      ),
      Effect.runPromiseExit,
    );

    expect(Exit.isFailure(exit)).toBeTrue();
    expect(calls).toEqual([
      "gh auth status",
      "gh auth token",
      "initializeOctokit:test-token",
      "git --version",
    ]);
  });

  test("rejects an empty GitHub token", async () => {
    const calls: string[] = [];
    const exit = await workflow({
      repo: "owner/repo",
      branch: "main",
      workspace: "~/.ralphie",
      cleanup: false,
    }).pipe(
      Effect.provide(
        testRuntime(calls, {
          commandResults: [
            { exitCode: 0, stdout: "", stderr: "" },
            { exitCode: 0, stdout: "", stderr: "" },
          ],
        }),
      ),
      Effect.runPromiseExit,
    );

    expect(Exit.isFailure(exit)).toBeTrue();
    expect(calls).toEqual(["gh auth status", "gh auth token"]);
  });
});
