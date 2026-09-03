import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    CommandRunnerLive,
    type CommandRunnerService,
} from "../../src/process/command-runner.ts";

/**
 * A throwaway git repository with two committed revisions and deliberate
 * index/working-tree noise. The committed (base..head) range is exactly the
 * first revision's change; the noise must never appear in a committed diff.
 */
export type GitFixture = {
    readonly repositoryPath: string;
    readonly baseSha: string;
    readonly headSha: string;
    readonly cleanup: () => Promise<void>;
};

export const makeGitFixture = async (
    runner: CommandRunnerService = CommandRunnerLive,
): Promise<GitFixture> => {
    const repositoryPath = await mkdtemp(join(tmpdir(), "ralphie-git-"));
    const run = async (args: ReadonlyArray<string>): Promise<string> => {
        const result = await runner.run("git", ["-C", repositoryPath, ...args]);
        if (result.exitCode !== 0) {
            throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
        }
        return result.stdout;
    };
    try {
        await run(["init", "-q"]);
        await run(["config", "user.email", "ralphie@test.local"]);
        await run(["config", "user.name", "Ralphie Test"]);
        await run(["config", "commit.gpgsign", "false"]);
        await writeFile(join(repositoryPath, "base.txt"), "base content\n");
        await run(["add", "."]);
        await run(["commit", "-q", "-m", "base commit"]);
        const baseSha = (await run(["rev-parse", "HEAD"])).trim();
        await writeFile(
            join(repositoryPath, "base.txt"),
            "base content\nchanged\n",
        );
        await run(["add", "."]);
        await run(["commit", "-q", "-m", "head commit"]);
        const headSha = (await run(["rev-parse", "HEAD"])).trim();
        // Staged and unstaged noise the committed diff must never include.
        await writeFile(join(repositoryPath, "uncommitted.txt"), "dirty\n");
        await run(["add", "uncommitted.txt"]);
        return {
            repositoryPath,
            baseSha,
            headSha,
            cleanup: () => rm(repositoryPath, { recursive: true, force: true }),
        };
    } catch (cause) {
        await rm(repositoryPath, { recursive: true, force: true });
        throw cause;
    }
};