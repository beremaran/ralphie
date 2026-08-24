import { Layer } from "effect";

import { GitRepositoryLive } from "./git/repository.ts";
import { GitHubClientLive } from "./github/client.ts";
import { GitHubIssuesLive } from "./github/issues.ts";
import { OpenCodeLive } from "./opencode/server.ts";
import { IssuePipelineLive } from "./issues/pipeline.ts";
import { CommandRunnerLive } from "./process/command-runner.ts";
import { WorkspaceLive } from "./workspace/workspace.ts";

const GitHubClientLiveWithCommandRunner = GitHubClientLive.pipe(
  Layer.provide(CommandRunnerLive),
);

const GitRepositoryLiveWithCommandRunner = GitRepositoryLive.pipe(
  Layer.provide(CommandRunnerLive),
);

export const LiveRuntime = Layer.mergeAll(
  GitHubClientLiveWithCommandRunner,
  GitHubIssuesLive,
  GitRepositoryLiveWithCommandRunner,
  IssuePipelineLive,
  OpenCodeLive,
  WorkspaceLive,
);
