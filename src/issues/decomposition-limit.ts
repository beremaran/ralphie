import type { DecompositionDepthLimitError } from "../github/decomposition-markdown.ts";
import { NeedsAttentionPolicy } from "../options.ts";
import { NeedsAttentionReason } from "./decisions.ts";
import {
    IssueExecutionOutcomeKind,
    type IssueExecutionOutcome,
} from "./execution.ts";

/** Turn the configured recursion ceiling into a controlled, non-halting route. */
export const decompositionLimitOutcome = (
    issueNumber: number,
    error: DecompositionDepthLimitError,
): IssueExecutionOutcome => ({
    kind: IssueExecutionOutcomeKind.NeedsAttention,
    reason: NeedsAttentionReason.DecompositionLimitReached,
    summary:
        `Issue #${issueNumber} reached the configured maximum decomposition depth ` +
        `${error.maximumDepth}; Ralphie left it open and will continue with independent issues.`,
    evidence: [
        `The next decomposition would create depth ${error.depth}, above --max-decomposition-depth ${error.maximumDepth}.`,
    ],
    questions: [
        `Increase --max-decomposition-depth above ${error.maximumDepth}, narrow the issue manually, or resolve the remaining review findings.`,
    ],
    route: "needs-attention",
    policy: NeedsAttentionPolicy.Continue,
});