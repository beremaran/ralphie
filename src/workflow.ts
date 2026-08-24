import { Effect } from "effect";

import { GitRepository } from "./git/repository.ts";
import { GitHubClient } from "./github/client.ts";
import {
  GitHubIssues,
  type IssueFilters,
} from "./github/issues.ts";
import { IssuePipeline, selectIssues } from "./issues/pipeline.ts";
import type { OpenCodeModel } from "./opencode/model.ts";
import { OpenCode, type OpenCodeServer } from "./opencode/server.ts";
import {
  ProgressReporter,
  type ProgressReporterService,
  ProgressStage,
  ProgressStatus,
  type ProgressUpdate,
} from "./progress/progress.ts";
import { Workspace } from "./workspace/workspace.ts";

const closeServer = (server: OpenCodeServer) =>
  Effect.sync(() => server.close());

type ProgressContext = Omit<ProgressUpdate, "stage" | "status" | "message">;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const track = <Result, Error, Requirements>(
  progress: ProgressReporterService,
  stage: ProgressStage,
  startedMessage: string,
  effect: Effect.Effect<Result, Error, Requirements>,
  succeededMessage: string | ((result: Result) => string),
  context: ProgressContext = {},
): Effect.Effect<Result, Error, Requirements> =>
  progress
    .emit({
      ...context,
      stage,
      status: ProgressStatus.Started,
      message: startedMessage,
    })
    .pipe(
      Effect.zipRight(effect),
      Effect.tap((result) =>
        progress.emit({
          ...context,
          stage,
          status: ProgressStatus.Succeeded,
          message:
            typeof succeededMessage === "function"
              ? succeededMessage(result)
              : succeededMessage,
        }),
      ),
      Effect.tapError((error) =>
        progress.emit({
          ...context,
          stage,
          status: ProgressStatus.Failed,
          message: `${startedMessage.replace(/\.{3}$/, "")} failed: ${errorMessage(error)}`,
        }),
      ),
    );

export type WorkflowOptions = {
  readonly repo: string;
  readonly branch: string;
  readonly maxIssues?: number;
  readonly issueFilters: IssueFilters;
  readonly agent: string;
  readonly model?: OpenCodeModel;
  readonly modelVariant?: string;
  readonly workspace: string;
  readonly cleanup: boolean;
  readonly startClean: boolean;
};

export const workflow = ({
  repo,
  branch,
  maxIssues,
  issueFilters,
  agent,
  model,
  modelVariant,
  workspace,
  cleanup,
  startClean,
}: WorkflowOptions) =>
  Effect.gen(function* () {
    const progress = yield* ProgressReporter;
    yield* progress.emit({
      stage: ProgressStage.Run,
      status: ProgressStatus.Info,
      message: `Ralphie started for ${repo} on ${branch}.`,
      details: {
        repository: repo,
        branch,
        workspace,
        model: model
          ? `${model.providerID}/${model.modelID}`
          : "OpenCode default",
        variant: modelVariant ?? "OpenCode default",
        agent,
        issueLimit: maxIssues ?? "unlimited",
      },
    });

    const run = Effect.gen(function* () {
      if (startClean) {
        const workspaceService = yield* Workspace;
        yield* track(
          progress,
          ProgressStage.WorkspaceCleanup,
          `Removing existing workspace ${workspace}...`,
          workspaceService.remove(workspace),
          `Existing workspace removed: ${workspace}.`,
        );
      }

      const github = yield* GitHubClient;
      const octokit = yield* track(
        progress,
        ProgressStage.GitHubAuthentication,
        "Checking GitHub authentication...",
        github.initialize,
        "GitHub authentication verified and Octokit initialized.",
      );

      const repository = yield* GitRepository;
      yield* track(
        progress,
        ProgressStage.GitVerification,
        "Checking Git installation...",
        repository.verifyInstalled,
        "Git installation verified.",
      );

      const prepared = yield* track(
        progress,
        ProgressStage.RepositoryPreparation,
        `Preparing ${repo} on ${branch}...`,
        repository.prepare(repo, branch, workspace),
        (result) =>
          `${result.cloned ? "Repository cloned" : "Existing repository ready"}: ${result.path}.`,
        { details: { repository: repo, branch, workspace } },
      );

      const githubIssues = yield* GitHubIssues;
      const issues = yield* track(
        progress,
        ProgressStage.IssueDiscovery,
        "Fetching matching open issues...",
        githubIssues.listOpen(octokit, repo, issueFilters),
        (result) =>
          result.length === 0
            ? "No open issues match the current filters."
            : `Found ${result.length} matching open issues; first is #${result[0]!.number} ${result[0]!.title}.`,
        { details: { filters: issueFilters } },
      );
      const selectedIssues = selectIssues(issues, maxIssues);

      const openCode = yield* OpenCode;
      const issuePipeline = yield* IssuePipeline;
      yield* Effect.acquireUseRelease(
        track(
          progress,
          ProgressStage.OpenCodeServer,
          "Starting OpenCode server...",
          openCode.start,
          (server) => `OpenCode server started at ${server.url}.`,
        ),
        () =>
          Effect.forEach(selectedIssues, (issue, index) => {
            const issueContext = {
              issue: { number: issue.number, title: issue.title },
              current: index + 1,
              total: selectedIssues.length,
              details: { url: issue.url },
            };
            return track(
              progress,
              ProgressStage.IssuePlanning,
              `Preparing #${issue.number} ${issue.title}...`,
              issuePipeline.plan({
                issue,
                repositoryPath: prepared.path,
                targetBranch: branch,
                openCode: { agent, model, variant: modelVariant },
              }),
              (plan) =>
                `Prepared #${issue.number} for complexity assessment on ${plan.targetBranch}.`,
              issueContext,
            );
          }, { discard: true }),
        closeServer,
      );

      if (cleanup) {
        const workspaceService = yield* Workspace;
        yield* track(
          progress,
          ProgressStage.WorkspaceCleanup,
          `Removing workspace ${workspace}...`,
          workspaceService.remove(workspace),
          `Workspace removed: ${workspace}.`,
        );
      }

      return selectedIssues.length;
    });

    return yield* run.pipe(
      Effect.tap((issueCount) =>
        progress.emit({
          stage: ProgressStage.Run,
          status: ProgressStatus.Succeeded,
          message: `Run completed successfully; ${issueCount} issues prepared.`,
          details: { issueCount },
        }),
      ),
      Effect.tapError((error) =>
        progress.emit({
          stage: ProgressStage.Run,
          status: ProgressStatus.Failed,
          message: `Run failed: ${errorMessage(error)}`,
        }),
      ),
    );
  });
