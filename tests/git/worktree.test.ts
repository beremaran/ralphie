import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CommandRunnerLive } from "../../src/process/command-runner.ts";
import { makeGitWorktreeService } from "../../src/git/worktree.ts";

const runGit = (path: string, args: ReadonlyArray<string>) =>
    CommandRunnerLive.run("git", ["-C", path, ...args]);

test("prepares, resumes, and removes an isolated issue worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralphie-worktree-"));
    const repositoryPath = join(root, "repository");
    try {
        await runGit(root, ["init", "-b", "main", repositoryPath]);
        await runGit(repositoryPath, [
            "config",
            "user.email",
            "ralphie@example.test",
        ]);
        await runGit(repositoryPath, ["config", "user.name", "Ralphie Tests"]);
        await writeFile(join(repositoryPath, "file.txt"), "base\n");
        await runGit(repositoryPath, ["add", "--all"]);
        await runGit(repositoryPath, ["commit", "-m", "initial"]);
        const baseSha = (await runGit(repositoryPath, ["rev-parse", "HEAD"]))
            .stdout;
        const input = {
            workspace: root,
            runId: "run-1",
            issueNumber: 42,
            branch: "ralphie/issue-42",
            repository: {
                repository: "owner/repository",
                repositoryPath,
                branch: "main",
            },
            baseSha,
        } as const;

        const worktrees = makeGitWorktreeService();
        const first = await worktrees.prepareIssue(input);
        const resumed = await worktrees.prepareIssue(input);
        expect(resumed).toEqual(first);
        await worktrees.removeIssue(input.repository, first);

        expect(first.branch).toBe("ralphie/issue-42");
        expect(
            (await runGit(repositoryPath, ["worktree", "list", "--porcelain"]))
                .stdout,
        ).not.toContain(first.repositoryPath);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});