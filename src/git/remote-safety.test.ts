import { describe, expect, test } from "bun:test";
import { Effect, Exit, Layer } from "effect";

import {
  CommandRunner,
  type CommandResult,
} from "../process/command-runner.ts";
import {
  GitDirectPushPolicy,
  GitPushMode,
  GitRemoteSafety,
  GitRemoteSafetyFailureKind,
  GitRemoteSafetyLive,
} from "./remote-safety.ts";

const runner = (
  counts = "0 0",
  origin = "https://github.com/owner/repository.git",
  remoteSha = "base123",
) => {
  const commands: ReadonlyArray<CommandResult> = [
    {
      exitCode: 0,
      stdout: origin,
      stderr: "",
    },
    {
      exitCode: 0,
      stdout: "main",
      stderr: "",
    },
    {
      exitCode: 0,
      stdout: "abc123",
      stderr: "",
    },
    {
      exitCode: 0,
      stdout: `${remoteSha}\trefs/heads/main`,
      stderr: "",
    },
    {
      exitCode: 0,
      stdout: counts,
      stderr: "",
    },
  ];
  let index = 0;
  return {
    commands,
    run: () => Effect.succeed(commands[index++] ?? commands.at(-1)!),
  };
};

const verify = (
  input: {
    readonly counts?: string;
    readonly origin?: string;
    readonly remoteSha?: string;
    readonly expectedCommitSha?: string;
    readonly pushMode?: GitPushMode;
  } = {},
) => {
  const commands = runner(input.counts, input.origin, input.remoteSha);
  return Effect.gen(function* () {
    const safety = yield* GitRemoteSafety;
    return yield* safety.verifyDirectPush({
      repository: "owner/repository",
      repositoryPath: "/workspace/repository",
      branch: "main",
      intendedBaseSha: "base123",
      expectedCommitSha: input.expectedCommitSha,
      pushMode: input.pushMode,
    });
  }).pipe(
    Effect.provide(GitRemoteSafetyLive),
    Effect.provide(Layer.succeed(CommandRunner, commands)),
  );
};

describe("Git remote safety", () => {
  test("accepts a matching, non-diverged direct push", async () => {
    const report = await Effect.runPromise(verify());
    expect(report).toMatchObject({
      repository: "owner/repository",
      branch: "main",
      commitsBehindBase: 0,
      commitsAheadBase: 0,
      pushMode: GitPushMode.NonForce,
    });
  });

  test.each([
    [
      "diverged base",
      {
        counts: "1 2",
      },
      GitRemoteSafetyFailureKind.DivergedBase,
    ],
    [
      "moved remote",
      {
        remoteSha: "newbase",
      },
      GitRemoteSafetyFailureKind.DivergedBase,
    ],
  ])("refuses %s", async (_name, options, kind) => {
    const exit = await Effect.runPromiseExit(verify(options));
    expect(Exit.isFailure(exit)).toBeTrue();
    if (Exit.isFailure(exit)) {
      expect(exit.cause).toBeDefined();
    }
  });

  test("refuses a force-push mode before any remote checks", async () => {
    const exit = await Effect.runPromiseExit(
      verify({
        pushMode: GitPushMode.Force,
      }),
    );
    expect(Exit.isFailure(exit)).toBeTrue();
    if (Exit.isFailure(exit)) {
      const text = JSON.stringify(exit.cause);
      expect(text).toContain(GitDirectPushPolicy.NonForceOnly);
      expect(text).toContain("GitRemoteSafetyError");
    }
  });

  test("revalidates that origin belongs to the requested repository", async () => {
    const exit = await Effect.runPromiseExit(
      verify({
        origin: "https://github.com/other/repository.git",
      }),
    );
    expect(Exit.isFailure(exit)).toBeTrue();
  });

  test("requires exactly one local commit when verifying a new issue push", async () => {
    const commands = runner("0 1");
    const effect = Effect.gen(function* () {
      const safety = yield* GitRemoteSafety;
      return yield* safety.verifyDirectPush({
        repository: "owner/repository",
        repositoryPath: "/workspace/repository",
        branch: "main",
        intendedBaseSha: "base123",
        expectedCommitSha: "abc123",
      });
    }).pipe(
      Effect.provide(GitRemoteSafetyLive),
      Effect.provide(Layer.succeed(CommandRunner, commands)),
    );
    const report = await Effect.runPromise(effect);
    expect(report.commitsAheadBase).toBe(1);
  });

  test("accepts an expected commit that already reached the remote", async () => {
    const report = await Effect.runPromise(
      verify({
        counts: "0 1",
        expectedCommitSha: "abc123",
        remoteSha: "abc123",
      }),
    );
    expect(report.commitsAheadBase).toBe(1);
  });
});