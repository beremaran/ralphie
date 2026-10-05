import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../src/cli.ts";
import { HELP_TEXT, parseCliArgs, runCommand } from "../src/command.ts";
import { RalphieExitCode } from "../src/workflow/exit-code.ts";
import { RalphieError } from "../src/shared/error.ts";
import { makeTestProgressRecorder } from "./shared/progress-recorder.ts";
import { fakeConfigSource, fakeGitHubLogin } from "./shared/config-source.ts";

describe("native CLI parser", () => {
    test("documents the config-driven command surface in help", () => {
        for (const documented of [
            "--config <path>",
            "--set <path=value>",
            "--output <mode>",
            "--thinking <level>",
            "--notify-needs-attention",
            "--needs-attention-label <name>",
        ]) {
            expect(HELP_TEXT).toContain(documented);
        }
        for (const removed of [
            "--branch",
            "--issue-label",
            "--issue-sort",
            "--verify-command",
            "--workspace",
            "--implementation-attempts",
            "--max-decomposition-depth",
            "maintain-issues",
            "get-pipelines-green",
            "--max-issues",
            "--dry-run",
            "--resume",
            "--clean",
            "--implementation-fallback-model",
        ]) {
            expect(HELP_TEXT).not.toContain(removed);
        }
    });

    test("parses the positional repository, --config and repeatable --set", () => {
        const parsed = parseCliArgs([
            "owner/repository",
            "--config",
            "/tmp/ralphie.yaml",
            "--set",
            "limits.reviewRounds=3",
            '--set=intake.requireLabels=["bug","ready"]',
        ]);

        expect(parsed.help).toBe(false);
        expect(parsed.version).toBe(false);
        expect(parsed.options).toMatchObject({
            repo: "owner/repository",
            configPath: "/tmp/ralphie.yaml",
            overrides: [
                { path: ["limits", "reviewRounds"], value: 3 },
                {
                    path: ["intake", "requireLabels"],
                    value: ["bug", "ready"],
                },
            ],
        });
    });

    test("names the replacing config key for every removed flag", () => {
        const removed: ReadonlyArray<[ReadonlyArray<string>, string]> = [
            [["--branch", "main"], 'repos."owner/repo".branch'],
            [["-b", "main"], 'repos."owner/repo".branch'],
            [
                ["--max-decomposition-depth", "4"],
                "limits.maxDecompositionDepth",
            ],
            [["--issue-label", "bug"], "intake.requireLabels"],
            [["--issue-sort", "created"], "intake.sort"],
            [["--verify-command", "bun test"], 'repos."owner/repo".verify'],
            [
                ["--implementation-attempts", "2"],
                "limits.implementationAttempts",
            ],
            [["--workspace", "/tmp/w"], "workspace"],
        ];
        for (const [flag, key] of removed) {
            expect(() => parseCliArgs(["owner/repository", ...flag])).toThrow(
                key,
            );
        }
    });

    test("rejects malformed --set values", () => {
        for (const bad of ["limits.reviewRounds", "=3", "a..b=1"]) {
            expect(() =>
                parseCliArgs(["owner/repository", "--set", bad]),
            ).toThrow("--set");
        }
    });

    test("reserves the bare init argument", () => {
        expect(() => parseCliArgs(["init"])).toThrow("ralphie init");
    });

    test("rejects the removed halt policy flags", () => {
        for (const args of [
            ["owner/repository", "--on-needs-attention", "halt"],
            ["owner/repository", "--on-issue-failure", "continue"],
        ]) {
            expect(() => parseCliArgs(args)).toThrow();
        }
    });

    test("parses the temporary thinking level", () => {
        expect(
            parseCliArgs(["owner/repository", "--thinking", "high"]).options
                .thinking,
        ).toBe("high");
    });

    test("parses the opt-in notification flag and trims its label", () => {
        const options = parseCliArgs([
            "owner/repository",
            "--notify-needs-attention",
            "--needs-attention-label",
            "  blocked  ",
        ]).options;

        expect(options.notifyNeedsAttention).toBeTrue();
        expect(options.needsAttentionLabel).toBe("blocked");
    });

    test("rejects a needs-attention label without notification opt-in", () => {
        expect(() =>
            parseCliArgs([
                "owner/repository",
                "--needs-attention-label",
                "blocked",
            ]),
        ).toThrow(
            "Option --needs-attention-label requires --notify-needs-attention.",
        );
    });

    test("passes notification opt-in and label to the workflow", async () => {
        let workflowOptions: Record<string, unknown> | undefined;
        await runCommand(
            [
                "owner/repository",
                "--notify-needs-attention",
                "--needs-attention-label",
                "needs-attention",
            ],
            {
                factories: {
                    configSource: fakeConfigSource(),
                    githubLogin: fakeGitHubLogin(),
                    makeCoordinator: () => ({
                        progress: makeTestProgressRecorder([]),
                        sessionListener: () => {},
                        ready: Promise.resolve(),
                        dispose: async () => {},
                    }),
                    makeAgentRuntime: () => ({
                        start: async () => undefined as never,
                    }),
                    makeRuntime: () => ({}) as never,
                    runWorkflow: async (options) => {
                        workflowOptions = options as Record<string, unknown>;
                        return undefined as never;
                    },
                },
            },
        );

        expect(workflowOptions).toMatchObject({
            notificationsEnabled: true,
            needsAttentionLabel: "needs-attention",
        });
    });

    test("keeps sensitive values verbatim in wrapped command errors", async () => {
        process.env.GH_TOKEN = "private-auth-token";
        try {
            const failure = new RalphieError({
                message:
                    "Failed: Bearer private-value at https://example.test/api?token=query-secret; " +
                    "environment token private-auth-token leaked.",
            });
            const error = await runCommand(["owner/repository"], {
                factories: {
                    configSource: fakeConfigSource(),
                    githubLogin: fakeGitHubLogin(),
                    makeCoordinator: () => ({
                        progress: makeTestProgressRecorder([]),
                        sessionListener: () => {},
                        ready: Promise.resolve(),
                        dispose: async () => {},
                    }),
                    makeAgentRuntime: () => ({
                        start: async () => undefined as never,
                    }),
                    makeRuntime: () => ({}) as never,
                    runWorkflow: async () => {
                        throw failure;
                    },
                },
            }).then(
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
            const dir = await mkdtemp(join(tmpdir(), "ralphie-cli-"));
            const config = join(dir, "config.yaml");
            await writeFile(config, "{}\n");
            await runCli([
                "not-a-slug Bearer private-value",
                "--config",
                config,
            ]);
            await rm(dir, { recursive: true, force: true });
            const output = written.join("");
            expect(output).toContain("Bearer private-value");
            expect(process.exitCode).toBe(RalphieExitCode.Failure);
        } finally {
            process.stderr.write = originalWrite;
            process.exitCode = 0;
        }
    });

    test("rejects the removed mode and pipeline flags", () => {
        for (const args of [
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

    test("resolves a run from the config file, repos entry and --set", async () => {
        let workflowOptions: Record<string, unknown> | undefined;
        const configSource = fakeConfigSource({
            defaultOwner: "acme",
            intake: { requireLabels: ["bug"], sort: "updated:desc" },
            repos: {
                "acme/widgets": {
                    branch: "develop",
                    verify: ["bun run check"],
                    limits: { implementationAttempts: 2 },
                },
            },
        });
        await runCommand(
            [
                "widgets",
                "--config",
                "/etc/ralphie.yaml",
                "--set",
                "limits.implementationAttempts=4",
            ],
            {
                factories: {
                    configSource,
                    githubLogin: fakeGitHubLogin("someone-else"),
                    makeCoordinator: () => ({
                        progress: makeTestProgressRecorder([]),
                        sessionListener: () => {},
                        ready: Promise.resolve(),
                        dispose: async () => {},
                    }),
                    makeAgentRuntime: () => ({
                        start: async () => undefined as never,
                    }),
                    makeRuntime: () => ({}) as never,
                    runWorkflow: async (options) => {
                        workflowOptions = options as Record<string, unknown>;
                        return undefined as never;
                    },
                },
            },
        );

        expect(configSource.requested).toEqual(["/etc/ralphie.yaml"]);
        expect(workflowOptions).toMatchObject({
            repo: "acme/widgets",
            branch: "develop",
            verificationCommands: ["bun run check"],
            implementationAttempts: 4,
            issueFilters: { labels: ["bug"], sort: "updated", order: "desc" },
        });
    });

    test("fails before running when the config is invalid", async () => {
        let ran = false;
        const error = await runCommand(["owner/repository"], {
            factories: {
                configSource: fakeConfigSource({ limits: { reviewRoundz: 2 } }),
                githubLogin: fakeGitHubLogin(),
                runWorkflow: async () => {
                    ran = true;
                    return undefined as never;
                },
            },
        }).then(
            () => undefined,
            (caught: unknown) => caught as Error,
        );
        process.exitCode = 0;
        expect(error?.message).toContain("limits.reviewRoundz: unknown key");
        expect(ran).toBe(false);
    });

    test("prints help and version without reading any configuration", async () => {
        const configSource = fakeConfigSource();
        const written: string[] = [];
        const output = {
            stdout: (text: string) => void written.push(text),
            stderr: () => {},
        };
        const factories = { configSource, githubLogin: fakeGitHubLogin() };
        await runCommand(["--help"], { factories, output });
        await runCommand(["--version"], { factories, output });
        expect(configSource.requested).toEqual([]);
        expect(written.join("")).toContain("Usage: ralphie");
    });
});