import { Console, Effect } from "effect";

import { GitRepository } from "./git/repository.ts";
import { GitHubClient } from "./github/client.ts";
import { OpenCode, type OpenCodeServer } from "./opencode/server.ts";
import { Workspace } from "./workspace/workspace.ts";

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

    const github = yield* GitHubClient;
    yield* github.initialize;
    yield* Console.log("GitHub authentication verified.");
    yield* Console.log("Octokit initialized.");

    const repository = yield* GitRepository;
    yield* repository.verifyInstalled;
    yield* Console.log("Git installation verified.");

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
