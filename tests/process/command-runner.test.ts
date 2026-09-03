import { describe, expect, test } from "bun:test";

import {
    CommandAbortedError,
    CommandRunnerLive,
    CommandTimeoutError,
    PROCESS_TERMINATION_ESCALATION_MS,
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

describe("CommandRunnerLive abortable subprocess", () => {
    test("runs a command normally and returns its captured output", async () => {
        const result = await CommandRunnerLive.run("printf", ["ok"], {
            trimStdout: false,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("ok");
        expect(result.stderr).toBe("");
    });

    test("aborts an in-flight subprocess promptly with CommandAbortedError", async () => {
        const controller = new AbortController();
        const started = Date.now();
        const outcome = CommandRunnerLive.run("sleep", ["30"], {
            signal: controller.signal,
        }).catch((error: unknown) => error);
        setTimeout(() => controller.abort(), 60);
        const result = await outcome;
        const elapsed = Date.now() - started;

        expect(result).toBeInstanceOf(CommandAbortedError);
        expect((result as Error).message).toContain("sleep 30");
        // The 30s child was terminated rather than allowed to finish.
        expect(elapsed).toBeLessThan(10_000);
    });

    test("rejects a pre-aborted run with CommandAbortedError", async () => {
        const controller = new AbortController();
        controller.abort();

        await expect(
            CommandRunnerLive.run("sleep", ["30"], {
                signal: controller.signal,
            }),
        ).rejects.toBeInstanceOf(CommandAbortedError);
    });

    test("keeps the timeout failure distinct from an abort", async () => {
        const controller = new AbortController();
        const started = Date.now();
        const result = await CommandRunnerLive.run("sleep", ["30"], {
            timeoutMs: 150,
            signal: controller.signal,
        }).catch((error: unknown) => error);
        const elapsed = Date.now() - started;

        expect(result).toBeInstanceOf(CommandTimeoutError);
        expect(result).not.toBeInstanceOf(CommandAbortedError);
        expect(elapsed).toBeLessThan(10_000);
    });

    test("escalates to SIGKILL when the child ignores the termination signal", async () => {
        const controller = new AbortController();
        const started = Date.now();
        const outcome = CommandRunnerLive.run(
            "/bin/sh",
            ["-c", "trap '' TERM; exec sleep 30"],
            { signal: controller.signal },
        ).catch((error: unknown) => error);
        setTimeout(() => controller.abort(), 60);
        const result = await outcome;
        const elapsed = Date.now() - started;

        expect(result).toBeInstanceOf(CommandAbortedError);
        // SIGTERM is ignored by the child, so only the SIGKILL escalation
        // could end it; that requires the full escalation grace period.
        expect(elapsed).toBeGreaterThan(PROCESS_TERMINATION_ESCALATION_MS / 2);
        expect(elapsed).toBeLessThan(PROCESS_TERMINATION_ESCALATION_MS * 5);
    });

    test("distinguishes an aborted live run from a failed one", async () => {
        const controller = new AbortController();
        const failed = await CommandRunnerLive.run("false", [], {
            signal: controller.signal,
        });
        expect(failed.exitCode).not.toBe(0);

        controller.abort();
        await expect(
            CommandRunnerLive.run("sleep", ["30"], {
                signal: controller.signal,
            }),
        ).rejects.toBeInstanceOf(CommandAbortedError);
    });
});