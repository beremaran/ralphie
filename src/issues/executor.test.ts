import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import {
  IssueArtifactKind,
  IssueArtifactStore,
  IssueArtifactStoreLive,
} from "./artifacts.ts";
import { ComplexityAssessment } from "./complexity.ts";
import { ComplexityLevel } from "./decisions.ts";
import { DecompositionExecutor } from "./decomposition-executor.ts";
import {
  IssueCompletionKind,
  IssueExecutionOutcomeKind,
  type IssueExecutionContext,
} from "./execution.ts";
import { IssueExecutor, IssueExecutorLive } from "./executor.ts";
import { ImplementationExecutor } from "./implementation-executor.ts";
import { RalphieError } from "../shared/error.ts";

describe("IssueExecutor", () => {
  test("exposes issue execution behind an Effect service", async () => {
    const context = {
      issue: {
        number: 42,
      },
    } as IssueExecutionContext;
    const outcome = await Effect.gen(function* () {
      const executor = yield* IssueExecutor;
      return yield* executor.execute(context);
    }).pipe(
      Effect.provide(
        Layer.succeed(IssueExecutor, {
          execute: (received) =>
            Effect.succeed({
              kind: IssueExecutionOutcomeKind.Skipped,
              reason: `Issue ${received.issue.number} is not ready.`,
            }),
        }),
      ),
      Effect.runPromise,
    );

    expect(outcome).toEqual({
      kind: IssueExecutionOutcomeKind.Skipped,
      reason: "Issue 42 is not ready.",
    });
  });

  for (const complexity of Object.values(ComplexityLevel).filter(
    (value): value is ComplexityLevel => typeof value === "number",
  )) {
    test(`stores and routes complexity ${complexity}`, async () => {
      let implementationCalls = 0;
      let decompositionCalls = 0;
      const context = {
        issue: {
          number: complexity + 1,
        },
      } as IssueExecutionContext;
      const dependencies = Layer.mergeAll(
        IssueArtifactStoreLive,
        Layer.succeed(ComplexityAssessment, {
          assess: () =>
            Effect.succeed({
              decision: {
                complexity,
                rationale: `Complexity ${complexity} rationale`,
              },
              sessionID: `complexity-${complexity}`,
            }),
        }),
        Layer.succeed(ImplementationExecutor, {
          execute: () => {
            implementationCalls += 1;
            return Effect.succeed({
              kind: IssueExecutionOutcomeKind.Completed,
              completion: IssueCompletionKind.PushedCommit,
              commitSha: "implementation-sha",
            });
          },
        }),
        Layer.succeed(DecompositionExecutor, {
          execute: () => {
            decompositionCalls += 1;
            return Effect.succeed({
              kind: IssueExecutionOutcomeKind.Decomposed,
              childIssueNumbers: [101, 102],
            });
          },
        }),
      );

      const result = await Effect.gen(function* () {
        const executor = yield* IssueExecutor;
        const outcome = yield* executor.execute(context);
        const stores = yield* IssueArtifactStore;
        const artifacts = yield* stores.forIssue(context.issue.number);
        const decision = yield* artifacts.read(
          IssueArtifactKind.ComplexityDecision,
        );
        return {
          outcome,
          decision,
        };
      }).pipe(
        Effect.provide(IssueExecutorLive),
        Effect.provide(dependencies),
        Effect.runPromise,
      );

      expect(result.decision).toEqual({
        complexity,
        rationale: `Complexity ${complexity} rationale`,
      });
      if (complexity <= ComplexityLevel.Level3) {
        expect(result.outcome.kind).toBe(IssueExecutionOutcomeKind.Completed);
        expect(implementationCalls).toBe(1);
        expect(decompositionCalls).toBe(0);
      } else {
        expect(result.outcome.kind).toBe(IssueExecutionOutcomeKind.Decomposed);
        expect(implementationCalls).toBe(0);
        expect(decompositionCalls).toBe(1);
      }
    });
  }

  test("reuses a persisted complexity decision when retrying an issue", async () => {
    let assessmentCalls = 0;
    let implementationCalls = 0;
    const context = {
      issue: {
        number: 42,
      },
    } as IssueExecutionContext;
    const dependencies = Layer.mergeAll(
      IssueArtifactStoreLive,
      Layer.succeed(ComplexityAssessment, {
        assess: () => {
          assessmentCalls += 1;
          return Effect.succeed({
            decision: {
              complexity: ComplexityLevel.Level2,
              rationale: "Persisted routing decision.",
            },
            sessionID: "complexity-session",
          });
        },
      }),
      Layer.succeed(ImplementationExecutor, {
        execute: () => {
          implementationCalls += 1;
          return Effect.succeed({
            kind: IssueExecutionOutcomeKind.Skipped,
            reason: "test retry",
          });
        },
      }),
      Layer.succeed(DecompositionExecutor, {
        execute: () => Effect.die("must not decompose"),
      }),
    );

    await Effect.gen(function* () {
      const executor = yield* IssueExecutor;
      yield* executor.execute(context);
      yield* executor.execute(context);
    }).pipe(
      Effect.provide(IssueExecutorLive),
      Effect.provide(dependencies),
      Effect.runPromise,
    );

    expect(assessmentCalls).toBe(1);
    expect(implementationCalls).toBe(2);
  });

  test("turns an invalid or missing complexity decision into a failed outcome", async () => {
    let workflowCalls = 0;
    const context = {
      issue: {
        number: 42,
      },
    } as IssueExecutionContext;
    const dependencies = Layer.mergeAll(
      IssueArtifactStoreLive,
      Layer.succeed(ComplexityAssessment, {
        assess: () =>
          Effect.fail(
            new RalphieError({
              message: "Structured decision is missing.",
            }),
          ),
      }),
      Layer.succeed(ImplementationExecutor, {
        execute: () => {
          workflowCalls += 1;
          return Effect.die("must not run");
        },
      }),
      Layer.succeed(DecompositionExecutor, {
        execute: () => {
          workflowCalls += 1;
          return Effect.die("must not run");
        },
      }),
    );

    const outcome = await Effect.gen(function* () {
      const executor = yield* IssueExecutor;
      return yield* executor.execute(context);
    }).pipe(
      Effect.provide(IssueExecutorLive),
      Effect.provide(dependencies),
      Effect.runPromise,
    );

    expect(outcome).toEqual({
      kind: IssueExecutionOutcomeKind.Failed,
      message: "Structured decision is missing.",
    });
    expect(workflowCalls).toBe(0);
  });

  test("hands a restored review escalation to decomposition", async () => {
    const context = {
      issue: {
        number: 42,
      },
    } as IssueExecutionContext;
    const dependencies = Layer.mergeAll(
      IssueArtifactStoreLive,
      Layer.succeed(ComplexityAssessment, {
        assess: () =>
          Effect.succeed({
            decision: {
              complexity: ComplexityLevel.Level3,
              rationale: "Implementation is appropriate.",
            },
            sessionID: "complexity-session",
          }),
      }),
      Layer.succeed(ImplementationExecutor, {
        execute: () =>
          Effect.succeed({
            kind: IssueExecutionOutcomeKind.Escalated,
            diagnosticsPath: "/workspace/diagnostics",
            reason: "Review budget exhausted.",
          }),
      }),
      Layer.succeed(DecompositionExecutor, {
        execute: () =>
          Effect.succeed({
            kind: IssueExecutionOutcomeKind.Decomposed,
            childIssueNumbers: [101, 102],
          }),
      }),
    );

    const outcome = await Effect.gen(function* () {
      const executor = yield* IssueExecutor;
      return yield* executor.execute(context);
    }).pipe(
      Effect.provide(IssueExecutorLive),
      Effect.provide(dependencies),
      Effect.runPromise,
    );

    expect(outcome).toEqual({
      kind: IssueExecutionOutcomeKind.Escalated,
      diagnosticsPath: "/workspace/diagnostics",
      reason: "Review budget exhausted.",
      childIssueNumbers: [101, 102],
    });
  });
});