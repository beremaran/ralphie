import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
    CommandRunnerLive,
    type CommandResult,
} from "../../src/process/command-runner.ts";
import { makeGitIssueCheckpointService } from "../../src/git/issue-checkpoint.ts";

const sha = "0123456789abcdef0123456789abcdef01234567";

const success = (stdout = ""): CommandResult => ({
    exitCode: 0,
    stdout,
    stderr: "",
});

const testService = (calls: string[], responses: CommandResult[]) =>
    makeGitIssueCheckpointService({
        run: async (command, args) => {
            calls.push([command, ...args].join(" "));
            const response = responses.shift();
            if (!response) throw new Error("Missing command response.");
            return response;
        },
    });

const runGit = (repositoryPath: string, args: ReadonlyArray<string>) =>
    CommandRunnerLive.run("git", ["-C", repositoryPath, ...args]);

describe("Git issue checkpoints", () => {
    test("captures a clean checkout and restores that exact commit", async () => {
        const calls: string[] = [];
        const checkpoints = testService(calls, [
            success("main"),
            success(),
            success(sha),
            success("main"),
            success(),
            success(),
            success(sha),
            success(),
        ]);

        const checkpoint = await checkpoints.capture("/workspace/repo", "main");
        expect(checkpoint).toEqual({ branch: "main", sha });
        await checkpoints.restore("/workspace/repo", checkpoint);

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
        const checkpoints = testService(calls, [success("develop")]);

        await expect(
            checkpoints.restore("/workspace/repo", { branch: "main", sha }),
        ).rejects.toThrow("Refusing to restore main; checkout is on develop.");
        expect(calls).toEqual([
            "git -C /workspace/repo rev-parse --abbrev-ref HEAD",
        ]);
    });

    test("captures staged, unstaged, and untracked changes in a binary-safe patch", async () => {
        const repositoryPath = await mkdtemp(
            join(tmpdir(), "ralphie-diagnostic-patch-"),
        );
        try {
            await runGit(repositoryPath, ["init", "-b", "main"]);
            await runGit(repositoryPath, [
                "config",
                "user.email",
                "ralphie@example.test",
            ]);
            await runGit(repositoryPath, [
                "config",
                "user.name",
                "Ralphie Tests",
            ]);
            await writeFile(join(repositoryPath, "staged.txt"), "before\n");
            await writeFile(join(repositoryPath, "unstaged.txt"), "before\n");
            await runGit(repositoryPath, ["add", "--all"]);
            await runGit(repositoryPath, ["commit", "-m", "initial"]);
            await writeFile(join(repositoryPath, "staged.txt"), "staged\n");
            await runGit(repositoryPath, ["add", "staged.txt"]);
            await writeFile(
                join(repositoryPath, "staged.txt"),
                "unstaged-after-staging\n",
            );
            await writeFile(join(repositoryPath, "unstaged.txt"), "unstaged\n");
            await writeFile(
                join(repositoryPath, "untracked.bin"),
                Buffer.from([0, 255, 1, 254]),
            );

            const patch =
                await makeGitIssueCheckpointService().createPatch(
                    repositoryPath,
                );
            expect(patch).toContain("staged.txt");
            expect(patch).toContain("staged");
            expect(patch).toContain("unstaged-after-staging");
            expect(patch).toContain("unstaged.txt");
            expect(patch).toContain("untracked.bin");
            expect(patch).toContain("GIT binary patch");
        } finally {
            await rm(repositoryPath, { recursive: true, force: true });
        }
    });
});