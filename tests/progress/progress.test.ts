import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    makeProgressReporter,
    type ProgressRenderMode,
    type ProgressStage,
    type ProgressStatus,
} from "../../src/progress/progress.ts";
import { cyan, dim, green, red, yellow } from "../../src/progress/colors.ts";

describe("progress reporting", () => {
    test("renders deterministic JSON Lines events", async () => {
        let output = "";
        const progress = makeProgressReporter({
            mode: "json",
            verbose: false,
            write: (text) => {
                output += text;
            },
            now: () => new Date("2026-08-24T01:02:03.000Z"),
            runId: "run-1",
        });
        await progress.emit({
            stage: "review",
            status: "started",
            message: "Reviewing changes...",
            repository: "owner/repo",
            issue: { number: 42, title: "Fix issue" },
            attempt: 1,
            maxAttempts: 5,
        });

        expect(JSON.parse(output)).toEqual({
            runId: "run-1",
            timestamp: "2026-08-24T01:02:03.000Z",
            stage: "review",
            status: "started",
            message: "Reviewing changes...",
            repository: "owner/repo",
            issue: { number: 42, title: "Fix issue" },
            attempt: 1,
            maxAttempts: 5,
        });
    });

    test("renders plain progress and optional verbose details", async () => {
        let output = "";
        const progress = makeProgressReporter({
            mode: "plain",
            verbose: true,
            write: (text) => {
                output += text;
            },
            runId: "run-1",
        });
        await progress.emit({
            stage: "issue-planning",
            status: "succeeded",
            message: "Issue prepared.",
            repository: "owner/repo",
            issue: { number: 42, title: "Fix issue" },
            current: 1,
            total: 3,
            details: { branch: "main" },
        });
        expect(output).toBe(
            `${green("✓")} ${dim("[owner/repo]")} ${dim("[1/3]")} ${cyan("#42")} Issue prepared. {"branch":"main"}\n`,
        );
    });

    test("renders needs-attention reason in default output and details in verbose output", async () => {
        let defaultOutput = "";
        const defaultProgress = makeProgressReporter({
            mode: "plain",
            verbose: false,
            colors: false,
            write: (text) => {
                defaultOutput += text;
            },
        });
        const update = {
            stage: "grounding" as const,
            status: "needs-attention" as const,
            message:
                "Issue #42 needs attention (missing_information): clarify the target.",
            issue: { number: 42, title: "Fix issue" },
            current: 1,
            total: 2,
            details: {
                reason: "missing_information",
                summary: "clarify the target.",
                evidence: ["The target is absent."],
                questions: ["Which target should be used?"],
                artifactPath: "/tmp/artifacts.json",
                policy: "halt",
            },
        };
        await defaultProgress.emit(update);
        expect(defaultOutput).toBe(
            "⚠ [1/2] #42 Issue #42 needs attention (missing_information): clarify the target.\n",
        );

        let verboseOutput = "";
        const verboseProgress = makeProgressReporter({
            mode: "plain",
            verbose: true,
            colors: false,
            write: (text) => {
                verboseOutput += text;
            },
        });
        await verboseProgress.emit(update);
        expect(verboseOutput).toContain('"evidence":["The target is absent."]');
        expect(verboseOutput).toContain(
            '"questions":["Which target should be used?"]',
        );
        expect(verboseOutput).toContain('"artifactPath":"/tmp/artifacts.json"');
        expect(verboseOutput).toContain('"policy":"halt"');

        let jsonOutput = "";
        const jsonProgress = makeProgressReporter({
            mode: "json",
            verbose: false,
            write: (text) => {
                jsonOutput += text;
            },
            runId: "run-needs-attention",
        });
        await jsonProgress.emit(update);
        expect(JSON.parse(jsonOutput)).toMatchObject({
            stage: "grounding",
            status: "needs-attention",
            details: update.details,
        });
    });

    test("renders nested interactive stages on one live line", async () => {
        let output = "";
        let second = 0;
        const progress = makeProgressReporter({
            mode: "interactive",
            verbose: false,
            colors: true,
            write: (text) => {
                output += text;
            },
            width: () => 80,
            now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, second++)),
            runId: "run-1",
        });
        const issue = { number: 42, title: "Fix issue" };
        await progress.emit({
            stage: "issue-execution",
            status: "started",
            message: "Working on issue...",
            issue,
        });
        await progress.emit({
            stage: "complexity-assessment",
            status: "started",
            message: "Assessing complexity...",
            issue,
        });
        await progress.emit({
            stage: "complexity-assessment",
            status: "succeeded",
            message: "Complexity assessed.",
            issue,
        });
        await progress.emit({
            stage: "issue-planning",
            status: "info",
            message: "Using implementation workflow.",
            issue,
        });
        await progress.emit({
            stage: "issue-execution",
            status: "succeeded",
            message: "Issue finished.",
            issue,
        });
        await progress.emit({
            stage: "push",
            status: "started",
            message: "Pushing...",
        });
        await progress.emit({
            stage: "push",
            status: "failed",
            message: "Push failed.",
        });
        await progress.emit({
            stage: "run",
            status: "failed",
            message: "Run failed.",
        });

        expect(output).toBe(
            `${yellow("◐")} ${cyan("#42")} Working on issue...` +
                `\r\x1b[2K${yellow("◐")} ${cyan("#42")} Assessing complexity...` +
                `\r\x1b[2K${green("✓")} ${cyan("#42")} Complexity assessed. ${dim("(1.0s)")}\n` +
                `${yellow("◐")} ${cyan("#42")} Working on issue...` +
                `\r\x1b[2K${cyan("•")} ${cyan("#42")} Using implementation workflow.\n` +
                `${yellow("◐")} ${cyan("#42")} Working on issue...` +
                `\r\x1b[2K${green("✓")} ${cyan("#42")} Issue finished. ${dim("(4.0s)")}\n` +
                `${yellow("◐")} Pushing...` +
                `\r\x1b[2K${red("✗")} Push failed. ${dim("(1.0s)")}\n` +
                `${red("✗")} Run failed.\n`,
        );
        expect(output).not.toContain("\x1b[H");
        expect(output).not.toContain("\x1b[J");
        expect(output).not.toContain("\x1b[?25l");
    });

    test("settles an interactive grounding line for needs attention", async () => {
        let output = "";
        let seconds = 0;
        const progress = makeProgressReporter({
            mode: "interactive",
            verbose: false,
            colors: false,
            write: (text) => {
                output += text;
            },
            now: () => new Date(2026, 0, 1, 0, 0, seconds++),
            runId: "run-1",
        });
        await progress.emit({
            stage: "grounding",
            status: "started",
            message: "Checking issue readiness...",
            issue: { number: 42, title: "Fix issue" },
        });
        await progress.emit({
            stage: "grounding",
            status: "needs-attention",
            message: "Issue #42 needs attention: clarify the target.",
            issue: { number: 42, title: "Fix issue" },
        });

        expect(output).toBe(
            "◐ #42 Checking issue readiness...\r\x1b[2K⚠ #42 Issue #42 needs attention: clarify the target. (1.0s)\n",
        );
    });

    test("clips an interactive live line before it can wrap", async () => {
        let output = "";
        const progress = makeProgressReporter({
            mode: "interactive",
            verbose: false,
            write: (text) => {
                output += text;
            },
            width: () => 24,
            runId: "run-1",
        });
        await progress.emit({
            stage: "repository-preparation",
            status: "started",
            message: "Preparing a repository with a very long name...",
        });
        expect(Bun.stringWidth(output)).toBeLessThanOrEqual(23);
        expect(output).toEndWith("…");
    });

    test("separates progress from a raw stream that ends mid-line", async () => {
        let output = "";
        const progress = makeProgressReporter({
            mode: "interactive",
            verbose: false,
            colors: false,
            write: (text) => {
                output += text;
            },
            runId: "run-1",
        });
        await progress.emit({
            stage: "implementation",
            status: "started",
            message: "Implementing...",
        });
        progress.writeRaw?.("partial token");
        await progress.emit({
            stage: "implementation",
            status: "info",
            message: "Still working.",
        });
        progress.writeRaw?.("next token");
        await progress.emit({
            stage: "review",
            status: "started",
            message: "Reviewing...",
        });

        expect(output).toBe(
            "◐ Implementing...\r\x1b[2Kpartial token\n" +
                "• Still working.\n" +
                "◐ Implementing...\r\x1b[2Knext token\n" +
                "◐ Reviewing...",
        );
    });

    test("quiet mode only emits failures", async () => {
        let output = "";
        const progress = makeProgressReporter({
            mode: "quiet",
            verbose: false,
            write: (text) => {
                output += text;
            },
            runId: "run-1",
        });
        await progress.emit({
            stage: "run",
            status: "succeeded",
            message: "Done.",
        });
        await progress.emit({
            stage: "grounding",
            status: "needs-attention",
            message: "Needs attention.",
        });
        await progress.emit({
            stage: "run",
            status: "failed",
            message: "Failed.",
        });
        expect(output).toBe("⚠ Needs attention.\n✗ Failed.\n");
    });

    test("redacts credentials from messages and nested JSON details", async () => {
        let output = "";
        const progress = makeProgressReporter({
            mode: "json",
            verbose: true,
            write: (text) => {
                output += text;
            },
            runId: "run-1",
        });
        await progress.emit({
            stage: "run",
            status: "failed",
            message: "Request failed with Bearer private-value",
            details: {
                githubToken: "private-value",
                nested: { password: "secret" },
            },
        });
        expect(output).not.toContain("private-value");
        expect(output).not.toContain('"secret"');
        expect(output).toContain("[REDACTED]");
    });

    test("redacts GitHub auth tokens from progress and event output", async () => {
        const token = "private-auth-token";
        const previous = process.env.GH_TOKEN;
        const directory = await mkdtemp(join(tmpdir(), "ralphie-auth-output-"));
        const eventLogPath = join(directory, "events.jsonl");
        let output = "";
        process.env.GH_TOKEN = token;
        try {
            const progress = makeProgressReporter({
                mode: "json",
                verbose: true,
                write: (text) => {
                    output += text;
                },
                eventLogPath,
            });
            await progress.emit({
                stage: "github-authentication",
                status: "failed",
                message: `Authentication failed: ${token}`,
                details: { stderr: token },
            });

            const events = await readFile(eventLogPath, "utf8");
            expect(output).not.toContain(token);
            expect(events).not.toContain(token);
        } finally {
            if (previous === undefined) delete process.env.GH_TOKEN;
            else process.env.GH_TOKEN = previous;
            await rm(directory, { recursive: true, force: true });
        }
    });

    test("persists redacted JSON Lines independently of the renderer", async () => {
        const directory = await mkdtemp(join(tmpdir(), "ralphie-progress-"));
        const eventLogPath = join(directory, "run", "events.jsonl");
        try {
            const progress = makeProgressReporter({
                mode: "quiet",
                verbose: false,
                write: () => undefined,
                now: () => new Date("2026-08-24T01:02:03.000Z"),
                runId: "run-durable",
                eventLogPath,
            });
            await progress.emit({
                stage: "commit",
                status: "succeeded",
                message: "Committed with Bearer private-value.",
                details: { commitSha: "abc123", token: "private-value" },
            });
            const events = (await readFile(eventLogPath, "utf8"))
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line));
            expect(events).toEqual([
                {
                    runId: "run-durable",
                    timestamp: "2026-08-24T01:02:03.000Z",
                    stage: "commit",
                    status: "succeeded",
                    message: "Committed with Bearer [REDACTED]",
                    details: { commitSha: "abc123", token: "[REDACTED]" },
                },
            ]);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test("keeps rendering without recreating storage after persistence stops", async () => {
        const directory = await mkdtemp(
            join(tmpdir(), "ralphie-progress-stop-"),
        );
        const runDirectory = join(directory, "run");
        const eventLogPath = join(runDirectory, "events.jsonl");
        let output = "";
        try {
            const progress = makeProgressReporter({
                mode: "json",
                verbose: false,
                write: (text) => {
                    output += text;
                },
                runId: "run-cleanup",
                eventLogPath,
            });
            await progress.emit({
                stage: "workspace-cleanup",
                status: "started",
                message: "Removing workspace...",
            });
            await progress.stopPersisting();
            await rm(runDirectory, { recursive: true, force: true });
            await progress.emit({
                stage: "workspace-cleanup",
                status: "succeeded",
                message: "Workspace removed.",
            });
            await progress.emit({
                stage: "run",
                status: "succeeded",
                message: "Run completed.",
            });
            expect(output).toContain("Removing workspace...");
            expect(output).toContain("Workspace removed.");
            expect(output).toContain("Run completed.");
            expect(await Bun.file(eventLogPath).exists()).toBeFalse();
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test("renders a representative non-interactive run as append-only lines", async () => {
        let output = "";
        const progress = makeProgressReporter({
            mode: "plain",
            verbose: false,
            colors: true,
            write: (text) => {
                output += text;
            },
            runId: "run-snapshot",
        });
        await progress.emit({
            stage: "run",
            status: "info",
            message: "Run started.",
        });
        await progress.emit({
            stage: "review",
            status: "started",
            message: "Reviewing changes...",
            issue: { number: 42, title: "Fix issue" },
            current: 1,
            total: 2,
            attempt: 2,
            maxAttempts: 5,
        });
        await progress.emit({
            stage: "review",
            status: "succeeded",
            message: "Review approved.",
            issue: { number: 42, title: "Fix issue" },
            current: 1,
            total: 2,
            attempt: 2,
            maxAttempts: 5,
        });
        await progress.emit({
            stage: "run",
            status: "succeeded",
            message: "Run completed.",
        });
        expect(output).toBe(
            `${cyan("•")} Run started.\n` +
                `${yellow("◐")} ${dim("[1/2]")} ${dim("(2/5)")} ${cyan("#42")} Reviewing changes...\n` +
                `${green("✓")} ${dim("[1/2]")} ${dim("(2/5)")} ${cyan("#42")} Review approved.\n` +
                `${green("✓")} Run completed.\n`,
        );
    });
});