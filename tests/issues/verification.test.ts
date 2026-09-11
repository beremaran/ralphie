import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type {
    CommandResult,
    CommandRunnerService,
} from "../../src/process/command-runner.ts";
import {
    makeIssueVerificationService,
    VerificationCommandError,
} from "../../src/issues/verification.ts";

const TREE_SHA = "a".repeat(40);

type RecordedCall = {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd: string | undefined;
};

const runnerFor = (
    calls: RecordedCall[],
    respond: (call: RecordedCall) => CommandResult,
): CommandRunnerService => ({
    run: async (command, args, options) => {
        const call = { command, args, cwd: options?.cwd };
        calls.push(call);
        return respond(call);
    },
});

const treeResult = (sha: string): CommandResult => ({
    exitCode: 0,
    stdout: sha,
    stderr: "",
});

describe("issue verification gate", () => {
    test("skips the gate with no commands, even when package.json has a check script", async () => {
        const directory = await mkdtemp(join(tmpdir(), "ralphie-verify-"));
        try {
            await writeFile(
                join(directory, "package.json"),
                JSON.stringify({ scripts: { check: "bun run check" } }),
            );
            const calls: RecordedCall[] = [];
            const verification = makeIssueVerificationService(
                runnerFor(calls, () => treeResult(TREE_SHA)),
            );

            const evidence = await verification.verify(directory, []);

            expect(evidence).toEqual({
                stagedTreeSha: TREE_SHA,
                commands: [],
            });
            expect(calls.map(({ command }) => command)).toEqual(["git", "git"]);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test("runs configured commands through /bin/sh in the checkout", async () => {
        const calls: RecordedCall[] = [];
        const verification = makeIssueVerificationService(
            runnerFor(calls, (call) =>
                call.command === "git"
                    ? treeResult(TREE_SHA)
                    : { exitCode: 0, stdout: "ok", stderr: "" },
            ),
        );

        const evidence = await verification.verify("/tmp/checkout", [
            "bun run check",
            "git diff --check",
        ]);

        expect(evidence).toEqual({
            stagedTreeSha: TREE_SHA,
            commands: [
                {
                    command: "bun run check",
                    exitCode: 0,
                    stdout: "ok",
                    stderr: "",
                },
                {
                    command: "git diff --check",
                    exitCode: 0,
                    stdout: "ok",
                    stderr: "",
                },
            ],
        });
        expect(calls.filter(({ command }) => command === "/bin/sh")).toEqual([
            {
                command: "/bin/sh",
                args: ["-c", "bun run check"],
                cwd: "/tmp/checkout",
            },
            {
                command: "/bin/sh",
                args: ["-c", "git diff --check"],
                cwd: "/tmp/checkout",
            },
        ]);
    });

    test("rejects a non-zero configured command with its evidence", async () => {
        const verification = makeIssueVerificationService(
            runnerFor([], (call) =>
                call.command === "git"
                    ? treeResult(TREE_SHA)
                    : { exitCode: 1, stdout: "failed", stderr: "boom" },
            ),
        );

        const failure = await verification
            .verify("/tmp/checkout", ["make test"])
            .catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(VerificationCommandError);
        expect((failure as VerificationCommandError).verification).toEqual({
            stagedTreeSha: TREE_SHA,
            commands: [
                {
                    command: "make test",
                    exitCode: 1,
                    stdout: "failed",
                    stderr: "boom",
                },
            ],
        });
    });

    test("rejects when a configured command mutates the staged tree", async () => {
        let treeReads = 0;
        const verification = makeIssueVerificationService(
            runnerFor([], (call) => {
                if (call.command !== "git") {
                    return { exitCode: 0, stdout: "", stderr: "" };
                }
                treeReads += 1;
                return treeResult(treeReads === 1 ? TREE_SHA : "b".repeat(40));
            }),
        );

        await expect(
            verification.verify("/tmp/checkout", ["make test"]),
        ).rejects.toThrow("Verification changed the staged tree");
    });
});