import { defineCommand, option } from "@bunli/core";
import { Effect } from "effect";
import { z } from "zod";

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
