import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
    CommandRunnerLive,
    type CommandRunnerService,
} from "../../src/process/command-runner.ts";
import { makePipelineDeliveryGitService } from "../../src/git/pipeline-delivery.ts";

type BareRemoteFixture = {
    readonly root: string;
    readonly remotePath: string;
    readonly checkoutPath: string;
    readonly moverPath: string;
    readonly baseSha: string;
    readonly cleanup: () => Promise<void>;
};

const runGit = async (
    runner: CommandRunnerService,
    repositoryPath: string,
    args: ReadonlyArray<string>,
): Promise<string> => {
    const result = await runner.run("git", ["-C", repositoryPath, ...args]);
    if (result.exitCode !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
    return result.stdout.trim();
};

const makeFixture = async (): Promise<BareRemoteFixture> => {
    const root = await mkdtemp(join(tmpdir(), "ralphie-pipeline-delivery-"));
    const remotePath = join(root, "remote.git");
    const seedPath = join(root, "seed");
    const checkoutPath = join(root, "checkout");
    const moverPath = join(root, "mover");
    try {
        await runGit(CommandRunnerLive, root, [
            "init",
            "-q",
            "--bare",
            remotePath,
        ]);
        await runGit(CommandRunnerLive, root, [
            "init",
            "-q",
            "--initial-branch=main",
            seedPath,
        ]);
        await runGit(CommandRunnerLive, seedPath, [
            "config",
            "user.email",
            "ralphie@test.local",
        ]);
        await runGit(CommandRunnerLive, seedPath, [
            "config",
            "user.name",
            "Ralphie Test",
        ]);
        await runGit(CommandRunnerLive, seedPath, [
            "config",
            "commit.gpgsign",
            "false",
        ]);
        await writeFile(join(seedPath, "README.md"), "pipeline fixture\n");
        await runGit(CommandRunnerLive, seedPath, ["add", "."]);
        await runGit(CommandRunnerLive, seedPath, [
            "commit",
            "-q",
            "-m",
            "seed",
        ]);
        const baseSha = await runGit(CommandRunnerLive, seedPath, [
            "rev-parse",
            "HEAD",
        ]);
        await runGit(CommandRunnerLive, seedPath, [
            "remote",
            "add",
            "origin",
            remotePath,
        ]);
        await runGit(CommandRunnerLive, seedPath, [
            "push",
            "-q",
            "-u",
            "origin",
            "main",
        ]);
        await runGit(CommandRunnerLive, remotePath, [
            "symbolic-ref",
            "HEAD",
            "refs/heads/main",
        ]);
        await runGit(CommandRunnerLive, root, [
            "clone",
            "-q",
            "--branch",
            "main",
            remotePath,
            checkoutPath,
        ]);
        await runGit(CommandRunnerLive, root, [
            "clone",
            "-q",
            "--branch",
            "main",
            remotePath,
            moverPath,
        ]);
        for (const path of [checkoutPath, moverPath]) {
            await runGit(CommandRunnerLive, path, [
                "config",
                "user.email",
                "ralphie@test.local",
            ]);
            await runGit(CommandRunnerLive, path, [
                "config",
                "user.name",
                "Ralphie Test",
            ]);
            await runGit(CommandRunnerLive, path, [
                "config",
                "commit.gpgsign",
                "false",
            ]);
        }
        return {
            root,
            remotePath,
            checkoutPath,
            moverPath,
            baseSha,
            cleanup: () => rm(root, { recursive: true, force: true }),
        };
    } catch (error) {
        await rm(root, { recursive: true, force: true });
        throw error;
    }
};

const pushMoverCommit = async (fixture: BareRemoteFixture): Promise<string> => {
    await writeFile(join(fixture.moverPath, "external.txt"), "external\n");
    await runGit(CommandRunnerLive, fixture.moverPath, ["add", "."]);
    await runGit(CommandRunnerLive, fixture.moverPath, [
        "commit",
        "-q",
        "-m",
        "external movement",
    ]);
    const sha = await runGit(CommandRunnerLive, fixture.moverPath, [
        "rev-parse",
        "HEAD",
    ]);
    await runGit(CommandRunnerLive, fixture.moverPath, [
        "push",
        "-q",
        "origin",
        "main",
    ]);
    return sha;
};

describe("pipeline Git delivery", () => {
    test("reads an exact remote head and commits/pushes the exact staged tree", async () => {
        const fixture = await makeFixture();
        try {
            const service = makePipelineDeliveryGitService();
            await expect(
                service.readRemoteHead(fixture.checkoutPath, "main"),
            ).resolves.toBe(fixture.baseSha);

            await writeFile(
                join(fixture.checkoutPath, "repair.txt"),
                "repair\n",
            );
            await runGit(CommandRunnerLive, fixture.checkoutPath, ["add", "."]);
            const treeSha = await service.readStagedTreeSha(
                fixture.checkoutPath,
            );
            const commit = await service.commitStaged({
                repositoryPath: fixture.checkoutPath,
                branch: "main",
                expectedParentSha: fixture.baseSha,
                expectedTreeSha: treeSha,
                message: {
                    subject: "Fix failing pipeline on main",
                    body: "Apply the verified pipeline repair.",
                },
            });
            expect(commit.parentSha).toBe(fixture.baseSha);
            expect(commit.treeSha).toBe(treeSha);
            expect(
                await service.readCheckout(fixture.checkoutPath),
            ).toMatchObject({ branch: "main", head: commit.sha, status: "" });

            await expect(
                service.pushNonForce({
                    repositoryPath: fixture.checkoutPath,
                    branch: "main",
                    expectedCommitSha: commit.sha,
                }),
            ).resolves.toMatchObject({ response: "accepted" });
            await expect(
                service.readRemoteHead(fixture.checkoutPath, "main"),
            ).resolves.toBe(commit.sha);
        } finally {
            await fixture.cleanup();
        }
    });

    test("refuses to reset when origin moved while preparing the exact checkpoint", async () => {
        const fixture = await makeFixture();
        try {
            const movedSha = await pushMoverCommit(fixture);
            const service = makePipelineDeliveryGitService();
            await expect(
                service.prepareExactCheckout(
                    fixture.checkoutPath,
                    "main",
                    fixture.baseSha,
                ),
            ).rejects.toEqual(
                expect.objectContaining({
                    _tag: "PipelineDeliveryGitError",
                    kind: "remote-moved",
                }),
            );
            expect(
                await service.readCheckout(fixture.checkoutPath),
            ).toMatchObject({
                branch: "main",
                head: fixture.baseSha,
                status: "",
            });
            expect(
                await service.readRemoteHead(fixture.checkoutPath, "main"),
            ).toBe(movedSha);
        } finally {
            await fixture.cleanup();
        }
    });

    test("discards only a still-proven local checkpoint", async () => {
        const fixture = await makeFixture();
        try {
            const service = makePipelineDeliveryGitService();
            await writeFile(join(fixture.checkoutPath, "README.md"), "stale\n");
            await writeFile(
                join(fixture.checkoutPath, "agent-created.txt"),
                "stale\n",
            );
            await runGit(CommandRunnerLive, fixture.checkoutPath, ["add", "."]);
            await service.discardToExactCheckout(
                fixture.checkoutPath,
                "main",
                fixture.baseSha,
            );
            expect(
                await service.readCheckout(fixture.checkoutPath),
            ).toMatchObject({
                branch: "main",
                head: fixture.baseSha,
                status: "",
            });
            await expect(
                readFile(join(fixture.checkoutPath, "agent-created.txt")),
            ).rejects.toBeDefined();
            await expect(
                readFile(join(fixture.checkoutPath, "README.md"), "utf8"),
            ).resolves.toBe("pipeline fixture\n");
        } finally {
            await fixture.cleanup();
        }
    });

    test("reports a non-fast-forward response without force-pushing", async () => {
        const fixture = await makeFixture();
        try {
            const externalSha = await pushMoverCommit(fixture);
            await writeFile(join(fixture.checkoutPath, "local.txt"), "local\n");
            await runGit(CommandRunnerLive, fixture.checkoutPath, ["add", "."]);
            await runGit(CommandRunnerLive, fixture.checkoutPath, [
                "commit",
                "-q",
                "-m",
                "local repair",
            ]);
            const localSha = await runGit(
                CommandRunnerLive,
                fixture.checkoutPath,
                ["rev-parse", "HEAD"],
            );
            const service = makePipelineDeliveryGitService();
            await expect(
                service.pushNonForce({
                    repositoryPath: fixture.checkoutPath,
                    branch: "main",
                    expectedCommitSha: localSha,
                }),
            ).resolves.toMatchObject({
                response: "rejected",
                failureKind: "non-fast-forward",
            });
            expect(
                await service.readRemoteHead(fixture.checkoutPath, "main"),
            ).toBe(externalSha);
        } finally {
            await fixture.cleanup();
        }
    });
});