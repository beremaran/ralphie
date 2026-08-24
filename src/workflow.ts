import { Console, Effect } from "effect";

import {
  CommandRunner,
  OctokitClient,
  OpenCode,
  RalphieError,
  type OpenCodeServer,
} from "./services.ts";

const requireSuccessfulCommand = (
  command: string,
  args: ReadonlyArray<string>,
  failureMessage: string,
) =>
  Effect.gen(function* () {
    const runner = yield* CommandRunner;
    const result = yield* runner.run(command, args);

    if (result.exitCode !== 0) {
      const detail = result.stderr ? `\n${result.stderr}` : "";
      return yield* new RalphieError({
        message: `${failureMessage}${detail}`,
      });
    }

    return result;
  });

const closeServer = (server: OpenCodeServer) =>
  Effect.sync(() => server.close());

export const workflow = (repo: string, branch: string) =>
  Effect.gen(function* () {
    yield* requireSuccessfulCommand(
      "gh",
      ["auth", "status"],
      "GitHub authentication check failed. Run `gh auth login` and try again.",
    );
    yield* Console.log("GitHub authentication verified.");

    const tokenResult = yield* requireSuccessfulCommand(
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

    const octokit = yield* OctokitClient;
    yield* octokit.create(authToken);
    yield* Console.log("Octokit initialized.");

    yield* requireSuccessfulCommand(
      "git",
      ["--version"],
      "Git is not installed or is not available on PATH.",
    );
    yield* Console.log("Git installation verified.");

    const openCode = yield* OpenCode;
    yield* Effect.acquireUseRelease(
      openCode.start,
      (server) =>
        Console.log(
          `OpenCode server started at ${server.url}.\nReady for ${repo} on branch ${branch}.`,
        ),
      closeServer,
    );
  });
