import { describe, expect, test } from "bun:test";
import { Effect, Exit, Layer } from "effect";

import { GitIssueCheckpoint, GitIssueCheckpointLive } from "./issue-checkpoint.ts";
import { CommandRunner, type CommandResult } from "../process/command-runner.ts";

const sha = "0123456789abcdef0123456789abcdef01234567";

const testLayer = (calls: string[], responses: CommandResult[]) =>
  GitIssueCheckpointLive.pipe(
    Layer.provide(
      Layer.succeed(CommandRunner, {
        run: (command, args) =>
          Effect.sync(() => {
            calls.push([command, ...args].join(" "));
            const response = responses.shift();
            if (!response) throw new Error("Missing command response.");
            return response;
          }),
      }),
    ),
  );

const success = (stdout = ""): CommandResult => ({
  exitCode: 0,
  stdout,
  stderr: "",
});

describe("Git issue checkpoints", () => {
  test("captures a clean checkout and restores that exact commit", async () => {
    const calls: string[] = [];
    const layer = testLayer(calls, [
      success("main"),
      success(),
      success(sha),
      success("main"),
      success(),
      success(),
      success(sha),
      success(),
    ]);

    await Effect.gen(function* () {
      const checkpoints = yield* GitIssueCheckpoint;
      const checkpoint = yield* checkpoints.capture("/workspace/repo", "main");
      expect(checkpoint).toEqual({ branch: "main", sha });
      yield* checkpoints.restore("/workspace/repo", checkpoint);
    }).pipe(Effect.provide(layer), Effect.runPromise);

    expect(calls).toEqual([
      "git -C /workspace/repo rev-parse --abbrev-ref HEAD",
      "git -C /workspace/repo status --porcelain=v1",
      "git -C /workspace/repo rev-parse HEAD",
      "git -C /workspace/repo rev-parse --abbrev-ref HEAD",
      `git -C /workspace/repo reset --hard ${sha}`,
      "git -C /workspace/repo clean -fd",
      "git -C /workspace/repo rev-parse HEAD",
      "git -C /workspace/repo status --porcelain=v1",
    ]);
  });

  test("refuses to restore a checkpoint on another branch", async () => {
    const calls: string[] = [];
    const layer = testLayer(calls, [success("develop")]);

    const exit = await Effect.gen(function* () {
      const checkpoints = yield* GitIssueCheckpoint;
      yield* checkpoints.restore("/workspace/repo", { branch: "main", sha });
    }).pipe(Effect.provide(layer), Effect.runPromiseExit);

    expect(Exit.isFailure(exit)).toBe(true);
    expect(calls).toEqual(["git -C /workspace/repo rev-parse --abbrev-ref HEAD"]);
  });
});
