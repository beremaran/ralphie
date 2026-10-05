import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeGitIssueOperationsService } from "../../src/git/adapters/issue-operations.ts";
import { DISABLED_PUSH_URL } from "../../src/git/adapters/repository.ts";
import { CommandRunnerLive } from "../../src/process/adapters/command-runner.ts";

const run = async (cwd: string, ...args: string[]): Promise<string> => {
    const result = await CommandRunnerLive.run("git", ["-C", cwd, ...args]);
    if (result.exitCode !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
};

test("git push in the workspace fails while the delivery push succeeds and is verified", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralphie-push-"));
    try {
        const remote = join(root, "remote.git");
        const work = join(root, "work");
        await run(root, "init", "-q", "--bare", remote);
        await run(root, "clone", "-q", remote, work);
        await run(work, "config", "user.email", "t@test.local");
        await run(work, "config", "user.name", "T");
        await run(work, "checkout", "-q", "-b", "main");
        await writeFile(join(work, "a.txt"), "a\n");
        await run(work, "add", ".");
        await run(work, "commit", "-q", "-m", "base");
        await run(work, "push", "-q", "origin", "main");

        await run(
            work,
            "remote",
            "set-url",
            "--push",
            "origin",
            DISABLED_PUSH_URL,
        );
        await writeFile(join(work, "b.txt"), "b\n");
        await run(work, "add", ".");
        await run(work, "commit", "-q", "-m", "change");
        const sha = await run(work, "rev-parse", "HEAD");

        await expect(
            run(work, "push", "origin", "HEAD:refs/heads/main"),
        ).rejects.toThrow();
        expect(await run(remote, "rev-parse", "refs/heads/main")).not.toBe(sha);

        await makeGitIssueOperationsService(CommandRunnerLive).push(
            work,
            "main",
            sha,
        );
        expect(await run(remote, "rev-parse", "refs/heads/main")).toBe(sha);
        expect(await run(work, "rev-parse", "refs/remotes/origin/main")).toBe(
            sha,
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});