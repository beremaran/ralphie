import type { DecompositionDepthLimitError } from "./decomposition-markdown.ts";
import { HandOffReason } from "./decisions.ts";
import {
    IssueExecutionOutcomeKind,
    type IssueExecutionOutcome,
} from "../app/execution.ts";

/** Turn the configured recursion ceiling into a controlled, non-halting route. */
export const decompositionLimitOutcome = (
    issueNumber: number,
    error: DecompositionDepthLimitError,
): IssueExecutionOutcome => ({
    kind: IssueExecutionOutcomeKind.HandOff,
    reason: HandOffReason.DecompositionLimitReached,
    summary:
        `Issue #${issueNumber} reached the configured maximum decomposition depth ` +
        `${error.maximumDepth}; Ralphie handed it off and will continue with independent issues.`,
    evidence: [
        `The next decomposition would create depth ${error.depth}, above limits.maxDecompositionDepth (${error.maximumDepth}).`,
    ],
    questions: [
        `Increase limits.maxDecompositionDepth above ${error.maximumDepth}, narrow the issue manually, or resolve the remaining review findings.`,
    ],
    route: "hand-off",
});