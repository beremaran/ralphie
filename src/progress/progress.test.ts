import { describe, expect, test } from "bun:test";
import type { PromptSpinnerFactory } from "@bunli/core";
import { Effect } from "effect";

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

    expect(output).toBe(
      '✓ [1/3] #42 Issue prepared. {"branch":"main"}\n',
    );
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
    }).pipe(Effect.provide(layer), Effect.runPromise);

    expect(calls).toEqual(["start", "succeed:✓ Git verified."]);
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
});
