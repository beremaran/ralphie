import { z } from "zod";

import { ReviewVerdict, reviewDecisionSchema } from "./decisions.ts";

/** Full object IDs are required so review evidence cannot follow a moving ref. */
export const gitObjectIdSchema = z
    .string()
    .regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i);

export const pullRequestReviewAttemptSchema = z
    .object({
        pullRequestNumber: z.number().int().positive(),
        baseSha: gitObjectIdSchema,
        reviewedHeadSha: gitObjectIdSchema,
        attempt: z.number().int().positive(),
        sessionID: z.string().min(1),
        decision: reviewDecisionSchema,
    })
    .strict();

export type PullRequestReviewAttempt = z.infer<
    typeof pullRequestReviewAttemptSchema
>;

/** A recoverable attempt history is ordered and permanently scoped to one PR/base. */
export const pullRequestReviewAttemptsSchema = z
    .array(pullRequestReviewAttemptSchema)
    .superRefine((attempts, context) => {
        const first = attempts[0];
        for (const [index, attempt] of attempts.entries()) {
            if (attempt.attempt !== index + 1) {
                context.addIssue({
                    code: "custom",
                    message: "Pull request review attempts must be ordered.",
                    path: [index, "attempt"],
                });
            }
            if (
                first &&
                (attempt.pullRequestNumber !== first.pullRequestNumber ||
                    attempt.baseSha !== first.baseSha)
            ) {
                context.addIssue({
                    code: "custom",
                    message:
                        "Pull request review attempts must share one PR/base.",
                    path: [index],
                });
            }
        }
    });

/** Durable proof of approval, permanently scoped to one PR head. */
export const approvedPullRequestReviewEvidenceSchema =
    pullRequestReviewAttemptSchema.refine(
        (attempt) => attempt.decision.verdict === ReviewVerdict.Approved,
        {
            message:
                "Approved review evidence must contain an approved decision.",
        },
    );

export type ApprovedPullRequestReviewEvidence = z.infer<
    typeof approvedPullRequestReviewEvidenceSchema
>;