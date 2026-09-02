import { describe, expect, test } from "bun:test";

import type {
    CommandResult,
    CommandRunnerService,
} from "../../src/process/command-runner.ts";
import {
    makeIssueVerificationService,
    VERIFICATION_COMMAND_TIMEOUT_MS,
    VerificationCommandError,
} from "../../src/issues/verification.ts";

const result = (exitCode: number, stdout = "", stderr = ""): CommandResult => ({
    exitCode,
    stdout,
    stderr,
});

describe("issue verification", () => {
    test("binds passing commands to one unchanged staged tree", async () => {
        const calls: string[] = [];
        const outputs = [
            result(0, "a".repeat(40)),
            result(0, "passed"),
            result(0, "a".repeat(40)),
        ];
        const runner: CommandRunnerService = {
            run: async (command, args, options) => {
                calls.push(
                    `${options?.cwd}:${command}:${args.join(" ")}:${options?.timeoutMs}`,
                );
                return outputs.shift()!;
            },
        };
        const evidence = await makeIssueVerificationService(runner).verify(
            "/repo",
            ["bun run check"],
        );
        expect(evidence.stagedTreeSha).toBe("a".repeat(40));
        expect(evidence.commands[0]?.exitCode).toBe(0);
        expect(calls).toContain("/repo:git:write-tree:undefined");
        expect(calls).toContain(
            `/repo:/bin/sh:-c bun run check:${VERIFICATION_COMMAND_TIMEOUT_MS}`,
        );
    });

    test("returns repairable evidence for a non-zero command", async () => {
        const outputs = [
            result(0, "a".repeat(40)),
            result(1, "", "format failed"),
            result(0, "a".repeat(40)),
        ];
        const runner: CommandRunnerService = {
            run: async () => outputs.shift()!,
        };
        try {
            await makeIssueVerificationService(runner).verify("/repo", [
                "check",
            ]);
            throw new Error("Expected verification to fail");
        } catch (error) {
            expect(error).toBeInstanceOf(VerificationCommandError);
            expect((error as VerificationCommandError).message).toContain(
                "format failed",
            );
            expect(
                (error as VerificationCommandError).verification.commands[0],
            ).toMatchObject({ command: "check", exitCode: 1 });
        }
    });

    test("fails closed when a failing command changes the staged tree", async () => {
        const outputs = [
            result(0, "a".repeat(40)),
            result(1, "", "check failed"),
            result(0, "b".repeat(40)),
        ];
        const runner: CommandRunnerService = {
            run: async () => outputs.shift()!,
        };

        await expect(
            makeIssueVerificationService(runner).verify("/repo", ["check"]),
        ).rejects.toThrow("Verification changed the staged tree");
    });
});