import { Context, Effect, Layer } from "effect";

import type { IssueCheckpoint } from "../git/issue-checkpoint.ts";
import { RalphieError } from "../shared/error.ts";
import {
  type CommitMessageDecision,
  type ComplexityDecision,
  type IssueBreakdownDecision,
  type ReviewDecision,
} from "./decisions.ts";
import type { ReviewAttempt } from "./recovery.ts";
import { REVIEW_ITERATION_LIMIT } from "./stage.ts";

/** The durable, per-issue values produced while an issue moves through Ralphie. */
export enum IssueArtifactKind {
  ComplexityDecision = "complexity-decision",
  IssueCheckpoint = "issue-checkpoint",
  ReviewAttempts = "review-attempts",
  CommitMessageDecision = "commit-message-decision",
  IssueBreakdownDecision = "issue-breakdown-decision",
  CreatedIssueNumbers = "created-issue-numbers",
}

export type CreatedIssueNumberMapping = Readonly<Record<string, number>>;

/**
 * The value type is keyed by the artifact kind so callers cannot read a
 * complexity decision as a checkpoint (or accidentally write the wrong
 * decision into a slot).
 */
export type IssueArtifactValues = {
  readonly [IssueArtifactKind.ComplexityDecision]: ComplexityDecision;
  readonly [IssueArtifactKind.IssueCheckpoint]: IssueCheckpoint;
  readonly [IssueArtifactKind.ReviewAttempts]: ReadonlyArray<ReviewAttempt>;
  readonly [IssueArtifactKind.CommitMessageDecision]: CommitMessageDecision;
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
  /** Append exactly the next review attempt, preserving review order. */
  readonly appendReview: (
    review: ReviewAttempt,
  ) => Effect.Effect<void, RalphieError>;
  /** Record one child issue as soon as its GitHub creation succeeds. */
  readonly recordCreatedIssue: (
    key: string,
    issueNumber: number,
  ) => Effect.Effect<void, RalphieError>;
};

export type IssueArtifactStoreService = {
  /** Get the stable in-memory store for one issue in the current run. */
  readonly forIssue: (
    issueNumber: number,
  ) => Effect.Effect<IssueArtifactStore, RalphieError>;
};

export const IssueArtifactStore = Context.GenericTag<IssueArtifactStoreService>(
  "ralphie/IssueArtifactStore",
);

const failure = (message: string): Effect.Effect<never, RalphieError> =>
  Effect.fail(new RalphieError({ message }));

const validIssueNumber = (issueNumber: number): boolean =>
  Number.isInteger(issueNumber) && issueNumber > 0;

const validReviewOrder = (
  reviews: ReadonlyArray<ReviewAttempt>,
): boolean =>
  reviews.length <= REVIEW_ITERATION_LIMIT &&
  reviews.every((review, index) => review.attempt === index + 1);

const validCreatedIssueNumberMapping = (
  mapping: CreatedIssueNumberMapping,
): boolean =>
  Object.entries(mapping).every(
    ([key, issueNumber]) =>
      key.trim().length > 0 && validIssueNumber(issueNumber),
  );

/** Create an isolated store, useful for an issue executor or unit tests. */
export const makeIssueArtifactStore = (
  issueNumber: number,
): Effect.Effect<IssueArtifactStore, RalphieError> => {
  if (!validIssueNumber(issueNumber)) {
    return failure(`Cannot create an artifact store for issue ${issueNumber}.`);
  }

  const values = new Map<IssueArtifactKind, unknown>();
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
      values.set(kind, value);
      return Effect.void;
    },

    read: (kind) => {
      const value = values.get(kind);
      return value === undefined
        ? failure(
            `Artifact ${kind} has not been produced for issue ${issueNumber}.`,
          )
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
        return failure(
          `Review attempt budget exhausted for issue ${issueNumber}.`,
        );
      }
      values.set(IssueArtifactKind.ReviewAttempts, [...existing, review]);
      return Effect.void;
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
      values.set(IssueArtifactKind.CreatedIssueNumbers, {
        ...existing,
        [key]: createdIssueNumber,
      });
      return Effect.void;
    },
  };

  return Effect.succeed(store);
};

export const IssueArtifactStoreLive = Layer.effect(
  IssueArtifactStore,
  Effect.sync(() => {
    const stores = new Map<number, IssueArtifactStore>();

    return {
      forIssue: (issueNumber: number) => {
        const existing = stores.get(issueNumber);
        if (existing) return Effect.succeed(existing);

        return makeIssueArtifactStore(issueNumber).pipe(
          Effect.tap((store) =>
            Effect.sync(() => {
              stores.set(issueNumber, store);
            }),
          ),
        );
      },
    } satisfies IssueArtifactStoreService;
  }),
);
