import { Console, Effect } from "effect";

import {
  CommandRunner,
  OctokitClient,
  OpenCode,
  RalphieError,
  Repository,
  Workspace,
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

export type WorkflowOptions = {
  readonly repo: string;
  readonly branch: string;
  readonly maxIssues?: number;
  readonly workspace: string;
  readonly cleanup: boolean;
  readonly startClean: boolean;
};

export const workflow = ({
  repo,
  branch,
  maxIssues,
  workspace,
  cleanup,
  startClean,
}: WorkflowOptions) =>
  Effect.gen(function* () {
    if (startClean) {
      const workspaceService = yield* Workspace;
      yield* workspaceService.remove(workspace);
      yield* Console.log(`Existing workspace removed: ${workspace}.`);
    }

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

    const repository = yield* Repository;
    const prepared = yield* repository.prepare(repo, branch, workspace);
    yield* Console.log(
      `${prepared.cloned ? "Repository cloned" : "Existing repository ready"}: ${prepared.path}.`,
    );
    if (prepared.cleaned) {
      yield* Console.log("Discarded uncommitted repository changes.");
    }
    if (prepared.branchChanged) {
      yield* Console.log(`Switched to branch ${branch}.`);
    }

    const openCode = yield* OpenCode;
    yield* Effect.acquireUseRelease(
      openCode.start,
      (server) =>
        Console.log(
          `OpenCode server started at ${server.url}.\nReady for ${repo} on branch ${branch}.\nWorkspace: ${workspace}.\nIssue limit: ${maxIssues ?? "unlimited"}.`,
        ),
      closeServer,
    );

    if (cleanup) {
      const workspaceService = yield* Workspace;
      yield* workspaceService.remove(workspace);
      yield* Console.log(`Workspace removed: ${workspace}.`);
    }
  });
