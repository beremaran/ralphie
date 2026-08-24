import { defineCommand, option } from "@bunli/core";
import { Effect, Layer } from "effect";
import { z } from "zod";

import { IssueOrder, IssueSort } from "./github/issues.ts";
import {
  openCodeAgentSchema,
  openCodeModelSchema,
  openCodeModelVariantSchema,
} from "./opencode/model.ts";
import {
  makeProgressReporterLayer,
  ProgressRenderMode,
} from "./progress/progress.ts";
import { LiveRuntime } from "./runtime.ts";
import { workflow } from "./workflow.ts";

export const runCommand = defineCommand({
  name: "run",
  description: "Run Ralphie against a GitHub repository",
  options: {
    branch: option(z.string().min(1).default("main"), {
      short: "b",
      description: "Branch to operate on",
    }),
    "max-issues": option(z.coerce.number().int().positive().optional(), {
      description: "Maximum number of issues to process (default: unlimited)",
    }),
    "issue-label": option(z.array(z.string().trim().min(1)).default([]), {
      description: "Only include issues with this label (repeatable)",
      repeatable: true,
    }),
    "issue-sort": option(z.enum(IssueSort).default(IssueSort.Created), {
      description: "Sort issues by created, updated, or comments",
    }),
    "issue-order": option(z.enum(IssueOrder).default(IssueOrder.Ascending), {
      description: "Sort issues in ascending or descending order",
    }),
    model: option(openCodeModelSchema.optional(), {
      description: "OpenCode model in provider/model format",
    }),
    "model-variant": option(openCodeModelVariantSchema.optional(), {
      description: "OpenCode model variant",
    }),
    agent: option(openCodeAgentSchema, {
      description: "OpenCode agent to use (default: build)",
    }),
    verbose: option(z.coerce.boolean().default(false), {
      description: "Include detailed progress information",
      argumentKind: "flag",
    }),
    json: option(z.coerce.boolean().default(false), {
      description: "Emit progress as JSON Lines",
      argumentKind: "flag",
    }),
    quiet: option(z.coerce.boolean().default(false), {
      description: "Only emit failures",
      argumentKind: "flag",
    }),
    workspace: option(z.string().trim().min(1).default("~/.ralphie"), {
      description: "Directory used to clone and work on repositories",
    }),
    cleanup: option(z.coerce.boolean().default(false), {
      description: "Remove the workspace after a successful run",
      argumentKind: "flag",
    }),
    "start-clean": option(z.coerce.boolean().default(false), {
      description: "Remove an existing workspace before starting",
      argumentKind: "flag",
    }),
  },
  handler: async ({ flags, positional, spinner, terminal, signal }) => {
    const [repo, ...extra] = positional;

    if (!repo) {
      throw new Error("Missing required repository argument.");
    }
    if (extra.length > 0) {
      throw new Error(`Unexpected argument: ${extra[0]}`);
    }
    if (flags.json && flags.quiet) {
      throw new Error("--json and --quiet cannot be used together.");
    }

    const progressMode = flags.json
      ? ProgressRenderMode.Json
      : flags.quiet
        ? ProgressRenderMode.Quiet
        : terminal.isInteractive
          ? ProgressRenderMode.Interactive
          : ProgressRenderMode.Plain;
    const progressLayer = makeProgressReporterLayer({
      mode: progressMode,
      verbose: flags.verbose,
      spinner,
      write: flags.json
        ? (text) => process.stdout.write(text)
        : (text) => process.stderr.write(text),
    });

    await workflow({
      repo,
      branch: flags.branch,
      maxIssues: flags["max-issues"],
      issueFilters: {
        labels: flags["issue-label"],
        sort: flags["issue-sort"],
        order: flags["issue-order"],
      },
      model: flags.model,
      modelVariant: flags["model-variant"],
      agent: flags.agent,
      workspace: flags.workspace,
      cleanup: flags.cleanup,
      startClean: flags["start-clean"],
      signal,
    }).pipe(
      Effect.provide(Layer.merge(LiveRuntime, progressLayer)),
      Effect.catchAll((error) => Effect.fail(new Error(error.message))),
      Effect.runPromise,
    );
  },
});

export default runCommand;
