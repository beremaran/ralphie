import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  CommandRunner,
  CommandRunnerLive,
} from "../process/command-runner.ts";
import {
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
});
