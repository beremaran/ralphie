import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
    IssueArtifactKind,
    makeIssueArtifactStoreService,
} from "../../src/issues/artifacts.ts";
import { CommandRunnerLive } from "../../src/process/command-runner.ts";
import { makeGitIssueCheckpointService } from "../../src/git/issue-checkpoint.ts";
import { makeGitIssuePreparationService } from "../../src/git/issue-preparation.ts";

const runGit = (repositoryPath: string, args: ReadonlyArray<string>) =>
    CommandRunnerLive.run("git", ["-C", repositoryPath, ...args]);

const setupRepository = async () => {
    const repositoryPath = await mkdtemp(
        join(tmpdir(), "ralphie-preparation-"),
    );
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

const makePreparation = () =>
    makeGitIssuePreparationService(
        makeGitIssueCheckpointService(),
        makeIssueArtifactStoreService(),
    );

describe("Git issue preparation", () => {
    test("captures and stores a clean branch checkpoint before agent work", async () => {
        const repositoryPath = await setupRepository();
        try {
            const stores = makeIssueArtifactStoreService();
            const preparation = makeGitIssuePreparationService(
                makeGitIssueCheckpointService(),
                stores,
            );
            const checkpoint = await preparation.prepare({
                issueNumber: 42,
                repositoryPath,
                branch: "main",
            });
            const store = await stores.forIssue(42);
            expect(checkpoint).toEqual(
                await store.read(IssueArtifactKind.IssueCheckpoint),
            );
            expect(checkpoint.branch).toBe("main");
            expect(checkpoint.sha).toMatch(/^[0-9a-f]{40}$/);
        } finally {
            await rm(repositoryPath, { recursive: true, force: true });
        }
    });

    test("fails before preparation can store a checkpoint when checkout is dirty or on another branch", async () => {
        const repositoryPath = await setupRepository();
        try {
            await writeFile(join(repositoryPath, "dirty.txt"), "uncommitted\n");
            await expect(
                makePreparation().prepare({
                    issueNumber: 43,
                    repositoryPath,
                    branch: "main",
                }),
            ).rejects.toThrow("dirty issue checkout");
            await runGit(repositoryPath, ["clean", "-fd"]);
            await runGit(repositoryPath, ["checkout", "-b", "develop"]);
            await expect(
                makePreparation().prepare({
                    issueNumber: 44,
                    repositoryPath,
                    branch: "main",
                }),
            ).rejects.toThrow("checkout is on develop");
        } finally {
            await rm(repositoryPath, { recursive: true, force: true });
        }
    });
});