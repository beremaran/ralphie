import { describe, expect, test } from "bun:test";

import { runCli } from "../src/cli.ts";
import { HELP_TEXT, parseCliArgs, runCommand } from "../src/command.ts";
import { RalphieExitCode } from "../src/workflow/exit-code.ts";
import { RalphieError } from "../src/shared/error.ts";
import {
    recordingFactories,
    workflowErrorFor,
    workflowOptionsFor,
    writeTemporaryFile,
} from "./shared/config-fixture.ts";

describe("native CLI parser", () => {
    test("documents the shrunken command surface in help", () => {
        expect(HELP_TEXT).toContain("Usage: ralphie [owner/]repository");
        for (const option of [
            "--config <path>",
            "--set <path=value>",
            "--output <mode>",
        ]) {
            expect(HELP_TEXT).toContain(option);
        }
        for (const removed of [
            "--model",
            "--thinking",
            "--branch",
            "--issue-label",
            "--issue-sort",
            "--verify-command",
            "--implementation-attempts",
            "--max-decomposition-depth",
            "--workspace",
            "--notify-hand-off",
            "--hand-off-label",
            "maintain-issues",
            "--max-issues",
            "--dry-run",
        ]) {
            expect(HELP_TEXT).not.toContain(removed);
        }
    });

    test("parses the repository, config path and repeatable --set", () => {
        const parsed = parseCliArgs([
            "owner/repository",
            "--config",
            "/etc/ralphie.yaml",
            "--set",
            "limits.reviewRounds=3",
            "--set=workspace=/tmp/w",
        ]);

        expect(parsed.help).toBe(false);
        expect(parsed.version).toBe(false);
        expect(parsed.options).toMatchObject({
            repo: "owner/repository",
            configPath: "/etc/ralphie.yaml",
            overrides: ["limits.reviewRounds=3", "workspace=/tmp/w"],
        });
    });

    test("names the config key that replaces each removed flag", () => {
        for (const [args, key] of [
            [["--branch", "main"], 'repos."<owner/repo>".branch'],
            [["-b", "main"], 'repos."<owner/repo>".branch'],
            [["--verify-command=bun test"], 'repos."<owner/repo>".verify'],
            [["--issue-label", "bug"], "intake.requireLabels"],
            [["--issue-sort", "updated"], "intake.sort"],
            [
                ["--implementation-attempts", "2"],
                "limits.implementationAttempts",
            ],
            [
                ["--max-decomposition-depth", "4"],
                "limits.maxDecompositionDepth",
            ],
            [["--workspace", "/tmp/w"], "workspace"],
        ] as const) {
            const flag = (args[0] ?? "").split("=")[0];
            expect(() => parseCliArgs(["owner/repository", ...args])).toThrow(
                `Option ${flag} was removed. Set ${key} in the config file instead, or override it for one run with --set.`,
            );
        }
    });

    test("still rejects flags removed by earlier releases", () => {
        for (const args of [
            ["owner/repository", "--on-hand-off", "halt"],
            ["owner/repository", "--notify-hand-off"],
            ["owner/repository", "--hand-off-label", "blocked"],
            ["owner/repository", "--on-issue-failure", "continue"],
            ["owner/repository", "--mode", "issues"],
            ["owner/repository", "--max-attempts", "2"],
            ["owner/repository", "--pipeline-timeout", "10m"],
            ["owner/repository", "--duplicate-action", "close"],
            ["owner/repository", "--max-issues", "1"],
            ["owner/repository", "--dry-run"],
            ["owner/repository", "--resume", "state.json"],
            ["owner/repository", "--clean", "both"],
            ["owner/repository", "--implementation-fallback-model", "o/m"],
        ]) {
            expect(() => parseCliArgs(args)).toThrow();
        }
    });

    test.each([
        ["--model", "harnesses.<harness>.model"],
        ["--thinking", "harnesses.<harness>.effort"],
    ])(
        "rejects %s and names the config keys that replace it",
        async (flag, key) => {
            const config = await writeTemporaryFile("{}");

            const error = await workflowErrorFor([
                "owner/repository",
                "--config",
                config,
                flag,
                "high",
            ]);

            expect(error.message).toContain(`Option ${flag} was removed`);
            expect(error.message).toContain(key);
        },
    );

    test("resolves the role assignments from harnesses and roles", async () => {
        const config = await writeTemporaryFile(`
harnesses:
  claude:
    model: opus
    effort: high
roles:
  reviewer:
    harness: claude
    model: sonnet
`);

        const options = await workflowOptionsFor([
            "owner/repository",
            "--config",
            config,
        ]);

        expect(options.roles.implementer).toEqual({
            harness: "claude",
            model: "opus",
            effort: "high",
        });
        expect(options.roles["standards-reviewer"]).toEqual({
            harness: "claude",
            model: "sonnet",
            effort: "high",
        });
    });

    test("passes the mapped triage labels to the workflow for hand-offs", async () => {
        const config = await writeTemporaryFile(
            "labels:\n  needs-info: waiting-on-reporter\n  ready-for-human: human-turn\n",
        );

        const options = await workflowOptionsFor([
            "owner/repository",
            "--config",
            config,
        ]);

        expect(options.handOffLabels).toEqual({
            "needs-info": "waiting-on-reporter",
            "ready-for-human": "human-turn",
            replaces: [
                "needs-triage",
                "waiting-on-reporter",
                "ready-for-agent",
                "human-turn",
                "wontfix",
            ],
        });
    });

    test("rejects the former notifications section", async () => {
        const config = await writeTemporaryFile(
            "notifications:\n  enabled: true\n",
        );

        const error = await workflowErrorFor([
            "owner/repository",
            "--config",
            config,
        ]);

        expect(error.message).toContain("notifications");
    });

    test("keeps sensitive values verbatim in wrapped command errors", async () => {
        process.env.GH_TOKEN = "private-auth-token";
        const config = await writeTemporaryFile("{}");
        try {
            const failure = new RalphieError({
                message:
                    "Failed: Bearer private-value at https://example.test/api?token=query-secret; " +
                    "environment token private-auth-token leaked.",
            });
            const error = await runCommand(
                ["owner/repository", "--config", config],
                {
                    factories: recordingFactories(() => {}, {
                        runWorkflow: async () => {
                            throw failure;
                        },
                    }),
                },
            ).then(
                () => {
                    throw new Error("expected runCommand to reject");
                },
                (caught: unknown) => caught as Error,
            );
            expect(error.message).toContain("Bearer private-value");
            expect(error.message).toContain("query-secret");
            expect(error.message).toContain("private-auth-token");
            expect(error.cause).toBe(failure);
        } finally {
            process.exitCode = 0;
            delete process.env.GH_TOKEN;
        }
    });

    test("emits thrown error text verbatim on stderr", async () => {
        const originalWrite = process.stderr.write.bind(process.stderr);
        const written: string[] = [];
        try {
            process.stderr.write = ((text: string) => {
                written.push(text);
                return true;
            }) as typeof process.stderr.write;
            process.exitCode = 0;
            await runCli(["not-a-slug Bearer private-value"]);
            const output = written.join("");
            expect(output).toContain("Bearer private-value");
            expect(process.exitCode).toBe(RalphieExitCode.Failure);
        } finally {
            process.stderr.write = originalWrite;
            process.exitCode = 0;
        }
    });

    test("answers --help and --version without a config file", async () => {
        const written: string[] = [];
        const output = {
            stdout: (text: string) => written.push(text),
            stderr: (text: string) => written.push(text),
        };
        const isolated = {
            output,
            environment: {},
            homeDirectory: "/nonexistent/ralphie-test-home",
        };

        await runCommand(["--help"], isolated);
        await runCommand(["--version", "--output", "json"], isolated);

        expect(written[0]).toBe(HELP_TEXT);
        expect(JSON.parse(written[1] ?? "")).toHaveProperty("version");
    });

    test("parses every supported output mode", () => {
        expect(parseCliArgs(["owner/repository"]).options).toMatchObject({
            json: false,
        });
        expect(
            parseCliArgs(["owner/repository", "--output", "default"]).options,
        ).toMatchObject({ json: false });
        expect(
            parseCliArgs(["owner/repository", "--output", "json"]).options,
        ).toMatchObject({ json: true });
        for (const removed of ["verbose", "quiet", "trace"]) {
            expect(() =>
                parseCliArgs(["owner/repository", "--output", removed]),
            ).toThrow();
        }
    });
});