import { isTimedOutSession } from "../../agent/sessions.ts";
import {
    buildImplementationAfterResolutionCorrectionPrompt,
    buildImplementationPrompt,
    buildImplementationRetryPrompt,
} from "../../agent/prompts.ts";
import {
    HAND_OFF_MESSAGE_LIMIT,
    HAND_OFF_REASONS,
    type HandOffRequest,
} from "../../agent/task-session.ts";
import { z } from "zod";
import { skillInvocation } from "../../harness/app/skill-injection.ts";
import {
    type IssueExecutionContext,
    type WorkflowExecutorInput,
} from "./execution-model.ts";
import {
    type CommitMessageDecision,
    commitMessageDecisionSchema,
} from "../domain/decisions.ts";

/**
 * One implementation attempt: the result the implementer submits, the prompt
 * for a first attempt or a retry, and when a failed attempt is retried.
 */
/**
 * The result of the implementer's `/implement` session: `done` carries the
 * commit message for the staged changes, `needs_attention` a hand-off request.
 */
export const implementationResultSchema = z
    .object({
        status: z.enum(["done", "needs_attention"]),
        summary: z.string().trim().min(1),
        commitMessage: commitMessageDecisionSchema.optional(),
        needsAttention: z
            .object({
                reason: z.enum(HAND_OFF_REASONS),
                questions: z.array(z.string().trim().min(1)).min(1).max(10),
            })
            .strict()
            .optional(),
    })
    .strict()
    .superRefine((result, context) => {
        if (result.status === "done" && result.commitMessage === undefined) {
            context.addIssue({
                code: "custom",
                path: ["commitMessage"],
                message: "A done result must include a commitMessage.",
            });
        }
        if (
            result.status === "needs_attention" &&
            result.needsAttention === undefined
        ) {
            context.addIssue({
                code: "custom",
                path: ["needsAttention"],
                message:
                    "A needs_attention result must include needsAttention.",
            });
        }
    });

export type ImplementationResult = z.infer<typeof implementationResultSchema>;

/** Used when a rejected hand-off request lets the work continue without a message. */
export const fallbackCommitMessage = (issue: {
    readonly number: number;
}): CommitMessageDecision => ({ subject: `Address issue #${issue.number}` });

export const handoffRequest = (
    result: ImplementationResult,
): HandOffRequest | undefined =>
    result.status !== "needs_attention" || result.needsAttention === undefined
        ? undefined
        : {
              reason: result.needsAttention.reason,
              message: [result.summary, ...result.needsAttention.questions]
                  .join("\n")
                  .slice(0, HAND_OFF_MESSAGE_LIMIT),
          };

const promptInput = (context: IssueExecutionContext) => ({
    issue: context.issue,
    repositoryPath: context.repositoryPath,
    targetBranch: context.targetBranch,
    implementInvocation: skillInvocation(
        context.agent.roles.implementer.harness,
        "implement",
    ),
});

/** Why an earlier implementation attempt is being retried. */
export type RetryReason =
    | { readonly kind: "unresolved"; readonly summary: string }
    | { readonly kind: "timeout" };

export const implementationPrompt = (
    input: WorkflowExecutorInput,
    attempt: number,
    retry: RetryReason | undefined,
): string => {
    const { context, unresolvedResolution } = input;
    if (attempt === 1 && unresolvedResolution !== undefined) {
        return buildImplementationAfterResolutionCorrectionPrompt({
            ...promptInput(context),
            unresolvedSummary: unresolvedResolution.summary,
            evidence: unresolvedResolution.evidence,
        });
    }
    if (retry?.kind === "unresolved") {
        return buildImplementationRetryPrompt({
            ...promptInput(context),
            unresolvedSummary: retry.summary,
            attempt,
        });
    }
    if (retry?.kind === "timeout") {
        return `${buildImplementationPrompt(promptInput(context))}

This is implementation attempt ${attempt}. The previous implementation session timed out before it submitted a result. Its edits may remain in the checkout: inspect them, finish the work and submit the implementation result.`;
    }
    return buildImplementationPrompt(promptInput(context));
};

/**
 * Whether a failed implementation session should be retried: only a timeout,
 * only while attempts remain, and never once the run was cancelled.
 */
export const retriesAfterTimeout = (
    error: unknown,
    attempt: number,
    budget: number,
    signal: AbortSignal | undefined,
): boolean =>
    isTimedOutSession(error) && attempt < budget && signal?.aborted !== true;