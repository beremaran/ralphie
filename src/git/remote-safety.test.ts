import { describe, expect, test } from "bun:test";
import { Effect, Exit, Layer } from "effect";
import type { Octokit } from "octokit";

import { CommandRunner, type CommandResult } from "../process/command-runner.ts";
import {
  GitDirectPushPolicy,
  GitPushMode,
  GitRemoteSafety,
  GitRemoteSafetyFailureKind,
  GitRemoteSafetyLive,
} from "./remote-safety.ts";

const repositoryResponse = (push: boolean) => ({ data: { permissions: { push } } });
const branchResponse = (protectedBranch: boolean) => ({ data: { protected: protectedBranch } });
const rulesResponse = (rules: ReadonlyArray<unknown>) => ({ data: rules });

const client = ({
  push = true,
  protectedBranch = false,
  rules = [],
}: {
  readonly push?: boolean;
  readonly protectedBranch?: boolean;
  readonly rules?: ReadonlyArray<unknown>;
} = {}) =>
  ({
    rest: {
      repos: {
        get: async () => repositoryResponse(push),
        getBranch: async () => branchResponse(protectedBranch),
        getBranchRules: async () => rulesResponse(rules),
      },
    },
  }) as unknown as Octokit;

const runner = (
  counts = "0 0",
  origin = "https://github.com/owner/repository.git",
  remoteSha = "base123",
) => {
  const commands: ReadonlyArray<CommandResult> = [
    { exitCode: 0, stdout: origin, stderr: "" },
    { exitCode: 0, stdout: "main", stderr: "" },
    { exitCode: 0, stdout: "abc123", stderr: "" },
    { exitCode: 0, stdout: `${remoteSha}\trefs/heads/main`, stderr: "" },
    { exitCode: 0, stdout: counts, stderr: "" },
  ];
  let index = 0;
  return {
    commands,
    run: () => Effect.succeed(commands[index++] ?? commands.at(-1)!),
  };
};

const verify = (input: {
  readonly client?: Octokit;
  readonly counts?: string;
  readonly origin?: string;
  readonly remoteSha?: string;
  readonly push?: boolean;
  readonly protectedBranch?: boolean;
  readonly rules?: ReadonlyArray<unknown>;
  readonly expectedCommitSha?: string;
  readonly pushMode?: GitPushMode;
} = {}) => {
  const commands = runner(input.counts, input.origin, input.remoteSha);
  return Effect.gen(function* () {
    const safety = yield* GitRemoteSafety;
    return yield* safety.verifyDirectPush({
      client:
        input.client ??
        client({
          push: input.push,
          protectedBranch: input.protectedBranch,
          rules: input.rules,
        }),
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
  test("accepts an owned, non-protected, non-diverged direct push", async () => {
    const report = await Effect.runPromise(verify());
    expect(report).toMatchObject({
      repository: "owner/repository",
      branch: "main",
      protected: false,
      activeBranchRules: 0,
      hasPushPermission: true,
      commitsBehindBase: 0,
      commitsAheadBase: 0,
      pushMode: GitPushMode.NonForce,
    });
  });

  test.each([
    ["protected branch", { protectedBranch: true }, GitRemoteSafetyFailureKind.ProtectedBranch],
    ["active branch rules", { rules: [{ type: "required_status_checks" }] }, GitRemoteSafetyFailureKind.BranchRules],
    ["missing push permission", { push: false }, GitRemoteSafetyFailureKind.PushPermission],
    ["diverged base", { counts: "1 2" }, GitRemoteSafetyFailureKind.DivergedBase],
    ["moved remote", { remoteSha: "newbase" }, GitRemoteSafetyFailureKind.DivergedBase],
  ])("refuses %s", async (_name, options, kind) => {
    const exit = await Effect.runPromiseExit(verify(options));
    expect(Exit.isFailure(exit)).toBeTrue();
    if (Exit.isFailure(exit)) {
      expect(exit.cause).toBeDefined();
    }
  });

  test("refuses a force-push mode before any remote checks", async () => {
    const exit = await Effect.runPromiseExit(
      verify({ pushMode: GitPushMode.Force }),
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
      verify({ origin: "https://github.com/other/repository.git" }),
    );
    expect(Exit.isFailure(exit)).toBeTrue();
  });

  test("requires exactly one local commit when verifying a new issue push", async () => {
    const commands = runner("0 1");
    const effect = Effect.gen(function* () {
      const safety = yield* GitRemoteSafety;
      return yield* safety.verifyDirectPush({
        client: client(),
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
});
