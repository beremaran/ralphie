import { describe, expect, test } from "bun:test";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { Effect, Exit, Layer } from "effect";
import type { Octokit } from "octokit";

import { GitRepository } from "./git/repository.ts";
import { GitRepositoryInvariant } from "./git/repository-invariant.ts";
import { GitIssueCheckpoint } from "./git/issue-checkpoint.ts";
import { GitIssueOperations } from "./git/issue-operations.ts";
import { GitHubClient } from "./github/client.ts";
import { GitHubPullRequests } from "./github/pull-requests.ts";
import { GitHubIssueMutations } from "./github/issue-mutations.ts";
import {
  GitHubIssues,
  type GitHubIssue,
  IssueOrder,
  IssueSort,
} from "./github/issues.ts";
import { GitHubRepositoryPatterns } from "./github/repository-patterns.ts";
import {
  IssueCompletionKind,
  type IssueExecutionContext,
  type IssueExecutionOutcome,
  IssueExecutionOutcomeKind,
} from "./issues/execution.ts";
import { IssueExecutor } from "./issues/executor.ts";
import { IssueArtifactStore, makeIssueArtifactStore } from "./issues/artifacts.ts";
import { DryRunIssueExecutor } from "./issues/dry-run-executor.ts";
import { DEFAULT_OPENCODE_AGENT } from "./opencode/model.ts";
import { OpenCode } from "./opencode/server.ts";
import {
  ProgressReporter,
  type ProgressUpdate,
  ProgressStage,
  ProgressStatus,
} from "./progress/progress.ts";
import { type RunState, RunStateStatus, RunStateStore } from "./run/state.ts";
import { RalphieError } from "./shared/error.ts";
import { Workspace } from "./workspace/workspace.ts";
import { batchWorkflow, workflow } from "./workflow.ts";
import { WorkflowMode } from "./config/config.ts";

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
  readonly closeFailure?: RalphieError;
  readonly abortOnExecute?: AbortController;
  readonly abortAt?: "github" | "repository" | "issues" | "opencode" | "between";
  readonly abortController?: AbortController;
  readonly captureStart?: number;
  readonly prepareGate?: () => Promise<void>;
  readonly failedRepository?: string;
  readonly patternRepositories?: ReadonlyArray<{
    readonly slug: string;
    readonly owner: string;
    readonly name: string;
  }>;
  readonly executionContexts?: IssueExecutionContext[];
};

function testRuntime(
  calls: string[],
  savedStates: RunState[],
  options: TestRuntimeOptions = {},
  progressEvents: ProgressUpdate[] = [],
) {
  let listIndex = 0;
  let outcomeIndex = 0;
  let captureIndex = options.captureStart ?? 0;
  const outcomes = options.outcomes ?? [
    {
      kind: IssueExecutionOutcomeKind.Completed,
      completion: IssueCompletionKind.PushedCommit,
      commitSha: "abc123",
      reviewCount: 1,
    },
  ];
  const issueLists = options.issueLists ?? [[firstIssue]];

  return Layer.mergeAll(
    Layer.succeed(GitHubClient, {
      initialize: Effect.suspend(() => {
        calls.push("initializeGitHub");
        if (options.abortAt === "github") options.abortController?.abort();
        if (options.githubFailure) return Effect.fail(options.githubFailure);
        return Effect.succeed({} as Octokit);
      }),
    }),
    Layer.succeed(GitRepository, {
      verifyInstalled: Effect.suspend(() => {
        calls.push("verifyGitInstalled");
        return options.gitFailure ? Effect.fail(options.gitFailure) : Effect.void;
      }),
      prepare: (repo, branch, workspace, destinationPath) => {
        calls.push(`prepareRepository:${repo}:${branch}:${workspace}`);
        if (options.abortAt === "repository") options.abortController?.abort();
        const prepared = {
          path: destinationPath ?? `${workspace}/repo`,
          branch: branch ?? "main",
          cloned: true,
          branchChanged: branch !== "main",
          cleaned: false,
        };
        return options.prepareGate === undefined
          ? Effect.succeed(prepared)
          : Effect.tryPromise({
              try: async () => {
                await options.prepareGate?.();
                return prepared;
              },
              catch: (cause) => new RalphieError({ message: "gate failed", cause }),
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
        if (options.abortAt === "issues") options.abortController?.abort();
        const result = issueLists[Math.min(listIndex, issueLists.length - 1)] ?? [];
        listIndex += 1;
        return Effect.succeed(result);
      },
    }),
    Layer.succeed(GitHubRepositoryPatterns, {
      resolve: (_client, pattern) => {
        calls.push(`resolvePattern:${pattern}`);
        return Effect.succeed(options.patternRepositories ?? []);
      },
    }),
    Layer.succeed(GitHubIssueMutations, {
      create: () => Effect.fail(new RalphieError({ message: "unused" })),
      update: () => Effect.fail(new RalphieError({ message: "unused" })),
      close: (_client, _repository, issueNumber) => {
        calls.push(`closeIssue:${issueNumber}`);
        return options.closeFailure
          ? Effect.fail(options.closeFailure)
          : Effect.succeed(
              issueLists.flat().find(({ number }) => number === issueNumber) ??
                firstIssue,
            );
      },
    }),
    Layer.succeed(GitHubPullRequests, {
      createOrFind: (_client, repository, input) =>
        Effect.sync(() => {
          calls.push(`createPullRequest:${repository}:${input.head}:${input.base}`);
          return {
            number: 1,
            url: "https://github.com/owner/repo/pull/1",
            merged: false,
          };
        }),
      publishReviewAttempts: (_client, repository, number) =>
        Effect.sync(() => calls.push(`publishReviews:${repository}:${number}`)),
      merge: (_client, repository, number) =>
        Effect.sync(() => {
          calls.push(`mergePullRequest:${repository}:${number}`);
          return {
            number: 1,
            url: "https://github.com/owner/repo/pull/1",
            merged: true,
          };
        }),
    }),
    Layer.succeed(GitIssueOperations, {
      stageAll: () => Effect.void,
      readStagedBinaryDiff: () => Effect.succeed(""),
      hasStagedChanges: () => Effect.succeed(false),
      commit: () => Effect.succeed({ sha: "a".repeat(40), treeSha: "b".repeat(40) }),
      push: (_path, branch) => Effect.sync(() => calls.push(`pushBranch:${branch}`)),
      createOrCheckoutFeatureBranch: (_path, featureBranch, baseBranch, baseSha) =>
        Effect.sync(() => {
          calls.push(`prepareFeatureBranch:${featureBranch}:${baseBranch}`);
          return {
            branch: featureBranch,
            baseBranch,
            baseSha,
            headSha: baseSha,
            created: true,
          };
        }),
      restoreBaseCheckout: (_path, branch) =>
        Effect.sync(() => calls.push(`restoreBase:${branch}`)),
    }),
    Layer.succeed(IssueArtifactStore, {
      forIssue: (issueNumber) => makeIssueArtifactStore(issueNumber),
    }),
    Layer.succeed(IssueExecutor, {
      execute: (context) =>
        Effect.gen(function* () {
          const { issue, repository, repositoryPath, targetBranch, openCodeSelection } =
            context;
          options.executionContexts?.push(context);
          calls.push(
            `executeIssue:${issue.number}:${repositoryPath}:${targetBranch}:${openCodeSelection.agent}`,
          );
          if (options.abortOnExecute !== undefined) {
            options.abortOnExecute.abort();
            return yield* new RalphieError({ message: "agent interrupted" });
          }
          if (options.failedRepository === repository) {
            return {
              kind: IssueExecutionOutcomeKind.Failed,
              message: "repository-specific failure",
            } as const;
          }
          const result = outcomes[Math.min(outcomeIndex, outcomes.length - 1)];
          outcomeIndex += 1;
          if (result === undefined) throw new Error("Missing test outcome");
          if (options.abortAt === "between") options.abortController?.abort();
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
            if (options.abortAt === "opencode") options.abortController?.abort();
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
      prepare: (workspace) => {
        calls.push(`prepareWorkspace:${workspace}`);
        return Effect.void;
      },
      remove: (workspace) => {
        calls.push(`removeWorkspace:${workspace}`);
        return options.removeFailure ? Effect.fail(options.removeFailure) : Effect.void;
      },
    }),
    Layer.succeed(ProgressReporter, {
      emit: (event) =>
        Effect.sync(() => {
          progressEvents.push(event);
        }),
      stopPersisting: Effect.sync(() => {
        calls.push("stopPersisting");
      }),
    }),
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
      project: "project-a",
      model: { providerID: "openai", modelID: "gpt-5" },
      modelVariant: "high",
      agent: "reviewer",
      cleanup: true,
      startClean: true,
    }).pipe(Effect.provide(testRuntime(calls, states, {}, events)), Effect.runPromise);

    expect(summary.counts.completed).toBe(1);
    expect(states.at(-1)?.status).toBe(RunStateStatus.Complete);
    expect(states.at(-1)?.project).toBe("project-a");
    expect(states.at(-1)?.queue.completedIssueNumbers).toEqual([42]);
    expect(calls).toEqual([
      "removeWorkspace:/tmp/ralphie",
      "prepareWorkspace:/tmp/ralphie",
      "initializeGitHub",
      "verifyGitInstalled",
      "prepareRepository:owner/repo:develop:/tmp/ralphie",
      "listIssues:owner/repo:bug:created:asc",
      "startServer",
      "executeIssue:42:/tmp/ralphie/repo:develop:reviewer",
      "closeIssue:42",
      "closeServer",
      "removeWorkspace:/tmp/ralphie",
      "stopPersisting",
    ]);
    expect(
      events.some(({ stage }) => stage === ProgressStage.IssueExecution),
    ).toBeTrue();
    expect(events.at(-1)?.status).toBe(ProgressStatus.Succeeded);
  });

  test("uses an issue branch and merged pull request without closing the issue directly", async () => {
    const calls: string[] = [];
    const states: RunState[] = [];
    const contexts: IssueExecutionContext[] = [];

    const summary = await workflow({
      ...baseOptions,
      workflow: WorkflowMode.Pr,
    }).pipe(
      Effect.provide(testRuntime(calls, states, { executionContexts: contexts })),
      Effect.runPromise,
    );

    expect(summary.counts.completed).toBe(1);
    expect(contexts[0]?.targetBranch).toBe("ralphie/issue-42");
    expect(calls).toContain("prepareFeatureBranch:ralphie/issue-42:develop");
    expect(calls).toContain("pushBranch:ralphie/issue-42");
    expect(calls).toContain("createPullRequest:owner/repo:ralphie/issue-42:develop");
    expect(calls).toContain("publishReviews:owner/repo:1");
    expect(calls).toContain("mergePullRequest:owner/repo:1");
    expect(calls).toContain("restoreBase:develop");
    expect(calls).not.toContain("closeIssue:42");
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
    [
      {
        kind: IssueExecutionOutcomeKind.Completed,
        completion: IssueCompletionKind.PushedCommit,
        commitSha: "abc",
      },
    ],
    [
      {
        kind: IssueExecutionOutcomeKind.Completed,
        completion: IssueCompletionKind.AlreadyResolved,
        resolutionSummary: "The checkout already satisfies the issue.",
        evidence: ["targeted validation passed"],
      },
    ],
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

  test("persists a recoverable closure stage when GitHub closure fails", async () => {
    const calls: string[] = [];
    const states: RunState[] = [];
    const exit = await workflow(baseOptions).pipe(
      Effect.provide(
        testRuntime(calls, states, {
          closeFailure: new RalphieError({ message: "close response lost" }),
        }),
      ),
      Effect.runPromiseExit,
    );

    expect(Exit.isFailure(exit)).toBeTrue();
    expect(calls).toContain("closeIssue:42");
    expect(states.at(-1)?.activeIssue).toEqual({
      issueNumber: 42,
      stage: ProgressStage.IssueClosure,
    });
    expect(states.at(-1)?.queue.pending.map(({ number }) => number)).toEqual([42]);
    expect(states.at(-1)?.checkout).toEqual({ branch: "develop", head: "head-1" });
    expect(states.at(-1)?.outcomes).toHaveLength(1);
    expect(states.at(-1)?.outcomes[0]?.outcome.kind).toBe(
      IssueExecutionOutcomeKind.Completed,
    );
  });

  test("resumes an interrupted closure without rerunning implementation", async () => {
    const failedStates: RunState[] = [];
    await workflow(baseOptions).pipe(
      Effect.provide(
        testRuntime([], failedStates, {
          closeFailure: new RalphieError({ message: "close response lost" }),
        }),
      ),
      Effect.runPromiseExit,
    );
    const resumeState = failedStates.at(-1);
    if (resumeState === undefined) throw new Error("Missing resumable state");

    const calls: string[] = [];
    const resumedStates: RunState[] = [];
    const summary = await workflow({
      ...baseOptions,
      resumeState,
    }).pipe(
      Effect.provide(
        testRuntime(calls, resumedStates, {
          issueLists: [[]],
          captureStart: 1,
        }),
      ),
      Effect.runPromise,
    );

    expect(calls).toContain("closeIssue:42");
    expect(calls.some((call) => call.startsWith("executeIssue:"))).toBeFalse();
    expect(summary.outcomes).toHaveLength(1);
    expect(summary.counts.completed).toBe(1);
    expect(resumedStates.at(-1)?.status).toBe(RunStateStatus.Complete);
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
            {
              kind: IssueExecutionOutcomeKind.Completed,
              completion: IssueCompletionKind.PushedCommit,
              commitSha: "child-sha",
            },
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
    expect(calls).toEqual(["prepareWorkspace:/tmp/ralphie", "initializeGitHub"]);
  });

  test.each([
    ["github", ["prepareWorkspace:/tmp/ralphie", "initializeGitHub"]],
    [
      "repository",
      [
        "prepareWorkspace:/tmp/ralphie",
        "initializeGitHub",
        "verifyGitInstalled",
        "prepareRepository:owner/repo:develop:/tmp/ralphie",
      ],
    ],
    [
      "issues",
      [
        "prepareWorkspace:/tmp/ralphie",
        "initializeGitHub",
        "verifyGitInstalled",
        "prepareRepository:owner/repo:develop:/tmp/ralphie",
        "listIssues:owner/repo:bug:created:asc",
      ],
    ],
  ] as const)(
    "cancels after %s without starting later work",
    async (stage, expectedCalls) => {
      const calls: string[] = [];
      const states: RunState[] = [];
      const controller = new AbortController();
      const exit = await workflow({
        ...baseOptions,
        cleanup: true,
        signal: controller.signal,
      }).pipe(
        Effect.provide(
          testRuntime(calls, states, {
            abortAt: stage,
            abortController: controller,
          }),
        ),
        Effect.runPromiseExit,
      );

      expect(Exit.isFailure(exit)).toBeTrue();
      expect(calls).toEqual([...expectedCalls]);
      expect(calls).not.toContain("startServer");
      expect(calls).not.toContain("removeWorkspace:/tmp/ralphie");
      expect(states).toHaveLength(0);
    },
  );

  test("cancels after OpenCode starts, closes the server, and saves active state", async () => {
    const calls: string[] = [];
    const states: RunState[] = [];
    const controller = new AbortController();
    const exit = await workflow({
      ...baseOptions,
      cleanup: true,
      signal: controller.signal,
    }).pipe(
      Effect.provide(
        testRuntime(calls, states, {
          abortAt: "opencode",
          abortController: controller,
        }),
      ),
      Effect.runPromiseExit,
    );

    expect(Exit.isFailure(exit)).toBeTrue();
    expect(calls).toContain("startServer");
    expect(calls).toContain("closeServer");
    expect(calls).not.toContain("executeIssue:42:/tmp/ralphie/repo:develop:build");
    expect(calls).not.toContain("removeWorkspace:/tmp/ralphie");
    expect(states.at(-1)?.status).toBe(RunStateStatus.Active);
    expect(states.at(-1)?.activeIssue).toBeUndefined();
  });

  test("cancels between issues, closes the server, saves state, and does not start the next issue", async () => {
    const calls: string[] = [];
    const states: RunState[] = [];
    const controller = new AbortController();
    const child = { ...firstIssue, number: 51, title: "Child" };
    const exit = await workflow({
      ...baseOptions,
      maxIssues: 2,
      cleanup: true,
      signal: controller.signal,
    }).pipe(
      Effect.provide(
        testRuntime(calls, states, {
          issueLists: [[firstIssue, child]],
          abortAt: "between",
          abortController: controller,
        }),
      ),
      Effect.runPromiseExit,
    );

    expect(Exit.isFailure(exit)).toBeTrue();
    expect(calls.filter((call) => call.startsWith("executeIssue:"))).toEqual([
      "executeIssue:42:/tmp/ralphie/repo:develop:build",
    ]);
    expect(calls).toContain("closeServer");
    expect(calls).not.toContain("executeIssue:51:/tmp/ralphie/repo:develop:build");
    expect(calls).not.toContain("removeWorkspace:/tmp/ralphie");
    expect(states.at(-1)?.status).toBe(RunStateStatus.Active);
    expect(states.at(-1)?.queue.pending.map(({ number }) => number)).toEqual([51]);
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

describe("batch workflow", () => {
  test("runs repositories concurrently and manages the shared workspace once", async () => {
    const calls: string[] = [];
    const states: RunState[] = [];
    const events: ProgressUpdate[] = [];
    let activePreparations = 0;
    let maximumPreparations = 0;
    const prepareGate = async () => {
      activePreparations += 1;
      maximumPreparations = Math.max(maximumPreparations, activePreparations);
      await Bun.sleep(10);
      activePreparations -= 1;
    };

    const summaries = await batchWorkflow({
      repositories: [
        { ...baseOptions, repo: "owner/one", runId: "run-one" },
        { ...baseOptions, repo: "owner/two", runId: "run-two" },
      ],
      workspace: baseOptions.workspace,
      startClean: true,
      cleanup: true,
    }).pipe(
      Effect.provide(testRuntime(calls, states, { prepareGate }, events)),
      Effect.runPromise,
    );

    expect(maximumPreparations).toBe(2);
    expect(summaries.map(({ repository }) => repository)).toEqual([
      "owner/one",
      "owner/two",
    ]);
    expect(
      calls.filter((call) => call === "removeWorkspace:/tmp/ralphie"),
    ).toHaveLength(2);
    expect(
      calls.filter((call) => call === "prepareWorkspace:/tmp/ralphie"),
    ).toHaveLength(1);
    expect(calls.filter((call) => call === "initializeGitHub")).toHaveLength(1);
    expect(calls.filter((call) => call === "verifyGitInstalled")).toHaveLength(1);
    expect(calls.filter((call) => call === "startServer")).toHaveLength(1);
    expect(calls.filter((call) => call === "closeServer")).toHaveLength(1);
  });

  test("lets sibling repositories finish and retains the workspace when one fails", async () => {
    const calls: string[] = [];
    const exit = await batchWorkflow({
      repositories: [
        { ...baseOptions, repo: "owner/failing", runId: "run-failing" },
        { ...baseOptions, repo: "owner/succeeding", runId: "run-succeeding" },
      ],
      workspace: baseOptions.workspace,
      startClean: false,
      cleanup: true,
    }).pipe(
      Effect.provide(testRuntime(calls, [], { failedRepository: "owner/failing" })),
      Effect.runPromiseExit,
    );

    expect(Exit.isFailure(exit)).toBeTrue();
    expect(calls).toContain("executeIssue:42:/tmp/ralphie/succeeding:develop:build");
    expect(calls.filter((call) => call === "closeIssue:42")).toHaveLength(1);
    expect(calls.filter((call) => call === "closeServer")).toHaveLength(1);
    expect(calls).not.toContain("removeWorkspace:/tmp/ralphie");
  });

  test("expands patterns after shared authentication and runs every match", async () => {
    const calls: string[] = [];
    const summaries = await batchWorkflow({
      repositories: [],
      repositoryPatterns: [
        {
          project: "finance",
          repoPattern: "owner/finance-*",
          ...baseOptions,
        },
      ],
      workspace: baseOptions.workspace,
      startClean: false,
      cleanup: false,
    }).pipe(
      Effect.provide(
        testRuntime(calls, [], {
          patternRepositories: [
            { slug: "owner/finance-a", owner: "owner", name: "finance-a" },
            { slug: "owner/finance-b", owner: "owner", name: "finance-b" },
          ],
        }),
      ),
      Effect.runPromise,
    );

    expect(summaries.map(({ repository }) => repository)).toEqual([
      "owner/finance-a",
      "owner/finance-b",
    ]);
    expect(calls.filter((call) => call === "initializeGitHub")).toHaveLength(1);
    expect(calls.filter((call) => call === "startServer")).toHaveLength(1);
    expect(calls).toContain("resolvePattern:owner/finance-*");
  });

  test("prepares a shared project root and serializes its repository issue loops", async () => {
    const calls: string[] = [];
    const contexts: IssueExecutionContext[] = [];
    const summaries = await batchWorkflow({
      repositories: [
        {
          ...baseOptions,
          project: "proj-b",
          repo: "owner/frontend",
          runId: "run-front",
        },
        {
          ...baseOptions,
          project: "proj-b",
          repo: "owner/backend",
          runId: "run-back",
        },
      ],
      workspace: baseOptions.workspace,
      startClean: false,
      cleanup: false,
    }).pipe(
      Effect.provide(testRuntime(calls, [], { executionContexts: contexts })),
      Effect.runPromise,
    );

    expect(summaries.map(({ repository }) => repository)).toEqual([
      "owner/frontend",
      "owner/backend",
    ]);
    expect(contexts.map(({ workingDirectory }) => workingDirectory)).toEqual([
      "/tmp/ralphie/proj-b",
      "/tmp/ralphie/proj-b",
    ]);
    expect(
      contexts[0]?.projectRepositories?.map(
        ({ repository, repositoryPath }) => `${repository}:${repositoryPath}`,
      ),
    ).toEqual([
      "owner/frontend:/tmp/ralphie/proj-b/frontend",
      "owner/backend:/tmp/ralphie/proj-b/backend",
    ]);
    expect(calls.findIndex((call) => call === "closeIssue:42")).toBeLessThan(
      calls.findLastIndex((call) => call.startsWith("executeIssue:42:")),
    );
  });

  test("halts sibling repository issue loops after a project failure", async () => {
    const calls: string[] = [];
    const exit = await batchWorkflow({
      repositories: [
        {
          ...baseOptions,
          project: "project",
          repo: "owner/failing",
          runId: "run-failing",
        },
        {
          ...baseOptions,
          project: "project",
          repo: "owner/not-started",
          runId: "run-not-started",
        },
      ],
      workspace: baseOptions.workspace,
      startClean: false,
      cleanup: false,
    }).pipe(
      Effect.provide(testRuntime(calls, [], { failedRepository: "owner/failing" })),
      Effect.runPromiseExit,
    );

    expect(Exit.isFailure(exit)).toBeTrue();
    expect(calls.some((call) => call.includes("/project/failing"))).toBeTrue();
    expect(calls.some((call) => call.includes("/project/not-started"))).toBeFalse();
  });
});
