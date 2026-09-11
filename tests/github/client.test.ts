import { describe, expect, test } from "bun:test";

import { makeGitHubConnection } from "../../src/github/adapters/session.ts";
import {
    type CommandResult,
    type CommandRunnerService,
} from "../../src/process/ports.ts";
import { RalphieError } from "../../src/shared/error.ts";

const result = (exitCode: number, stdout = "", stderr = ""): CommandResult => ({
    exitCode,
    stdout,
    stderr,
});

const authenticationError = async (
    runner: CommandRunnerService,
): Promise<Error> =>
    (await makeGitHubConnection(runner)
        .connect()
        .catch((caught: unknown) => caught as Error)) as Error;

describe("GitHub client authentication", () => {
    test("fails with gh auth status stderr verbatim", async () => {
        const runner: CommandRunnerService = {
            run: async () =>
                result(1, "", "Authorization: Bearer private-value"),
        };

        const error = await authenticationError(runner);

        expect(error).toBeInstanceOf(RalphieError);
        expect(error.message).toContain("GitHub authentication check failed.");
        expect(error.message).toContain("Bearer private-value");
    });

    test("fails with gh auth token stderr verbatim", async () => {
        let calls = 0;
        const runner: CommandRunnerService = {
            run: async () => {
                calls += 1;
                return calls === 1
                    ? result(0)
                    : result(1, "", "Could not read token private-auth-token");
            },
        };

        const error = await authenticationError(runner);

        expect(calls).toBe(2);
        expect(error.message).toContain(
            "Could not retrieve the GitHub authentication token.",
        );
        expect(error.message).toContain("private-auth-token");
    });

    test("keeps environment-derived values in authentication failures", async () => {
        process.env.GH_TOKEN = "env-derived-secret";
        try {
            const runner: CommandRunnerService = {
                run: async (_command, _args, options) => {
                    expect(options?.env?.GH_TOKEN).toBe("env-derived-secret");
                    return result(1, "", "gh refused env-derived-secret");
                },
            };

            const error = await authenticationError(runner);

            expect(error.message).toContain("env-derived-secret");
        } finally {
            delete process.env.GH_TOKEN;
        }
    });

    test("initializes Octokit from the gh auth token stdout", async () => {
        let calls = 0;
        const runner: CommandRunnerService = {
            run: async () => {
                calls += 1;
                return calls === 1 ? result(0) : result(0, "ghs_test_token\n");
            },
        };

        const connection = makeGitHubConnection(runner);
        await connection.connect();

        expect(calls).toBe(2);
        expect(connection.session.client().rest).toBeDefined();
    });
});