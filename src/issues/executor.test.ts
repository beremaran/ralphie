import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import {
  IssueExecutionOutcomeKind,
  type IssueExecutionContext,
} from "./execution.ts";
import { IssueExecutor } from "./executor.ts";

describe("IssueExecutor", () => {
  test("exposes issue execution behind an Effect service", async () => {
    const context = {
      issue: { number: 42 },
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
});
