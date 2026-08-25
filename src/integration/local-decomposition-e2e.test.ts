import { describe, expect, test } from "bun:test";
import type { PiClient } from "../pi/client.ts";
import { Effect, Layer } from "effect";
import type { Octokit } from "octokit";

import {
  IssueArtifactKind,
  IssueArtifactStore,
  makeIssueArtifactStore,
} from "../issues/artifacts.ts";
import { ComplexityAssessment } from "../issues/complexity.ts";
import { ComplexityLevel, ImplementationComplexityLevel } from "../issues/decisions.ts";
import { DecompositionExecutorLive } from "../issues/decomposition-executor.ts";
import {
  IssueExecutionOutcomeKind,
  type IssueExecutionContext,
} from "../issues/execution.ts";
import { IssueExecutor, IssueExecutorLive } from "../issues/executor.ts";
import { ImplementationExecutor } from "../issues/implementation-executor.ts";
import { GitHubIssueMutationsLive } from "../github/issue-mutations.ts";
import { GitHubIssuesLive } from "../github/issues.ts";
import { makePiSessionDiagnostics } from "../agent/task-session.ts";
import {
  makeProgressRecorderLayer,
  type ProgressUpdate,
} from "../progress/progress.ts";

const breakdown = {
  rationale: "Separate storage migration from API adoption.",
  issues: [
    {
      key: "storage",
      title: "Migrate storage",
      body: "Move persistence behind the new storage interface.",
      estimatedComplexity: ImplementationComplexityLevel.Level2,
      dependsOn: [],
    },
    {
      key: "api",
      title: "Adopt storage API",
      body: "Update API consumers after storage migration.",
      estimatedComplexity: ImplementationComplexityLevel.Level1,
      dependsOn: ["storage"],
    },
  ],
};

type StoredIssue = {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  state_reason?: string;
  html_url: string;
  labels: ReadonlyArray<string>;
};

const makeOctokit = () => {
  const issues = new Map<number, StoredIssue>([
    [
      42,
      {
        number: 42,
        title: "Modernize persistence",
        body: "Preserve this original issue content.",
        state: "open",
        html_url: "https://github.com/owner/repository/issues/42",
        labels: ["architecture"],
      },
    ],
  ]);
  const requests: Array<{
    readonly method: "create" | "update";
    readonly parameters: Record<string, unknown>;
  }> = [];
  let nextIssueNumber = 101;

  const toResponse = (issue: StoredIssue) => ({
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    state_reason: issue.state_reason,
    html_url: issue.html_url,
    labels: issue.labels,
  });

  const client = {
    rest: {
      issues: {
        listForRepo: Symbol("listForRepo"),
        get: async (parameters: Record<string, unknown>) => {
          const issue = issues.get(Number(parameters.issue_number));
          if (issue === undefined) {
            throw new Error(`Unknown issue ${String(parameters.issue_number)}`);
          }
          return { data: toResponse(issue) };
        },
        create: async (parameters: Record<string, unknown>) => {
          const number = nextIssueNumber++;
          const issue: StoredIssue = {
            number,
            title: String(parameters.title),
            body: String(parameters.body ?? ""),
            state: "open",
            html_url: `https://github.com/owner/repository/issues/${number}`,
            labels: [],
          };
          issues.set(number, issue);
          requests.push({ method: "create", parameters });
          return { data: toResponse(issue) };
        },
        update: async (parameters: Record<string, unknown>) => {
          const number = Number(parameters.issue_number);
          const issue = issues.get(number);
          if (issue === undefined) throw new Error(`Unknown issue ${number}`);
          if (parameters.title !== undefined) issue.title = String(parameters.title);
          if (parameters.body !== undefined) issue.body = String(parameters.body);
          if (parameters.state === "closed") issue.state = "closed";
          if (parameters.state_reason !== undefined) {
            issue.state_reason = String(parameters.state_reason);
          }
          requests.push({ method: "update", parameters });
          return { data: toResponse(issue) };
        },
      },
    },
    paginate: async () => [...issues.values()].map(toResponse),
  } as unknown as Octokit;

  return { client, issues, requests };
};

const pi = {
  session: {
    create: async () => ({ data: { id: "decomposition-session" } }),
    prompt: async () => ({
      data: {
        info: { structured: breakdown },
        parts: [],
      },
    }),
  },
} as unknown as PiClient;

const context = (octokit: Octokit): IssueExecutionContext => ({
  issue: {
    number: 42,
    title: "Modernize persistence",
    url: "https://github.com/owner/repository/issues/42",
    body: "Preserve this original issue content.",
    labels: ["architecture"],
  },
  repository: "owner/repository",
  repositoryPath: "/tmp/ralphie-local-decomposition",
  targetBranch: "main",
  workspace: "/tmp/ralphie-local-decomposition-workspace",
  runId: "local-decomposition-e2e",
  octokit,
  pi,
  piSelection: { agent: "build" },
  piDiagnostics: makePiSessionDiagnostics(() => "now"),
  repositoryInvariant: {
    capture: () => Effect.succeed({ branch: "main", head: "abc123" }),
    verify: () => Effect.void,
  },
});

test("runs the real decomposition workflow against a disposable in-memory GitHub", async () => {
  const fake = makeOctokit();
  const artifacts = await Effect.runPromise(makeIssueArtifactStore(42));
  let assessmentCalls = 0;
  let implementationCalls = 0;
  const progressEvents: ProgressUpdate[] = [];

  const decompositionDependencies = Layer.mergeAll(
    GitHubIssueMutationsLive,
    GitHubIssuesLive,
    makeProgressRecorderLayer(progressEvents),
  );
  const applicationDependencies = Layer.mergeAll(
    Layer.succeed(IssueArtifactStore, {
      forIssue: () => Effect.succeed(artifacts),
    }),
    Layer.succeed(ComplexityAssessment, {
      assess: () => {
        assessmentCalls += 1;
        return Effect.succeed({
          decision: {
            complexity: ComplexityLevel.Level4,
            rationale: "This spans storage and API concerns.",
          },
          sessionID: "complexity-session",
        });
      },
    }),
    Layer.succeed(ImplementationExecutor, {
      execute: () => {
        implementationCalls += 1;
        return Effect.die("implementation workflow must not run for complexity 4");
      },
    }),
    DecompositionExecutorLive.pipe(Layer.provide(decompositionDependencies)),
  );

  const outcome = await Effect.gen(function* () {
    const executor = yield* IssueExecutor;
    const result = yield* executor.execute(context(fake.client));
    return {
      result,
      mapping: yield* artifacts.read(IssueArtifactKind.CreatedIssueNumbers),
    };
  }).pipe(
    Effect.provide(IssueExecutorLive),
    Effect.provide(applicationDependencies),
    Effect.runPromise,
  );

  expect(assessmentCalls).toBe(1);
  expect(implementationCalls).toBe(0);
  expect(outcome.result).toEqual({
    kind: IssueExecutionOutcomeKind.Decomposed,
    childIssueNumbers: [101, 102],
  });
  expect(outcome.mapping).toEqual({ storage: 101, api: 102 });
  expect(
    fake.requests.map(({ method, parameters }) => [method, parameters.issue_number]),
  ).toEqual([
    ["create", undefined],
    ["create", undefined],
    ["update", 101],
    ["update", 102],
    ["update", 42],
    ["update", 42],
  ]);

  const storage = fake.issues.get(101)!;
  const api = fake.issues.get(102)!;
  const original = fake.issues.get(42)!;
  expect(storage.body).toContain("#42");
  expect(storage.body).toContain("#102");
  expect(api.body).toContain("#42");
  expect(api.body).toContain("#101");
  expect(original.body).toContain("Preserve this original issue content.");
  expect(original.body).toContain("#101");
  expect(original.body).toContain("#102");
  expect(original.body).toContain("depends on #101");
  expect(original.state).toBe("closed");
  expect(original.state_reason).toBe("duplicate");
  expect(progressEvents.length).toBeGreaterThan(0);
});
