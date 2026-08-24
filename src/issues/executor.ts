import { Context, type Effect } from "effect";

import type { RalphieError } from "../shared/error.ts";
import type {
  IssueExecutionContext,
  IssueExecutionOutcome,
} from "./execution.ts";

export type IssueExecutorService = {
  readonly execute: (
    context: IssueExecutionContext,
  ) => Effect.Effect<IssueExecutionOutcome, RalphieError>;
};

export const IssueExecutor = Context.GenericTag<IssueExecutorService>(
  "ralphie/IssueExecutor",
);
