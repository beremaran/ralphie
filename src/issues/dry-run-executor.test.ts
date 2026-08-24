import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import type { Octokit } from "octokit";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import { IssueArtifactKind, IssueArtifactStore, makeIssueArtifactStore } from "./artifacts.ts";
import { ComplexityAssessment } from "./complexity.ts";
import { ComplexityLevel } from "./decisions.ts";
import { DryRunIssueExecutor, DryRunIssueExecutorLive } from "./dry-run-executor.ts";
import { IssueExecutionOutcomeKind, type IssueExecutionContext } from "./execution.ts";
import { ImplementationExecutor } from "./implementation-executor.ts";
import { DecompositionExecutor } from "./decomposition-executor.ts";
import { makeProgressRecorderLayer, type ProgressUpdate } from "../progress/progress.ts";

const context = (number: number): IssueExecutionContext => ({
  issue: {
    number,
    title: "Dry-run issue",
    url: `issue/${number}`,
    body: "Assess this issue.",
    labels: [],
  },
  repository: "owner/repository",
  repositoryPath: "/workspace/repository",
  targetBranch: "main",
  workspace: "/workspace",
  runId: "dry-run",
  octokit: {} as Octokit,
  openCode: {} as OpencodeClient,
  openCodeSelection: { agent: "build" },
  openCodeDiagnostics: { record: () => undefined, list: () => [] },
  repositoryInvariant: {
    capture: () => Effect.succeed({ branch: "main", head: "abc123" }),
    verify: () => Effect.void,
  },
});

const run = async (complexity: ComplexityLevel, events: ProgressUpdate[]) => {
  let implementationCalls = 0;
  let decompositionCalls = 0;
  const artifacts = await Effect.runPromise(makeIssueArtifactStore(42));
  const layer = DryRunIssueExecutorLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(IssueArtifactStore, {
          forIssue: () => Effect.succeed(artifacts),
        }),
        Layer.succeed(ComplexityAssessment, {
          assess: () =>
            Effect.succeed({
              sessionID: "complexity-session",
              decision: { complexity, rationale: "dry-run test" },
            }),
        }),
        Layer.succeed(ImplementationExecutor, {
          execute: () => {
            implementationCalls += 1;
            return Effect.dieMessage("implementation must not run");
          },
        }),
        Layer.succeed(DecompositionExecutor, {
          execute: () => {
            decompositionCalls += 1;
            return Effect.dieMessage("decomposition must not run");
          },
        }),
        makeProgressRecorderLayer(events),
      ),
    ),
  );
  const result = await Effect.gen(function* () {
    const executor = yield* DryRunIssueExecutor;
    return yield* executor.execute(context(42));
  }).pipe(Effect.provide(layer), Effect.runPromise);
  return { result, artifacts, implementationCalls, decompositionCalls };
};

describe("dry-run issue executor", () => {
  test.each([ComplexityLevel.Level2, ComplexityLevel.Level4])(
    "assesses complexity %s, reports routing, and never invokes mutation executors",
    async (complexity) => {
      const events: ProgressUpdate[] = [];
      const outcome = await run(complexity, events);

      expect(outcome.result.kind).toBe(IssueExecutionOutcomeKind.Skipped);
      if (outcome.result.kind === IssueExecutionOutcomeKind.Skipped) {
        expect(outcome.result.reason).toContain(`complexity ${complexity}/5`);
      }
      expect(outcome.implementationCalls).toBe(0);
      expect(outcome.decompositionCalls).toBe(0);
      expect(events.at(-1)?.message).toContain("Dry run would route");
      expect(
        await Effect.runPromise(
          outcome.artifacts.read(IssueArtifactKind.ComplexityDecision),
        ),
      ).toEqual({ complexity, rationale: "dry-run test" });
    },
  );
});
