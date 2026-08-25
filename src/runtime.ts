import { Layer } from "effect";

import { GitRepositoryLive } from "./git/repository.ts";
import { GitRepositoryInvariantLive } from "./git/repository-invariant.ts";
import { GitIssueCheckpointLive } from "./git/issue-checkpoint.ts";
import { GitIssueOperationsLive } from "./git/issue-operations.ts";
import { GitIssuePreparationLive } from "./git/issue-preparation.ts";
import { GitRemoteSafetyLive } from "./git/remote-safety.ts";
import { GitHubClientLive } from "./github/client.ts";
import { GitHubIssueMutationsLive } from "./github/issue-mutations.ts";
import { GitHubIssuesLive } from "./github/issues.ts";
import { GitHubPullRequestsLive } from "./github/pull-requests.ts";
import { GitHubRepositoryPatternsLive } from "./github/repository-patterns.ts";
import { OpenCodeLive } from "./opencode/server.ts";
import { IssueArtifactStoreLive } from "./issues/artifacts.ts";
import { ComplexityAssessmentLive } from "./issues/complexity.ts";
import { DecompositionExecutorLive } from "./issues/decomposition-executor.ts";
import { DryRunIssueExecutorLive } from "./issues/dry-run-executor.ts";
import { IssueExecutorLive } from "./issues/executor.ts";
import { ImplementationExecutorLive } from "./issues/implementation-executor.ts";
import { IssueRecoveryLive } from "./issues/recovery.ts";
import { CommandRunnerLive } from "./process/command-runner.ts";
import { RunStateStoreLive } from "./run/state.ts";
import { WorkspaceLive } from "./workspace/workspace.ts";

const GitHubClientLiveWithCommandRunner = GitHubClientLive.pipe(
  Layer.provide(CommandRunnerLive),
);

const GitRepositoryLiveWithCommandRunner = GitRepositoryLive.pipe(
  Layer.provide(CommandRunnerLive),
);

const GitRepositoryInvariantLiveWithCommandRunner = GitRepositoryInvariantLive.pipe(
  Layer.provide(CommandRunnerLive),
);

const GitIssueCheckpointLiveWithCommandRunner = GitIssueCheckpointLive.pipe(
  Layer.provide(CommandRunnerLive),
);
const GitIssueOperationsLiveWithCommandRunner = GitIssueOperationsLive.pipe(
  Layer.provide(CommandRunnerLive),
);
const GitRemoteSafetyLiveWithCommandRunner = GitRemoteSafetyLive.pipe(
  Layer.provide(CommandRunnerLive),
);
const GitIssuePreparationRuntime = GitIssuePreparationLive.pipe(
  Layer.provideMerge(
    Layer.merge(GitIssueCheckpointLiveWithCommandRunner, IssueArtifactStoreLive),
  ),
);
const IssueRecoveryRuntime = IssueRecoveryLive.pipe(
  Layer.provideMerge(GitIssueCheckpointLiveWithCommandRunner),
);
const ImplementationExecutorRuntime = ImplementationExecutorLive.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      GitIssuePreparationRuntime,
      GitIssueOperationsLiveWithCommandRunner,
      GitRemoteSafetyLiveWithCommandRunner,
      IssueRecoveryRuntime,
    ),
  ),
);
const DecompositionExecutorRuntime = DecompositionExecutorLive.pipe(
  Layer.provideMerge(Layer.merge(GitHubIssueMutationsLive, GitHubIssuesLive)),
);
const IssueExecutorRuntime = IssueExecutorLive.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      IssueArtifactStoreLive,
      ComplexityAssessmentLive,
      ImplementationExecutorRuntime,
      DecompositionExecutorRuntime,
      DryRunIssueExecutorLive.pipe(
        Layer.provideMerge(
          Layer.merge(ComplexityAssessmentLive, IssueArtifactStoreLive),
        ),
      ),
    ),
  ),
);

export const LiveRuntime = Layer.mergeAll(
  GitHubClientLiveWithCommandRunner,
  GitHubIssuesLive,
  GitHubIssueMutationsLive,
  GitHubPullRequestsLive,
  GitHubRepositoryPatternsLive,
  GitRepositoryLiveWithCommandRunner,
  GitRepositoryInvariantLiveWithCommandRunner,
  GitIssueOperationsLiveWithCommandRunner,
  IssueArtifactStoreLive,
  IssueExecutorRuntime,
  OpenCodeLive,
  RunStateStoreLive,
  WorkspaceLive,
);
