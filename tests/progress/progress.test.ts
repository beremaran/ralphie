import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    makeProgressReporter,
    ProgressRenderMode,
    ProgressStage,
    ProgressStatus,
} from "../../src/progress/progress.ts";
import { cyan, dim, green, red, yellow } from "../../src/progress/colors.ts";

describe("progress reporting", () => {
    test("renders deterministic JSON Lines events", async () => {
        let output = "";
        const progress = makeProgressReporter({
            mode: ProgressRenderMode.Json,
            verbose: false,
            write: (text) => {
                output += text;
            },
            now: () => new Date("2026-08-24T01:02:03.000Z"),
            runId: "run-1",
        });
        await progress.emit({
            stage: ProgressStage.Review,
            status: ProgressStatus.Started,
            message: "Reviewing changes...",
            repository: "owner/repo",
            issue: { number: 42, title: "Fix issue" },
            attempt: 1,
            maxAttempts: 5,
        });

        expect(JSON.parse(output)).toEqual({
            runId: "run-1",
            timestamp: "2026-08-24T01:02:03.000Z",
            stage: ProgressStage.Review,
            status: ProgressStatus.Started,
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
            mode: ProgressRenderMode.Plain,
            verbose: true,
            write: (text) => {
                output += text;
            },
            runId: "run-1",
        });
        await progress.emit({
            stage: ProgressStage.IssuePlanning,
            status: ProgressStatus.Succeeded,
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

    test("renders nested interactive stages on one live line", async () => {
        let output = "";
        let second = 0;
        const progress = makeProgressReporter({
            mode: ProgressRenderMode.Interactive,
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
            stage: ProgressStage.IssueExecution,
            status: ProgressStatus.Started,
            message: "Working on issue...",
            issue,
        });
        await progress.emit({
            stage: ProgressStage.ComplexityAssessment,
            status: ProgressStatus.Started,
            message: "Assessing complexity...",
            issue,
        });
        await progress.emit({
            stage: ProgressStage.ComplexityAssessment,
            status: ProgressStatus.Succeeded,
            message: "Complexity assessed.",
            issue,
        });
        await progress.emit({
            stage: ProgressStage.IssuePlanning,
            status: ProgressStatus.Info,
            message: "Using implementation workflow.",
            issue,
        });
        await progress.emit({
            stage: ProgressStage.IssueExecution,
            status: ProgressStatus.Succeeded,
            message: "Issue finished.",
            issue,
        });
        await progress.emit({
            stage: ProgressStage.Push,
            status: ProgressStatus.Started,
            message: "Pushing...",
        });
        await progress.emit({
            stage: ProgressStage.Push,
            status: ProgressStatus.Failed,
            message: "Push failed.",
        });
        await progress.emit({
            stage: ProgressStage.Run,
            status: ProgressStatus.Failed,
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

    test("clips an interactive live line before it can wrap", async () => {
        let output = "";
        const progress = makeProgressReporter({
            mode: ProgressRenderMode.Interactive,
            verbose: false,
            write: (text) => {
                output += text;
            },
            width: () => 24,
            runId: "run-1",
        });
        await progress.emit({
            stage: ProgressStage.RepositoryPreparation,
            status: ProgressStatus.Started,
            message: "Preparing a repository with a very long name...",
        });
        expect(Bun.stringWidth(output)).toBeLessThanOrEqual(23);
        expect(output).toEndWith("…");
    });

    test("quiet mode only emits failures", async () => {
        let output = "";
        const progress = makeProgressReporter({
            mode: ProgressRenderMode.Quiet,
            verbose: false,
            write: (text) => {
                output += text;
            },
            runId: "run-1",
        });
        await progress.emit({
            stage: ProgressStage.Run,
            status: ProgressStatus.Succeeded,
            message: "Done.",
        });
        await progress.emit({
            stage: ProgressStage.Run,
            status: ProgressStatus.Failed,
            message: "Failed.",
        });
        expect(output).toBe("✗ Failed.\n");
    });

    test("redacts credentials from messages and nested JSON details", async () => {
        let output = "";
        const progress = makeProgressReporter({
            mode: ProgressRenderMode.Json,
            verbose: true,
            write: (text) => {
                output += text;
            },
            runId: "run-1",
        });
        await progress.emit({
            stage: ProgressStage.Run,
            status: ProgressStatus.Failed,
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

    test("persists redacted JSON Lines independently of the renderer", async () => {
        const directory = await mkdtemp(join(tmpdir(), "ralphie-progress-"));
        const eventLogPath = join(directory, "run", "events.jsonl");
        try {
            const progress = makeProgressReporter({
                mode: ProgressRenderMode.Quiet,
                verbose: false,
                write: () => undefined,
                now: () => new Date("2026-08-24T01:02:03.000Z"),
                runId: "run-durable",
                eventLogPath,
            });
            await progress.emit({
                stage: ProgressStage.Commit,
                status: ProgressStatus.Succeeded,
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
                    stage: ProgressStage.Commit,
                    status: ProgressStatus.Succeeded,
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
                mode: ProgressRenderMode.Json,
                verbose: false,
                write: (text) => {
                    output += text;
                },
                runId: "run-cleanup",
                eventLogPath,
            });
            await progress.emit({
                stage: ProgressStage.WorkspaceCleanup,
                status: ProgressStatus.Started,
                message: "Removing workspace...",
            });
            await progress.stopPersisting();
            await rm(runDirectory, { recursive: true, force: true });
            await progress.emit({
                stage: ProgressStage.WorkspaceCleanup,
                status: ProgressStatus.Succeeded,
                message: "Workspace removed.",
            });
            await progress.emit({
                stage: ProgressStage.Run,
                status: ProgressStatus.Succeeded,
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
            mode: ProgressRenderMode.Plain,
            verbose: false,
            colors: true,
            write: (text) => {
                output += text;
            },
            runId: "run-snapshot",
        });
        await progress.emit({
            stage: ProgressStage.Run,
            status: ProgressStatus.Info,
            message: "Run started.",
        });
        await progress.emit({
            stage: ProgressStage.Review,
            status: ProgressStatus.Started,
            message: "Reviewing changes...",
            issue: { number: 42, title: "Fix issue" },
            current: 1,
            total: 2,
            attempt: 2,
            maxAttempts: 5,
        });
        await progress.emit({
            stage: ProgressStage.Review,
            status: ProgressStatus.Succeeded,
            message: "Review approved.",
            issue: { number: 42, title: "Fix issue" },
            current: 1,
            total: 2,
            attempt: 2,
            maxAttempts: 5,
        });
        await progress.emit({
            stage: ProgressStage.Run,
            status: ProgressStatus.Succeeded,
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