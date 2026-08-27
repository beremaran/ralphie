import { describe, expect, test } from "bun:test";

import { makeGitIssueCheckpointService } from "../../src/git/issue-checkpoint.ts";
import type { CommandResult } from "../../src/process/command-runner.ts";

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
});