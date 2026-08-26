import { Context, Effect, Layer } from "effect";

import { IssueArtifactKind, IssueArtifactStore } from "../issues/artifacts.ts";
import type { IssueCheckpoint } from "./issue-checkpoint.ts";
import { GitIssueCheckpoint } from "./issue-checkpoint.ts";
import { RalphieError } from "../shared/error.ts";

export type IssuePreparationInput = {
  readonly issueNumber: number;
  readonly repositoryPath: string;
  readonly branch: string;
};

export type GitIssuePreparationService = {
  /** Capture and persist the clean issue base before agent work starts. */
  readonly prepare: (
    input: IssuePreparationInput,
  ) => Effect.Effect<IssueCheckpoint, RalphieError>;
};

export const GitIssuePreparation =
  Context.GenericTag<GitIssuePreparationService>("ralphie/GitIssuePreparation");

export const GitIssuePreparationLive = Layer.effect(
  GitIssuePreparation,
  Effect.gen(function* () {
    const checkpoints = yield* GitIssueCheckpoint;
    const artifactStores = yield* IssueArtifactStore;

    return {
      prepare: (input) =>
        Effect.gen(function* () {
          const checkpoint = yield* checkpoints.capture(
            input.repositoryPath,
            input.branch,
          );
          const artifacts = yield* artifactStores.forIssue(input.issueNumber);
          if (artifacts.has(IssueArtifactKind.IssueCheckpoint)) {
            const existing = yield* artifacts.read(
              IssueArtifactKind.IssueCheckpoint,
            );
            if (
              existing.branch !== checkpoint.branch ||
              existing.sha.toLowerCase() !== checkpoint.sha.toLowerCase()
            ) {
              return yield* new RalphieError({
                message: `Issue ${input.issueNumber} already has a different clean issue-base checkpoint.`,
              });
            }
            return checkpoint;
          }
          yield* artifacts.write(IssueArtifactKind.IssueCheckpoint, checkpoint);
          return checkpoint;
        }),
    } satisfies GitIssuePreparationService;
  }),
);