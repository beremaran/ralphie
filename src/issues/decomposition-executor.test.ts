import { describe, expect, test } from "bun:test";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { Cause, Effect, Exit, Layer } from "effect";
import type { Octokit } from "octokit";

import {
  IssueArtifactKind,
  type IssueArtifactStore,
  makeIssueArtifactStore,
} from "./artifacts.ts";
import { ImplementationComplexityLevel, ReviewFindingSeverity, ReviewVerdict } from "./decisions.ts";
import {
  DecompositionExecutor,
  DecompositionExecutorLive,
} from "./decomposition-executor.ts";
import {
  IssueExecutionOutcomeKind,
  type IssueExecutionContext,
} from "./execution.ts";
import {
  GitHubMutationRecoveryError,
  GitHubIssueMutations,
  GitHubIssueMutationsLive,
} from "../github/issue-mutations.ts";
import { GitHubIssues } from "../github/issues.ts";
import type { GitHubDecompositionChild } from "../github/issues.ts";
import { makeOpenCodeSessionDiagnostics } from "../opencode/task-session.ts";
import { makeProgressRecorderLayer } from "../progress/progress.ts";

const breakdown = {
  rationale: "Separate the API and storage work.",
  issues: [
    {
      key: "storage",
      title: "Migrate storage",
      body: "Move storage behind the new interface.",
      estimatedComplexity: ImplementationComplexityLevel.Level2,
      dependsOn: [],
    },
    {
      key: "api",
      title: "Update API",
      body: "Update API consumers to use the interface.",
      estimatedComplexity: ImplementationComplexityLevel.Level1,
      dependsOn: ["storage"],
    },
  ],
};

const issueResponse = (number: number, title: string, body: string) => ({
  data: {
    number,
    title,
    html_url: `https://github.com/owner/repository/issues/${number}`,
    body,
    labels: [],
  },
});

const context = (
  openCode: OpencodeClient,
  octokit: Octokit,
): IssueExecutionContext => ({
  issue: {
    number: 42,
    title: "Modernize the API",
    url: "https://github.com/owner/repository/issues/42",
    body: "Preserve this original content.",
    labels: ["architecture"],
  },
  repository: "owner/repository",
  repositoryPath: "/workspace/repository",
  targetBranch: "main",
  workspace: "/workspace",
  runId: "run-1",
  octokit,
  openCode,
  openCodeSelection: { agent: "build" },
  openCodeDiagnostics: makeOpenCodeSessionDiagnostics(),
  repositoryInvariant: {
    capture: () => Effect.succeed({ branch: "main", head: "abc123" }),
    verify: () => Effect.void,
  },
});

const openCodeClient = (capturePrompt?: (prompt: string) => void) =>
  ({
    session: {
      create: async () => ({ data: { id: "decomposition-session" } }),
      prompt: async (parameters: { parts: ReadonlyArray<{ text: string }> }) => {
        capturePrompt?.(parameters.parts[0]?.text ?? "");
        return {
          data: {
            info: { structured: breakdown },
            parts: [],
          },
        };
      },
    },
  }) as unknown as OpencodeClient;

const run = (
  openCode: OpencodeClient,
  octokit: Octokit,
  artifacts: IssueArtifactStore,
  discoveredChildren: ReadonlyArray<GitHubDecompositionChild> = [],
) =>
  Effect.gen(function* () {
    const executor = yield* DecompositionExecutor;
    return yield* executor.execute({ context: context(openCode, octokit), artifacts });
  }).pipe(
    Effect.provide(DecompositionExecutorLive),
    Effect.provide(
      Layer.merge(
        GitHubIssueMutationsLive,
        Layer.merge(
          Layer.succeed(GitHubIssues, {
            listOpen: () => Effect.succeed([]),
            listDecompositionChildren: () => Effect.succeed(discoveredChildren),
          }),
          makeProgressRecorderLayer([]),
        ),
      ),
    ),
  );

describe("decomposition executor", () => {
  test("creates, links, rewrites, and closes in deterministic order", async () => {
    const requests: Array<{ method: string; parameters: Record<string, unknown> }> = [];
    let prompt = "";
    const octokit = {
      rest: {
        issues: {
          create: async (parameters: Record<string, unknown>) => {
            requests.push({ method: "create", parameters });
            const number = parameters.title === "Migrate storage" ? 101 : 102;
            return issueResponse(number, String(parameters.title), String(parameters.body));
          },
          update: async (parameters: Record<string, unknown>) => {
            requests.push({ method: "update", parameters });
            return issueResponse(
              Number(parameters.issue_number),
              "Updated",
              String(parameters.body ?? ""),
            );
          },
        },
      },
    } as unknown as Octokit;
    const artifacts = await Effect.runPromise(makeIssueArtifactStore(42));
    await Effect.runPromise(
      run(openCodeClient((value) => (prompt = value)), octokit, artifacts),
    );

    expect(prompt).toContain("Break down the GitHub issue");
    expect(requests.map(({ method, parameters }) => [method, parameters.issue_number])).toEqual([
      ["create", undefined],
      ["create", undefined],
      ["update", 101],
      ["update", 102],
      ["update", 42],
      ["update", 42],
    ]);
    expect(requests[2]?.parameters.body).toContain("#102");
    expect(requests[2]?.parameters.body).toContain("#42");
    expect(requests[3]?.parameters.body).toContain("#101");
    expect(requests[4]?.parameters.body).toContain("Preserve this original content.");
    expect(requests[5]?.parameters.state_reason).toBe("duplicate");

    const mapping = await Effect.runPromise(
      artifacts.read(IssueArtifactKind.CreatedIssueNumbers),
    );
    expect(mapping).toEqual({ storage: 101, api: 102 });
  });

  test("passes failed review summaries to decomposition and persists breakdown before creation", async () => {
    let prompt = "";
    let breakdownPersisted = false;
    const artifacts = await Effect.runPromise(makeIssueArtifactStore(42));
    await Effect.runPromise(
      artifacts.appendReview({
        attempt: 1,
        sessionID: "review-1",
        decision: {
          verdict: ReviewVerdict.ChangesRequested,
          summary: "Split the migration.",
          findings: [
            {
              severity: ReviewFindingSeverity.Blocking,
              description: "The change is too broad.",
            },
          ],
        },
      }),
    );
    const client = openCodeClient((value) => (prompt = value));
    const octokit = {
      rest: {
        issues: {
          create: async () => {
            breakdownPersisted = artifacts.has(IssueArtifactKind.IssueBreakdownDecision);
            return issueResponse(101, "Child", "Child");
          },
          update: async () => issueResponse(101, "Child", "Child"),
        },
      },
    } as unknown as Octokit;

    await Effect.runPromise(run(client, octokit, artifacts));
    expect(prompt).toContain("Split the migration.");
    expect(breakdownPersisted).toBeTrue();
  });

  test("reconciles marker-discovered children before creating new issues", async () => {
    let createCount = 0;
    const artifacts = await Effect.runPromise(makeIssueArtifactStore(42));
    await Effect.runPromise(
      artifacts.write(IssueArtifactKind.IssueBreakdownDecision, breakdown),
    );
    const discoveredChildren: ReadonlyArray<GitHubDecompositionChild> = [
      {
        number: 101,
        title: "Migrate storage",
        url: "https://github.com/owner/repository/issues/101",
        body: '<!-- ralphie:decomposition root=42 parent=42 key="storage" depth=1 -->',
        labels: [],
        decompositionKey: "storage",
      },
      {
        number: 102,
        title: "Update API",
        url: "https://github.com/owner/repository/issues/102",
        body: '<!-- ralphie:decomposition root=42 parent=42 key="api" depth=1 -->',
        labels: [],
        decompositionKey: "api",
      },
    ];
    const octokit = {
      rest: {
        issues: {
          create: async () => {
            createCount += 1;
            return issueResponse(999, "Unexpected", "Unexpected");
          },
          update: async (parameters: Record<string, unknown>) =>
            issueResponse(Number(parameters.issue_number), "Updated", "Updated"),
        },
      },
    } as unknown as Octokit;

    const outcome = await Effect.runPromise(
      run(openCodeClient(), octokit, artifacts, discoveredChildren),
    );
    expect(outcome).toEqual({
      kind: IssueExecutionOutcomeKind.Decomposed,
      childIssueNumbers: [101, 102],
    });
    expect(createCount).toBe(0);
    expect(
      await Effect.runPromise(
        artifacts.read(IssueArtifactKind.CreatedIssueNumbers),
      ),
    ).toEqual({ storage: 101, api: 102 });
  });

  test("leaves the original open when child linking fails", async () => {
    let originalUpdated = false;
    let closeCount = 0;
    let createCount = 0;
    let failLink = true;
    const octokit = {
      rest: {
        issues: {
          create: async (parameters: Record<string, unknown>) => {
            createCount += 1;
            return issueResponse(parameters.title === "Migrate storage" ? 101 : 102, "Child", "Child");
          },
          update: async (parameters: Record<string, unknown>) => {
            if (parameters.issue_number === 42) originalUpdated = true;
            if (parameters.issue_number === 102 && failLink) {
              throw new Error("link failed");
            }
            if (parameters.state === "closed") closeCount += 1;
            return issueResponse(Number(parameters.issue_number), "Child", "Child");
          },
        },
      },
    } as unknown as Octokit;
    const artifacts = await Effect.runPromise(makeIssueArtifactStore(42));

    const exit = await Effect.runPromiseExit(
      run(openCodeClient(), octokit, artifacts),
    );
    expect(Exit.isFailure(exit)).toBeTrue();
    expect(originalUpdated).toBeFalse();
    expect(closeCount).toBe(0);

    failLink = false;
    await Effect.runPromise(run(openCodeClient(), octokit, artifacts));
    expect(createCount).toBe(2);
    expect(originalUpdated).toBeTrue();
    expect(closeCount).toBe(1);

    await Effect.runPromise(run(openCodeClient(), octokit, artifacts));
    expect(createCount).toBe(2);
    expect(closeCount).toBe(2);
  });

  test.each([1, 2, 3, 4, 5, 6])(
    "emits recovery failure when mutation boundary %d fails",
    async (failureAt) => {
      let mutationCount = 0;
      let closeCount = 0;
      const octokit = {
        rest: {
          issues: {
            create: async (parameters: Record<string, unknown>) => {
              mutationCount += 1;
              if (mutationCount === failureAt) throw new Error("mutation failed");
              return issueResponse(
                parameters.title === "Migrate storage" ? 101 : 102,
                "Child",
                "Child",
              );
            },
            update: async (parameters: Record<string, unknown>) => {
              mutationCount += 1;
              if (mutationCount === failureAt) throw new Error("mutation failed");
              if (parameters.state === "closed") closeCount += 1;
              return issueResponse(Number(parameters.issue_number), "Child", "Child");
            },
          },
        },
      } as unknown as Octokit;
      const artifacts = await Effect.runPromise(makeIssueArtifactStore(42));

      const exit = await Effect.runPromiseExit(
        run(openCodeClient(), octokit, artifacts),
      );
      expect(Exit.isFailure(exit)).toBeTrue();
      expect(closeCount).toBe(0);
      if (failureAt === 6 && Exit.isFailure(exit)) {
        const error = Cause.failureOption(exit.cause);
        expect(
          error._tag === "Some" && error.value instanceof GitHubMutationRecoveryError,
        ).toBeTrue();
      }
    },
  );
});
