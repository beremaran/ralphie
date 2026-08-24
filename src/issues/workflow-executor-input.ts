import type { IssueArtifactStore } from "./artifacts.ts";
import type { IssueExecutionContext, IssueExecutionOutcome } from "./execution.ts";

/**
 * Inputs shared by the concrete per-issue workflow executors.
 *
 * The artifact store is passed explicitly so an executor can persist each
 * decision and deterministic checkpoint as it progresses. Keeping it next to
 * the execution context also makes the boundary easy to exercise with a
 * per-issue store in tests and in a future live implementation.
 */
export type WorkflowExecutorInput = {
  readonly context: IssueExecutionContext;
  readonly artifacts: IssueArtifactStore;
};

export type WorkflowExecutorResult = IssueExecutionOutcome;
