import { Context, type Effect } from "effect";

import type { RalphieError } from "../shared/error.ts";
import type {
  WorkflowExecutorInput,
  WorkflowExecutorResult,
} from "./workflow-executor-input.ts";

/** The implementation workflow for issues with complexity 0 through 3. */
export type ImplementationExecutorService = {
  readonly execute: (
    input: WorkflowExecutorInput,
  ) => Effect.Effect<WorkflowExecutorResult, RalphieError>;
};

export const ImplementationExecutor =
  Context.GenericTag<ImplementationExecutorService>(
    "ralphie/ImplementationExecutor",
  );
