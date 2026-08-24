import { describe, expect, test } from "bun:test";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { Effect, Exit, Layer } from "effect";
import type { Octokit } from "octokit";

import { GitRepository } from "./git/repository.ts";
import { GitRepositoryInvariant } from "./git/repository-invariant.ts";
import { GitIssueCheckpoint } from "./git/issue-checkpoint.ts";
import { GitHubClient } from "./github/client.ts";
import {
  GitHubIssues,
  type GitHubIssue,
  IssueOrder,
  IssueSort,
} from "./github/issues.ts";
import {
  type IssueExecutionOutcome,
  IssueExecutionOutcomeKind,
} from "./issues/execution.ts";
import { IssueExecutor } from "./issues/executor.ts";
import { DryRunIssueExecutor } from "./issues/dry-run-executor.ts";
import { DEFAULT_OPENCODE_AGENT } from "./opencode/model.ts";
import { OpenCode } from "./opencode/server.ts";
import {
  makeProgressRecorderLayer,
  type ProgressUpdate,
  ProgressStage,
  ProgressStatus,
} from "./progress/progress.ts";
import { type RunState, RunStateStatus, RunStateStore } from "./run/state.ts";
import { RalphieError } from "./shared/error.ts";
import { Workspace } from "./workspace/workspace.ts";
import { workflow } from "./workflow.ts";

const firstIssue: GitHubIssue = {
  number: 42,
  title: "Test issue",
  url: "https://github.com/owner/repo/issues/42",
  body: "Test body",
  labels: ["bug"],
};

type TestRuntimeOptions = {
  readonly outcomes?: ReadonlyArray<IssueExecutionOutcome>;
  readonly issueLists?: ReadonlyArray<ReadonlyArray<GitHubIssue>>;
  readonly githubFailure?: RalphieError;
  readonly gitFailure?: RalphieError;
  readonly startFailure?: RalphieError;
  readonly removeFailure?: RalphieError;
  readonly abortOnExecute?: AbortController;
};

function testRuntime(
  calls: string[],
  savedStates: RunState[],
  options: TestRuntimeOptions = {},
  progressEvents: ProgressUpdate[] = [],
) {
  let listIndex = 0;
  let outcomeIndex = 0;
  let captureIndex = 0;
  const outcomes = options.outcomes ?? [
    { kind: IssueExecutionOutcomeKind.Completed, commitSha: "abc123", reviewCount: 1 },
  ];
  const issueLists = options.issueLists ?? [[firstIssue]];

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
        return options.gitFailure ? Effect.fail(options.gitFailure) : Effect.void;
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
    Layer.succeed(GitRepositoryInvariant, {
      capture: () =>
        Effect.sync(() => ({ branch: "develop", head: `head-${captureIndex++}` })),
      verify: () => Effect.void,
    }),
    Layer.succeed(GitIssueCheckpoint, {
      capture: () => Effect.succeed({ branch: "develop", sha: "a".repeat(40) }),
      createPatch: () => Effect.succeed(""),
      restore: (_path, _checkpoint) => {
        calls.push("restoreCheckout");
        return Effect.void;
      },
    }),
    Layer.succeed(GitHubIssues, {
      listDecompositionChildren: () => Effect.succeed([]),
      listOpen: (_client, repo, filters) => {
        calls.push(
          `listIssues:${repo}:${filters.labels.join(",")}:${filters.sort}:${filters.order}`,
        );
        const result = issueLists[Math.min(listIndex, issueLists.length - 1)] ?? [];
        listIndex += 1;
        return Effect.succeed(result);
      },
    }),
    Layer.succeed(IssueExecutor, {
      execute: ({ issue, repositoryPath, targetBranch, openCodeSelection }) =>
        Effect.gen(function* () {
          calls.push(
            `executeIssue:${issue.number}:${repositoryPath}:${targetBranch}:${openCodeSelection.agent}`,
          );
          if (options.abortOnExecute !== undefined) {
            options.abortOnExecute.abort();
            return yield* new RalphieError({ message: "agent interrupted" });
          }
          const result = outcomes[Math.min(outcomeIndex, outcomes.length - 1)];
          outcomeIndex += 1;
          if (result === undefined) throw new Error("Missing test outcome");
          return result;
        }),
    }),
    Layer.succeed(DryRunIssueExecutor, {
      execute: ({ issue }) => {
        calls.push(`dryRunIssue:${issue.number}`);
        return Effect.succeed({
          kind: IssueExecutionOutcomeKind.Skipped,
          reason: "dry run",
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
    Layer.succeed(RunStateStore, {
      load: () => Effect.fail(new RalphieError({ message: "unused" })),
      save: (_path, state) =>
        Effect.sync(() => {
          savedStates.push(structuredClone(state));
        }),
    }),
    Layer.succeed(Workspace, {
      remove: (workspace) => {
        calls.push(`removeWorkspace:${workspace}`);
        return options.removeFailure ? Effect.fail(options.removeFailure) : Effect.void;
      },
    }),
    makeProgressRecorderLayer(progressEvents),
  );
}

const baseOptions = {
  repo: "owner/repo",
  branch: "develop",
  maxIssues: 1,
  issueFilters: {
    labels: ["bug"],
    sort: IssueSort.Created,
    order: IssueOrder.Ascending,
  },
  agent: DEFAULT_OPENCODE_AGENT,
  workspace: "/tmp/ralphie",
  cleanup: false,
  startClean: false,
  runId: "test-run",
} as const;

describe("workflow", () => {
  test("executes an issue, persists completion, releases OpenCode, and cleans up", async () => {
    const calls: string[] = [];
    const states: RunState[] = [];
    const events: ProgressUpdate[] = [];
    const summary = await workflow({
      ...baseOptions,
      model: { providerID: "openai", modelID: "gpt-5" },
      modelVariant: "high",
      agent: "reviewer",
      cleanup: true,
      startClean: true,
    }).pipe(Effect.provide(testRuntime(calls, states, {}, events)), Effect.runPromise);

    expect(summary.counts.completed).toBe(1);
    expect(states.at(-1)?.status).toBe(RunStateStatus.Complete);
    expect(states.at(-1)?.queue.completedIssueNumbers).toEqual([42]);
    expect(calls).toEqual([
      "removeWorkspace:/tmp/ralphie",
      "initializeGitHub",
      "verifyGitInstalled",
      "prepareRepository:owner/repo:develop:/tmp/ralphie",
      "listIssues:owner/repo:bug:created:asc",
      "startServer",
      "executeIssue:42:/tmp/ralphie/repo:develop:reviewer",
      "closeServer",
      "removeWorkspace:/tmp/ralphie",
    ]);
    expect(
      events.some(({ stage }) => stage === ProgressStage.IssueExecution),
    ).toBeTrue();
    expect(events.at(-1)?.status).toBe(ProgressStatus.Succeeded);
  });

  test("dry-run assesses through the queue without invoking mutation execution", async () => {
    const calls: string[] = [];
    const states: RunState[] = [];
    const summary = await workflow({
      ...baseOptions,
      dryRun: true,
    }).pipe(Effect.provide(testRuntime(calls, states)), Effect.runPromise);

    expect(summary.outcomes).toEqual([
      {
        issueNumber: 42,
        outcome: { kind: IssueExecutionOutcomeKind.Skipped, reason: "dry run" },
      },
    ]);
    expect(calls).toContain("dryRunIssue:42");
    expect(calls).not.toContain("executeIssue:42:/tmp/ralphie/repo:develop:build");
    expect(states.at(-1)?.status).toBe(RunStateStatus.Complete);
    expect(states.at(-1)?.dryRun).toBe(true);
  });

  test.each([
    [{ kind: IssueExecutionOutcomeKind.Completed, commitSha: "abc" }],
    [{ kind: IssueExecutionOutcomeKind.Decomposed, childIssueNumbers: [51] }],
    [
      {
        kind: IssueExecutionOutcomeKind.Escalated,
        diagnosticsPath: "/tmp/diagnostics.json",
        reason: "review budget exhausted",
        childIssueNumbers: [52],
      },
    ],
    [{ kind: IssueExecutionOutcomeKind.Skipped, reason: "no changes" }],
  ] satisfies ReadonlyArray<readonly [IssueExecutionOutcome]>)(
    "records the executor outcome",
    async (outcome) => {
      const calls: string[] = [];
      const states: RunState[] = [];
      const summary = await workflow(baseOptions).pipe(
        Effect.provide(testRuntime(calls, states, { outcomes: [outcome] })),
        Effect.runPromise,
      );

      expect(summary.outcomes).toEqual([{ issueNumber: 42, outcome }]);
      expect(summary.counts[outcome.kind]).toBe(1);
      expect(states.at(-1)?.status).toBe(RunStateStatus.Complete);
      if (
        outcome.kind === IssueExecutionOutcomeKind.Decomposed ||
        outcome.kind === IssueExecutionOutcomeKind.Escalated
      ) {
        expect(calls.filter((call) => call.startsWith("listIssues:"))).toHaveLength(2);
      }
    },
  );

  test("halts, persists the active issue, and releases OpenCode on failure", async () => {
    const calls: string[] = [];
    const states: RunState[] = [];
    const exit = await workflow(baseOptions).pipe(
      Effect.provide(
        testRuntime(calls, states, {
          outcomes: [{ kind: IssueExecutionOutcomeKind.Failed, message: "boom" }],
        }),
      ),
      Effect.runPromiseExit,
    );

    expect(Exit.isFailure(exit)).toBeTrue();
    expect(states.at(-1)?.status).toBe(RunStateStatus.Active);
    expect(states.at(-1)?.activeIssue?.issueNumber).toBe(42);
    expect(states.at(-1)?.queue.pending.map(({ number }) => number)).toEqual([42]);
    expect(states.at(-1)?.queue.processedCount).toBe(0);
    expect(calls.at(-1)).toBe("closeServer");
  });

  test("refreshes the queue after decomposition and runs a new child within budget", async () => {
    const calls: string[] = [];
    const states: RunState[] = [];
    const child = { ...firstIssue, number: 51, title: "Child" };
    const summary = await workflow({ ...baseOptions, maxIssues: 2 }).pipe(
      Effect.provide(
        testRuntime(calls, states, {
          issueLists: [[firstIssue], [child]],
          outcomes: [
            { kind: IssueExecutionOutcomeKind.Decomposed, childIssueNumbers: [51] },
            { kind: IssueExecutionOutcomeKind.Completed, commitSha: "child-sha" },
          ],
        }),
      ),
      Effect.runPromise,
    );

    expect(summary.outcomes.map(({ issueNumber }) => issueNumber)).toEqual([42, 51]);
    expect(states.at(-1)?.queue.processedCount).toBe(2);
  });

  test("stops before other work when start-clean fails", async () => {
    const calls: string[] = [];
    const exit = await workflow({ ...baseOptions, startClean: true }).pipe(
      Effect.provide(
        testRuntime(calls, [], {
          removeFailure: new RalphieError({ message: "cleanup failed" }),
        }),
      ),
      Effect.runPromiseExit,
    );

    expect(Exit.isFailure(exit)).toBeTrue();
    expect(calls).toEqual(["removeWorkspace:/tmp/ralphie"]);
  });

  test("stops when preflight authentication fails", async () => {
    const calls: string[] = [];
    const exit = await workflow(baseOptions).pipe(
      Effect.provide(
        testRuntime(calls, [], {
          githubFailure: new RalphieError({ message: "not logged in" }),
        }),
      ),
      Effect.runPromiseExit,
    );

    expect(Exit.isFailure(exit)).toBeTrue();
    expect(calls).toEqual(["initializeGitHub"]);
  });

  test("restores the active checkout and saves resumable state on cancellation", async () => {
    const calls: string[] = [];
    const states: RunState[] = [];
    const controller = new AbortController();
    const exit = await workflow({
      ...baseOptions,
      cleanup: true,
      signal: controller.signal,
    }).pipe(
      Effect.provide(testRuntime(calls, states, { abortOnExecute: controller })),
      Effect.runPromiseExit,
    );

    expect(Exit.isFailure(exit)).toBeTrue();
    expect(states.at(-1)?.status).toBe(RunStateStatus.Active);
    expect(states.at(-1)?.activeIssue?.issueNumber).toBe(42);
    expect(calls).toContain("restoreCheckout");
    expect(calls).not.toContain("removeWorkspace:/tmp/ralphie");
  });

  test("fails before side effects when already cancelled", async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    controller.abort();

    const exit = await workflow({
      ...baseOptions,
      signal: controller.signal,
    }).pipe(Effect.provide(testRuntime(calls, [])), Effect.runPromiseExit);

    expect(Exit.isFailure(exit)).toBeTrue();
    expect(calls).toEqual([]);
  });
});
