import { describe, expect, test } from "bun:test";
import { Effect, Exit, Layer } from "effect";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  IssueArtifactKind,
  IssueArtifactStore,
  IssueArtifactStoreLive,
} from "../../src/issues/artifacts.ts";
import {
  CommandRunner,
  CommandRunnerLive,
} from "../../src/process/command-runner.ts";
import {
  GitIssueCheckpoint,
  GitIssueCheckpointLive,
} from "../../src/git/issue-checkpoint.ts";
import {
  GitIssuePreparation,
  GitIssuePreparationLive,
} from "../../src/git/issue-preparation.ts";

const runGit = (repositoryPath: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const runner = yield* CommandRunner;
    return yield* runner.run("git", ["-C", repositoryPath, ...args]);
  }).pipe(Effect.provide(CommandRunnerLive), Effect.runPromise);

const setupRepository = async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "ralphie-preparation-"));
  await runGit(repositoryPath, ["init", "-b", "main"]);
  await runGit(repositoryPath, [
    "config",
    "user.email",
    "ralphie@example.test",
  ]);
  await runGit(repositoryPath, ["config", "user.name", "Ralphie Tests"]);
  await writeFile(join(repositoryPath, "README.md"), "initial\n");
  await runGit(repositoryPath, ["add", "--all"]);
  await runGit(repositoryPath, ["commit", "-m", "initial"]);
  return repositoryPath;
};

const liveLayer = GitIssuePreparationLive.pipe(
  Layer.provideMerge(
    Layer.merge(GitIssueCheckpointLive, IssueArtifactStoreLive).pipe(
      Layer.provide(CommandRunnerLive),
    ),
  ),
);

describe("Git issue preparation", () => {
  test("captures and stores a clean branch checkpoint before agent work", async () => {
    const repositoryPath = await setupRepository();
    try {
      const [checkpoint, stored] = await Effect.gen(function* () {
        const preparation = yield* GitIssuePreparation;
        const stores = yield* IssueArtifactStore;
        const checkpoint = yield* preparation.prepare({
          issueNumber: 42,
          repositoryPath,
          branch: "main",
        });
        const store = yield* stores.forIssue(42);
        const stored = yield* store.read(IssueArtifactKind.IssueCheckpoint);
        return [checkpoint, stored] as const;
      }).pipe(Effect.provide(liveLayer), Effect.runPromise);

      expect(checkpoint).toEqual(stored);
      expect(checkpoint.branch).toBe("main");
      expect(checkpoint.sha).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      await rm(repositoryPath, {
        recursive: true,
        force: true,
      });
    }
  });

  test("fails before preparation can store a checkpoint when the checkout is dirty or on another branch", async () => {
    const repositoryPath = await setupRepository();
    try {
      await writeFile(join(repositoryPath, "dirty.txt"), "uncommitted\n");
      const dirtyExit = await Effect.gen(function* () {
        const preparation = yield* GitIssuePreparation;
        yield* preparation.prepare({
          issueNumber: 43,
          repositoryPath,
          branch: "main",
        });
      }).pipe(Effect.provide(liveLayer), Effect.runPromiseExit);
      expect(Exit.isFailure(dirtyExit)).toBe(true);

      await runGit(repositoryPath, ["clean", "-fd"]);
      await runGit(repositoryPath, ["checkout", "-b", "develop"]);
      const branchExit = await Effect.gen(function* () {
        const preparation = yield* GitIssuePreparation;
        yield* preparation.prepare({
          issueNumber: 44,
          repositoryPath,
          branch: "main",
        });
      }).pipe(Effect.provide(liveLayer), Effect.runPromiseExit);
      expect(Exit.isFailure(branchExit)).toBe(true);
    } finally {
      await rm(repositoryPath, {
        recursive: true,
        force: true,
      });
    }
  });
});