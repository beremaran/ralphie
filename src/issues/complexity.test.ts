import { describe, expect, test } from "bun:test";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import type { Octokit } from "octokit";
import { Effect, Exit, Layer } from "effect";

import {
  makeProgressRecorderLayer,
  type ProgressUpdate,
  ProgressStage,
  ProgressStatus,
} from "../progress/progress.ts";
import {
  ComplexityAssessment,
  ComplexityAssessmentLive,
} from "./complexity.ts";
import { ComplexityLevel } from "./decisions.ts";
import type { IssueExecutionContext } from "./execution.ts";

const assistantInfo = (structured: unknown) => ({
  id: "message-1",
  sessionID: "session-1",
  role: "assistant" as const,
  time: { created: 0, completed: 1 },
  parentID: "message-0",
  modelID: "test-model",
  providerID: "test-provider",
  mode: "test",
  agent: "build",
  path: { cwd: "/workspace/repo", root: "/workspace/repo" },
  cost: 0,
  tokens: {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  },
  structured,
});

const context = (client: OpencodeClient): IssueExecutionContext => ({
  issue: {
    number: 42,
    title: "Fix token refresh",
    url: "issue/42",
    body: "Refresh expired tokens.",
    labels: ["bug"],
  },
  repositoryPath: "/workspace/repo",
  targetBranch: "main",
  workspace: "/workspace",
  runId: "run-1",
  octokit: {} as Octokit,
  openCode: client,
  openCodeSelection: { agent: "build" },
});

const assessmentLayer = (events: ProgressUpdate[]) =>
  ComplexityAssessmentLive.pipe(
    Layer.provide(makeProgressRecorderLayer(events)),
  );

describe("complexity assessment", () => {
  test("gets a schema-validated decision and reports progress", async () => {
    const events: ProgressUpdate[] = [];
    const client = {
      session: {
        create: async () => ({ data: { id: "session-1" } }),
        prompt: async () => ({
          data: {
            info: assistantInfo({
              complexity: ComplexityLevel.Level2,
              rationale: "The change is localized.",
            }),
            parts: [],
          },
        }),
      },
    } as unknown as OpencodeClient;

    const result = await Effect.gen(function* () {
      const assessment = yield* ComplexityAssessment;
      return yield* assessment.assess(context(client));
    }).pipe(Effect.provide(assessmentLayer(events)), Effect.runPromise);

    expect(result).toEqual({
      sessionID: "session-1",
      decision: {
        complexity: ComplexityLevel.Level2,
        rationale: "The change is localized.",
      },
    });
    expect(events.map(({ stage, status }) => ({ stage, status }))).toEqual([
      {
        stage: ProgressStage.ComplexityAssessment,
        status: ProgressStatus.Started,
      },
      {
        stage: ProgressStage.ComplexityAssessment,
        status: ProgressStatus.Succeeded,
      },
    ]);
  });

  test("fails without mutation when structured output is invalid", async () => {
    const events: ProgressUpdate[] = [];
    const client = {
      session: {
        create: async () => ({ data: { id: "session-1" } }),
        prompt: async () => ({
          data: {
            info: assistantInfo({ complexity: 9, rationale: "Invalid" }),
            parts: [],
          },
        }),
      },
    } as unknown as OpencodeClient;

    const exit = await Effect.gen(function* () {
      const assessment = yield* ComplexityAssessment;
      yield* assessment.assess(context(client));
    }).pipe(
      Effect.provide(assessmentLayer(events)),
      Effect.runPromiseExit,
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(events.at(-1)?.status).toBe(ProgressStatus.Failed);
  });
});
