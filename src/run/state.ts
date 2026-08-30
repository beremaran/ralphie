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

export const RUN_STATE_VERSION = 6 as const;

/** Terminal and transitional states of an active PR delivery gate. */
export const PR_CLOSURE_GATE_STATUSES = [
    "pending",
    "green",
    "failed",
    "cancelled",
    "unknown",
    "no-pipelines",
    "timeout",
    "aborted",
    "stale",
    "unmergeable",
    "closed",
    "merged",
] as const;

export type PrClosureGateStatus = (typeof PR_CLOSURE_GATE_STATUSES)[number];

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

const pipelineSnapshotSchema = z
    .object({
        repository: z.string().min(1),
        branch: z.string().min(1),
        commitSha: z.string().min(1),
        state: z.enum(["empty", "non-empty"]),
        items: z.array(z.record(z.string(), z.unknown())).readonly(),
        sourceErrors: z.array(z.record(z.string(), z.unknown())).readonly(),
        completenessErrors: z.array(z.string()).readonly(),
        diagnostics: z.array(z.record(z.string(), z.unknown())).readonly(),
        reason: z.enum([
            "success",
            "pending",
            "failure",
            "no-checks",
            "timeout",
            "unknown",
            "cancelled",
            "error",
        ]),
        greenCandidate: z.boolean(),
        fingerprint: z.string().min(1),
    })
    .strict();

/**
 * Durable state of an active PR closure gate. The snapshot and status are
 * updated atomically whenever polling changes them; the record is kept in
 * run state so a resumed run can continue polling or re-evaluate a saved
 * decision without re-creating the PR.
 */
const prClosureSchema = z
    .object({
        pullRequestNumber: z.number().int().positive(),
        observedHeadSha: z.string().min(1),
        /** Latest normalized check snapshot observed by the gate. */
        snapshot: pipelineSnapshotSchema.optional(),
        /** Observation start timestamp, kept across resume. */
        startedAt: z.string().datetime(),
        /** Timestamp of the last atomic state update. */
        updatedAt: z.string().datetime(),
        gate: z.enum(PR_CLOSURE_GATE_STATUSES),
        /** Details when the gate reached a terminal non-merged state. */
        terminalReason: z.string().min(1).optional(),
    })
    .strict()
    .optional();

const runStateFields = {
    status: z.enum(RunStateStatus),
    runId: z.string().min(1),
    repository: z.string().min(1),
    branch: z.string().min(1),
    workflow: z.enum(WorkflowMode).optional(),
    onNeedsAttention: z.enum(NeedsAttentionPolicy),
    dryRun: z.boolean().optional(),
    /** Whether needs-attention outcomes should be published to GitHub. */
    notificationsEnabled: z.boolean().optional(),
    needsAttentionLabel: z.string().trim().min(1).optional(),
    pendingNotification: z
        .object({
            issueNumber: z.number().int().positive(),
            outcome: needsAttentionOutcomeSchema,
            labelName: z.string().trim().min(1).optional(),
        })
        .strict()
        .optional(),
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
    /** Active PR closure gate state for the current issue (pr workflow). */
    prClosure: prClosureSchema,
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
    version: z.union([z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
    ...runStateFields,
    onNeedsAttention: z.enum(NeedsAttentionPolicy).optional(),
});

// Keep versions 4 and 5 resumable as in-memory inputs while all newly
// persisted state is validated as version 6 by runStateSchema.
type RunStateFields = z.infer<z.ZodObject<typeof runStateFields>>;
export type RunState = RunStateFields & { readonly version: 4 | 5 | 6 };

type LoadedRunState = {
    readonly state: RunState;
    readonly migrated: boolean;
};

const migrateRunState = (value: unknown): LoadedRunState => {
    if (
        typeof value === "object" &&
        value !== null &&
        "version" in value &&
        (value.version === 2 ||
            value.version === 3 ||
            value.version === 4 ||
            value.version === 5)
    ) {
        const legacy = legacyRunStateSchema.parse(value);
        return {
            state: runStateSchema.parse({
                ...legacy,
                version: RUN_STATE_VERSION,
                onNeedsAttention:
                    legacy.onNeedsAttention ?? DEFAULT_NEEDS_ATTENTION_POLICY,
                notificationsEnabled: legacy.notificationsEnabled ?? false,
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