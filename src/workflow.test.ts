import { describe, expect, test } from "bun:test";
import { Effect, Exit, Layer } from "effect";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import type { Octokit } from "octokit";

import { GitRepository } from "./git/repository.ts";
import { GitHubClient } from "./github/client.ts";
import { GitHubIssues, IssueOrder, IssueSort } from "./github/issues.ts";
import { ComplexityLevel } from "./issues/decisions.ts";
import { IssuePipeline } from "./issues/pipeline.ts";
import { IssueStageKind, IssueWorkflowKind } from "./issues/stage.ts";
import { OpenCode } from "./opencode/server.ts";
import {
  OpenCodeSessionPurpose,
  StructuredOutputName,
} from "./opencode/session.ts";
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
    Layer.succeed(GitHubIssues, {
      listOpen: (_client, repo, filters) => {
        calls.push(
          `listIssues:${repo}:${filters.labels.join(",")}:${filters.sort}:${filters.order}`,
        );
        return Effect.succeed([
          {
            number: 42,
            title: "Test issue",
            url: "https://github.com/owner/repo/issues/42",
            body: "Test body",
            labels: ["bug"],
          },
          {
            number: 43,
            title: "Second issue",
            url: "https://github.com/owner/repo/issues/43",
            body: null,
            labels: [],
          },
        ]);
      },
    }),
    Layer.succeed(IssuePipeline, {
      plan: ({ issue, repositoryPath, targetBranch, openCode }) => {
        calls.push(
          `planIssue:${issue.number}:${repositoryPath}:${targetBranch}:${openCode.model?.providerID}/${openCode.model?.modelID}:${openCode.variant}`,
        );
        return Effect.succeed({
          issue,
          repositoryPath,
          targetBranch,
          openCode,
          assessment: {
            kind: IssueStageKind.OpenCodeSession,
            purpose: OpenCodeSessionPurpose.AssessComplexity,
            output: StructuredOutputName.ComplexityDecision,
          },
          workflows: [
            {
              kind: IssueWorkflowKind.Implementation,
              complexity: {
                min: ComplexityLevel.Level0,
                max: ComplexityLevel.Level3,
              },
              stages: [],
            },
            {
              kind: IssueWorkflowKind.Decomposition,
              complexity: {
                min: ComplexityLevel.Level4,
                max: ComplexityLevel.Level5,
              },
              stages: [],
            },
          ],
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
              client: {} as OpencodeClient,
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
      maxIssues: 1,
      issueFilters: {
        labels: ["bug"],
        sort: IssueSort.Created,
        order: IssueOrder.Ascending,
      },
      model: { providerID: "openai", modelID: "gpt-5" },
      modelVariant: "high",
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
      "listIssues:owner/repo:bug:created:asc",
      "startServer",
      "planIssue:42:/tmp/ralphie/repo:develop:openai/gpt-5:high",
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
      issueFilters: {
        labels: [],
        sort: IssueSort.Created,
        order: IssueOrder.Ascending,
      },
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
      issueFilters: {
        labels: [],
        sort: IssueSort.Created,
        order: IssueOrder.Ascending,
      },
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
      issueFilters: {
        labels: [],
        sort: IssueSort.Created,
        order: IssueOrder.Ascending,
      },
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
