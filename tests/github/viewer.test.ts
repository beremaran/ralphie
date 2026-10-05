import { describe, expect, test } from "bun:test";

import { makeGitHubViewerService } from "../../src/github/adapters/viewer.ts";
import type {
    CommandResult,
    CommandRunnerService,
} from "../../src/process/ports.ts";

const result = (exitCode: number, stdout = "", stderr = ""): CommandResult => ({
    exitCode,
    stdout,
    stderr,
});

describe("GitHub viewer", () => {
    test("reads the authenticated login from gh", async () => {
        const calls: Array<{ command: string; args: readonly string[] }> = [];
        const runner: CommandRunnerService = {
            run: async (command, args) => {
                calls.push({ command, args });
                return result(0, "octocat\n");
            },
        };

        expect(await makeGitHubViewerService(runner).login()).toBe("octocat");
        expect(calls).toEqual([
            { command: "gh", args: ["api", "user", "--jq", ".login"] },
        ]);
    });

    test("points at defaultOwner when gh cannot name the user", async () => {
        for (const outcome of [result(1, "", "not logged in"), result(0, "")]) {
            const runner: CommandRunnerService = { run: async () => outcome };

            const error = await makeGitHubViewerService(runner)
                .login()
                .then(
                    () => {
                        throw new Error("expected login to reject");
                    },
                    (caught: unknown) => caught as Error,
                );

            expect(error).toBeInstanceOf(Error);
            expect(error.message).toContain("defaultOwner");
        }
    });
});