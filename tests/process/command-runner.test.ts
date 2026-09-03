import { describe, expect, test } from "bun:test";

import {
    requireSuccess,
    type CommandResult,
    type CommandRunnerService,
} from "../../src/process/command-runner.ts";
import { RalphieError } from "../../src/shared/error.ts";

const result = (
    exitCode: number,
    stderr: string,
    stdout = "",
): CommandResult => ({ exitCode, stdout, stderr });

const failingRunner = (stderr: string): CommandRunnerService => ({
    run: async () => result(1, stderr),
});

describe("requireSuccess", () => {
    test("returns the successful result unchanged", async () => {
        const runner: CommandRunnerService = {
            run: async () => {
                return result(0, "", "clean output");
            },
        };

        const outcome = await requireSuccess(
            runner,
            "gh",
            ["auth", "status"],
            "check failed.",
        );

        expect(outcome).toEqual({
            exitCode: 0,
            stdout: "clean output",
            stderr: "",
        });
    });

    test("keeps captured stderr verbatim in the failure error", async () => {
        const error = (await requireSuccess(
            failingRunner(
                "Authorization: Bearer private-value\nhttps://example.test/api?token=query-secret",
            ),
            "gh",
            ["auth", "status"],
            "GitHub authentication check failed.",
        ).catch((caught) => caught as Error)) as Error;

        expect(error).toBeInstanceOf(RalphieError);
        expect(error.message).toContain("GitHub authentication check failed.");
        expect(error.message).toContain("Authorization: Bearer private-value");
        expect(error.message).toContain("?token=query-secret");
    });

    test("keeps environment-derived values verbatim in stderr", async () => {
        process.env.GH_TOKEN = "private-auth-token";
        try {
            const error = (await requireSuccess(
                failingRunner("gh refused token private-auth-token"),
                "gh",
                ["auth", "status"],
                "GitHub authentication check failed.",
            ).catch((caught) => caught as Error)) as Error;

            expect(error.message).toContain("private-auth-token");
        } finally {
            delete process.env.GH_TOKEN;
        }
    });
});