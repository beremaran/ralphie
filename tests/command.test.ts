import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runCli } from "../src/cli.ts";
import { HELP_TEXT, parseCliArgs, runCommand } from "../src/command.ts";
import { RalphieExitCode } from "../src/process/exit-code.ts";
import { RalphieError } from "../src/shared/error.ts";
import { IssueFailurePolicy, NeedsAttentionPolicy } from "../src/options.ts";
import { IssueOrder, IssueSort } from "../src/github/issues.ts";
import { RUN_STATE_VERSION, RunStateStatus } from "../src/run/state.ts";
import { makeTestProgressRecorder } from "./shared/progress-recorder.ts";

describe("native CLI parser", () => {
    test("documents the issue workflow in help", () => {
        expect(HELP_TEXT).toContain("--on-needs-attention <halt|continue>");
        expect(HELP_TEXT).toContain("--on-issue-failure <halt|continue>");
        expect(HELP_TEXT).toContain("--thinking <level>");
        expect(HELP_TEXT).toContain("--implementation-attempts <n>");
        expect(HELP_TEXT).toContain("--implementation-fallback-model");
        expect(HELP_TEXT).toContain("--max-decomposition-depth <n>");
        expect(HELP_TEXT).toContain("--notify-needs-attention");
        expect(HELP_TEXT).toContain("--needs-attention-label <name>");
        expect(HELP_TEXT).toContain("default halt");
        expect(HELP_TEXT).not.toContain("maintain-issues");
        expect(HELP_TEXT).not.toContain("get-pipelines-green");
    });

    test("parses positional repository, repeatable labels, flags, and values", () => {
        const parsed = parseCliArgs([
            "owner/repository",
            "--issue-label",
            "bug",
            "--issue-label=ready",
            "--max-issues",
            "3",
            "--dry-run",
        ]);

        expect(parsed.help).toBe(false);
        expect(parsed.version).toBe(false);
        expect(parsed.options).toMatchObject({
            repo: "owner/repository",
            issueLabels: ["bug", "ready"],
            maxIssues: 3,
            dryRun: true,
        });
    });

    test("parses and validates the needs-attention policy", () => {
        expect(
            parseCliArgs(["owner/repository"]).options.onNeedsAttention,
        ).toBeUndefined();
        expect(
            parseCliArgs(["owner/repository", "--on-needs-attention", "halt"])
                .options.onNeedsAttention,
        ).toBe(NeedsAttentionPolicy.Halt);
        expect(
            parseCliArgs([
                "owner/repository",
                "--on-needs-attention",
                "continue",
            ]).options.onNeedsAttention,
        ).toBe(NeedsAttentionPolicy.Continue);
        expect(() =>
            parseCliArgs(["owner/repository", "--on-needs-attention", "retry"]),
        ).toThrow();
    });

    test("parses and validates the ordinary issue failure policy", () => {
        expect(
            parseCliArgs(["owner/repository"]).options.onIssueFailure,
        ).toBeUndefined();
        expect(
            parseCliArgs(["owner/repository", "--on-issue-failure", "continue"])
                .options.onIssueFailure,
        ).toBe(IssueFailurePolicy.Continue);
        expect(() =>
            parseCliArgs(["owner/repository", "--on-issue-failure", "retry"]),
        ).toThrow();
    });

    test("parses the single thinking level and implementation controls", () => {
        const options = parseCliArgs([
            "owner/repository",
            "--thinking",
            "high",
            "--implementation-attempts",
            "4",
            "--implementation-fallback-model",
            "openai/gpt-5.6-sol",
        ]).options;
        expect(options.thinking).toBe("high");
        expect(options.implementationAttempts).toBe(4);
        expect(options.implementationFallbackModel).toEqual({
            providerID: "openai",
            modelID: "gpt-5.6-sol",
        });
        expect(() =>
            parseCliArgs([
                "owner/repository",
                "--implementation-attempts",
                "0",
            ]),
        ).toThrow();
    });

    test("parses and validates the maximum decomposition depth", () => {
        expect(
            parseCliArgs(["owner/repository", "--max-decomposition-depth", "6"])
                .options.maxDecompositionDepth,
        ).toBe(6);
        expect(() =>
            parseCliArgs([
                "owner/repository",
                "--max-decomposition-depth",
                "0",
            ]),
        ).toThrow();
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

    test("rejects a conflicting resume policy before creating runtime resources", async () => {
        const directory = await mkdtemp(join(tmpdir(), "ralphie-command-"));
        const path = join(directory, "state.json");
        const sideEffects: string[] = [];
        try {
            await writeFile(
                path,
                JSON.stringify({
                    version: RUN_STATE_VERSION,
                    status: RunStateStatus.Active,
                    runId: "run-1",
                    repository: "owner/repository",
                    branch: "main",
                    onNeedsAttention: NeedsAttentionPolicy.Continue,
                    selection: { agent: "build" },
                    queue: {
                        pending: [],
                        completedIssueNumbers: [],
                        processedCount: 0,
                    },
                    outcomes: [],
                    updatedAt: "2026-08-24T00:00:00.000Z",
                }),
            );
            await expect(
                runCommand(
                    [
                        "owner/repository",
                        "--resume",
                        path,
                        "--on-needs-attention",
                        "halt",
                    ],
                    {
                        factories: {
                            makeCoordinator: () => {
                                sideEffects.push("coordinator");
                                throw new Error("unexpected side effect");
                            },
                        },
                    },
                ),
            ).rejects.toThrow("saved on-needs-attention policy is continue");
            expect(sideEffects).toEqual([]);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test("passes saved notification intent and label through resume", async () => {
        const directory = await mkdtemp(join(tmpdir(), "ralphie-command-"));
        const path = join(directory, "state.json");
        let workflowOptions: Record<string, unknown> | undefined;
        try {
            await writeFile(
                path,
                JSON.stringify({
                    version: RUN_STATE_VERSION,
                    status: RunStateStatus.Active,
                    runId: "run-notification-resume",
                    repository: "owner/repository",
                    branch: "main",
                    onNeedsAttention: NeedsAttentionPolicy.Halt,
                    notificationsEnabled: true,
                    needsAttentionLabel: "saved-label",
                    selection: { agent: "build" },
                    queue: {
                        pending: [],
                        completedIssueNumbers: [],
                        processedCount: 0,
                    },
                    outcomes: [],
                    updatedAt: "2026-08-24T00:00:00.000Z",
                }),
            );

            await runCommand(["owner/repository", "--resume", path], {
                factories: {
                    makeCoordinator: () => ({
                        progress: makeTestProgressRecorder([]),
                        piListener: () => {},
                        getDisplayState: () => ({}) as never,
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
            });

            expect(workflowOptions).toMatchObject({
                onNeedsAttention: NeedsAttentionPolicy.Halt,
                notificationsEnabled: true,
                needsAttentionLabel: "saved-label",
            });
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
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
                    makeCoordinator: () => ({
                        progress: makeTestProgressRecorder([]),
                        piListener: () => {},
                        getDisplayState: () => ({}) as never,
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
        const directory = await mkdtemp(join(tmpdir(), "ralphie-command-"));
        const path = join(directory, "state.json");
        const originalWrite = process.stderr.write.bind(process.stderr);
        const written: string[] = [];
        try {
            await writeFile(
                path,
                JSON.stringify({
                    version: RUN_STATE_VERSION,
                    status: RunStateStatus.Active,
                    runId: "Bearer private-value",
                    repository: "owner/repository",
                    branch: "main",
                    onNeedsAttention: NeedsAttentionPolicy.Continue,
                    selection: { agent: "build" },
                    queue: {
                        pending: [],
                        completedIssueNumbers: [],
                        processedCount: 0,
                    },
                    outcomes: [],
                    updatedAt: "2026-08-24T00:00:00.000Z",
                }),
            );
            process.stderr.write = ((text: string) => {
                written.push(text);
                return true;
            }) as typeof process.stderr.write;
            process.exitCode = 0;
            await runCli([
                "owner/repository",
                "--resume",
                path,
                "--on-needs-attention",
                "halt",
            ]);
            const output = written.join("");
            expect(output).toContain("Cannot resume run Bearer private-value");
            expect(process.exitCode).toBe(RalphieExitCode.Failure);
        } finally {
            process.stderr.write = originalWrite;
            process.exitCode = 0;
            await rm(directory, { recursive: true, force: true });
        }
    });

    test("rejects the removed mode and pipeline flags", () => {
        for (const args of [
            ["owner/repository", "--mode", "issues"],
            ["owner/repository", "--max-attempts", "2"],
            ["owner/repository", "--pipeline-timeout", "10m"],
            ["owner/repository", "--duplicate-action", "close"],
        ]) {
            expect(() => parseCliArgs(args)).toThrow();
        }
    });

    test("parses compound issue sort and validates enums", () => {
        expect(
            parseCliArgs(["owner/repository", "--issue-sort", "updated:desc"])
                .options,
        ).toMatchObject({
            issueSort: IssueSort.Updated,
            issueOrder: IssueOrder.Descending,
        });
        expect(
            parseCliArgs(["owner/repository", "--issue-sort", "created"])
                .options,
        ).toMatchObject({
            issueSort: IssueSort.Created,
            issueOrder: IssueOrder.Ascending,
        });
        expect(() =>
            parseCliArgs(["owner/repository", "--issue-sort", "invalid"]),
        ).toThrow();
        expect(() =>
            parseCliArgs([
                "owner/repository",
                "--issue-sort",
                "created:sideways",
            ]),
        ).toThrow();
        expect(String(IssueSort.Created)).toBe("created");
        expect(String(IssueOrder.Ascending)).toBe("asc");
    });

    test("parses clean and every supported output mode", () => {
        expect(
            parseCliArgs(["owner/repository", "--clean", "both"]).options,
        ).toMatchObject({
            clean: "both",
            verbose: false,
            json: false,
            quiet: false,
        });
        expect(parseCliArgs(["owner/repository"]).options).toMatchObject({
            verbose: false,
            json: false,
            quiet: false,
        });
        expect(
            parseCliArgs(["owner/repository", "--output", "default"]).options,
        ).toMatchObject({ verbose: false, json: false, quiet: false });
        expect(
            parseCliArgs(["owner/repository", "--output", "verbose"]).options,
        ).toMatchObject({ verbose: true, json: false, quiet: false });
        expect(
            parseCliArgs(["owner/repository", "--output", "json"]).options,
        ).toMatchObject({ verbose: false, json: true, quiet: false });
        expect(
            parseCliArgs(["owner/repository", "--output", "quiet"]).options,
        ).toMatchObject({ verbose: false, json: false, quiet: true });
        expect(() =>
            parseCliArgs(["owner/repository", "--clean", "sometimes"]),
        ).toThrow();
        expect(() =>
            parseCliArgs(["owner/repository", "--output", "trace"]),
        ).toThrow();
    });
});