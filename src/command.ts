import { defineCommand, option } from "@bunli/core";
import { Effect } from "effect";
import { z } from "zod";

import { IssueOrder, IssueSort } from "./github/issues.ts";
import {
  openCodeModelSchema,
  openCodeModelVariantSchema,
} from "./opencode/model.ts";
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
  handler: async ({ flags, positional }) => {
    const [repo, ...extra] = positional;

    if (!repo) {
      throw new Error("Missing required repository argument.");
    }
    if (extra.length > 0) {
      throw new Error(`Unexpected argument: ${extra[0]}`);
    }

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
      workspace: flags.workspace,
      cleanup: flags.cleanup,
      startClean: flags["start-clean"],
    }).pipe(
      Effect.provide(LiveRuntime),
      Effect.catchAll((error) => Effect.fail(new Error(error.message))),
      Effect.runPromise,
    );
  },
});

export default runCommand;
