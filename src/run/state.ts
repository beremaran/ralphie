import { Context, Effect, Layer } from "effect";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

import { IssueExecutionOutcomeKind } from "../issues/execution.ts";
import { RalphieError } from "../shared/error.ts";

export const RUN_STATE_VERSION = 1 as const;

export enum RunStateStatus {
  Active = "active",
  Complete = "complete",
}

const issueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  body: z.string().nullable(),
  labels: z.array(z.string()),
});

const outcomeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal(IssueExecutionOutcomeKind.Completed),
    commitSha: z.string().min(1),
  }),
  z.object({
    kind: z.literal(IssueExecutionOutcomeKind.Decomposed),
    childIssueNumbers: z.array(z.number().int().positive()),
  }),
  z.object({
    kind: z.literal(IssueExecutionOutcomeKind.Escalated),
    diagnosticsPath: z.string().min(1),
    reason: z.string().min(1),
  }),
  z.object({
    kind: z.literal(IssueExecutionOutcomeKind.Skipped),
    reason: z.string().min(1),
  }),
  z.object({
    kind: z.literal(IssueExecutionOutcomeKind.Failed),
    message: z.string().min(1),
  }),
]);

export const runStateSchema = z.object({
  version: z.literal(RUN_STATE_VERSION),
  status: z.enum(RunStateStatus),
  runId: z.string().min(1),
  repository: z.string().min(1),
  branch: z.string().min(1),
  selection: z.object({
    agent: z.string().min(1),
    model: z
      .object({ providerID: z.string().min(1), modelID: z.string().min(1) })
      .optional(),
    variant: z.string().min(1).optional(),
  }),
  maxIssues: z.number().int().positive().optional(),
  queue: z.object({
    pending: z.array(issueSchema),
    completedIssueNumbers: z.array(z.number().int().positive()),
    processedCount: z.number().int().nonnegative(),
  }),
  outcomes: z.array(
    z.object({ issueNumber: z.number().int().positive(), outcome: outcomeSchema }),
  ),
  activeIssue: z
    .object({ issueNumber: z.number().int().positive(), stage: z.string().min(1) })
    .optional(),
  checkout: z
    .object({ branch: z.string().min(1), head: z.string().min(1) })
    .optional(),
  updatedAt: z.string().datetime(),
});

export type RunState = z.infer<typeof runStateSchema>;

export type RunStateStoreService = {
  readonly save: (path: string, state: RunState) => Effect.Effect<void, RalphieError>;
  readonly load: (path: string) => Effect.Effect<RunState, RalphieError>;
};

export const RunStateStore = Context.GenericTag<RunStateStoreService>(
  "ralphie/RunStateStore",
);

export const RunStateStoreLive = Layer.succeed(RunStateStore, {
  save: (path, state) =>
    Effect.tryPromise({
      try: async () => {
        const validated = runStateSchema.parse(state);
        await mkdir(dirname(path), { recursive: true });
        const temporaryPath = `${path}.tmp-${crypto.randomUUID()}`;
        await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, {
          flag: "wx",
        });
        await rename(temporaryPath, path);
      },
      catch: (cause) =>
        new RalphieError({ message: `Failed to persist run state at ${path}.`, cause }),
    }),
  load: (path) =>
    Effect.tryPromise({
      try: async () => runStateSchema.parse(JSON.parse(await readFile(path, "utf8"))),
      catch: (cause) =>
        new RalphieError({ message: `Run state at ${path} is invalid or unreadable.`, cause }),
    }),
});
