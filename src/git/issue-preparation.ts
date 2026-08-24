import { Context, Effect, Layer } from "effect";

import {
  IssueArtifactKind,
  IssueArtifactStore,
  type IssueArtifactStore as IssueArtifacts,
  type ProjectCheckpoint,
} from "../issues/artifacts.ts";
import type { ProjectRepositoryCheckout } from "../project/project.ts";
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
  readonly prepareProject?: (
    repositories: ReadonlyArray<ProjectRepositoryCheckout>,
    artifacts: IssueArtifacts,
  ) => Effect.Effect<ReadonlyArray<ProjectCheckpoint>, RalphieError>;
};

export const GitIssuePreparation = Context.GenericTag<GitIssuePreparationService>(
  "ralphie/GitIssuePreparation",
);

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
            const existing = yield* artifacts.read(IssueArtifactKind.IssueCheckpoint);
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
      prepareProject: (repositories, artifacts) =>
        Effect.gen(function* () {
          const captured = yield* Effect.forEach(repositories, (repository) =>
            checkpoints.capture(repository.repositoryPath, repository.branch).pipe(
              Effect.map((checkpoint) => ({
                repository: repository.repository,
                repositoryPath: repository.repositoryPath,
                ...checkpoint,
              })),
            ),
          );
          if (artifacts.has(IssueArtifactKind.ProjectCheckpoints)) {
            const existing = yield* artifacts.read(
              IssueArtifactKind.ProjectCheckpoints,
            );
            if (JSON.stringify(existing) !== JSON.stringify(captured)) {
              return yield* new RalphieError({
                message:
                  "This issue already has different project repository checkpoints.",
              });
            }
            return existing;
          }
          yield* artifacts.write(IssueArtifactKind.ProjectCheckpoints, captured);
          return captured;
        }),
    } satisfies GitIssuePreparationService;
  }),
);
