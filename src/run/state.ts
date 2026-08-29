import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

import {
    DRY_RUN_ROUTES,
    type IssueCompletionKind,
    IssueExecutionOutcomeKind,
} from "../issues/execution.ts";
import {
    NeedsAttentionReason,
    nonBlankStringSchema,
} from "../issues/decisions.ts";
import { RalphieError } from "../shared/error.ts";
import {
    DEFAULT_NEEDS_ATTENTION_POLICY,
    NeedsAttentionPolicy,
    WorkflowMode,
} from "../options.ts";

export const RUN_STATE_VERSION = 4 as const;

const dryRunRouteSchema = z.enum(DRY_RUN_ROUTES);

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
    z.union([
        z
            .object({
                kind: z.literal(IssueExecutionOutcomeKind.NeedsAttention),
                reason: z.enum(NeedsAttentionReason),
                summary: nonBlankStringSchema,
                evidence: z.array(nonBlankStringSchema).min(1),
                questions: z.array(nonBlankStringSchema).min(1),
                artifactPath: z.string().min(1),
                route: z.literal("needs-attention").optional(),
                policy: z.enum(NeedsAttentionPolicy).optional(),
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
                policy: z.enum(NeedsAttentionPolicy).optional(),
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
                policy: z.enum(NeedsAttentionPolicy).optional(),
            })
            .strict(),
    ]),
    z
        .object({
            kind: z.literal(IssueExecutionOutcomeKind.Skipped),
            reason: z.string().min(1),
            route: dryRunRouteSchema.optional(),
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

export const runStateOutcomeSchema = outcomeSchema;

const runStateFields = {
    status: z.enum(RunStateStatus),
    runId: z.string().min(1),
    repository: z.string().min(1),
    branch: z.string().min(1),
    workflow: z.enum(WorkflowMode).optional(),
    onNeedsAttention: z.enum(NeedsAttentionPolicy),
    dryRun: z.boolean().optional(),
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
    maxIssues: z.number().int().positive().optional(),
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

export const runStateSchema = z.object({
    version: z.literal(RUN_STATE_VERSION),
    ...runStateFields,
});

const legacyRunStateSchema = z.object({
    version: z.union([z.literal(2), z.literal(3)]),
    ...runStateFields,
    onNeedsAttention: z.enum(NeedsAttentionPolicy).optional(),
});

export type RunState = z.infer<typeof runStateSchema>;

type LoadedRunState = {
    readonly state: RunState;
    readonly migrated: boolean;
};

const migrateRunState = (value: unknown): LoadedRunState => {
    if (
        typeof value === "object" &&
        value !== null &&
        "version" in value &&
        (value.version === 2 || value.version === 3)
    ) {
        const legacy = legacyRunStateSchema.parse(value);
        return {
            state: runStateSchema.parse({
                ...legacy,
                version: RUN_STATE_VERSION,
                onNeedsAttention:
                    legacy.onNeedsAttention ?? DEFAULT_NEEDS_ATTENTION_POLICY,
            }),
            migrated: true,
        };
    }
    if (
        typeof value === "object" &&
        value !== null &&
        "version" in value &&
        value.version !== RUN_STATE_VERSION
    ) {
        throw new RalphieError({
            message: `Run state uses unsupported version ${String(value.version)}; expected version ${RUN_STATE_VERSION}.`,
        });
    }
    return { state: runStateSchema.parse(value), migrated: false };
};

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
    readonly load: (path: string) => Promise<RunState>;
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

    load: async (path) => {
        try {
            const loaded = migrateRunState(
                JSON.parse(await readFile(path, "utf8")),
            );
            if (loaded.migrated) {
                await persistRunStateAtomically(path, loaded.state);
            }
            return loaded.state;
        } catch (cause) {
            throw new RalphieError({
                message:
                    cause instanceof RalphieError
                        ? `Run state at ${path} is invalid or unreadable: ${cause.message}`
                        : `Run state at ${path} is invalid or unreadable.`,
                cause,
            });
        }
    },
};