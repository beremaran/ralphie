import { Context, Data, Effect, Layer } from "effect";

import { CommandRunner, type CommandRunnerService } from "../process/command-runner.ts";
import { RalphieError } from "../shared/error.ts";
import { parseRepositorySlug } from "../github/repository.ts";

export enum GitRemoteSafetyFailureKind {
  OriginMismatch = "origin-mismatch",
  DivergedBase = "diverged-base",
  InvalidPushMode = "invalid-push-mode",
}

export enum GitDirectPushPolicy {
  RequireOwnedOrigin = "require-owned-origin",
  RequireExpectedBase = "require-expected-base",
  NonForceOnly = "non-force-only",
}

export enum GitPushMode {
  NonForce = "non-force",
  Force = "force",
}

export class GitRemoteSafetyError extends Data.TaggedError("GitRemoteSafetyError")<{
  readonly kind: GitRemoteSafetyFailureKind;
  readonly policy: GitDirectPushPolicy;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type GitRemoteSafetyInput = {
  readonly repository: string;
  readonly repositoryPath: string;
  readonly branch: string;
  /** The exact clean checkout base captured before issue work began. */
  readonly intendedBaseSha: string;
  /** When supplied, HEAD must be this commit and exactly one commit ahead. */
  readonly expectedCommitSha?: string;
  readonly pushMode?: GitPushMode;
};

export type GitRemoteSafetyReport = {
  readonly repository: string;
  readonly branch: string;
  readonly origin: string;
  readonly commitsBehindBase: number;
  readonly commitsAheadBase: number;
  readonly pushMode: GitPushMode.NonForce;
};

export type GitRemoteSafetyService = {
  /** Verify all invariants required immediately before a direct branch push. */
  readonly verifyDirectPush: (
    input: GitRemoteSafetyInput,
  ) => Effect.Effect<GitRemoteSafetyReport, GitRemoteSafetyError | RalphieError>;
};

export const GitRemoteSafety = Context.GenericTag<GitRemoteSafetyService>(
  "ralphie/GitRemoteSafety",
);

const fail = (
  kind: GitRemoteSafetyFailureKind,
  policy: GitDirectPushPolicy,
  message: string,
  cause?: unknown,
): Effect.Effect<never, GitRemoteSafetyError> =>
  Effect.fail(new GitRemoteSafetyError({ kind, policy, message, cause }));

const runGit = (
  runner: CommandRunnerService,
  repositoryPath: string,
  args: ReadonlyArray<string>,
  message: string,
) =>
  Effect.gen(function* () {
    const result = yield* runner.run("git", ["-C", repositoryPath, ...args]);
    if (result.exitCode !== 0) {
      return yield* new RalphieError({
        message: `${message}${result.stderr ? ` ${result.stderr}` : ""}`,
      });
    }
    return result.stdout;
  });

const parseCounts = (output: string): readonly [number, number] | undefined => {
  const values = output.trim().split(/\s+/).map(Number);
  if (
    values.length !== 2 ||
    values.some((value) => !Number.isInteger(value) || value < 0)
  ) {
    return undefined;
  }
  return [values[0]!, values[1]!];
};

const repositorySlug = (repository: string): string =>
  parseRepositorySlug(repository).slug;

export const GitRemoteSafetyLive = Layer.effect(
  GitRemoteSafety,
  Effect.gen(function* () {
    const runner = yield* CommandRunner;

    return {
      verifyDirectPush: (input) =>
        Effect.gen(function* () {
          const mode = input.pushMode ?? GitPushMode.NonForce;
          if (mode !== GitPushMode.NonForce) {
            return yield* fail(
              GitRemoteSafetyFailureKind.InvalidPushMode,
              GitDirectPushPolicy.NonForceOnly,
              "Direct pushes must use Git's non-force mode; force pushes are refused.",
            );
          }

          const slug = yield* Effect.try({
            try: () => repositorySlug(input.repository),
            catch: (cause) =>
              cause instanceof RalphieError
                ? cause
                : new RalphieError({
                    message: `Invalid GitHub repository: ${input.repository}.`,
                    cause,
                  }),
          });
          if (input.intendedBaseSha.trim().length === 0) {
            return yield* fail(
              GitRemoteSafetyFailureKind.DivergedBase,
              GitDirectPushPolicy.RequireExpectedBase,
              "An intended base commit is required before a direct push.",
            );
          }

          const origin = yield* runGit(
            runner,
            input.repositoryPath,
            ["remote", "get-url", "origin"],
            "Failed to read the repository origin.",
          );
          const originSlug = yield* Effect.try({
            try: () => parseRepositorySlug(origin).slug,
            catch: (cause) =>
              new GitRemoteSafetyError({
                kind: GitRemoteSafetyFailureKind.OriginMismatch,
                policy: GitDirectPushPolicy.RequireOwnedOrigin,
                message: `Repository origin ${origin} is not a GitHub repository owned by ${slug}.`,
                cause,
              }),
          });
          if (originSlug.toLowerCase() !== slug.toLowerCase()) {
            return yield* fail(
              GitRemoteSafetyFailureKind.OriginMismatch,
              GitDirectPushPolicy.RequireOwnedOrigin,
              `Repository origin ${originSlug} does not match ${slug}.`,
            );
          }

          const localBranch = yield* runGit(
            runner,
            input.repositoryPath,
            ["symbolic-ref", "--short", "HEAD"],
            "Failed to read the checked-out branch.",
          );
          if (localBranch !== input.branch) {
            return yield* fail(
              GitRemoteSafetyFailureKind.OriginMismatch,
              GitDirectPushPolicy.RequireOwnedOrigin,
              `Checkout is on ${localBranch}, expected ${input.branch}.`,
            );
          }

          const head = yield* runGit(
            runner,
            input.repositoryPath,
            ["rev-parse", "HEAD"],
            "Failed to read the local HEAD.",
          );
          if (
            input.expectedCommitSha !== undefined &&
            head.toLowerCase() !== input.expectedCommitSha.toLowerCase()
          ) {
            return yield* fail(
              GitRemoteSafetyFailureKind.DivergedBase,
              GitDirectPushPolicy.RequireExpectedBase,
              `Local HEAD ${head} does not match expected commit ${input.expectedCommitSha}.`,
            );
          }

          const remote = yield* runGit(
            runner,
            input.repositoryPath,
            ["ls-remote", "origin", `refs/heads/${input.branch}`],
            `Failed to read origin/${input.branch}.`,
          );
          const remoteSha = remote.split(/\s+/)[0] ?? "";
          const normalizedRemoteSha = remoteSha.toLowerCase();
          const remoteIsIntendedBase =
            normalizedRemoteSha === input.intendedBaseSha.toLowerCase();
          const remoteIsExpectedCommit =
            input.expectedCommitSha !== undefined &&
            normalizedRemoteSha === input.expectedCommitSha.toLowerCase();
          if (!remoteIsIntendedBase && !remoteIsExpectedCommit) {
            return yield* fail(
              GitRemoteSafetyFailureKind.DivergedBase,
              GitDirectPushPolicy.RequireExpectedBase,
              `Remote origin/${input.branch} moved from intended base ${input.intendedBaseSha} to ${remoteSha || "no commit"}.`,
            );
          }

          const countsOutput = yield* runGit(
            runner,
            input.repositoryPath,
            ["rev-list", "--left-right", "--count", `${input.intendedBaseSha}...HEAD`],
            "Failed to compare the checkout with its intended base.",
          );
          const counts = parseCounts(countsOutput);
          if (counts === undefined) {
            return yield* fail(
              GitRemoteSafetyFailureKind.DivergedBase,
              GitDirectPushPolicy.RequireExpectedBase,
              `Git returned an invalid ahead/behind count: ${countsOutput}.`,
            );
          }
          const [behind, ahead] = counts;
          const expectedAhead = input.expectedCommitSha === undefined ? 0 : 1;
          if (behind !== 0 || ahead !== expectedAhead) {
            return yield* fail(
              GitRemoteSafetyFailureKind.DivergedBase,
              GitDirectPushPolicy.RequireExpectedBase,
              `Checkout diverged from intended base: ${behind} behind and ${ahead} ahead; expected 0 behind and ${expectedAhead} ahead.`,
            );
          }

          return {
            repository: slug,
            branch: input.branch,
            origin,
            commitsBehindBase: behind,
            commitsAheadBase: ahead,
            pushMode: GitPushMode.NonForce,
          } as const;
        }),
    } satisfies GitRemoteSafetyService;
  }),
);
