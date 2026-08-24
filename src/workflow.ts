import { Console, Effect } from "effect";

import { GitRepository } from "./git/repository.ts";
import { GitHubClient } from "./github/client.ts";
import {
  GitHubIssues,
  type IssueFilters,
} from "./github/issues.ts";
import { IssuePipeline, selectIssues } from "./issues/pipeline.ts";
import { OpenCode, type OpenCodeServer } from "./opencode/server.ts";
import { Workspace } from "./workspace/workspace.ts";

const closeServer = (server: OpenCodeServer) =>
  Effect.sync(() => server.close());

export type WorkflowOptions = {
  readonly repo: string;
  readonly branch: string;
  readonly maxIssues?: number;
  readonly issueFilters: IssueFilters;
  readonly workspace: string;
  readonly cleanup: boolean;
  readonly startClean: boolean;
};

export const workflow = ({
  repo,
  branch,
  maxIssues,
  issueFilters,
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
    const octokit = yield* github.initialize;
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

    const githubIssues = yield* GitHubIssues;
    const issues = yield* githubIssues.listOpen(octokit, repo, issueFilters);
    yield* Console.log(
      `${issueFilters.labels.length > 0 ? "Matching open issues" : "Open issues"}: ${issues.length}.`,
    );
    const firstIssue = issues[0];
    if (firstIssue) {
      yield* Console.log(
        `First issue: #${firstIssue.number} ${firstIssue.title}\n${firstIssue.url}`,
      );
    } else {
      yield* Console.log("No open issues match the current filters.");
    }
    const selectedIssues = selectIssues(issues, maxIssues);
    yield* Console.log(`Issues selected for processing: ${selectedIssues.length}.`);

    const openCode = yield* OpenCode;
    const issuePipeline = yield* IssuePipeline;
    yield* Effect.acquireUseRelease(
      openCode.start,
      (server) =>
        Effect.gen(function* () {
          yield* Console.log(
            `OpenCode server started at ${server.url}.\nReady for ${repo} on branch ${branch}.\nWorkspace: ${workspace}.\nIssue limit: ${maxIssues ?? "unlimited"}.`,
          );

          yield* Effect.forEach(selectedIssues, (issue) =>
            Effect.gen(function* () {
              const plan = yield* issuePipeline.plan({
                issue,
                repositoryPath: prepared.path,
                targetBranch: branch,
              });
              yield* Console.log(
                `Prepared issue #${issue.number} for complexity assessment on ${plan.targetBranch}; complexity 0-3 uses implementation and 4-5 uses decomposition.`,
              );
            }),
          );
        }),
      closeServer,
    );

    if (cleanup) {
      const workspaceService = yield* Workspace;
      yield* workspaceService.remove(workspace);
      yield* Console.log(`Workspace removed: ${workspace}.`);
    }
  });
