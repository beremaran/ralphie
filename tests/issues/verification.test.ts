import { describe, expect, test } from "bun:test";

import type {
    CommandResult,
    CommandRunnerService,
} from "../../src/process/command-runner.ts";
import { makeIssueVerificationService } from "../../src/issues/verification.ts";

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
                calls.push(`${options?.cwd}:${command}:${args.join(" ")}`);
                return outputs.shift()!;
            },
        };
        const evidence = await makeIssueVerificationService(runner).verify(
            "/repo",
            ["bun run check"],
        );
        expect(evidence.stagedTreeSha).toBe("a".repeat(40));
        expect(evidence.commands[0]?.exitCode).toBe(0);
        expect(calls).toContain("/repo:/bin/sh:-c bun run check");
    });

    test("fails immediately on a non-zero command", async () => {
        const outputs = [
            result(0, "a".repeat(40)),
            result(1, "", "format failed"),
        ];
        const runner: CommandRunnerService = {
            run: async () => outputs.shift()!,
        };
        await expect(
            makeIssueVerificationService(runner).verify("/repo", ["check"]),
        ).rejects.toThrow("format failed");
    });
});