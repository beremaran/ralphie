import { describe, expect, test } from "bun:test";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { Effect, Exit, Layer } from "effect";
import type { Octokit } from "octokit";

import {
  IssueArtifactKind,
  type IssueArtifactStore,
  makeIssueArtifactStore,
} from "./artifacts.ts";
import {
  GitIssueOperations,
  type GitIssueOperationsService,
  GitPushError,
  GitPushFailurePolicy,
  GitPushFailureKind,
} from "../git/issue-operations.ts";
import {
  GitIssuePreparation,
  type GitIssuePreparationService,
} from "../git/issue-preparation.ts";
import {
  GitPushMode,
  GitRemoteSafety,
  type GitRemoteSafetyInput,
  type GitRemoteSafetyService,
} from "../git/remote-safety.ts";
import {
  IssueCompletionKind,
  IssueExecutionOutcomeKind,
  type IssueExecutionContext,
} from "./execution.ts";
import type { WorkflowExecutorResult } from "./workflow-executor-input.ts";
import {
  ImplementationExecutor,
  ImplementationExecutorLive,
} from "./implementation-executor.ts";
import {
  IssueRecovery,
  ReviewExhaustionOutcome,
  type IssueRecoveryService,
} from "./recovery.ts";
import { IssueQueueResumeStrategy, IssueWorkflowKind } from "./stage.ts";
import { RalphieError } from "../shared/error.ts";
import { makeOpenCodeSessionDiagnostics } from "../opencode/task-session.ts";
import {
  makeProgressRecorderLayer,
  type ProgressUpdate,
} from "../progress/progress.ts";
import type { IssueCheckpoint } from "../git/issue-checkpoint.ts";
import { reviewDecisionSchema } from "./decisions.ts";
import { IssueResolutionStatus } from "./decisions.ts";

const checkpoint: IssueCheckpoint = {
  branch: "main",
  sha: "0123456789abcdef0123456789abcdef01234567",
};

const review = (verdict: "approved" | "changes_requested") => ({
  verdict,
  summary: verdict === "approved" ? "The change is safe." : "Fix the blocker.",
  findings:
    verdict === "approved"
      ? []
      : [
          {
            severity: "blocking" as const,
            description: "The implementation misses an edge case.",
          },
        ],
});

const issueContext = (
  openCode: OpencodeClient,
  verify: IssueExecutionContext["repositoryInvariant"]["verify"] = () => Effect.void,
  head = checkpoint.sha,
): IssueExecutionContext => ({
  issue: {
    number: 42,
    title: "Fix token refresh",
    url: "https://github.com/owner/repository/issues/42",
    body: "Refresh expired tokens.",
    labels: ["bug"],
  },
  repository: "owner/repository",
  repositoryPath: "/workspace/repository",
  targetBranch: "main",
  workspace: "/workspace",
  runId: "run-1",
  octokit: {} as Octokit,
  openCode,
  openCodeSelection: { agent: "build" },
  openCodeDiagnostics: makeOpenCodeSessionDiagnostics(() => "now"),
  repositoryInvariant: {
    capture: () => Effect.succeed({ branch: checkpoint.branch, head }),
    verify,
  },
});

const openCodeClient = (outputs: ReadonlyArray<unknown>, sessions?: string[]) => {
  let index = 0;
  let sessionIndex = 0;
  const client = {
    session: {
      create: async () => {
        const sessionID = `session-${++sessionIndex}`;
        sessions?.push(sessionID);
        return { data: { id: sessionID } };
      },
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
  };
  return client as unknown as OpencodeClient;
};

const services = (options: {
  readonly preparation?: Partial<GitIssuePreparationService>;
  readonly operations?: Partial<GitIssueOperationsService>;
  readonly recovery?: Partial<IssueRecoveryService>;
  readonly remoteSafety?: Partial<GitRemoteSafetyService>;
  readonly safetyInputs?: GitRemoteSafetyInput[];
  readonly progress?: ProgressUpdate[];
}) => {
  const preparation: GitIssuePreparationService = {
    prepare: () => Effect.succeed(checkpoint),
    ...options.preparation,
  };
  const operations: GitIssueOperationsService = {
    stageAll: () => Effect.void,
    readStagedBinaryDiff: () => Effect.succeed("diff --git a/file b/file\n"),
    hasStagedChanges: () => Effect.succeed(true),
    commit: () => Effect.succeed({ sha: "commit-1", treeSha: "tree-1" }),
    push: () => Effect.void,
    createOrCheckoutFeatureBranch: () =>
      Effect.succeed({
        branch: "feature",
        baseBranch: "main",
        baseSha: checkpoint.sha,
        headSha: checkpoint.sha,
        created: true,
      }),
    restoreBaseCheckout: () => Effect.void,
    ...options.operations,
  };
  const recovery: IssueRecoveryService = {
    handleReviewExhaustion: () =>
      Effect.succeed({
        outcome: ReviewExhaustionOutcome.EscalatedToDecomposition,
        diagnosticsPath: "/workspace/review-exhaustion",
        nextWorkflow: IssueWorkflowKind.Decomposition,
        resume: IssueQueueResumeStrategy.RefreshOpenIssues,
      }),
    ...options.recovery,
  };
  const remoteSafety: GitRemoteSafetyService = {
    verifyDirectPush: (input) =>
      Effect.sync(() => {
        options.safetyInputs?.push(input);
        return {
          repository: input.repository,
          branch: input.branch,
          origin: "https://github.com/owner/repository.git",
          commitsBehindBase: 0,
          commitsAheadBase: input.expectedCommitSha === undefined ? 0 : 1,
          pushMode: GitPushMode.NonForce,
        } as const;
      }),
    ...options.remoteSafety,
  };
  return {
    layer: Layer.mergeAll(
      Layer.succeed(GitIssuePreparation, preparation),
      Layer.succeed(GitIssueOperations, operations),
      Layer.succeed(GitRemoteSafety, remoteSafety),
      Layer.succeed(IssueRecovery, recovery),
      makeProgressRecorderLayer(options.progress ?? []),
    ),
    preparation,
    operations,
    recovery,
  };
};

const run = (
  client: OpencodeClient,
  artifacts: IssueArtifactStore,
  layer: Layer.Layer.Any,
  verify?: IssueExecutionContext["repositoryInvariant"]["verify"],
  head?: string,
) =>
  Effect.gen(function* () {
    const executor = yield* ImplementationExecutor;
    return yield* executor.execute({
      context: issueContext(client, verify, head),
      artifacts,
    });
  }).pipe(
    Effect.provide(ImplementationExecutorLive),
    Effect.provide(layer as any),
  ) as Effect.Effect<WorkflowExecutorResult, RalphieError, never>;

describe("implementation executor", () => {
  test("implements, reviews, commits, and pushes after first-pass approval", async () => {
    const events: ProgressUpdate[] = [];
    const safetyInputs: GitRemoteSafetyInput[] = [];
    const setup = services({ progress: events, safetyInputs });
    const artifacts = await Effect.runPromise(makeIssueArtifactStore(42));
    const result = await Effect.runPromise(
      run(
        openCodeClient([
          undefined,
          review("approved"),
          { subject: "fix token refresh" },
        ]),
        artifacts,
        setup.layer,
      ),
    );

    expect(result).toEqual({
      kind: IssueExecutionOutcomeKind.Completed,
      completion: IssueCompletionKind.PushedCommit,
      commitSha: "commit-1",
      reviewCount: 1,
    });
    expect(
      await Effect.runPromise(artifacts.read(IssueArtifactKind.ReviewAttempts)),
    ).toHaveLength(1);
    expect(
      await Effect.runPromise(artifacts.read(IssueArtifactKind.CommitMessageDecision)),
    ).toEqual({
      subject: "fix token refresh",
    });
    expect(
      events.some((event) => event.stage === "review" && event.status === "succeeded"),
    ).toBe(true);
    expect(safetyInputs.map(({ expectedCommitSha }) => expectedCommitSha)).toEqual([
      undefined,
      "commit-1",
    ]);
  });

  test("refuses unsafe direct pushes before starting an agent session", async () => {
    let prompted = false;
    const client = openCodeClient([]);
    client.session.prompt = (async () => {
      prompted = true;
      return { data: { info: {}, parts: [] } };
    }) as unknown as typeof client.session.prompt;
    const setup = services({
      remoteSafety: {
        verifyDirectPush: () =>
          Effect.fail(new RalphieError({ message: "protected branch" })),
      },
    });
    const artifacts = await Effect.runPromise(makeIssueArtifactStore(42));
    const exit = await Effect.runPromiseExit(run(client, artifacts, setup.layer));

    expect(Exit.isFailure(exit)).toBe(true);
    expect(prompted).toBe(false);
  });

  test("reconciles a commit created before interruption without rerunning the agent", async () => {
    let pushedSha: string | undefined;
    const setup = services({
      operations: {
        push: (_path, _branch, sha) => {
          pushedSha = sha;
          return Effect.void;
        },
      },
    });
    const artifacts = await Effect.runPromise(makeIssueArtifactStore(42));
    await Effect.runPromise(
      artifacts.write(IssueArtifactKind.IssueCheckpoint, checkpoint),
    );
    await Effect.runPromise(
      artifacts.appendReview({
        attempt: 1,
        sessionID: "review-before-interruption",
        decision: reviewDecisionSchema.parse(review("approved")),
      }),
    );
    await Effect.runPromise(
      artifacts.write(IssueArtifactKind.CreatedCommit, {
        sha: "commit-1",
        treeSha: "tree-1",
      }),
    );

    const result = await Effect.runPromise(
      run(openCodeClient([]), artifacts, setup.layer, undefined, "commit-1"),
    );

    expect(result).toEqual({
      kind: IssueExecutionOutcomeKind.Completed,
      completion: IssueCompletionKind.PushedCommit,
      commitSha: "commit-1",
      reviewCount: 1,
    });
    expect(pushedSha).toBe("commit-1");
  });

  test("starts a fresh review-fix session and converges after a requested change", async () => {
    const sessions: string[] = [];
    const setup = services({
      operations: {
        hasStagedChanges: () => Effect.succeed(true),
      },
    });
    const artifacts = await Effect.runPromise(makeIssueArtifactStore(42));
    const result = await Effect.runPromise(
      run(
        openCodeClient(
          [
            undefined,
            review("changes_requested"),
            undefined,
            review("approved"),
            { subject: "fix token refresh" },
          ],
          sessions,
        ),
        artifacts,
        setup.layer,
      ),
    );

    expect(result).toMatchObject({
      kind: IssueExecutionOutcomeKind.Completed,
      reviewCount: 2,
    });
    expect(sessions).toHaveLength(5);
    expect(
      await Effect.runPromise(artifacts.read(IssueArtifactKind.ReviewAttempts)),
    ).toHaveLength(2);
  });

  test("completes without a commit when fresh verification proves the issue resolved", async () => {
    let commitCalled = false;
    let reviewPrompted = false;
    const setup = services({
      operations: {
        hasStagedChanges: () => Effect.succeed(false),
        commit: () => {
          commitCalled = true;
          return Effect.succeed({ sha: "commit-1", treeSha: "tree-1" });
        },
      },
    });
    const client = openCodeClient([
      undefined,
      {
        status: IssueResolutionStatus.Resolved,
        summary: "The checkout already closes every response body.",
        evidence: ["bodyclose reports zero findings"],
      },
    ]);
    const originalPrompt = client.session.prompt;
    client.session.prompt = (async (parameters: { format?: unknown }) => {
      if (parameters.format !== undefined) reviewPrompted = true;
      return originalPrompt(parameters as never);
    }) as unknown as typeof client.session.prompt;
    const artifacts = await Effect.runPromise(makeIssueArtifactStore(42));
    const result = await Effect.runPromise(run(client, artifacts, setup.layer));

    expect(result).toEqual({
      kind: IssueExecutionOutcomeKind.Completed,
      completion: IssueCompletionKind.AlreadyResolved,
      resolutionSummary: "The checkout already closes every response body.",
      evidence: ["bodyclose reports zero findings"],
    });
    expect(commitCalled).toBe(false);
    expect(reviewPrompted).toBe(true);
    expect(
      await Effect.runPromise(
        artifacts.read(IssueArtifactKind.IssueResolutionDecision),
      ),
    ).toMatchObject({ status: IssueResolutionStatus.Resolved });
  });

  test("fails safely when a no-change implementation remains unresolved", async () => {
    const setup = services({
      operations: { hasStagedChanges: () => Effect.succeed(false) },
    });
    const artifacts = await Effect.runPromise(makeIssueArtifactStore(42));
    const result = await Effect.runPromise(
      run(
        openCodeClient([
          undefined,
          {
            status: IssueResolutionStatus.Unresolved,
            summary: "The reported behavior still reproduces.",
            evidence: ["targeted test still fails"],
          },
        ]),
        artifacts,
        setup.layer,
      ),
    );

    expect(result).toEqual({
      kind: IssueExecutionOutcomeKind.Failed,
      message:
        "Issue remains unresolved after a no-change implementation: The reported behavior still reproduces.",
    });
  });

  test("fails when the implementation agent fails", async () => {
    const client = {
      session: {
        create: async () => ({ data: { id: "implementation" } }),
        prompt: async () => ({
          data: {
            info: {
              error: {
                name: "MessageOutputLengthError",
                data: { message: "too long" },
              },
            },
            parts: [],
          },
        }),
      },
    } as unknown as OpencodeClient;
    const artifacts = await Effect.runPromise(makeIssueArtifactStore(42));
    const exit = await Effect.runPromiseExit(
      run(client, artifacts, services({}).layer),
    );

    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("fails when a review response is invalid", async () => {
    const artifacts = await Effect.runPromise(makeIssueArtifactStore(42));
    const exit = await Effect.runPromiseExit(
      run(openCodeClient([{ verdict: "invalid" }]), artifacts, services({}).layer),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(artifacts.has(IssueArtifactKind.ReviewAttempts)).toBe(false);
  });

  test("fails without pushing when deterministic commit fails", async () => {
    let pushed = false;
    const setup = services({
      operations: {
        commit: () => Effect.fail(new RalphieError({ message: "commit failed" })),
        push: () => {
          pushed = true;
          return Effect.void;
        },
      },
    });
    const artifacts = await Effect.runPromise(makeIssueArtifactStore(42));
    const exit = await Effect.runPromiseExit(
      run(
        openCodeClient([undefined, review("approved"), { subject: "fix" }]),
        artifacts,
        setup.layer,
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(pushed).toBe(false);
  });

  test("fails when push is rejected", async () => {
    const setup = services({
      operations: {
        push: () =>
          Effect.fail(
            new GitPushError({
              kind: GitPushFailureKind.NonFastForward,
              policy: GitPushFailurePolicy.Halt,
              branch: "main",
              message: "rejected",
            }),
          ),
      },
    });
    const artifacts = await Effect.runPromise(makeIssueArtifactStore(42));
    const exit = await Effect.runPromiseExit(
      run(
        openCodeClient([undefined, review("approved"), { subject: "fix" }]),
        artifacts,
        setup.layer,
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(artifacts.has(IssueArtifactKind.CreatedCommit)).toBe(true);
    expect(
      await Effect.runPromise(artifacts.read(IssueArtifactKind.CreatedCommit)),
    ).toMatchObject({ sha: "commit-1" });
  });

  test("escalates after five rejected reviews without fixing or committing after the fifth", async () => {
    let fixCount = 0;
    let commitCalled = false;
    let recoveryInput: number | undefined;
    const setup = services({
      recovery: {
        handleReviewExhaustion: (input) => {
          recoveryInput = input.reviews.length;
          return Effect.succeed({
            outcome: ReviewExhaustionOutcome.EscalatedToDecomposition,
            diagnosticsPath: "/workspace/recovery",
            nextWorkflow: IssueWorkflowKind.Decomposition,
            resume: IssueQueueResumeStrategy.RefreshOpenIssues,
          });
        },
      },
      operations: {
        commit: () => {
          commitCalled = true;
          return Effect.succeed({ sha: "commit-1", treeSha: "tree-1" });
        },
      },
    });
    const client = openCodeClient([
      undefined,
      review("changes_requested"),
      undefined,
      review("changes_requested"),
      undefined,
      review("changes_requested"),
      undefined,
      review("changes_requested"),
      undefined,
      review("changes_requested"),
    ]);
    const originalPrompt = client.session.prompt;
    client.session.prompt = (async (parameters: {
      format?: unknown;
      parts?: ReadonlyArray<{ text: string }>;
    }) => {
      if (
        parameters.format === undefined &&
        parameters.parts?.[0]?.text.includes("Address the blocking findings")
      ) {
        fixCount += 1;
      }
      return originalPrompt(parameters as never);
    }) as unknown as typeof client.session.prompt;
    const artifacts = await Effect.runPromise(makeIssueArtifactStore(42));
    const result = await Effect.runPromise(run(client, artifacts, setup.layer));

    expect(result).toEqual({
      kind: IssueExecutionOutcomeKind.Escalated,
      diagnosticsPath: "/workspace/recovery",
      reason: "Review did not converge within the review iteration budget.",
    });
    expect(recoveryInput).toBe(5);
    expect(fixCount).toBe(4);
    expect(commitCalled).toBe(false);
  });

  test("stages, reviews, commits, and pushes every changed project repository", async () => {
    const directories: string[] = [];
    const calls: string[] = [];
    const client = openCodeClient([
      undefined,
      review("approved"),
      { subject: "fix project integration" },
    ]);
    const originalCreate = client.session.create;
    client.session.create = (async (parameters: { directory: string }) => {
      directories.push(parameters.directory);
      return originalCreate(parameters as never);
    }) as typeof client.session.create;
    const repositories = [
      {
        repository: "owner/frontend",
        repositoryPath: "/workspace/proj-b/frontend",
        branch: "main",
      },
      {
        repository: "owner/backend",
        repositoryPath: "/workspace/proj-b/backend",
        branch: "main",
      },
    ];
    const artifacts = await Effect.runPromise(makeIssueArtifactStore(42));
    const setup = services({
      preparation: {
        prepareProject: (_repositories, store) => {
          const checkpoints = repositories.map((repository, index) => ({
            ...repository,
            sha: `${index + 1}`.repeat(40),
          }));
          return store
            .write(IssueArtifactKind.ProjectCheckpoints, checkpoints)
            .pipe(Effect.as(checkpoints));
        },
      },
      operations: {
        stageAll: (path) => Effect.sync(() => calls.push(`stage:${path}`)),
        hasStagedChanges: () => Effect.succeed(true),
        readStagedBinaryDiff: (path) =>
          Effect.succeed(`diff --git ${path}/file ${path}/file\n`),
        commit: (path) =>
          Effect.sync(() => {
            calls.push(`commit:${path}`);
            const name = path.endsWith("frontend") ? "front" : "back";
            return { sha: `${name}-sha`, treeSha: `${name}-tree` };
          }),
        push: (path) => Effect.sync(() => calls.push(`push:${path}`)),
      },
    });
    const context: IssueExecutionContext = {
      ...issueContext(client),
      project: "proj-b",
      workingDirectory: "/workspace/proj-b",
      projectRepositories: repositories,
    };
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* ImplementationExecutor;
        return yield* executor.execute({ context, artifacts });
      }).pipe(
        Effect.provide(ImplementationExecutorLive),
        Effect.provide(setup.layer as any),
      ) as Effect.Effect<WorkflowExecutorResult, RalphieError, never>,
    );

    expect(directories).toEqual([
      "/workspace/proj-b",
      "/workspace/proj-b",
      "/workspace/proj-b",
    ]);
    expect(calls.filter((call) => call.startsWith("commit:"))).toEqual([
      "commit:/workspace/proj-b/frontend",
      "commit:/workspace/proj-b/backend",
    ]);
    expect(calls.filter((call) => call.startsWith("push:"))).toEqual([
      "push:/workspace/proj-b/frontend",
      "push:/workspace/proj-b/backend",
    ]);
    expect(result).toMatchObject({
      kind: IssueExecutionOutcomeKind.Completed,
      completion: IssueCompletionKind.PushedCommit,
      commits: [
        { repository: "owner/frontend", sha: "front-sha" },
        { repository: "owner/backend", sha: "back-sha" },
      ],
    });
  });

  test("resumes project delivery without rerunning agents after a partial push failure", async () => {
    const repositories = [
      {
        repository: "owner/frontend",
        repositoryPath: "/workspace/proj/frontend",
        branch: "main",
      },
      {
        repository: "owner/backend",
        repositoryPath: "/workspace/proj/backend",
        branch: "main",
      },
    ];
    const heads = new Map(
      repositories.map(({ repositoryPath }) => [repositoryPath, "a".repeat(40)]),
    );
    const artifacts = await Effect.runPromise(makeIssueArtifactStore(42));
    let failBackendPush = true;
    let sessionCount = 0;
    const client = openCodeClient([
      undefined,
      review("approved"),
      { subject: "fix project delivery" },
    ]);
    const originalCreate = client.session.create;
    client.session.create = (async (
      ...parameters: Parameters<typeof originalCreate>
    ) => {
      sessionCount += 1;
      return originalCreate(...parameters);
    }) as typeof client.session.create;
    const setup = services({
      preparation: {
        prepareProject: (_repositories, store) => {
          const checkpoints = repositories.map((repository) => ({
            ...repository,
            sha: "a".repeat(40),
          }));
          return store
            .write(IssueArtifactKind.ProjectCheckpoints, checkpoints)
            .pipe(Effect.as(checkpoints));
        },
      },
      operations: {
        hasStagedChanges: (path) => Effect.succeed(heads.get(path) === "a".repeat(40)),
        commit: (path) =>
          Effect.sync(() => {
            const sha = path.endsWith("frontend") ? "b".repeat(40) : "c".repeat(40);
            heads.set(path, sha);
            return { sha, treeSha: `${sha}-tree` };
          }),
        push: (path) =>
          path.endsWith("backend") && failBackendPush
            ? Effect.fail(new RalphieError({ message: "backend push failed" }))
            : Effect.void,
      },
    });
    const context: IssueExecutionContext = {
      ...issueContext(client),
      project: "proj",
      workingDirectory: "/workspace/proj",
      projectRepositories: repositories,
      repositoryInvariant: {
        capture: (path) => Effect.succeed({ branch: "main", head: heads.get(path)! }),
        verify: () => Effect.void,
      },
    };
    const execute = () =>
      Effect.gen(function* () {
        const executor = yield* ImplementationExecutor;
        return yield* executor.execute({ context, artifacts });
      }).pipe(
        Effect.provide(ImplementationExecutorLive),
        Effect.provide(setup.layer as any),
      ) as Effect.Effect<WorkflowExecutorResult, RalphieError, never>;

    const first = await Effect.runPromiseExit(execute());
    expect(Exit.isFailure(first)).toBeTrue();
    expect(sessionCount).toBe(3);

    failBackendPush = false;
    const resumed = await Effect.runPromise(execute());
    expect(sessionCount).toBe(3);
    expect(resumed).toMatchObject({
      kind: IssueExecutionOutcomeKind.Completed,
      commits: [
        { repository: "owner/frontend", sha: "b".repeat(40) },
        { repository: "owner/backend", sha: "c".repeat(40) },
      ],
    });
  });
});
