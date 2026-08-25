import { expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CommandRunner, CommandRunnerLive } from "../process/command-runner.ts";
import { GitWorktrees, GitWorktreesLive } from "./worktree.ts";

const runGit = (path: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const runner = yield* CommandRunner;
    return yield* runner.run("git", ["-C", path, ...args]);
  }).pipe(Effect.provide(CommandRunnerLive), Effect.runPromise);

test("prepares, resumes, and removes an isolated issue worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "ralphie-worktree-"));
  const repositoryPath = join(root, "repository");
  try {
    await runGit(root, ["init", "-b", "main", repositoryPath]);
    await runGit(repositoryPath, ["config", "user.email", "ralphie@example.test"]);
    await runGit(repositoryPath, ["config", "user.name", "Ralphie Tests"]);
    await writeFile(join(repositoryPath, "file.txt"), "base\n");
    await runGit(repositoryPath, ["add", "--all"]);
    await runGit(repositoryPath, ["commit", "-m", "initial"]);
    const baseSha = (await runGit(repositoryPath, ["rev-parse", "HEAD"])).stdout;
    const input = {
      workspace: root,
      runId: "run-1",
      issueNumber: 42,
      branch: "ralphie/issue-42",
      repository: { repository: "owner/repository", repositoryPath, branch: "main" },
      baseSha,
    } as const;

    const prepared = await Effect.gen(function* () {
      const worktrees = yield* GitWorktrees;
      const first = yield* worktrees.prepareIssue(input);
      const resumed = yield* worktrees.prepareIssue(input);
      expect(resumed).toEqual(first);
      yield* worktrees.removeIssue(input.repository, first);
      return first;
    }).pipe(
      Effect.provide(GitWorktreesLive),
      Effect.provide(CommandRunnerLive),
      Effect.runPromise,
    );

    expect(prepared.branch).toBe("ralphie/issue-42");
    expect(
      (await runGit(repositoryPath, ["worktree", "list", "--porcelain"])).stdout,
    ).not.toContain(prepared.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
