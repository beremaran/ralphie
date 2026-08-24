import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  makeProgressReporterLayer,
  ProgressRenderMode,
  ProgressReporter,
  ProgressStage,
  ProgressStatus,
  withProgressContext,
} from "./progress.ts";

describe("progress reporting", () => {
  test("renders deterministic JSON Lines events", async () => {
    let output = "";
    const layer = makeProgressReporterLayer({
      mode: ProgressRenderMode.Json,
      verbose: false,
      write: (text) => {
        output += text;
      },
      now: () => new Date("2026-08-24T01:02:03.000Z"),
      runId: "run-1",
    });

    await Effect.gen(function* () {
      const progress = yield* ProgressReporter;
      yield* progress.emit({
        stage: ProgressStage.Review,
        status: ProgressStatus.Started,
        message: "Reviewing changes...",
        issue: { number: 42, title: "Fix issue" },
        attempt: 1,
        maxAttempts: 5,
      });
    }).pipe(
      (effect) =>
        withProgressContext(effect, {
          project: "project-a",
          repository: "owner/repo",
          repositoryRunId: "repository-run-1",
        }),
      Effect.provide(layer),
      Effect.runPromise,
    );

    expect(JSON.parse(output)).toEqual({
      runId: "run-1",
      timestamp: "2026-08-24T01:02:03.000Z",
      stage: ProgressStage.Review,
      status: ProgressStatus.Started,
      message: "Reviewing changes...",
      project: "project-a",
      repository: "owner/repo",
      repositoryRunId: "repository-run-1",
      issue: { number: 42, title: "Fix issue" },
      attempt: 1,
      maxAttempts: 5,
    });
  });

  test("renders plain progress and optional verbose details", async () => {
    let output = "";
    const layer = makeProgressReporterLayer({
      mode: ProgressRenderMode.Plain,
      verbose: true,
      write: (text) => {
        output += text;
      },
      runId: "run-1",
    });

    await Effect.gen(function* () {
      const progress = yield* ProgressReporter;
      yield* progress.emit({
        stage: ProgressStage.IssuePlanning,
        status: ProgressStatus.Succeeded,
        message: "Issue prepared.",
        repository: "owner/repo",
        issue: { number: 42, title: "Fix issue" },
        current: 1,
        total: 3,
        details: { branch: "main" },
      });
    }).pipe(Effect.provide(layer), Effect.runPromise);

    expect(output).toBe('✓ [owner/repo] [1/3] #42 Issue prepared. {"branch":"main"}\n');
  });

  test("renders nested interactive stages on one live line", async () => {
    let output = "";
    let second = 0;
    const layer = makeProgressReporterLayer({
      mode: ProgressRenderMode.Interactive,
      verbose: false,
      write: (text) => {
        output += text;
      },
      width: () => 80,
      now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, second++)),
      runId: "run-1",
    });

    await Effect.gen(function* () {
      const progress = yield* ProgressReporter;
      yield* progress.emit({
        stage: ProgressStage.IssueExecution,
        status: ProgressStatus.Started,
        message: "Working on issue...",
        issue: { number: 42, title: "Fix issue" },
      });
      yield* progress.emit({
        stage: ProgressStage.ComplexityAssessment,
        status: ProgressStatus.Started,
        message: "Assessing complexity...",
        issue: { number: 42, title: "Fix issue" },
      });
      yield* progress.emit({
        stage: ProgressStage.ComplexityAssessment,
        status: ProgressStatus.Succeeded,
        message: "Complexity assessed.",
        issue: { number: 42, title: "Fix issue" },
      });
      yield* progress.emit({
        stage: ProgressStage.IssuePlanning,
        status: ProgressStatus.Info,
        message: "Using implementation workflow.",
        issue: { number: 42, title: "Fix issue" },
      });
      yield* progress.emit({
        stage: ProgressStage.IssueExecution,
        status: ProgressStatus.Succeeded,
        message: "Issue finished.",
        issue: { number: 42, title: "Fix issue" },
      });
      yield* progress.emit({
        stage: ProgressStage.Push,
        status: ProgressStatus.Started,
        message: "Pushing...",
      });
      yield* progress.emit({
        stage: ProgressStage.Push,
        status: ProgressStatus.Failed,
        message: "Push failed.",
      });
      yield* progress.emit({
        stage: ProgressStage.Run,
        status: ProgressStatus.Failed,
        message: "Run failed.",
      });
    }).pipe(Effect.provide(layer), Effect.runPromise);

    expect(output).toBe(
      "◐ #42 Working on issue..." +
        "\r\x1b[2K◐ #42 Assessing complexity..." +
        "\r\x1b[2K✓ #42 Complexity assessed. (1.0s)\n" +
        "◐ #42 Working on issue..." +
        "\r\x1b[2K• #42 Using implementation workflow.\n" +
        "◐ #42 Working on issue..." +
        "\r\x1b[2K✓ #42 Issue finished. (4.0s)\n" +
        "◐ Pushing..." +
        "\r\x1b[2K✗ Push failed. (1.0s)\n" +
        "✗ Run failed.\n",
    );
    expect(output).not.toContain("\x1b[H");
    expect(output).not.toContain("\x1b[J");
    expect(output).not.toContain("\x1b[?25l");
  });

  test("clips an interactive live line before it can wrap", async () => {
    let output = "";
    const layer = makeProgressReporterLayer({
      mode: ProgressRenderMode.Interactive,
      verbose: false,
      write: (text) => {
        output += text;
      },
      width: () => 24,
      runId: "run-1",
    });

    await Effect.gen(function* () {
      const progress = yield* ProgressReporter;
      yield* progress.emit({
        stage: ProgressStage.RepositoryPreparation,
        status: ProgressStatus.Started,
        message: "Preparing a repository with a very long name...",
      });
    }).pipe(Effect.provide(layer), Effect.runPromise);

    expect(Bun.stringWidth(output)).toBeLessThanOrEqual(23);
    expect(output).toEndWith("…");
  });

  test("quiet mode only emits failures", async () => {
    let output = "";
    const layer = makeProgressReporterLayer({
      mode: ProgressRenderMode.Quiet,
      verbose: false,
      write: (text) => {
        output += text;
      },
      runId: "run-1",
    });

    await Effect.gen(function* () {
      const progress = yield* ProgressReporter;
      yield* progress.emit({
        stage: ProgressStage.Run,
        status: ProgressStatus.Succeeded,
        message: "Done.",
      });
      yield* progress.emit({
        stage: ProgressStage.Run,
        status: ProgressStatus.Failed,
        message: "Failed.",
      });
    }).pipe(Effect.provide(layer), Effect.runPromise);

    expect(output).toBe("✗ Failed.\n");
  });

  test("redacts credentials from messages and nested JSON details", async () => {
    let output = "";
    const layer = makeProgressReporterLayer({
      mode: ProgressRenderMode.Json,
      verbose: true,
      write: (text) => {
        output += text;
      },
      runId: "run-1",
    });

    await Effect.gen(function* () {
      const progress = yield* ProgressReporter;
      yield* progress.emit({
        stage: ProgressStage.Run,
        status: ProgressStatus.Failed,
        message: "Request failed with Bearer private-value",
        details: { githubToken: "private-value", nested: { password: "secret" } },
      });
    }).pipe(Effect.provide(layer), Effect.runPromise);

    expect(output).not.toContain("private-value");
    expect(output).not.toContain('"secret"');
    expect(output).toContain("[REDACTED]");
  });

  test("persists redacted JSON Lines independently of the renderer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ralphie-progress-"));
    const eventLogPath = join(directory, "run", "events.jsonl");
    try {
      const layer = makeProgressReporterLayer({
        mode: ProgressRenderMode.Quiet,
        verbose: false,
        write: () => undefined,
        now: () => new Date("2026-08-24T01:02:03.000Z"),
        runId: "run-durable",
        eventLogPath,
      });

      await Effect.gen(function* () {
        const progress = yield* ProgressReporter;
        yield* progress.emit({
          stage: ProgressStage.Commit,
          status: ProgressStatus.Succeeded,
          message: "Committed with Bearer private-value.",
          details: { commitSha: "abc123", token: "private-value" },
        });
      }).pipe(Effect.provide(layer), Effect.runPromise);

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
    const directory = await mkdtemp(join(tmpdir(), "ralphie-progress-stop-"));
    const runDirectory = join(directory, "run");
    const eventLogPath = join(runDirectory, "events.jsonl");
    let output = "";
    try {
      const layer = makeProgressReporterLayer({
        mode: ProgressRenderMode.Json,
        verbose: false,
        write: (text) => {
          output += text;
        },
        runId: "run-cleanup",
        eventLogPath,
      });

      await Effect.gen(function* () {
        const progress = yield* ProgressReporter;
        yield* progress.emit({
          stage: ProgressStage.WorkspaceCleanup,
          status: ProgressStatus.Started,
          message: "Removing workspace...",
        });
        yield* progress.stopPersisting;
        yield* Effect.promise(() => rm(runDirectory, { recursive: true, force: true }));
        yield* progress.emit({
          stage: ProgressStage.WorkspaceCleanup,
          status: ProgressStatus.Succeeded,
          message: "Workspace removed.",
        });
        yield* progress.emit({
          stage: ProgressStage.Run,
          status: ProgressStatus.Succeeded,
          message: "Run completed.",
        });
      }).pipe(Effect.provide(layer), Effect.runPromise);

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
    const layer = makeProgressReporterLayer({
      mode: ProgressRenderMode.Plain,
      verbose: false,
      write: (text) => {
        output += text;
      },
      runId: "run-snapshot",
    });

    await Effect.gen(function* () {
      const progress = yield* ProgressReporter;
      yield* progress.emit({
        stage: ProgressStage.Run,
        status: ProgressStatus.Info,
        message: "Run started.",
      });
      yield* progress.emit({
        stage: ProgressStage.Review,
        status: ProgressStatus.Started,
        message: "Reviewing changes...",
        issue: { number: 42, title: "Fix issue" },
        current: 1,
        total: 2,
        attempt: 2,
        maxAttempts: 5,
      });
      yield* progress.emit({
        stage: ProgressStage.Review,
        status: ProgressStatus.Succeeded,
        message: "Review approved.",
        issue: { number: 42, title: "Fix issue" },
        current: 1,
        total: 2,
        attempt: 2,
        maxAttempts: 5,
      });
      yield* progress.emit({
        stage: ProgressStage.Run,
        status: ProgressStatus.Succeeded,
        message: "Run completed.",
      });
    }).pipe(Effect.provide(layer), Effect.runPromise);

    expect(output).toBe(
      "• Run started.\n" +
        "◐ [1/2] (2/5) #42 Reviewing changes...\n" +
        "✓ [1/2] (2/5) #42 Review approved.\n" +
        "✓ Run completed.\n",
    );
  });
});
