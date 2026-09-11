import { describe, expect, test } from "bun:test";

import { runCli } from "../src/cli.ts";
import { HELP_TEXT, parseCliArgs, runCommand } from "../src/command.ts";
import { RalphieExitCode } from "../src/process/exit-code.ts";
import { RalphieError } from "../src/shared/error.ts";
import { IssueOrder, IssueSort } from "../src/github/issues.ts";
import { makeTestProgressRecorder } from "./shared/progress-recorder.ts";

describe("native CLI parser", () => {
    test("documents the issue workflow in help", () => {
        expect(HELP_TEXT).toContain("--thinking <level>");
        expect(HELP_TEXT).toContain("--implementation-attempts <n>");
        expect(HELP_TEXT).toContain("--max-decomposition-depth <n>");
        expect(HELP_TEXT).toContain("--notify-needs-attention");
        expect(HELP_TEXT).toContain("--needs-attention-label <name>");
        for (const removed of [
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

    test("parses positional repository, repeatable labels, flags, and values", () => {
        const parsed = parseCliArgs([
            "owner/repository",
            "--issue-label",
            "bug",
            "--issue-label=ready",
        ]);

        expect(parsed.help).toBe(false);
        expect(parsed.version).toBe(false);
        expect(parsed.options).toMatchObject({
            repo: "owner/repository",
            issueLabels: ["bug", "ready"],
        });
    });

    test("rejects the removed halt policy flags", () => {
        for (const args of [
            ["owner/repository", "--on-needs-attention", "halt"],
            ["owner/repository", "--on-issue-failure", "continue"],
        ]) {
            expect(() => parseCliArgs(args)).toThrow();
        }
    });

    test("parses the single thinking level and implementation controls", () => {
        const options = parseCliArgs([
            "owner/repository",
            "--thinking",
            "high",
            "--implementation-attempts",
            "4",
        ]).options;
        expect(options.thinking).toBe("high");
        expect(options.implementationAttempts).toBe(4);
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