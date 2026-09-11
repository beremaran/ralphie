import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

import { IssueExecutionOutcomeKind } from "../../core/app/issues/execution.ts";
import {
    NeedsAttentionReason,
    nonBlankStringSchema,
} from "../../core/app/issues/decisions.ts";
import { RalphieError } from "../../shared/error.ts";
import { DEFAULT_MAX_DECOMPOSITION_DEPTH } from "../../options.ts";

export const RUN_STATE_VERSION = 12 as const;

export enum RunStateStatus {
    Active = "active",
    Complete = "complete",
}

const issueSchema = z.object({
    number: z.number().int().positive(),
    title: z.string(),
    url: z.string(),
    body: z.string().nullable(),
    labels: z.array(z.string()),
    state: z.enum(["open", "closed"]).optional(),
    updatedAt: z.string().datetime().optional(),
    comments: z
        .array(
            z.object({
                id: z.number().int().positive(),
                body: z.string(),
                updatedAt: z.string().datetime(),
            }),
        )
        .readonly()
        .optional(),
    commentCount: z.number().int().nonnegative().optional(),
    commentVersion: z.string().min(1).optional(),
});

const needsAttentionOutcomeSchema = z.union([
    z
        .object({
            kind: z.literal(IssueExecutionOutcomeKind.NeedsAttention),
            reason: z.enum(NeedsAttentionReason),
            summary: nonBlankStringSchema,
            evidence: z.array(nonBlankStringSchema).min(1),
            questions: z.array(nonBlankStringSchema).min(1),
            artifactPath: z.string().min(1),
            route: z.literal("needs-attention").optional(),
        })
        .strict(),
    z
        .object({
            kind: z.literal(IssueExecutionOutcomeKind.NeedsAttention),
            reason: z.enum(NeedsAttentionReason),
            summary: nonBlankStringSchema,
            evidence: z.array(nonBlankStringSchema).min(1),
            questions: z.array(nonBlankStringSchema).min(1),
            diagnosticsPath: z.string().min(1),
            route: z.literal("needs-attention").optional(),
        })
        .strict(),
    z
        .object({
            kind: z.literal(IssueExecutionOutcomeKind.NeedsAttention),
            reason: z.enum(NeedsAttentionReason),
            summary: nonBlankStringSchema,
            evidence: z.array(nonBlankStringSchema).min(1),
            questions: z.array(nonBlankStringSchema).min(1),
            route: z.literal("needs-attention"),
        })
        .strict(),
]);

const currentOutcomeSchema = z.union([
    z.object({
        kind: z.literal(IssueExecutionOutcomeKind.Completed),
        completion: z.literal("pushed-commit"),
        commitSha: z.string().min(1),
        reviewCount: z.number().int().positive().optional(),
    }),
    z.object({
        kind: z.literal(IssueExecutionOutcomeKind.Completed),
        completion: z.literal("already-resolved"),
        resolutionSummary: z.string().min(1),
        evidence: z.array(z.string().min(1)).min(1),
    }),
    z.object({
        kind: z.literal(IssueExecutionOutcomeKind.Decomposed),
        childIssueNumbers: z.array(z.number().int().positive()),
    }),
    z.object({
        kind: z.literal(IssueExecutionOutcomeKind.Escalated),
        diagnosticsPath: z.string().min(1),
        reason: z.string().min(1),
        childIssueNumbers: z.array(z.number().int().positive()).optional(),
    }),
    needsAttentionOutcomeSchema,
    z
        .object({
            kind: z.literal(IssueExecutionOutcomeKind.Skipped),
            reason: z.string().min(1),
        })
        .strict(),
    z.object({
        kind: z.literal(IssueExecutionOutcomeKind.Failed),
        message: z.string().min(1),
    }),
]);

const outcomeSchema = z.preprocess((value) => {
    if (
        typeof value === "object" &&
        value !== null &&
        "kind" in value &&
        value.kind === IssueExecutionOutcomeKind.Completed &&
        !("completion" in value) &&
        "commitSha" in value
    ) {
        return {
            ...value,
            completion: "pushed-commit",
        };
    }
    return value;
}, currentOutcomeSchema);

const runStateFields = {
    status: z.enum(RunStateStatus),
    runId: z.string().min(1),
    repository: z.string().min(1),
    branch: z.string().min(1),
    /** Whether needs-attention outcomes should be published to GitHub. */
    notificationsEnabled: z.boolean().optional(),
    needsAttentionLabel: z.string().trim().min(1).optional(),
    selection: z.object({
        agent: z.string().min(1),
        model: z
            .object({
                providerID: z.string().min(1),
                modelID: z.string().min(1),
            })
            .optional(),
        variant: z.string().min(1).optional(),
    }),
    maxDecompositionDepth: z
        .number()
        .int()
        .positive()
        .default(DEFAULT_MAX_DECOMPOSITION_DEPTH),
    queue: z.object({
        pending: z.array(issueSchema),
        completedIssueNumbers: z.array(z.number().int().positive()),
        processedCount: z.number().int().nonnegative(),
    }),
    outcomes: z.array(
        z.object({
            issueNumber: z.number().int().positive(),
            outcome: outcomeSchema,
        }),
    ),
    /** Active issue stage for progress reporting, when known. */
    activeIssue: z
        .object({
            issueNumber: z.number().int().positive(),
            stage: z.string().min(1),
        })
        .optional(),
    checkout: z
        .object({
            branch: z.string().min(1),
            head: z.string().min(1),
        })
        .optional(),
    updatedAt: z.string().datetime(),
};

const runStateSchema = z.object({
    version: z.literal(RUN_STATE_VERSION),
    ...runStateFields,
});

export type RunState = z.infer<typeof runStateSchema>;

const persistRunStateAtomically = async (
    path: string,
    state: RunState,
): Promise<void> => {
    const temporaryPath = `${path}.tmp-${crypto.randomUUID()}`;
    try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
            flag: "wx",
        });
        await rename(temporaryPath, path);
    } catch (cause) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw new RalphieError({
            message: `Failed to persist run state at ${path}.`,
            cause,
        });
    }
};

export type RunStateStoreService = {
    readonly save: (path: string, state: RunState) => Promise<void>;
};

export const RunStateStoreLive: RunStateStoreService = {
    save: async (path, state) => {
        try {
            const validated = runStateSchema.parse(state);
            await persistRunStateAtomically(path, validated);
        } catch (cause) {
            throw new RalphieError({
                message: `Failed to persist run state at ${path}.`,
                cause,
            });
        }
    },
};