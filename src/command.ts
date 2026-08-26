import { defineCommand, option } from "@bunli/core";
import { Effect, Layer } from "effect";
import { dirname, join } from "node:path";
import { z } from "zod";

import {
  WorkflowMode,
  resolveRalphieConfig,
  type ResolvedRalphieConfig,
} from "./options.ts";
import { IssueOrder, IssueSort } from "./github/issues.ts";
import { piModelSchema, piModelVariantSchema } from "./agent/model.ts";
import { makeProgressReporterLayer, ProgressRenderMode } from "./progress/progress.ts";
import { type PiProviderConfig } from "./pi/config.ts";
import { PiLive } from "./pi/server.ts";
import { LiveRuntime } from "./runtime.ts";
import { exitCodeForFailure } from "./process/exit-code.ts";
import { workflow } from "./workflow.ts";
import { redactSensitiveText } from "./shared/redaction.ts";
import { type RunState, RunStateStore, RunStateStoreLive } from "./run/state.ts";
import { reconcileRunState } from "./run/reconciliation.ts";
import { resolveWorkspacePath } from "./workspace/workspace.ts";
import { type PiModel } from "./agent/model.ts";

/**
 * Build the Pi provider configuration for this run.
 *
 * When `--model-base-url` is supplied, the provider/model id default to the
 * `--model` segments so the common case needs no extra flags; explicit
 * `--model-provider`/`--model-id` override them. `--agent-dir` opts out of the
 * generated config entirely (Option A).
 */
const resolvePiConfig = (
  config: ResolvedRalphieConfig,
  model: PiModel | undefined,
  modelBaseUrl: string | undefined,
  modelApiKey: string | undefined,
  modelProvider: string | undefined,
  modelId: string | undefined,
  agentDir: string | undefined,
): PiProviderConfig => ({
  workspace: config.workspace,
  modelBaseUrl,
  modelApiKey,
  modelProvider: modelProvider ?? model?.providerID,
  modelId: modelId ?? model?.modelID,
  agentDir,
});

export const runCommand = defineCommand({
  name: "run",
  description: "Run Ralphie against a GitHub repository",
  options: {
    branch: option(z.string().min(1).optional(), {
      short: "b",
      description: "Branch to operate on (default: main, otherwise master)",
    }),
    workflow: option(z.enum(WorkflowMode).optional(), {
      description: "Delivery workflow: lgtm, pr, or parallel-pr",
    }),
    "issue-concurrency": option(z.coerce.number().int().positive().optional(), {
      description: "Concurrent issues in parallel-pr mode",
    }),
    "agent-concurrency": option(z.coerce.number().int().positive().optional(), {
      description: "Maximum concurrent Pi agent tasks",
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
    model: option(piModelSchema.optional(), {
      description: "Pi model in provider/model format",
    }),
    "model-variant": option(piModelVariantSchema.optional(), {
      description: "Pi thinking level (off through max)",
    }),
    "model-base-url": option(z.string().trim().min(1).optional(), {
      description:
        "OpenAI-compatible base URL for the model runtime (env: RALPHIE_MODEL_BASE_URL). When set, Ralphie writes a throwaway, 0600 Pi config into the workspace so no pre-existing Pi setup is required.",
    }),
    "api-key": option(z.string().trim().min(1).optional(), {
      description:
        "API key for the OpenAI-compatible model runtime (env: RALPHIE_MODEL_API_KEY). Written to a 0600 file in the workspace and removed after the run.",
    }),
    "model-provider": option(z.string().trim().min(1).optional(), {
      description:
        "Provider id to register for the OpenAI-compatible runtime (default: openai, or the --model provider segment)",
    }),
    "model-id": option(z.string().trim().min(1).optional(), {
      description: "Model id to register for the OpenAI-compatible runtime",
    }),
    "agent-dir": option(z.string().trim().min(1).optional(), {
      description:
        "Use an existing Pi agent directory (models.json/auth.json) instead of generating a temporary one",
    }),
    agent: option(z.string().trim().min(1).optional(), {
      description: "Compatibility label for task diagnostics (default: build)",
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
      description: "Directory used to clone and work on the repository",
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
    if (extra.length > 0) throw new Error(`Unexpected argument: ${extra[0]}`);

    const config = resolveRalphieConfig({
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
      ...(flags["model-base-url"] === undefined
        ? {}
        : { modelBaseUrl: flags["model-base-url"] }),
      ...(flags["api-key"] === undefined
        ? {}
        : { modelApiKey: flags["api-key"] }),
      ...(flags["model-provider"] === undefined
        ? {}
        : { modelProvider: flags["model-provider"] }),
      ...(flags["model-id"] === undefined
        ? {}
        : { modelId: flags["model-id"] }),
      ...(flags["agent-dir"] === undefined
        ? {}
        : { agentDir: flags["agent-dir"] }),
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

    let resumeState: RunState | undefined;
    if (config.resume !== undefined) {
      resumeState = await Effect.gen(function* () {
        const store = yield* RunStateStore;
        return yield* store.load(config.resume!);
      }).pipe(Effect.provide(RunStateStoreLive), Effect.runPromise);
      if (config.branch !== undefined) {
        const reconciliation = reconcileRunState(resumeState, {
          repository: config.repo,
          branch: config.branch,
        });
        if (!reconciliation.compatible) {
          throw new Error(
            `Cannot resume run ${resumeState.runId}: ${reconciliation.reasons.join("; ")}.`,
          );
        }
      }
    }

    const progressMode = config.json
      ? ProgressRenderMode.Json
      : config.quiet
        ? ProgressRenderMode.Quiet
        : terminal.isInteractive && !terminal.isCI && process.stderr.isTTY === true
          ? ProgressRenderMode.Interactive
          : ProgressRenderMode.Plain;
    const runId = resumeState?.runId ?? crypto.randomUUID();
    const eventLogPath =
      config.resume === undefined
        ? join(
            resolveWorkspacePath(config.workspace),
            ".ralphie",
            "runs",
            runId,
            "events.jsonl",
          )
        : join(dirname(config.resume), "events.jsonl");
    const progressLayer = makeProgressReporterLayer({
      mode: progressMode,
      verbose: config.verbose,
      width: () => process.stderr.columns ?? terminal.width,
      write: config.json
        ? (text) => process.stdout.write(text)
        : (text) => process.stderr.write(text),
      runId,
      eventLogPath,
    });

    try {
      await workflow({
        workflow: config.workflow,
        issueConcurrency: config.issueConcurrency,
        agentConcurrency: config.agentConcurrency,
        repo: config.repo,
        branch: config.branch,
        maxIssues: config.maxIssues,
        issueFilters: {
          labels: config.issueLabels,
          sort: config.issueSort,
          order: config.issueOrder,
        },
        model: config.model,
        modelVariant: config.modelVariant,
        agent: config.agent,
        workspace: config.workspace,
        cleanup: config.cleanup,
        startClean: config.startClean,
        signal,
        runId,
        resumeState,
        resumePath: config.resume,
        dryRun: config.dryRun,
      }).pipe(
        Effect.provide(
          Layer.provideMerge(
            progressLayer,
            LiveRuntime,
            PiLive(
              resolvePiConfig(
                config,
                flags.model,
                flags["model-base-url"],
                flags["api-key"],
                flags["model-provider"],
                flags["model-id"],
                flags["agent-dir"],
              ),
            ),
          ),
        ),
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
