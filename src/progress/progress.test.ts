import { describe, expect, test } from "bun:test";
import type { PromptSpinnerFactory } from "@bunli/core";
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
} from "./progress.ts";

const unusedSpinner = (() => {
  throw new Error("Spinner should not be used in this render mode.");
}) as PromptSpinnerFactory;

describe("progress reporting", () => {
  test("renders deterministic JSON Lines events", async () => {
    let output = "";
    const layer = makeProgressReporterLayer({
      mode: ProgressRenderMode.Json,
      verbose: false,
      spinner: unusedSpinner,
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
    }).pipe(Effect.provide(layer), Effect.runPromise);

    expect(JSON.parse(output)).toEqual({
      runId: "run-1",
      timestamp: "2026-08-24T01:02:03.000Z",
      stage: ProgressStage.Review,
      status: ProgressStatus.Started,
      message: "Reviewing changes...",
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
      spinner: unusedSpinner,
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
        issue: { number: 42, title: "Fix issue" },
        current: 1,
        total: 3,
        details: { branch: "main" },
      });
    }).pipe(Effect.provide(layer), Effect.runPromise);

    expect(output).toBe('✓ [1/3] #42 Issue prepared. {"branch":"main"}\n');
  });

  test("uses a spinner for interactive stage transitions", async () => {
    const calls: string[] = [];
    const spinner = (() => ({
      start: () => calls.push("start"),
      stop: () => calls.push("stop"),
      succeed: (text?: string) => calls.push(`succeed:${text}`),
      fail: (text?: string) => calls.push(`fail:${text}`),
      warn: (text?: string) => calls.push(`warn:${text}`),
      info: (text?: string) => calls.push(`info:${text}`),
      update: (text: string) => calls.push(`update:${text}`),
    })) as PromptSpinnerFactory;
    const layer = makeProgressReporterLayer({
      mode: ProgressRenderMode.Interactive,
      verbose: false,
      spinner,
      write: () => undefined,
      runId: "run-1",
    });

    await Effect.gen(function* () {
      const progress = yield* ProgressReporter;
      yield* progress.emit({
        stage: ProgressStage.GitVerification,
        status: ProgressStatus.Started,
        message: "Checking Git...",
      });
      yield* progress.emit({
        stage: ProgressStage.GitVerification,
        status: ProgressStatus.Succeeded,
        message: "Git verified.",
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
    }).pipe(Effect.provide(layer), Effect.runPromise);

    expect(calls).toEqual([
      "start",
      "succeed:✓ Git verified.",
      "start",
      "fail:✗ Push failed.",
    ]);
  });

  test("quiet mode only emits failures", async () => {
    let output = "";
    const layer = makeProgressReporterLayer({
      mode: ProgressRenderMode.Quiet,
      verbose: false,
      spinner: unusedSpinner,
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
      spinner: unusedSpinner,
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
        spinner: unusedSpinner,
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
        spinner: unusedSpinner,
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
      spinner: unusedSpinner,
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
