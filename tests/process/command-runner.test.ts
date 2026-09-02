import { describe, expect, test } from "bun:test";

import {
    CommandRunnerLive,
    CommandTimeoutError,
    DEFAULT_PROCESS_COMMAND_TIMEOUT_MS,
} from "../../src/process/command-runner.ts";
import { RalphieError } from "../../src/shared/error.ts";

describe("live command runner", () => {
    test("runs fast commands and trims their stdout", async () => {
        const result = await CommandRunnerLive.run("echo", ["hello"]);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("hello");
        expect(result.stderr).toBe("");
    });

    test("keeps untrimmed stdout when requested", async () => {
        const result = await CommandRunnerLive.run("printf", ["  hi  "], {
            trimStdout: false,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("  hi  ");
    });

    test("kills a command that exceeds its explicit deadline", async () => {
        const startedAt = Date.now();
        try {
            await CommandRunnerLive.run("sleep", ["30"], {
                timeoutMs: 200,
            });
            throw new Error("Expected the command to time out");
        } catch (error) {
            expect(error).toBeInstanceOf(RalphieError);
            expect(error).toBeInstanceOf(CommandTimeoutError);
            expect((error as CommandTimeoutError).timeoutMs).toBe(200);
            expect((error as Error).message).toBe(
                "Command timed out after 0.2s and was terminated: sleep 30",
            );
        }
        expect(Date.now() - startedAt).toBeLessThan(5_000);
    });

    test("every spawned command carries a default deadline", () => {
        expect(DEFAULT_PROCESS_COMMAND_TIMEOUT_MS).toBeGreaterThan(0);
        expect(DEFAULT_PROCESS_COMMAND_TIMEOUT_MS % 1000).toBe(0);
    });
});