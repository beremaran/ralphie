import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  IssueCompletionKind,
  IssueExecutionOutcomeKind,
} from "../../src/issues/execution.ts";
import {
  RUN_STATE_VERSION,
  RunStateStatus,
  RunStateStore,
  RunStateStoreLive,
  type RunState,
  type RunStateStoreService,
} from "../../src/run/state.ts";

const state: RunState = {
  version: RUN_STATE_VERSION,
  status: RunStateStatus.Active,
  runId: "run-1",
  repository: "owner/repo",
  branch: "main",
  selection: {
    agent: "build",
  },
  maxIssues: 3,
  queue: {
    pending: [
      {
        number: 2,
        title: "Next",
        url: "issue/2",
        body: null,
        labels: [],
      },
    ],
    completedIssueNumbers: [1],
    processedCount: 1,
  },
  outcomes: [
    {
      issueNumber: 1,
      outcome: {
        kind: IssueExecutionOutcomeKind.Completed,
        completion: IssueCompletionKind.PushedCommit,
        commitSha: "abc123",
      },
    },
  ],
  activeIssue: {
    issueNumber: 2,
    stage: "implementation",
  },
  updatedAt: "2026-08-24T00:00:00.000Z",
};

const withStore = <A, E>(effect: Effect.Effect<A, E, RunStateStoreService>) =>
  effect.pipe(Effect.provide(RunStateStoreLive));

describe("run state store", () => {
  test("atomically persists and validates complete run context", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ralphie-state-"));
    const path = join(directory, "nested", "state.json");
    try {
      const loaded = await withStore(
        Effect.gen(function* () {
          const store = yield* RunStateStore;
          yield* store.save(path, state);
          return yield* store.load(path);
        }),
      ).pipe(Effect.runPromise);

      expect(loaded).toEqual(state);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual(state);
    } finally {
      await rm(directory, {
        recursive: true,
        force: true,
      });
    }
  });

  test.each([
    ["corrupted JSON", "not-json"],
    [
      "incompatible version",
      JSON.stringify({
        ...state,
        version: 1,
      }),
    ],
    [
      "missing queue state",
      JSON.stringify({
        ...state,
        queue: undefined,
      }),
    ],
  ])("rejects %s", async (_label, content) => {
    const directory = await mkdtemp(join(tmpdir(), "ralphie-state-"));
    const path = join(directory, "state.json");
    try {
      await writeFile(path, content);
      const exit = await withStore(
        Effect.gen(function* () {
          const store = yield* RunStateStore;
          return yield* store.load(path);
        }),
      ).pipe(Effect.runPromiseExit);
      expect(Exit.isFailure(exit)).toBe(true);
    } finally {
      await rm(directory, {
        recursive: true,
        force: true,
      });
    }
  });

  test("migrates legacy completed outcomes to pushed-commit completions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ralphie-state-legacy-"));
    const path = join(directory, "state.json");
    try {
      const legacy = structuredClone(state) as unknown as {
        outcomes: Array<{
          outcome: Record<string, unknown>;
        }>;
      };
      delete legacy.outcomes[0]?.outcome.completion;
      await writeFile(path, JSON.stringify(legacy));

      const loaded = await withStore(
        Effect.gen(function* () {
          const store = yield* RunStateStore;
          return yield* store.load(path);
        }),
      ).pipe(Effect.runPromise);

      expect(loaded.outcomes[0]?.outcome).toMatchObject({
        kind: IssueExecutionOutcomeKind.Completed,
        completion: IssueCompletionKind.PushedCommit,
        commitSha: "abc123",
      });
    } finally {
      await rm(directory, {
        recursive: true,
        force: true,
      });
    }
  });

  test("does not replace good state when a new value fails validation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ralphie-state-"));
    const path = join(directory, "state.json");
    try {
      const exit = await withStore(
        Effect.gen(function* () {
          const store = yield* RunStateStore;
          yield* store.save(path, state);
          yield* store.save(path, {
            ...state,
            runId: "",
          });
        }),
      ).pipe(Effect.runPromiseExit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual(state);
    } finally {
      await rm(directory, {
        recursive: true,
        force: true,
      });
    }
  });
});