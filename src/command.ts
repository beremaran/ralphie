import { defineCommand, option } from "@bunli/core";
import { Effect } from "effect";
import { z } from "zod";

import { LiveRuntime } from "./services.ts";
import { workflow } from "./workflow.ts";

export const runCommand = defineCommand({
  name: "run",
  description: "Run Ralphie against a GitHub repository",
  options: {
    branch: option(z.string().min(1).default("main"), {
      short: "b",
      description: "Branch to operate on",
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

    await workflow(repo, flags.branch).pipe(
      Effect.provide(LiveRuntime),
      Effect.catchAll((error) => Effect.fail(new Error(error.message))),
      Effect.runPromise,
    );
  },
});

export default runCommand;
