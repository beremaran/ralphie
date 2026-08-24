import { Context, Effect, Layer } from "effect";
import { Octokit } from "octokit";

import {
  CommandRunner,
  requireSuccessfulCommand,
} from "../process/command-runner.ts";
import { RalphieError } from "../shared/error.ts";

export type GitHubClientService = {
  readonly initialize: Effect.Effect<Octokit, RalphieError>;
};

export const GitHubClient =
  Context.GenericTag<GitHubClientService>("ralphie/GitHubClient");

export const GitHubClientLive = Layer.effect(
  GitHubClient,
  Effect.gen(function* () {
    const runner = yield* CommandRunner;

    return {
      initialize: Effect.gen(function* () {
        yield* requireSuccessfulCommand(
          runner,
          "gh",
          ["auth", "status"],
          "GitHub authentication check failed. Run `gh auth login` and try again.",
        );

        const tokenResult = yield* requireSuccessfulCommand(
          runner,
          "gh",
          ["auth", "token"],
          "Could not retrieve the GitHub authentication token.",
        );
        const authToken = tokenResult.stdout.trim();
        if (!authToken) {
          return yield* new RalphieError({
            message: "GitHub CLI returned an empty authentication token.",
          });
        }

        return yield* Effect.try({
          try: () => new Octokit({ auth: authToken }),
          catch: (cause) =>
            new RalphieError({
              message: "Failed to initialize Octokit.",
              cause,
            }),
        });
      }),
    };
  }),
);
