import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Option } from "effect";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  CommandRunner,
  CommandRunnerLive,
} from "../process/command-runner.ts";
import {
  GitIssueCheckpoint,
  GitIssueCheckpointLive,
} from "./issue-checkpoint.ts";
import {
  GitPushError,
  GitPushFailureKind,
  GitRemoteMovementPolicy,
  GitIssueOperations,
  GitIssueOperationsLive,
} from "./issue-operations.ts";

const runGit = (
  repositoryPath: string,
  args: ReadonlyArray<string>,
  trimStdout = true,
) =>
  Effect.gen(function* () {
    const runner = yield* CommandRunner;
    return yield* runner.run("git", ["-C", repositoryPath, ...args], {
      trimStdout,
    });
  }).pipe(Effect.provide(CommandRunnerLive), Effect.runPromise);

const setupRepository = async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "ralphie-git-operations-"));
  await runGit(repositoryPath, ["init", "-b", "main"]);
  await runGit(repositoryPath, ["config", "user.email", "ralphie@example.test"]);
  await runGit(repositoryPath, ["config", "user.name", "Ralphie Tests"]);
  await writeFile(join(repositoryPath, "binary.dat"), Buffer.from([0, 1, 2, 3]));
  await runGit(repositoryPath, ["add", "--all"]);
  await runGit(repositoryPath, ["commit", "-m", "initial"]);
  return repositoryPath;
};

describe("deterministic Git issue operations", () => {
  test("stages all changes, detects the staged set, and preserves the exact binary diff", async () => {
    const repositoryPath = await setupRepository();
    try {
      await writeFile(join(repositoryPath, "binary.dat"), Buffer.from([0, 9, 8, 7]));
      await writeFile(join(repositoryPath, "untracked.txt"), "new file\n");

      const beforeStage = await Effect.gen(function* () {
        const operations = yield* GitIssueOperations;
        return yield* operations.hasStagedChanges(repositoryPath);
      }).pipe(
        Effect.provide(GitIssueOperationsLive),
        Effect.provide(CommandRunnerLive),
        Effect.runPromise,
      );
      expect(beforeStage).toBe(false);

      await Effect.gen(function* () {
        const operations = yield* GitIssueOperations;
        yield* operations.stageAll(repositoryPath);
      }).pipe(
        Effect.provide(GitIssueOperationsLive),
        Effect.provide(CommandRunnerLive),
        Effect.runPromise,
      );

      const [hasChanges, actualDiff, expectedDiff] = await Promise.all([
        Effect.gen(function* () {
          const operations = yield* GitIssueOperations;
          return yield* operations.hasStagedChanges(repositoryPath);
        }).pipe(
          Effect.provide(GitIssueOperationsLive),
          Effect.provide(CommandRunnerLive),
          Effect.runPromise,
        ),
        Effect.gen(function* () {
          const operations = yield* GitIssueOperations;
          return yield* operations.readStagedBinaryDiff(repositoryPath);
        }).pipe(
          Effect.provide(GitIssueOperationsLive),
          Effect.provide(CommandRunnerLive),
          Effect.runPromise,
        ),
        runGit(repositoryPath, ["diff", "--cached", "--binary"], false).then(
          (result) => result.stdout,
        ),
      ]);

      expect(hasChanges).toBe(true);
      expect(actualDiff).toBe(expectedDiff);
      expect(actualDiff).toContain("GIT binary patch");
      expect(actualDiff).toContain("untracked.txt");
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  test("reports an empty staged change set for a clean index", async () => {
    const repositoryPath = await setupRepository();
    try {
      const result = await Effect.gen(function* () {
        const operations = yield* GitIssueOperations;
        return yield* operations.hasStagedChanges(repositoryPath);
      }).pipe(
        Effect.provide(GitIssueOperationsLive),
        Effect.provide(CommandRunnerLive),
        Effect.runPromise,
      );

      expect(result).toBe(false);
      expect(await readFile(join(repositoryPath, "binary.dat"))).toEqual(
        Buffer.from([0, 1, 2, 3]),
      );
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  test("commits the generated message, verifies its staged tree, pushes without force, and verifies origin", async () => {
    const repositoryPath = await setupRepository();
    const remotePath = await mkdtemp(join(tmpdir(), "ralphie-git-remote-"));
    try {
      await runGit(remotePath, ["init", "--bare"]);
      await runGit(repositoryPath, ["remote", "add", "origin", remotePath]);
      await runGit(repositoryPath, ["push", "--no-force", "origin", "main"]);

      await writeFile(join(repositoryPath, "change.txt"), "implementation\n");
      const result = await Effect.gen(function* () {
        const operations = yield* GitIssueOperations;
        yield* operations.stageAll(repositoryPath);
        return yield* operations.commit(repositoryPath, {
          subject: "implement issue behavior",
          body: "This change was generated by the issue workflow.",
        });
      }).pipe(
        Effect.provide(GitIssueOperationsLive),
        Effect.provide(CommandRunnerLive),
        Effect.runPromise,
      );

      expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(result.treeSha).toMatch(/^[0-9a-f]{40}$/);
      await Effect.gen(function* () {
        const operations = yield* GitIssueOperations;
        yield* operations.push(repositoryPath, "main", result.sha);
      }).pipe(
        Effect.provide(GitIssueOperationsLive),
        Effect.provide(CommandRunnerLive),
        Effect.runPromise,
      );

      const remote = await runGit(remotePath, ["rev-parse", "refs/heads/main"]);
      const status = await runGit(repositoryPath, ["status", "--porcelain=v1"]);
      expect(remote.stdout).toBe(result.sha);
      expect(status.stdout).toBe("");
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
      await rm(remotePath, { recursive: true, force: true });
    }
  });

  test("classifies non-fast-forward rejection and halts instead of retrying", async () => {
    const repositoryPath = await setupRepository();
    const remotePath = await mkdtemp(join(tmpdir(), "ralphie-git-remote-"));
    const otherRepositoryPath = await mkdtemp(
      join(tmpdir(), "ralphie-git-other-"),
    );
    try {
      await runGit(remotePath, ["init", "--bare"]);
      await runGit(repositoryPath, ["remote", "add", "origin", remotePath]);
      await runGit(repositoryPath, ["push", "--no-force", "origin", "main"]);
      await runGit(otherRepositoryPath, ["clone", remotePath, "."]);
      await runGit(otherRepositoryPath, ["config", "user.email", "other@example.test"]);
      await runGit(otherRepositoryPath, ["config", "user.name", "Other Tests"]);
      await writeFile(join(otherRepositoryPath, "remote.txt"), "remote\n");
      await runGit(otherRepositoryPath, ["add", "--all"]);
      await runGit(otherRepositoryPath, ["commit", "-m", "advance remote"]);
      await runGit(otherRepositoryPath, ["push", "--no-force", "origin", "main"]);

      await writeFile(join(repositoryPath, "local.txt"), "local\n");
      const outcome = await Effect.gen(function* () {
        const operations = yield* GitIssueOperations;
        yield* operations.stageAll(repositoryPath);
        const commit = yield* operations.commit(repositoryPath, {
          subject: "local work",
        });
        return yield* operations.push(repositoryPath, "main", commit.sha);
      }).pipe(
        Effect.provide(GitIssueOperationsLive),
        Effect.provide(CommandRunnerLive),
        Effect.runPromiseExit,
      );

      expect(Exit.isFailure(outcome)).toBe(true);
      const failure = Exit.isFailure(outcome)
        ? Cause.failureOption(outcome.cause)
        : Option.none();
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(failure.value).toBeInstanceOf(GitPushError);
        expect(failure.value).toMatchObject({
          kind: GitPushFailureKind.NonFastForward,
          policy: GitRemoteMovementPolicy.Halt,
          branch: "main",
        });
      }
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
      await rm(remotePath, { recursive: true, force: true });
      await rm(otherRepositoryPath, { recursive: true, force: true });
    }
  });

  test("runs checkpoint, stage, binary diff, restore, commit, and push in one temporary checkout flow", async () => {
    const repositoryPath = await setupRepository();
    const remotePath = await mkdtemp(join(tmpdir(), "ralphie-git-remote-"));
    try {
      await runGit(remotePath, ["init", "--bare"]);
      await runGit(repositoryPath, ["remote", "add", "origin", remotePath]);
      await runGit(repositoryPath, ["push", "--no-force", "origin", "main"]);

      const checkpoint = await Effect.gen(function* () {
        const checkpoints = yield* GitIssueCheckpoint;
        return yield* checkpoints.capture(repositoryPath, "main");
      }).pipe(
        Effect.provide(GitIssueCheckpointLive),
        Effect.provide(CommandRunnerLive),
        Effect.runPromise,
      );

      await writeFile(join(repositoryPath, "temporary.bin"), Buffer.from([0, 4, 5, 6]));
      const stagedDiff = await Effect.gen(function* () {
        const operations = yield* GitIssueOperations;
        yield* operations.stageAll(repositoryPath);
        return yield* operations.readStagedBinaryDiff(repositoryPath);
      }).pipe(
        Effect.provide(GitIssueOperationsLive),
        Effect.provide(CommandRunnerLive),
        Effect.runPromise,
      );
      expect(stagedDiff).toContain("GIT binary patch");

      await Effect.gen(function* () {
        const checkpoints = yield* GitIssueCheckpoint;
        yield* checkpoints.restore(repositoryPath, checkpoint);
      }).pipe(
        Effect.provide(GitIssueCheckpointLive),
        Effect.provide(CommandRunnerLive),
        Effect.runPromise,
      );
      expect((await runGit(repositoryPath, ["status", "--porcelain=v1"])).stdout).toBe("");
      expect((await runGit(repositoryPath, ["rev-parse", "HEAD"])).stdout).toBe(
        checkpoint.sha,
      );

      await writeFile(join(repositoryPath, "final.txt"), "final implementation\n");
      const commit = await Effect.gen(function* () {
        const operations = yield* GitIssueOperations;
        yield* operations.stageAll(repositoryPath);
        return yield* operations.commit(repositoryPath, {
          subject: "finish issue integration flow",
        });
      }).pipe(
        Effect.provide(GitIssueOperationsLive),
        Effect.provide(CommandRunnerLive),
        Effect.runPromise,
      );
      await Effect.gen(function* () {
        const operations = yield* GitIssueOperations;
        yield* operations.push(repositoryPath, "main", commit.sha);
      }).pipe(
        Effect.provide(GitIssueOperationsLive),
        Effect.provide(CommandRunnerLive),
        Effect.runPromise,
      );
      expect((await runGit(remotePath, ["rev-parse", "refs/heads/main"])).stdout).toBe(
        commit.sha,
      );
      expect((await runGit(repositoryPath, ["status", "--porcelain=v1"])).stdout).toBe("");
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
      await rm(remotePath, { recursive: true, force: true });
    }
  });
});
