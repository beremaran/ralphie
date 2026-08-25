import { defineCommand, option } from "@bunli/core";
import { Effect, Layer } from "effect";
import { dirname, join } from "node:path";
import { z } from "zod";

import {
  RalphieConfigFile,
  RalphieConfigFileLive,
  RepositoryTargetKind,
  WorkflowMode,
  resolveRalphieConfig,
} from "./config/config.ts";
import { IssueOrder, IssueSort } from "./github/issues.ts";
import { openCodeModelSchema, openCodeModelVariantSchema } from "./opencode/model.ts";
import { makeProgressReporterLayer, ProgressRenderMode } from "./progress/progress.ts";
import { LiveRuntime } from "./runtime.ts";
import { exitCodeForFailure } from "./process/exit-code.ts";
import {
  batchWorkflow,
  type RepositoryPatternWorkflowOptions,
  type WorkflowOptions,
} from "./workflow.ts";
import { redactSensitiveText } from "./shared/redaction.ts";
import { type RunState, RunStateStore, RunStateStoreLive } from "./run/state.ts";
import { reconcileRunState } from "./run/reconciliation.ts";
import { resolveWorkspacePath } from "./workspace/workspace.ts";

export const runCommand = defineCommand({
  name: "run",
  description: "Run Ralphie against a GitHub repository",
  options: {
    config: option(z.string().trim().min(1).optional(), {
      description: "Load repeatable options from a JSON config file",
    }),
    branch: option(z.string().min(1).optional(), {
      short: "b",
      description: "Branch to operate on (default: main, otherwise master)",
    }),
    workflow: option(z.enum(WorkflowMode).optional(), {
      description: "Delivery workflow: lgtm, pr, or parallel-pr",
    }),
    "issue-concurrency": option(z.coerce.number().int().positive().optional(), {
      description: "Concurrent issues per project in parallel-pr mode",
    }),
    "agent-concurrency": option(z.coerce.number().int().positive().optional(), {
      description: "Global maximum concurrent OpenCode agent tasks",
    }),
    "max-issues": option(z.coerce.number().int().positive().optional(), {
      description: "Maximum number of issues to process (default: unlimited)",
    }),
    "issue-label": option(z.array(z.string().trim().min(1)).optional(), {
      description: "Only include issues with this label (repeatable)",
      repeatable: true,
    }),
    "issue-sort": option(z.enum(IssueSort).optional(), {
      description: "Sort issues by created, updated, or comments",
    }),
    "issue-order": option(z.enum(IssueOrder).optional(), {
      description: "Sort issues in ascending or descending order",
    }),
    model: option(openCodeModelSchema.optional(), {
      description: "OpenCode model in provider/model format",
    }),
    "model-variant": option(openCodeModelVariantSchema.optional(), {
      description: "OpenCode model variant",
    }),
    agent: option(z.string().trim().min(1).optional(), {
      description: "OpenCode agent to use (default: build)",
    }),
    verbose: option(z.coerce.boolean().optional(), {
      description: "Include detailed progress information",
      argumentKind: "flag",
    }),
    json: option(z.coerce.boolean().optional(), {
      description: "Emit progress as JSON Lines",
      argumentKind: "flag",
    }),
    quiet: option(z.coerce.boolean().optional(), {
      description: "Only emit failures",
      argumentKind: "flag",
    }),
    "dry-run": option(z.coerce.boolean().optional(), {
      description: "Assess and route issues without implementation or mutations",
      argumentKind: "flag",
    }),
    workspace: option(z.string().trim().min(1).optional(), {
      description: "Directory used to clone and work on repositories",
    }),
    cleanup: option(z.coerce.boolean().optional(), {
      description: "Remove the workspace after a successful run",
      argumentKind: "flag",
    }),
    "start-clean": option(z.coerce.boolean().optional(), {
      description: "Remove an existing workspace before starting",
      argumentKind: "flag",
    }),
    resume: option(z.string().trim().min(1).optional(), {
      description: "Resume from a saved run-state JSON file",
    }),
  },
  handler: async ({ flags, positional, terminal, signal }) => {
    const [positionalRepo, ...extra] = positional;

    if (extra.length > 0) {
      throw new Error(`Unexpected argument: ${extra[0]}`);
    }
    const configPath = flags.config;
    const fileConfig =
      configPath === undefined
        ? {}
        : await Effect.gen(function* () {
            const files = yield* RalphieConfigFile;
            return yield* files.load(configPath);
          }).pipe(Effect.provide(RalphieConfigFileLive), Effect.runPromise);
    const config = resolveRalphieConfig(fileConfig, {
      ...(positionalRepo === undefined ? {} : { repo: positionalRepo }),
      ...(flags.workflow === undefined ? {} : { workflow: flags.workflow }),
      ...(flags["issue-concurrency"] === undefined
        ? {}
        : { issueConcurrency: flags["issue-concurrency"] }),
      ...(flags["agent-concurrency"] === undefined
        ? {}
        : { agentConcurrency: flags["agent-concurrency"] }),
      ...(flags.branch === undefined ? {} : { branch: flags.branch }),
      ...(flags["max-issues"] === undefined ? {} : { maxIssues: flags["max-issues"] }),
      ...(flags["issue-label"] === undefined
        ? {}
        : { issueLabels: flags["issue-label"] }),
      ...(flags["issue-sort"] === undefined ? {} : { issueSort: flags["issue-sort"] }),
      ...(flags["issue-order"] === undefined
        ? {}
        : { issueOrder: flags["issue-order"] }),
      ...(flags.model === undefined ? {} : { model: flags.model }),
      ...(flags["model-variant"] === undefined
        ? {}
        : { modelVariant: flags["model-variant"] }),
      ...(flags.agent === undefined ? {} : { agent: flags.agent }),
      ...(flags.workspace === undefined ? {} : { workspace: flags.workspace }),
      ...(flags.cleanup === undefined ? {} : { cleanup: flags.cleanup }),
      ...(flags["start-clean"] === undefined
        ? {}
        : { startClean: flags["start-clean"] }),
      ...(flags["dry-run"] === undefined ? {} : { dryRun: flags["dry-run"] }),
      ...(flags.resume === undefined ? {} : { resume: flags.resume }),
      ...(flags.verbose === undefined ? {} : { verbose: flags.verbose }),
      ...(flags.json === undefined ? {} : { json: flags.json }),
      ...(flags.quiet === undefined ? {} : { quiet: flags.quiet }),
    });

    const configuredTargets = config.projects.flatMap((project) =>
      project.targets.map((target) => ({ project: project.name, target })),
    );
    const explicitTargets = configuredTargets.filter(
      (entry) => entry.target.kind === RepositoryTargetKind.Explicit,
    );
    const repositoryRuns = await Promise.all(
      explicitTargets.map(async ({ project, target }) => {
        let resumeState: RunState | undefined;
        if (target.kind !== RepositoryTargetKind.Explicit) {
          throw new Error("Expected an explicit repository target.");
        }
        if (target.resume !== undefined) {
          const resumePath = target.resume;
          resumeState = await Effect.gen(function* () {
            const store = yield* RunStateStore;
            return yield* store.load(resumePath);
          }).pipe(Effect.provide(RunStateStoreLive), Effect.runPromise);
          if (target.branch !== undefined) {
            const reconciliation = reconcileRunState(resumeState, {
              project,
              repository: target.repo,
              branch: target.branch,
            });
            if (!reconciliation.compatible) {
              throw new Error(
                `Cannot resume run ${resumeState.runId}: ${reconciliation.reasons.join("; ")}.`,
              );
            }
          }
        }
        return { project, target, resumeState };
      }),
    );

    const progressMode = config.json
      ? ProgressRenderMode.Json
      : config.quiet
        ? ProgressRenderMode.Quiet
        : configuredTargets.length === 1 &&
            configuredTargets[0]?.target.kind === RepositoryTargetKind.Explicit &&
            terminal.isInteractive &&
            !terminal.isCI &&
            process.stderr.isTTY === true
          ? ProgressRenderMode.Interactive
          : ProgressRenderMode.Plain;
    const batchRunId =
      configuredTargets.length === 1 && repositoryRuns.length === 1
        ? (repositoryRuns[0]!.resumeState?.runId ?? crypto.randomUUID())
        : crypto.randomUUID();
    const eventLogPath =
      repositoryRuns.length !== 1 || repositoryRuns[0]?.target.resume === undefined
        ? join(
            resolveWorkspacePath(config.workspace),
            ".ralphie",
            "runs",
            batchRunId,
            "events.jsonl",
          )
        : join(dirname(repositoryRuns[0]!.target.resume!), "events.jsonl");
    const progressLayer = makeProgressReporterLayer({
      mode: progressMode,
      verbose: config.verbose,
      width: () => process.stderr.columns ?? terminal.width,
      write: config.json
        ? (text) => process.stdout.write(text)
        : (text) => process.stderr.write(text),
      runId: batchRunId,
      eventLogPath,
    });

    try {
      const repositories: WorkflowOptions[] = repositoryRuns.map(
        ({ project, target: repository, resumeState }) => ({
          workflow: repository.workflow,
          issueConcurrency: repository.issueConcurrency,
          project,
          repo: repository.repo,
          branch: repository.branch,
          maxIssues: repository.maxIssues,
          issueFilters: {
            labels: repository.issueLabels,
            sort: repository.issueSort,
            order: repository.issueOrder,
          },
          model: repository.model,
          modelVariant: repository.modelVariant,
          agent: repository.agent,
          workspace: config.workspace,
          cleanup: false,
          startClean: false,
          signal,
          runId: resumeState?.runId ?? crypto.randomUUID(),
          resumeState,
          resumePath: repository.resume,
          dryRun: repository.dryRun,
        }),
      );
      const repositoryPatterns: RepositoryPatternWorkflowOptions[] = configuredTargets
        .filter((entry) => entry.target.kind === RepositoryTargetKind.Pattern)
        .map(({ project, target }) => {
          if (target.kind !== RepositoryTargetKind.Pattern) {
            throw new Error("Expected a repository pattern target.");
          }
          return {
            workflow: target.workflow,
            issueConcurrency: target.issueConcurrency,
            project,
            repoPattern: target.repoPattern,
            branch: target.branch,
            maxIssues: target.maxIssues,
            issueFilters: {
              labels: target.issueLabels,
              sort: target.issueSort,
              order: target.issueOrder,
            },
            model: target.model,
            modelVariant: target.modelVariant,
            agent: target.agent,
            workspace: config.workspace,
            cleanup: false,
            startClean: false,
            signal,
            dryRun: target.dryRun,
          };
        });
      await batchWorkflow({
        repositories,
        repositoryPatterns,
        workspace: config.workspace,
        cleanup: config.cleanup,
        startClean: config.startClean,
        agentConcurrency: config.agentConcurrency,
      }).pipe(
        Effect.provide(LiveRuntime.pipe(Layer.provideMerge(progressLayer))),
        Effect.catchAll((error) =>
          Effect.fail(new Error(redactSensitiveText(error.message))),
        ),
        Effect.runPromise,
      );
    } catch (error) {
      process.exitCode = exitCodeForFailure(signal);
      throw error;
    }
  },
});

export default runCommand;
