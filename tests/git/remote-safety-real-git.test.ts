import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeGitRemoteSafetyService } from "../../src/git/adapters/remote-safety.ts";
import { GitRemoteSafetyError } from "../../src/git/ports.ts";
import { CommandRunnerLive } from "../../src/process/adapters/command-runner.ts";
import type { CommandRunnerService } from "../../src/process/ports.ts";
import { makeGitFixture, type GitFixture } from "../shared/git-fixture.ts";

const REPOSITORY = "owner/repository";
const ORIGIN_URL = "https://github.com/owner/repository.git";

let fixture: GitFixture | undefined;
let remotePath: string | undefined;
afterEach(async () => {
    await fixture?.cleanup();
    if (remotePath !== undefined) {
        await rm(remotePath, { recursive: true, force: true });
    }
    fixture = undefined;
    remotePath = undefined;
});

const git = async (path: string, ...args: string[]): Promise<string> => {
    const result = await CommandRunnerLive.run("git", ["-C", path, ...args]);
    if (result.exitCode !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
    return result.stdout.trim();
};

/**
 * Real git for every command, except that `origin` is a local bare
 * repository standing in for the GitHub URL the origin check expects.
 */
const runnerWithLocalOrigin = (bare: string): CommandRunnerService => ({
    run: async (command, args, options) => {
        const joined = args.join(" ");
        if (joined.endsWith("remote get-url origin")) {
            return { stdout: ORIGIN_URL, stderr: "", exitCode: 0 };
        }
        const remoteIndex = args.indexOf("ls-remote");
        if (remoteIndex >= 0) {
            const rewritten = [...args];
            rewritten[remoteIndex + 1] = bare;
            return CommandRunnerLive.run(command, rewritten, options);
        }
        return CommandRunnerLive.run(command, args, options);
    },
});

const setup = async () => {
    fixture = await makeGitFixture();
    const path = fixture.repositoryPath;
    const branch = await git(path, "symbolic-ref", "--short", "HEAD");
    remotePath = await mkdtemp(join(tmpdir(), "ralphie-remote-"));
    await git(remotePath, "init", "-q", "--bare");
    await git(
        path,
        "push",
        "-q",
        remotePath,
        `${fixture.baseSha}:refs/heads/${branch}`,
    );
    return {
        path,
        branch,
        base: fixture.baseSha,
        service: makeGitRemoteSafetyService(runnerWithLocalOrigin(remotePath)),
    };
};

describe("direct-push safety against a real repository", () => {
    test("passes with exactly one created commit ahead of the checkpoint", async () => {
        const { path, branch, base, service } = await setup();
        const head = await git(path, "rev-parse", "HEAD");
        const report = await service.verifyDirectPush({
            repository: REPOSITORY,
            repositoryPath: path,
            branch,
            intendedBaseSha: base,
            expectedCommitSha: head,
            pushMode: "non-force",
        });
        expect(report).toMatchObject({
            commitsBehindBase: 0,
            commitsAheadBase: 1,
        });
    });

    test("refuses two candidate commits ahead of the checkpoint", async () => {
        const { path, branch, base, service } = await setup();
        await writeFile(join(path, "second.txt"), "second candidate\n");
        await git(path, "add", "second.txt");
        await git(path, "commit", "-q", "-m", "second candidate");
        const head = await git(path, "rev-parse", "HEAD");

        const attempt = service.verifyDirectPush({
            repository: REPOSITORY,
            repositoryPath: path,
            branch,
            intendedBaseSha: base,
            expectedCommitSha: head,
            pushMode: "non-force",
        });

        await expect(attempt).rejects.toBeInstanceOf(GitRemoteSafetyError);
        await expect(attempt).rejects.toThrow("0 behind and 2 ahead");
    });

    test("refuses a candidate that is not the expected created commit", async () => {
        const { path, branch, base, service } = await setup();
        const head = await git(path, "rev-parse", "HEAD");
        await writeFile(join(path, "second.txt"), "second candidate\n");
        await git(path, "add", "second.txt");
        await git(path, "commit", "-q", "-m", "second candidate");

        await expect(
            service.verifyDirectPush({
                repository: REPOSITORY,
                repositoryPath: path,
                branch,
                intendedBaseSha: base,
                expectedCommitSha: head,
                pushMode: "non-force",
            }),
        ).rejects.toThrow("does not match expected commit");
    });
});