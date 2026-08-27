import { describe, expect, test } from "bun:test";

import type { CommandResult } from "../../src/process/command-runner.ts";
import {
    type GitDirectPushPolicy,
    type GitPushMode,
    type GitRemoteSafetyFailureKind,
    makeGitRemoteSafetyService,
} from "../../src/git/remote-safety.ts";

const runner = (
    counts = "0 0",
    origin = "https://github.com/owner/repository.git",
    remoteSha = "base123",
) => {
    const commands: ReadonlyArray<CommandResult> = [
        { exitCode: 0, stdout: origin, stderr: "" },
        { exitCode: 0, stdout: "main", stderr: "" },
        { exitCode: 0, stdout: "abc123", stderr: "" },
        { exitCode: 0, stdout: `${remoteSha}\trefs/heads/main`, stderr: "" },
        { exitCode: 0, stdout: counts, stderr: "" },
    ];
    let index = 0;
    return {
        run: async () => commands[index++] ?? commands.at(-1)!,
    };
};

const verify = (
    input: {
        readonly counts?: string;
        readonly origin?: string;
        readonly remoteSha?: string;
        readonly expectedCommitSha?: string;
        readonly pushMode?: GitPushMode;
    } = {},
) =>
    makeGitRemoteSafetyService(
        runner(input.counts, input.origin, input.remoteSha),
    ).verifyDirectPush({
        repository: "owner/repository",
        repositoryPath: "/workspace/repository",
        branch: "main",
        intendedBaseSha: "base123",
        expectedCommitSha: input.expectedCommitSha,
        pushMode: input.pushMode,
    });

describe("Git remote safety", () => {
    test("accepts a matching, non-diverged direct push", async () => {
        const report = await verify();
        expect(report).toMatchObject({
            repository: "owner/repository",
            branch: "main",
            commitsBehindBase: 0,
            commitsAheadBase: 0,
            pushMode: "non-force",
        });
    });

    test.each([
        ["diverged base", { counts: "1 2" }, "diverged-base"],
        ["moved remote", { remoteSha: "newbase" }, "diverged-base"],
    ])("refuses %s", async (_name, options) => {
        await expect(verify(options)).rejects.toMatchObject({
            kind: "diverged-base",
        });
    });

    test("refuses a force-push mode before any remote checks", async () => {
        await expect(verify({ pushMode: "force" })).rejects.toMatchObject({
            policy: "non-force-only",
        });
    });

    test("revalidates that origin belongs to the requested repository", async () => {
        await expect(
            verify({ origin: "https://github.com/other/repository.git" }),
        ).rejects.toThrow("does not match");
    });

    test("requires exactly one local commit when verifying a new issue push", async () => {
        const report = await verify({
            counts: "0 1",
            expectedCommitSha: "abc123",
        });
        expect(report.commitsAheadBase).toBe(1);
    });

    test("accepts an expected commit that already reached the remote", async () => {
        const report = await verify({
            counts: "0 1",
            expectedCommitSha: "abc123",
            remoteSha: "abc123",
        });
        expect(report.commitsAheadBase).toBe(1);
    });
});