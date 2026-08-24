import { Context, type Effect } from "effect";

import type { RalphieError } from "../shared/error.ts";
import type {
  WorkflowExecutorInput,
  WorkflowExecutorResult,
} from "./workflow-executor-input.ts";

/** The decomposition workflow for issues with complexity 4 or 5. */
export type DecompositionExecutorService = {
  readonly execute: (
    input: WorkflowExecutorInput,
  ) => Effect.Effect<WorkflowExecutorResult, RalphieError>;
};

export const DecompositionExecutor =
  Context.GenericTag<DecompositionExecutorService>(
    "ralphie/DecompositionExecutor",
  );
