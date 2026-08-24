import { Context, Effect, Layer } from "effect";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

import type { IssueCheckpoint } from "../git/issue-checkpoint.ts";
import { RalphieError } from "../shared/error.ts";
import { resolveWorkspacePath } from "../workspace/workspace.ts";
import {
  commitMessageDecisionSchema,
  complexityDecisionSchema,
  issueBreakdownDecisionSchema,
  issueResolutionDecisionSchema,
  reviewDecisionSchema,
  type CommitMessageDecision,
  type ComplexityDecision,
  type IssueBreakdownDecision,
  type IssueResolutionDecision,
} from "./decisions.ts";
import type { ReviewAttempt } from "./recovery.ts";
import { REVIEW_ITERATION_LIMIT } from "./stage.ts";

export enum IssueArtifactKind {
  ComplexityDecision = "complexity-decision",
  IssueCheckpoint = "issue-checkpoint",
  ReviewAttempts = "review-attempts",
  CommitMessageDecision = "commit-message-decision",
  CreatedCommit = "created-commit",
  IssueResolutionDecision = "issue-resolution-decision",
  IssueBreakdownDecision = "issue-breakdown-decision",
  CreatedIssueNumbers = "created-issue-numbers",
}

export type CreatedIssueNumberMapping = Readonly<Record<string, number>>;

export type IssueArtifactValues = {
  readonly [IssueArtifactKind.ComplexityDecision]: ComplexityDecision;
  readonly [IssueArtifactKind.IssueCheckpoint]: IssueCheckpoint;
  readonly [IssueArtifactKind.ReviewAttempts]: ReadonlyArray<ReviewAttempt>;
  readonly [IssueArtifactKind.CommitMessageDecision]: CommitMessageDecision;
  readonly [IssueArtifactKind.CreatedCommit]: {
    readonly sha: string;
    readonly treeSha: string;
  };
  readonly [IssueArtifactKind.IssueResolutionDecision]: IssueResolutionDecision;
  readonly [IssueArtifactKind.IssueBreakdownDecision]: IssueBreakdownDecision;
  readonly [IssueArtifactKind.CreatedIssueNumbers]: CreatedIssueNumberMapping;
};

export type IssueArtifactStore = {
  readonly issueNumber: number;
  readonly write: <K extends IssueArtifactKind>(
    kind: K,
    value: IssueArtifactValues[K],
  ) => Effect.Effect<void, RalphieError>;
  readonly read: <K extends IssueArtifactKind>(
    kind: K,
  ) => Effect.Effect<IssueArtifactValues[K], RalphieError>;
  readonly has: (kind: IssueArtifactKind) => boolean;
  readonly appendReview: (review: ReviewAttempt) => Effect.Effect<void, RalphieError>;
  readonly recordCreatedIssue: (
    key: string,
    issueNumber: number,
  ) => Effect.Effect<void, RalphieError>;
  /** Drop artifacts from an interrupted implementation attempt after checkout restore. */
  readonly resetImplementationAttempt: () => Effect.Effect<void, RalphieError>;
};

export type IssueArtifactScope = {
  readonly workspace: string;
  readonly runId: string;
};

export type IssueArtifactStoreService = {
  readonly forIssue: (
    issueNumber: number,
    scope?: IssueArtifactScope,
  ) => Effect.Effect<IssueArtifactStore, RalphieError>;
};

export const IssueArtifactStore = Context.GenericTag<IssueArtifactStoreService>(
  "ralphie/IssueArtifactStore",
);

const failure = (message: string): Effect.Effect<never, RalphieError> =>
  Effect.fail(new RalphieError({ message }));

const validIssueNumber = (issueNumber: number): boolean =>
  Number.isInteger(issueNumber) && issueNumber > 0;

const validReviewOrder = (reviews: ReadonlyArray<ReviewAttempt>): boolean =>
  reviews.length <= REVIEW_ITERATION_LIMIT &&
  reviews.every((review, index) => review.attempt === index + 1);

const validCreatedIssueNumberMapping = (mapping: CreatedIssueNumberMapping): boolean =>
  Object.entries(mapping).every(
    ([key, issueNumber]) => key.trim().length > 0 && validIssueNumber(issueNumber),
  );

const reviewAttemptSchema = z.object({
  attempt: z.number().int().positive(),
  sessionID: z.string().min(1),
  decision: reviewDecisionSchema,
});

const issueCheckpointSchema = z.object({
  branch: z.string().min(1),
  sha: z.string().min(1),
});

const persistedArtifactsSchema = z
  .object({
    [IssueArtifactKind.ComplexityDecision]: complexityDecisionSchema.optional(),
    [IssueArtifactKind.IssueCheckpoint]: issueCheckpointSchema.optional(),
    [IssueArtifactKind.ReviewAttempts]: z
      .array(reviewAttemptSchema)
      .max(REVIEW_ITERATION_LIMIT)
      .optional(),
    [IssueArtifactKind.CommitMessageDecision]: commitMessageDecisionSchema.optional(),
    [IssueArtifactKind.CreatedCommit]: z
      .object({ sha: z.string().min(1), treeSha: z.string().min(1) })
      .optional(),
    [IssueArtifactKind.IssueResolutionDecision]:
      issueResolutionDecisionSchema.optional(),
    [IssueArtifactKind.IssueBreakdownDecision]: issueBreakdownDecisionSchema.optional(),
    [IssueArtifactKind.CreatedIssueNumbers]: z
      .record(z.string(), z.number().int().positive())
      .optional(),
  })
  .strict();

const persistedArtifactStateSchema = z
  .object({
    version: z.literal(1),
    issueNumber: z.number().int().positive(),
    artifacts: persistedArtifactsSchema,
  })
  .strict();

type PersistedArtifactState = z.infer<typeof persistedArtifactStateSchema>;
type ArtifactPersistence = (
  state: PersistedArtifactState,
) => Effect.Effect<void, RalphieError>;

const safeRunId = (runId: string): string =>
  runId.replace(/[^a-zA-Z0-9_-]/g, "_") || "run";

const artifactPath = (scope: IssueArtifactScope, issueNumber: number): string =>
  join(
    resolveWorkspacePath(scope.workspace),
    ".ralphie",
    "runs",
    safeRunId(scope.runId),
    "issues",
    String(issueNumber),
    "artifacts.json",
  );

const toPersistedState = (
  issueNumber: number,
  values: ReadonlyMap<IssueArtifactKind, unknown>,
): PersistedArtifactState => {
  const artifacts: Record<string, unknown> = {};
  for (const kind of Object.values(IssueArtifactKind)) {
    const value = values.get(kind);
    if (value !== undefined) artifacts[kind] = value;
  }
  return persistedArtifactStateSchema.parse({
    version: 1,
    issueNumber,
    artifacts,
  });
};

const persistAtomically = (
  filePath: string,
  state: PersistedArtifactState,
): Effect.Effect<void, RalphieError> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
          encoding: "utf8",
          flag: "wx",
        });
        await rename(temporaryPath, filePath);
      } catch (cause) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw cause;
      }
    },
    catch: (cause) =>
      new RalphieError({
        message: `Failed to persist issue artifacts at ${filePath}.`,
        cause,
      }),
  });

const loadPersistedState = (
  filePath: string,
  issueNumber: number,
): Effect.Effect<PersistedArtifactState | undefined, RalphieError> =>
  Effect.tryPromise({
    try: async () => {
      let encoded: string;
      try {
        encoded = await readFile(filePath, "utf8");
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw cause;
      }
      const parsed = persistedArtifactStateSchema.parse(JSON.parse(encoded));
      if (parsed.issueNumber !== issueNumber) {
        throw new RalphieError({
          message: `Persisted artifacts at ${filePath} belong to issue ${parsed.issueNumber}, not issue ${issueNumber}.`,
        });
      }
      return parsed;
    },
    catch: (cause) =>
      cause instanceof RalphieError
        ? cause
        : new RalphieError({
            message: `Failed to load issue artifacts at ${filePath}.`,
            cause,
          }),
  });

const makeStore = (
  issueNumber: number,
  initialValues = new Map<IssueArtifactKind, unknown>(),
  persistence?: ArtifactPersistence,
): Effect.Effect<IssueArtifactStore, RalphieError> => {
  const values = initialValues;
  const save = (nextValues: ReadonlyMap<IssueArtifactKind, unknown>) => {
    if (!persistence) {
      values.clear();
      for (const [kind, value] of nextValues) values.set(kind, value);
      return Effect.void;
    }
    return Effect.gen(function* () {
      const state = toPersistedState(issueNumber, nextValues);
      yield* persistence(state);
      values.clear();
      for (const [kind, value] of nextValues) values.set(kind, value);
    });
  };

  const store: IssueArtifactStore = {
    issueNumber,
    write: (kind, value) => {
      if (values.has(kind)) {
        return failure(
          `Artifact ${kind} has already been produced for issue ${issueNumber}.`,
        );
      }
      if (
        kind === IssueArtifactKind.ReviewAttempts &&
        !validReviewOrder(value as ReadonlyArray<ReviewAttempt>)
      ) {
        return failure(
          `Review attempts for issue ${issueNumber} must be ordered from 1 through ${REVIEW_ITERATION_LIMIT}.`,
        );
      }
      if (
        kind === IssueArtifactKind.CreatedIssueNumbers &&
        !validCreatedIssueNumberMapping(value as CreatedIssueNumberMapping)
      ) {
        return failure(
          `Created issue numbers for issue ${issueNumber} must use non-empty keys and positive issue numbers.`,
        );
      }
      const nextValues = new Map(values);
      nextValues.set(kind, value);
      return save(nextValues);
    },
    read: (kind) => {
      const value = values.get(kind);
      return value === undefined
        ? failure(`Artifact ${kind} has not been produced for issue ${issueNumber}.`)
        : Effect.succeed(value as IssueArtifactValues[typeof kind]);
    },
    has: (kind) => values.has(kind),
    appendReview: (review) => {
      if (!review || !Number.isInteger(review.attempt)) {
        return failure(`Invalid review attempt for issue ${issueNumber}.`);
      }
      const existing = (values.get(IssueArtifactKind.ReviewAttempts) ??
        []) as ReadonlyArray<ReviewAttempt>;
      if (review.attempt !== existing.length + 1) {
        return failure(
          `Review attempts for issue ${issueNumber} must be appended in order; expected attempt ${existing.length + 1}.`,
        );
      }
      if (existing.length >= REVIEW_ITERATION_LIMIT) {
        return failure(`Review attempt budget exhausted for issue ${issueNumber}.`);
      }
      const nextValues = new Map(values);
      nextValues.set(IssueArtifactKind.ReviewAttempts, [...existing, review]);
      return save(nextValues);
    },
    recordCreatedIssue: (key, createdIssueNumber) => {
      if (key.trim().length === 0 || !validIssueNumber(createdIssueNumber)) {
        return failure(
          `Created issue mapping for issue ${issueNumber} requires a non-empty key and positive issue number.`,
        );
      }
      const existing = (values.get(IssueArtifactKind.CreatedIssueNumbers) ??
        {}) as CreatedIssueNumberMapping;
      if (existing[key] !== undefined) {
        return failure(
          `Created issue mapping already contains key ${key} for issue ${issueNumber}.`,
        );
      }
      const nextValues = new Map(values);
      nextValues.set(IssueArtifactKind.CreatedIssueNumbers, {
        ...existing,
        [key]: createdIssueNumber,
      });
      return save(nextValues);
    },
    resetImplementationAttempt: () => {
      const nextValues = new Map(values);
      nextValues.delete(IssueArtifactKind.ReviewAttempts);
      nextValues.delete(IssueArtifactKind.CommitMessageDecision);
      nextValues.delete(IssueArtifactKind.CreatedCommit);
      nextValues.delete(IssueArtifactKind.IssueResolutionDecision);
      return save(nextValues);
    },
  };

  return Effect.succeed(store);
};

export const makeIssueArtifactStore = (
  issueNumber: number,
): Effect.Effect<IssueArtifactStore, RalphieError> => {
  if (!validIssueNumber(issueNumber)) {
    return failure(`Cannot create an artifact store for issue ${issueNumber}.`);
  }
  return makeStore(issueNumber);
};

export const makeDurableIssueArtifactStore = (
  issueNumber: number,
  scope: IssueArtifactScope,
): Effect.Effect<IssueArtifactStore, RalphieError> => {
  if (!validIssueNumber(issueNumber)) {
    return failure(`Cannot create an artifact store for issue ${issueNumber}.`);
  }
  const filePath = artifactPath(scope, issueNumber);
  return loadPersistedState(filePath, issueNumber).pipe(
    Effect.flatMap((state) => {
      const values = new Map<IssueArtifactKind, unknown>();
      if (state) {
        for (const kind of Object.values(IssueArtifactKind)) {
          const value = state.artifacts[kind];
          if (value !== undefined) values.set(kind, value);
        }
      }
      return makeStore(issueNumber, values, (nextState) =>
        persistAtomically(filePath, nextState),
      );
    }),
  );
};

export const IssueArtifactStoreLive = Layer.effect(
  IssueArtifactStore,
  Effect.sync(() => {
    const stores = new Map<string, IssueArtifactStore>();

    return {
      forIssue: (issueNumber: number, scope?: IssueArtifactScope) => {
        const key = scope
          ? `${resolveWorkspacePath(scope.workspace)}\u0000${safeRunId(scope.runId)}\u0000${issueNumber}`
          : `memory\u0000${issueNumber}`;
        const existing = stores.get(key);
        if (existing) return Effect.succeed(existing);

        return (
          scope
            ? makeDurableIssueArtifactStore(issueNumber, scope)
            : makeIssueArtifactStore(issueNumber)
        ).pipe(
          Effect.tap((store) =>
            Effect.sync(() => {
              stores.set(key, store);
            }),
          ),
        );
      },
    } satisfies IssueArtifactStoreService;
  }),
);
