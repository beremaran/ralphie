import { describe, expect, test } from "bun:test";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { Effect, Layer } from "effect";
import type { Octokit } from "octokit";

import {
  IssueArtifactKind,
  IssueArtifactStore as IssueArtifactStoreTag,
  makeIssueArtifactStore,
  type IssueArtifactStore,
} from "./artifacts.ts";
import { ComplexityAssessment, ComplexityAssessmentLive } from "./complexity.ts";
import { ComplexityLevel, ImplementationComplexityLevel } from "./decisions.ts";
import {
  DecompositionExecutor,
  DecompositionExecutorLive,
} from "./decomposition-executor.ts";
import type { IssueExecutionContext } from "./execution.ts";
import {
  GitIssueOperations,
  type GitIssueOperationsService,
} from "../git/issue-operations.ts";
import {
  GitIssuePreparation,
  type GitIssuePreparationService,
} from "../git/issue-preparation.ts";
import type { IssueCheckpoint } from "../git/issue-checkpoint.ts";
import { GitPushMode, GitRemoteSafety } from "../git/remote-safety.ts";
import {
  GitHubIssueMutations,
  type GitHubIssueMutationService,
} from "../github/issue-mutations.ts";
import { GitHubIssues, type GitHubIssuesService } from "../github/issues.ts";
import { makeOpenCodeSessionDiagnostics } from "../opencode/task-session.ts";
import {
  makeProgressRecorderLayer,
  type ProgressUpdate,
} from "../progress/progress.ts";
import { createIssueQueue, toQueuedIssues } from "./queue.ts";
import { IssueCompletionKind, IssueExecutionOutcomeKind } from "./execution.ts";
import {
  ImplementationExecutor,
  ImplementationExecutorLive,
} from "./implementation-executor.ts";
import { IssueExecutor, IssueExecutorLive } from "./executor.ts";
import { IssueRecovery, type IssueRecoveryService } from "./recovery.ts";
import { ReviewExhaustionOutcome } from "./recovery.ts";
import { IssueQueueResumeStrategy, IssueWorkflowKind } from "./stage.ts";
import { RalphieError } from "../shared/error.ts";

const checkpoint: IssueCheckpoint = { branch: "main", sha: "abc123" };

const issue = (number: number, title: string, body = "Task body") => ({
  number,
  title,
  url: `https://github.com/owner/repository/issues/${number}`,
  body,
  labels: [],
});

const context = (
  client: OpencodeClient,
  current = issue(42, "Complete task"),
): IssueExecutionContext => ({
  issue: current,
  repository: "owner/repository",
  repositoryPath: "/workspace/repository",
  targetBranch: "main",
  workspace: "/workspace",
  runId: "run-e2e",
  octokit: {} as Octokit,
  openCode: client,
  openCodeSelection: { agent: "build" },
  openCodeDiagnostics: makeOpenCodeSessionDiagnostics(() => "now"),
  repositoryInvariant: {
    capture: () => Effect.succeed({ branch: "main", head: checkpoint.sha }),
    verify: () => Effect.void,
  },
});

const clientFor = (outputs: ReadonlyArray<unknown>) => {
  let index = 0;
  let session = 0;
  return {
    session: {
      create: async () => ({ data: { id: `session-${++session}` } }),
      prompt: async (parameters: { format?: unknown }) => {
        const output = outputs[index++];
        return {
          data: {
            info: parameters.format === undefined ? {} : { structured: output },
            parts: [],
          },
        };
      },
    },
  } as unknown as OpencodeClient;
};

const implementationServices = (
  operations: Partial<GitIssueOperationsService> = {},
  progress: ProgressUpdate[] = [],
) => {
  const preparation: GitIssuePreparationService = {
    prepare: () => Effect.succeed(checkpoint),
  };
  const git: GitIssueOperationsService = {
    stageAll: () => Effect.void,
    readStagedBinaryDiff: () => Effect.succeed("diff --git a/file b/file\n"),
    hasStagedChanges: () => Effect.succeed(true),
    commit: () => Effect.succeed({ sha: "commit-e2e", treeSha: "tree-e2e" }),
    push: () => Effect.void,
    ...operations,
  };
  const recovery: IssueRecoveryService = {
    handleReviewExhaustion: () =>
      Effect.succeed({
        outcome: ReviewExhaustionOutcome.EscalatedToDecomposition,
        diagnosticsPath: "/workspace/recovery",
        nextWorkflow: IssueWorkflowKind.Decomposition,
        resume: IssueQueueResumeStrategy.RefreshOpenIssues,
      }),
  };
  return Layer.mergeAll(
    Layer.succeed(GitIssuePreparation, preparation),
    Layer.succeed(GitIssueOperations, git),
    Layer.succeed(GitRemoteSafety, {
      verifyDirectPush: (input) =>
        Effect.succeed({
          repository: input.repository,
          branch: input.branch,
          origin: "https://github.com/owner/repository.git",
          commitsBehindBase: 0,
          commitsAheadBase: input.expectedCommitSha === undefined ? 0 : 1,
          pushMode: GitPushMode.NonForce,
        }),
    }),
    Layer.succeed(IssueRecovery, recovery),
    makeProgressRecorderLayer(progress),
  );
};

const reviewApproved = {
  verdict: "approved",
  summary: "Looks good.",
  findings: [],
};

const runComplexity = (client: OpencodeClient, progress: ProgressUpdate[]) =>
  Effect.gen(function* () {
    const service = yield* ComplexityAssessment;
    return yield* service.assess(context(client));
  }).pipe(
    Effect.provide(ComplexityAssessmentLive),
    Effect.provide(makeProgressRecorderLayer(progress)),
  );

const breakdown = {
  rationale: "Split storage before dependent tests.",
  issues: [
    {
      key: "storage",
      title: "Implement storage",
      body: "Implement the storage layer.",
      estimatedComplexity: ImplementationComplexityLevel.Level2,
      dependsOn: [],
    },
    {
      key: "tests",
      title: "Add storage tests",
      body: "Add tests for the storage layer.",
      estimatedComplexity: ImplementationComplexityLevel.Level1,
      dependsOn: ["storage"],
    },
  ],
};

const decompositionServices = (state: {
  readonly created: number[];
  readonly updates: Array<{ issueNumber: number; body?: string }>;
  readonly closeCount: { value: number };
  readonly failSecondLink?: { value: boolean };
}) => {
  const mutations: GitHubIssueMutationService = {
    create: (_client, _repository, input) =>
      Effect.sync(() => {
        const number = state.created.length === 0 ? 101 : 102;
        state.created.push(number);
        return issue(number, input.title, input.body);
      }),
    update: (_client, _repository, issueNumber, input) =>
      state.failSecondLink?.value && issueNumber === 102
        ? Effect.gen(function* () {
            state.failSecondLink!.value = false;
            return yield* new RalphieError({ message: "link failed" });
          })
        : Effect.sync(() => {
            state.updates.push({ issueNumber, body: input.body });
            return issue(issueNumber, "Updated", input.body ?? "");
          }),
    close: (_client, _repository, issueNumber) =>
      Effect.sync(() => {
        state.closeCount.value += 1;
        return issue(issueNumber, "Closed");
      }),
  };
  const issues: GitHubIssuesService = {
    listOpen: () => Effect.succeed([]),
    listDecompositionChildren: () => Effect.succeed([]),
  };
  return Layer.merge(
    Layer.succeed(GitHubIssueMutations, mutations),
    Layer.merge(Layer.succeed(GitHubIssues, issues), makeProgressRecorderLayer([])),
  );
};

const runDecomposition = (
  client: OpencodeClient,
  artifacts: IssueArtifactStore,
  layer: Layer.Layer.Any,
) =>
  Effect.gen(function* () {
    const executor = yield* DecompositionExecutor;
    return yield* executor.execute({ context: context(client), artifacts });
  }).pipe(
    Effect.provide(DecompositionExecutorLive),
    Effect.provide(layer as any),
  ) as any;

describe("mocked end-to-end issue workflows", () => {
  test("executes a complexity-2 issue through push", async () => {
    const progress: ProgressUpdate[] = [];
    const client = clientFor([
      { complexity: ComplexityLevel.Level2, rationale: "Localized change." },
      undefined,
      reviewApproved,
      { subject: "complete task" },
    ]);
    const assessment = await Effect.runPromise(runComplexity(client, progress));
    expect(assessment.decision.complexity).toBe(ComplexityLevel.Level2);

    const artifacts = await Effect.runPromise(makeIssueArtifactStore(42));
    await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* ImplementationExecutor;
        return yield* executor.execute({ context: context(client), artifacts });
      }).pipe(
        Effect.provide(ImplementationExecutorLive),
        Effect.provide(
          implementationServices({
            push: () => Effect.void,
          }) as any,
        ),
      ) as any,
    ).then((result) => {
      expect(result).toEqual({
        kind: IssueExecutionOutcomeKind.Completed,
        completion: IssueCompletionKind.PushedCommit,
        commitSha: "commit-e2e",
        reviewCount: 1,
      });
    });
  });

  test("executes a complexity-4 issue through closure and refreshes dependent queue work", async () => {
    const client = clientFor([
      { complexity: ComplexityLevel.Level4, rationale: "Broad change." },
      breakdown,
    ]);
    const assessment = await Effect.runPromise(runComplexity(client, []));
    expect(assessment.decision.complexity).toBe(ComplexityLevel.Level4);
    const artifacts = await Effect.runPromise(makeIssueArtifactStore(42));
    await Effect.runPromise(
      artifacts.write(IssueArtifactKind.ComplexityDecision, assessment.decision),
    );
    const state = {
      created: [] as number[],
      updates: [] as Array<{ issueNumber: number; body?: string }>,
      closeCount: { value: 0 },
    };
    const result = await Effect.runPromise(
      runDecomposition(client, artifacts, decompositionServices(state)),
    );

    expect(result).toEqual({
      kind: IssueExecutionOutcomeKind.Decomposed,
      childIssueNumbers: [101, 102],
    });
    expect(state.closeCount.value).toBe(1);

    const childBodies = state.updates
      .filter(({ issueNumber }) => issueNumber === 101 || issueNumber === 102)
      .map(({ issueNumber, body }) => issue(issueNumber, `Child ${issueNumber}`, body));
    const queue = createIssueQueue([{ issue: issue(42, "Original") }]);
    expect(queue.next()?.number).toBe(42);
    queue.complete(42);
    expect(queue.refresh(toQueuedIssues(childBodies))).toBe(2);
    expect(queue.next()?.number).toBe(101);
    queue.complete(101);
    expect(queue.next()?.number).toBe(102);
  });

  test("resumes a partially completed decomposition without duplicating children", async () => {
    const state = {
      created: [] as number[],
      updates: [] as Array<{ issueNumber: number; body?: string }>,
      closeCount: { value: 0 },
      failSecondLink: { value: true },
    };
    const artifacts = await Effect.runPromise(makeIssueArtifactStore(42));
    const client = clientFor([breakdown]);
    const layer = decompositionServices(state);
    const first = await Effect.runPromiseExit(
      runDecomposition(client, artifacts, layer),
    );
    expect(first._tag).toBe("Failure");
    expect(state.created).toEqual([101, 102]);
    await Effect.runPromise(runDecomposition(client, artifacts, layer));
    expect(state.created).toEqual([101, 102]);
    expect(state.closeCount.value).toBe(1);
  });

  test("hands five-review exhaustion from the real implementation executor to decomposition without commit or push", async () => {
    const client = clientFor([
      { complexity: ComplexityLevel.Level2, rationale: "Small enough to implement." },
      undefined,
      {
        verdict: "changes_requested",
        summary: "Blocker remains.",
        findings: [{ severity: "blocking", description: "Fix it." }],
      },
      undefined,
      {
        verdict: "changes_requested",
        summary: "Blocker remains.",
        findings: [{ severity: "blocking", description: "Fix it." }],
      },
      undefined,
      {
        verdict: "changes_requested",
        summary: "Blocker remains.",
        findings: [{ severity: "blocking", description: "Fix it." }],
      },
      undefined,
      {
        verdict: "changes_requested",
        summary: "Blocker remains.",
        findings: [{ severity: "blocking", description: "Fix it." }],
      },
      undefined,
      {
        verdict: "changes_requested",
        summary: "Blocker remains.",
        findings: [{ severity: "blocking", description: "Fix it." }],
      },
    ]);
    const artifacts = await Effect.runPromise(makeIssueArtifactStore(42));
    let commitCalls = 0;
    let pushCalls = 0;
    let decompositionCalls = 0;
    const progress: ProgressUpdate[] = [];
    const implementationLayer = implementationServices(
      {
        commit: () => {
          commitCalls += 1;
          return Effect.succeed({ sha: "unexpected", treeSha: "unexpected" });
        },
        push: () => {
          pushCalls += 1;
          return Effect.void;
        },
      },
      progress,
    );
    const complexityLayer = ComplexityAssessmentLive.pipe(
      Layer.provide(makeProgressRecorderLayer([])),
    );
    const runtime = IssueExecutorLive.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.succeed(IssueArtifactStoreTag, {
            forIssue: () => Effect.succeed(artifacts),
          }),
          complexityLayer,
          ImplementationExecutorLive.pipe(Layer.provideMerge(implementationLayer)),
          Layer.succeed(DecompositionExecutor, {
            execute: () => {
              decompositionCalls += 1;
              return Effect.succeed({
                kind: IssueExecutionOutcomeKind.Decomposed,
                childIssueNumbers: [101, 102],
              });
            },
          }),
        ),
      ),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* IssueExecutor;
        return yield* executor.execute(context(client));
      }).pipe(Effect.provide(runtime as any)) as any,
    );

    expect(result).toEqual({
      kind: IssueExecutionOutcomeKind.Escalated,
      diagnosticsPath: "/workspace/recovery",
      reason: "Review did not converge within the review iteration budget.",
      childIssueNumbers: [101, 102],
    });
    expect(decompositionCalls).toBe(1);
    expect(commitCalls).toBe(0);
    expect(pushCalls).toBe(0);
    expect(
      await Effect.runPromise(artifacts.read(IssueArtifactKind.ReviewAttempts)),
    ).toHaveLength(5);
  });
});
