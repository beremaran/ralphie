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
  removeFailure?: RalphieError;
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
      remove: (workspace) => {
        calls.push(`removeWorkspace:${workspace}`);
        return options.removeFailure
          ? Effect.fail(options.removeFailure)
          : Effect.void;
      },
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
      startClean: true,
    }).pipe(
      Effect.provide(testRuntime(calls)),
      Effect.runPromise,
    );

    expect(calls).toEqual([
      "removeWorkspace:/tmp/ralphie",
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
      startClean: false,
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
      startClean: false,
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
      startClean: false,
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

  test("stops before other work when start-clean fails", async () => {
    const calls: string[] = [];
    const exit = await workflow({
      repo: "owner/repo",
      branch: "main",
      workspace: "/tmp/ralphie",
      cleanup: false,
      startClean: true,
    }).pipe(
      Effect.provide(
        testRuntime(calls, {
          removeFailure: new RalphieError({ message: "cleanup failed" }),
        }),
      ),
      Effect.runPromiseExit,
    );

    expect(Exit.isFailure(exit)).toBeTrue();
    expect(calls).toEqual(["removeWorkspace:/tmp/ralphie"]);
  });
});
