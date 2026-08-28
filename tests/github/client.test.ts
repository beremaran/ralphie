import { describe, expect, test } from "bun:test";
import { Octokit } from "octokit";

import {
    GITHUB_REST_API_VERSION,
    makeGitHubClientService,
} from "../../src/github/client.ts";
import type { CommandResult } from "../../src/process/command-runner.ts";

const testService = (calls: string[], results: CommandResult[]) =>
    makeGitHubClientService({
        run: async (command, args) => {
            calls.push(`${command} ${args.join(" ")}`);
            return (
                results.shift() ?? {
                    exitCode: 0,
                    stdout: "",
                    stderr: "",
                }
            );
        },
    });

describe("GitHub client", () => {
    test("checks auth, retrieves the token, and initializes Octokit", async () => {
        const calls: string[] = [];
        const client = await testService(calls, [
            { exitCode: 0, stdout: "", stderr: "" },
            { exitCode: 0, stdout: "test-token", stderr: "" },
        ]).initialize();

        expect(client).toBeInstanceOf(Octokit);
        expect(GITHUB_REST_API_VERSION).toBe("2026-03-10");
        expect(calls).toEqual(["gh auth status", "gh auth token"]);
    });

    test("stops when authentication fails", async () => {
        const calls: string[] = [];
        const service = testService(calls, [
            { exitCode: 1, stdout: "", stderr: "not logged in" },
        ]);

        await expect(service.initialize()).rejects.toThrow(
            "GitHub authentication check failed",
        );
        expect(calls).toEqual(["gh auth status"]);
    });

    test("rejects an empty token", async () => {
        const calls: string[] = [];
        const service = testService(calls, [
            { exitCode: 0, stdout: "", stderr: "" },
            { exitCode: 0, stdout: "", stderr: "" },
        ]);

        await expect(service.initialize()).rejects.toThrow(
            "GitHub CLI returned an empty authentication token",
        );
        expect(calls).toEqual(["gh auth status", "gh auth token"]);
    });
});