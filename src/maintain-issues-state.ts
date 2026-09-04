/**
 * Durable state for the one-shot maintain-issues runner.
 *
 * Maintenance state deliberately has its own discriminator and store.  The
 * issue workflow's queue state is a different state machine: it can create
 * branches, commits, pull requests, and issue relationships.  Reusing that
 * schema here would make a maintenance resume look deceptively compatible
 * while losing the exact GitHub action boundary this mode needs.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

import { IssueOrder, IssueSort } from "./github/issues.ts";
import { DuplicateAction } from "./options.ts";
import { RalphieError } from "./shared/error.ts";

export const MAINTENANCE_RUN_STATE_VERSION = 1 as const;
export const MAINTENANCE_STATE_VERSION = MAINTENANCE_RUN_STATE_VERSION;

export const MAINTENANCE_RUN_STATUSES = [
    "active",
    "failed",
    "complete",
] as const;
export type MaintenanceRunStatus = (typeof MAINTENANCE_RUN_STATUSES)[number];

export const MAINTENANCE_ACTION_STATUSES = [
    "pending",
    "in-progress",
    "applied",
    "unchanged",
    "skipped",
] as const;
export type MaintenanceActionStatus =
    (typeof MAINTENANCE_ACTION_STATUSES)[number];

export const MAINTENANCE_ISSUE_STATUSES = [
    "pending",
    "planned",
    "skipped",
    "complete",
] as const;
export type MaintenanceIssueStatus =
    (typeof MAINTENANCE_ISSUE_STATUSES)[number];

const positiveInteger = z
    .number()
    .int()
    .positive()
    .refine(Number.isSafeInteger, "Expected a safe positive integer.");
const nonNegativeInteger = z
    .number()
    .int()
    .nonnegative()
    .refine(Number.isSafeInteger, "Expected a safe non-negative integer.");
const timestamp = z.string().datetime();
const jsonValue = z.unknown();

const selectionSchema = z
    .object({
        agent: z.string().min(1),
        model: z
            .object({
                providerID: z.string().min(1),
                modelID: z.string().min(1),
            })
            .optional(),
        variant: z.string().min(1).optional(),
        maxIssues: positiveInteger.optional(),
        issueLabels: z.array(z.string()).readonly(),
        issueSort: z.enum(IssueSort),
        issueOrder: z.enum(IssueOrder),
    })
    .strict();

const actionStateSchema = z
    .object({
        actionKey: z.string().min(1),
        action: z.record(z.string(), jsonValue),
        status: z.enum(MAINTENANCE_ACTION_STATUSES),
        attempts: nonNegativeInteger,
        replanCount: nonNegativeInteger,
        result: jsonValue.optional(),
        updatedAt: timestamp,
    })
    .strict();

const issueStateSchema = z
    .object({
        issueNumber: positiveInteger,
        status: z.enum(MAINTENANCE_ISSUE_STATUSES),
        replanCount: nonNegativeInteger,
        replanRequested: z.boolean(),
        plan: jsonValue.optional(),
        candidates: jsonValue.optional(),
        skips: z.array(jsonValue).readonly(),
        actions: z.array(actionStateSchema).readonly(),
        outcome: jsonValue.optional(),
        updatedAt: timestamp,
    })
    .strict();

const reconciliationSchema = z
    .object({
        actionKey: z.string().min(1),
        issueNumber: positiveInteger,
        status: z.string().min(1),
        result: jsonValue,
        recordedAt: timestamp,
    })
    .strict();

const storedPlanSchema = z
    .object({
        issueNumber: positiveInteger,
        snapshotFingerprint: z.string().min(1),
        plan: jsonValue,
        candidates: jsonValue,
        skips: z.array(jsonValue).readonly(),
        replanCount: nonNegativeInteger,
        recordedAt: timestamp,
    })
    .strict();

export const maintenanceRunStateSchema = z
    .object({
        version: z.literal(MAINTENANCE_RUN_STATE_VERSION),
        mode: z.literal("maintain-issues"),
        status: z.enum(MAINTENANCE_RUN_STATUSES),
        runId: z.string().min(1),
        repository: z.string().min(1),
        branch: z.string().min(1),
        duplicateAction: z.enum(DuplicateAction),
        dryRun: z.boolean(),
        selection: selectionSchema,
        selectedIssueNumbers: z.array(positiveInteger).readonly(),
        nextIssueIndex: nonNegativeInteger,
        snapshotFingerprint: z.string().min(1).optional(),
        groundingFingerprint: z.string().min(1).optional(),
        plans: z.array(storedPlanSchema).readonly(),
        issues: z.array(issueStateSchema).readonly(),
        reconciliationResults: z.array(reconciliationSchema).readonly(),
        skips: z.array(jsonValue).readonly(),
        lastError: z.string().min(1).optional(),
        createdAt: timestamp,
        updatedAt: timestamp,
    })
    .strict();

export type MaintenanceSelectionState = z.infer<typeof selectionSchema>;
export type MaintenanceActionState = z.infer<typeof actionStateSchema>;
export type MaintenanceIssueState = z.infer<typeof issueStateSchema>;
export type MaintenanceStoredPlan = z.infer<typeof storedPlanSchema>;
export type MaintenanceReconciliationState = z.infer<
    typeof reconciliationSchema
>;
export type MaintenanceRunState = z.infer<typeof maintenanceRunStateSchema>;

const persistAtomically = async (
    path: string,
    state: MaintenanceRunState,
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
            message: `Failed to persist maintenance run state at ${path}.`,
            cause,
        });
    }
};

export type MaintenanceRunStateStoreService = {
    readonly save: (path: string, state: MaintenanceRunState) => Promise<void>;
    readonly load: (path: string) => Promise<MaintenanceRunState>;
};

/** Atomic, schema-validating maintenance state store. */
export const MaintenanceRunStateStoreLive: MaintenanceRunStateStoreService = {
    save: async (path, state) => {
        try {
            const validated = maintenanceRunStateSchema.parse(state);
            await persistAtomically(path, validated);
        } catch (cause) {
            if (cause instanceof RalphieError) throw cause;
            throw new RalphieError({
                message: `Failed to persist maintenance run state at ${path}.`,
                cause,
            });
        }
    },

    load: async (path) => {
        try {
            const value: unknown = JSON.parse(await readFile(path, "utf8"));
            if (
                typeof value === "object" &&
                value !== null &&
                "version" in value &&
                value.version !== MAINTENANCE_RUN_STATE_VERSION
            ) {
                throw new RalphieError({
                    message:
                        `Maintenance run state uses unsupported version ${String(value.version)}; ` +
                        `expected version ${String(MAINTENANCE_RUN_STATE_VERSION)}.`,
                });
            }
            return maintenanceRunStateSchema.parse(value);
        } catch (cause) {
            throw new RalphieError({
                message:
                    cause instanceof RalphieError
                        ? `Maintenance run state at ${path} is invalid or unreadable: ${cause.message}`
                        : `Maintenance run state at ${path} is invalid or unreadable.`,
                cause,
            });
        }
    },
};

export const MaintenanceStateStoreLive = MaintenanceRunStateStoreLive;

export type MaintenanceResumeExpectations = {
    readonly repository: string;
    readonly branch?: string;
    /** Omit when the caller did not explicitly choose a policy on resume. */
    readonly duplicateAction?: DuplicateAction;
    /** Maintenance and dry-run state machines cannot be resumed interchangeably. */
    readonly dryRun?: boolean;
};

/** Validate the compatibility boundary before any command resources start. */
export const validateMaintenanceResumeState = (
    state: MaintenanceRunState,
    expected: MaintenanceResumeExpectations,
): MaintenanceRunState => {
    const reasons: string[] = [];
    if (state.mode !== "maintain-issues") {
        reasons.push(`saved mode is ${state.mode}`);
    }
    if (state.repository !== expected.repository) {
        reasons.push(
            `saved repository is ${state.repository}, not ${expected.repository}`,
        );
    }
    if (state.branch !== (expected.branch ?? state.branch)) {
        reasons.push(
            `saved branch is ${state.branch}, not ${expected.branch ?? state.branch}`,
        );
    }
    if (
        expected.duplicateAction !== undefined &&
        state.duplicateAction !== expected.duplicateAction
    ) {
        reasons.push(
            `saved duplicate policy is ${state.duplicateAction}, not ${expected.duplicateAction}`,
        );
    }
    if (expected.dryRun !== undefined && state.dryRun !== expected.dryRun) {
        reasons.push(
            `saved dry-run mode is ${String(state.dryRun)}, not ${String(expected.dryRun)}`,
        );
    }
    if (state.status === "complete") {
        reasons.push("the saved maintenance run is already complete");
    }
    if (reasons.length > 0) {
        throw new RalphieError({
            message: `Cannot resume maintenance run ${state.runId}: ${reasons.join("; ")}.`,
        });
    }
    return state;
};

export const loadMaintenanceRunState = async (
    path: string,
    expected: MaintenanceResumeExpectations,
    store: MaintenanceRunStateStoreService = MaintenanceRunStateStoreLive,
): Promise<MaintenanceRunState> =>
    validateMaintenanceResumeState(await store.load(path), expected);

export const loadMaintenanceState = loadMaintenanceRunState;