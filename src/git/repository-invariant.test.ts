import { describe, expect, test } from "bun:test";
import { Effect, Exit, Layer } from "effect";

import {
  GitRepositoryInvariant,
  GitRepositoryInvariantLive,
} from "./repository-invariant.ts";
import { CommandRunner } from "../process/command-runner.ts";

const runnerLayer = (outputs: ReadonlyArray<string>) => {
  let index = 0;
  return Layer.succeed(CommandRunner, {
    run: () =>
      Effect.succeed({
        exitCode: 0,
        stdout: outputs[index++] ?? "",
        stderr: "",
      }),
  });
};

describe("Git repository invariants", () => {
  test("captures branch and HEAD", async () => {
    const invariant = await Effect.gen(function* () {
      const service = yield* GitRepositoryInvariant;
      return yield* service.capture("/workspace/repo");
    }).pipe(
      Effect.provide(
        GitRepositoryInvariantLive.pipe(Layer.provide(runnerLayer(["main", "abc123"]))),
      ),
      Effect.runPromise,
    );

    expect(invariant).toEqual({ branch: "main", head: "abc123" });
  });

  test("fails when branch or HEAD changes", async () => {
    const branchExit = await Effect.gen(function* () {
      const service = yield* GitRepositoryInvariant;
      yield* service.verify("/workspace/repo", { branch: "main", head: "abc123" });
    }).pipe(
      Effect.provide(
        GitRepositoryInvariantLive.pipe(
          Layer.provide(runnerLayer(["feature", "abc123"])),
        ),
      ),
      Effect.runPromiseExit,
    );

    expect(Exit.isFailure(branchExit)).toBe(true);
  });
});
