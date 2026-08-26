import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { makeIssueArtifactStore } from "../artifacts.ts";
import { DecompositionExecutor } from "../decomposition-executor.ts";
import {
  IssueCompletionKind,
  IssueExecutionOutcomeKind,
  type IssueExecutionContext,
} from "../execution.ts";
import { ImplementationExecutor } from "../implementation-executor.ts";

const context = {
  issue: {
    number: 42,
  },
} as IssueExecutionContext;

describe("concrete issue workflow executors", () => {
  test("exposes implementation execution with its per-issue artifacts", async () => {
    const artifacts = await Effect.runPromise(makeIssueArtifactStore(42));
    const outcome = await Effect.gen(function* () {
      const executor = yield* ImplementationExecutor;
      return yield* executor.execute({
        context,
        artifacts,
      });
    }).pipe(
      Effect.provide(
        Layer.succeed(ImplementationExecutor, {
          execute: (input) =>
            Effect.succeed({
              kind: IssueExecutionOutcomeKind.Completed,
              completion: IssueCompletionKind.PushedCommit,
              commitSha: `issue-${input.artifacts.issueNumber}`,
            }),
        }),
      ),
      Effect.runPromise,
    );

    expect(outcome).toEqual({
      kind: IssueExecutionOutcomeKind.Completed,
      completion: IssueCompletionKind.PushedCommit,
      commitSha: "issue-42",
    });
  });

  test("exposes decomposition execution with its per-issue artifacts", async () => {
    const artifacts = await Effect.runPromise(makeIssueArtifactStore(99));
    const outcome = await Effect.gen(function* () {
      const executor = yield* DecompositionExecutor;
      return yield* executor.execute({
        context,
        artifacts,
      });
    }).pipe(
      Effect.provide(
        Layer.succeed(DecompositionExecutor, {
          execute: (input) =>
            Effect.succeed({
              kind: IssueExecutionOutcomeKind.Decomposed,
              childIssueNumbers: [input.artifacts.issueNumber + 1],
            }),
        }),
      ),
      Effect.runPromise,
    );

    expect(outcome).toEqual({
      kind: IssueExecutionOutcomeKind.Decomposed,
      childIssueNumbers: [100],
    });
  });
});