import { describe, expect, test } from "bun:test";
import { Effect, Exit, Layer } from "effect";
import type { Octokit } from "octokit";

import { GitRepository } from "./git/repository.ts";
import { GitHubClient } from "./github/client.ts";
import { OpenCode } from "./opencode/server.ts";
import { RalphieError } from "./shared/error.ts";
import { Workspace } from "./workspace/workspace.ts";
import { workflow } from "./workflow.ts";

type TestRuntimeOptions = {
  githubFailure?: RalphieError;
  gitFailure?: RalphieError;
  startFailure?: RalphieError;
  removeFailure?: RalphieError;
};

function testRuntime(calls: string[], options: TestRuntimeOptions = {}) {
  return Layer.mergeAll(
    Layer.succeed(GitHubClient, {
      initialize: Effect.suspend(() => {
        calls.push("initializeGitHub");
        return options.githubFailure
          ? Effect.fail(options.githubFailure)
          : Effect.succeed({} as Octokit);
      }),
    }),
    Layer.succeed(GitRepository, {
      verifyInstalled: Effect.suspend(() => {
        calls.push("verifyGitInstalled");
        return options.gitFailure
          ? Effect.fail(options.gitFailure)
          : Effect.void;
      }),
      prepare: (repo, branch, workspace) => {
        calls.push(`prepareRepository:${repo}:${branch}:${workspace}`);
        return Effect.succeed({
          path: `${workspace}/repo`,
          cloned: true,
          branchChanged: branch !== "main",
          cleaned: false,
        });
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
      "initializeGitHub",
      "verifyGitInstalled",
      "prepareRepository:owner/repo:develop:/tmp/ralphie",
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
          githubFailure: new RalphieError({ message: "not logged in" }),
        }),
      ),
      Effect.runPromiseExit,
    );

    expect(Exit.isFailure(exit)).toBeTrue();
    expect(calls).toEqual(["initializeGitHub"]);
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
          gitFailure: new RalphieError({ message: "git unavailable" }),
        }),
      ),
      Effect.runPromiseExit,
    );

    expect(Exit.isFailure(exit)).toBeTrue();
    expect(calls).toEqual([
      "initializeGitHub",
      "verifyGitInstalled",
    ]);
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
