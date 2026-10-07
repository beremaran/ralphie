import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeGitIssueOperationsService } from "../../src/git/adapters/issue-operations.ts";
import { makeGitRemoteSafetyService } from "../../src/git/adapters/remote-safety.ts";
import { makeGitRepositoryService } from "../../src/git/adapters/repository.ts";
import { CommandRunnerLive } from "../../src/process/adapters/command-runner.ts";
import type { CommandRunnerService } from "../../src/process/ports.ts";

const ORIGIN_URL = "https://github.com/owner/repository.git";

const run = async (cwd: string, ...args: string[]): Promise<string> => {
    const result = await CommandRunnerLive.run("git", ["-C", cwd, ...args]);
    if (result.exitCode !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
};

const prepareLocalRemote = async () => {
    const root = await mkdtemp(join(tmpdir(), "ralphie-push-"));
    const remote = join(root, "remote.git");
    const work = join(root, "work");
    const commands: string[][] = [];
    try {
        await run(root, "init", "-q", "--bare", remote);
        await run(root, "clone", "-q", remote, work);
        await run(work, "config", "user.email", "t@test.local");
        await run(work, "config", "user.name", "T");
        await run(work, "checkout", "-q", "-b", "main");
        await writeFile(join(work, "a.txt"), "a\n");
        await run(work, "add", ".");
        await run(work, "commit", "-q", "-m", "base");
        const baseSha = await run(work, "rev-parse", "HEAD");
        await run(work, "push", "-q", "origin", "main");

        const runner: CommandRunnerService = {
            run: async (command, args, options) => {
                commands.push([...args]);
                const operation = args[0] === "-C" ? args.slice(2) : args;
                if (operation.join(" ") === "remote get-url origin") {
                    return {
                        stdout: `${ORIGIN_URL}\n`,
                        stderr: "",
                        exitCode: 0,
                    };
                }
                const rewritten = [...args];
                const pushIndex = operation.indexOf("push");
                const originIndex = rewritten.indexOf(ORIGIN_URL);
                if (pushIndex >= 0 && originIndex >= 0) {
                    rewritten[originIndex] = remote;
                }
                return CommandRunnerLive.run(command, rewritten, options);
            },
        };

        const prepared = await makeGitRepositoryService(runner).prepare(
            "owner/repository",
            "main",
            root,
            work,
        );
        return {
            root,
            remote,
            work,
            baseSha,
            prepared,
            commands,
            runner,
            cleanup: () => rm(root, { recursive: true, force: true }),
        };
    } catch (cause) {
        await rm(root, { recursive: true, force: true });
        throw cause;
    }
};

test("workspace preparation preserves origin's push URL and delivery is non-force and verified", async () => {
    const harness = await prepareLocalRemote();
    try {
        const { prepared, work, remote, runner, commands } = harness;
        expect(prepared).toMatchObject({
            path: work,
            branch: "main",
            cloned: false,
            branchChanged: false,
            cleaned: false,
        });
        expect(await run(work, "remote", "get-url", "--push", "origin")).toBe(
            await run(work, "remote", "get-url", "origin"),
        );

        await writeFile(join(work, "b.txt"), "b\n");
        await run(work, "add", ".");
        await run(work, "commit", "-q", "-m", "change");
        const sha = await run(work, "rev-parse", "HEAD");

        await makeGitIssueOperationsService(runner).push(work, "main", sha);

        expect(await run(remote, "rev-parse", "refs/heads/main")).toBe(sha);
        expect(await run(work, "rev-parse", "refs/remotes/origin/main")).toBe(
            sha,
        );
        expect(
            commands.some(
                (args) =>
                    args.includes("--no-force") && args.includes(ORIGIN_URL),
            ),
        ).toBe(true);
    } finally {
        await harness.cleanup();
    }
});

test("delivery rejects an early session push before pushing its created commit", async () => {
    const harness = await prepareLocalRemote();
    try {
        const { work, remote, baseSha, runner, commands } = harness;
        await writeFile(join(work, "session.txt"), "session change\n");
        await run(work, "add", ".");
        await run(work, "commit", "-q", "-m", "early session commit");
        const sessionSha = await run(work, "rev-parse", "HEAD");
        await run(work, "push", "origin", "HEAD:refs/heads/main");

        await writeFile(join(work, "approved.txt"), "approved change\n");
        await run(work, "add", ".");
        await run(work, "commit", "-q", "-m", "created delivery commit");
        const createdSha = await run(work, "rev-parse", "HEAD");

        const deliver = async () => {
            await makeGitRemoteSafetyService(runner).verifyDirectPush({
                repository: "owner/repository",
                repositoryPath: work,
                branch: "main",
                intendedBaseSha: baseSha,
                expectedCommitSha: createdSha,
                pushMode: "non-force",
            });
            await makeGitIssueOperationsService(runner).push(
                work,
                "main",
                createdSha,
            );
        };

        await expect(deliver()).rejects.toMatchObject({
            name: "GitRemoteSafetyError",
            kind: "diverged-base",
            message: `Remote origin/main moved from intended base ${baseSha} to ${sessionSha}.`,
        });
        expect(await run(remote, "rev-parse", "refs/heads/main")).toBe(
            sessionSha,
        );
        expect(commands.some((args) => args.includes("--no-force"))).toBe(
            false,
        );
    } finally {
        await harness.cleanup();
    }
});