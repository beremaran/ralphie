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
import {
  makeProgressRecorderLayer,
  type ProgressUpdate,
  ProgressStage,
  ProgressStatus,
} from "./progress/progress.ts";
import { RalphieError } from "./shared/error.ts";
import { Workspace } from "./workspace/workspace.ts";
import { workflow } from "./workflow.ts";

type TestRuntimeOptions = {
  githubFailure?: RalphieError;
  gitFailure?: RalphieError;
  startFailure?: RalphieError;
  removeFailure?: RalphieError;
};

function testRuntime(
  calls: string[],
  options: TestRuntimeOptions = {},
  progressEvents: ProgressUpdate[] = [],
) {
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
    makeProgressRecorderLayer(progressEvents),
  );
}

describe("workflow", () => {
  test("checks dependencies, starts OpenCode, and releases it", async () => {
    const calls: string[] = [];
    const progressEvents: ProgressUpdate[] = [];

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
      Effect.provide(testRuntime(calls, {}, progressEvents)),
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
    expect(
      progressEvents.map(({ stage, status }) => ({ stage, status })),
    ).toEqual([
      { stage: ProgressStage.Run, status: ProgressStatus.Info },
      {
        stage: ProgressStage.WorkspaceCleanup,
        status: ProgressStatus.Started,
      },
      {
        stage: ProgressStage.WorkspaceCleanup,
        status: ProgressStatus.Succeeded,
      },
      {
        stage: ProgressStage.GitHubAuthentication,
        status: ProgressStatus.Started,
      },
      {
        stage: ProgressStage.GitHubAuthentication,
        status: ProgressStatus.Succeeded,
      },
      { stage: ProgressStage.GitVerification, status: ProgressStatus.Started },
      {
        stage: ProgressStage.GitVerification,
        status: ProgressStatus.Succeeded,
      },
      {
        stage: ProgressStage.RepositoryPreparation,
        status: ProgressStatus.Started,
      },
      {
        stage: ProgressStage.RepositoryPreparation,
        status: ProgressStatus.Succeeded,
      },
      { stage: ProgressStage.IssueDiscovery, status: ProgressStatus.Started },
      {
        stage: ProgressStage.IssueDiscovery,
        status: ProgressStatus.Succeeded,
      },
      { stage: ProgressStage.OpenCodeServer, status: ProgressStatus.Started },
      {
        stage: ProgressStage.OpenCodeServer,
        status: ProgressStatus.Succeeded,
      },
      { stage: ProgressStage.IssuePlanning, status: ProgressStatus.Started },
      {
        stage: ProgressStage.IssuePlanning,
        status: ProgressStatus.Succeeded,
      },
      {
        stage: ProgressStage.WorkspaceCleanup,
        status: ProgressStatus.Started,
      },
      {
        stage: ProgressStage.WorkspaceCleanup,
        status: ProgressStatus.Succeeded,
      },
      { stage: ProgressStage.Run, status: ProgressStatus.Succeeded },
    ]);
  });

  test("stops when GitHub authentication fails", async () => {
    const calls: string[] = [];
    const progressEvents: ProgressUpdate[] = [];
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
        testRuntime(
          calls,
          { githubFailure: new RalphieError({ message: "not logged in" }) },
          progressEvents,
        ),
      ),
      Effect.runPromiseExit,
    );

    expect(Exit.isFailure(exit)).toBeTrue();
    expect(calls).toEqual(["initializeGitHub"]);
    expect(progressEvents.at(-2)?.status).toBe(ProgressStatus.Failed);
    expect(progressEvents.at(-2)?.stage).toBe(
      ProgressStage.GitHubAuthentication,
    );
    expect(progressEvents.at(-1)?.status).toBe(ProgressStatus.Failed);
    expect(progressEvents.at(-1)?.stage).toBe(ProgressStage.Run);
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
