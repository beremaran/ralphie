import { z } from "zod";

import { IssueOrder, IssueSort } from "../github/domain.ts";
import { HARNESS_NAMES } from "../harness/ports.ts";
import {
    TRIAGE_ROLES,
    type TriageLabels,
} from "../issues/domain/triage-roles.ts";
import { DEFAULT_MAX_DECOMPOSITION_DEPTH } from "../issues/domain/decomposition-markdown.ts";
import {
    DEFAULT_IMPLEMENTATION_ATTEMPTS,
    MAX_REVIEW_ROUNDS,
    REVIEW_ITERATION_LIMIT,
} from "../issues/domain/stage.ts";

export const DEFAULT_WORKSPACE = "~/.ralphie";

/** Minutes one session may run in a role that edits the checkout. */
export const DEFAULT_EDIT_SESSION_TIMEOUT_MINUTES = 60;

/** Minutes one session may run in a read-only role. */
export const DEFAULT_READ_ONLY_SESSION_TIMEOUT_MINUTES = 15;

const INTAKE_SORTS = [
    "created",
    "created:asc",
    "created:desc",
    "updated",
    "updated:asc",
    "updated:desc",
    "comments",
    "comments:asc",
    "comments:desc",
] as const;

const SAFE_SEGMENT = /^[A-Za-z0-9_.-]+$/;

const nonEmptyString = z.string().trim().min(1);
const positiveInteger = z.number().int().positive();

const intakeSchema = z.strictObject({
    requireLabels: z.array(nonEmptyString).default([]),
    sort: z.enum(INTAKE_SORTS).default("created:asc"),
});

/** AFK triage of issues that are not agent-ready yet. Opt-in. */
const triageSchema = z.strictObject({
    enabled: z.boolean().default(false),
});

/** A strict object with one entry per name, so the keys track the list. */
const keyedBy = <Key extends string, Schema extends z.ZodType>(
    keys: ReadonlyArray<Key>,
    schemaFor: (key: Key) => Schema,
) =>
    z.strictObject(
        Object.fromEntries(keys.map((key) => [key, schemaFor(key)])) as Record<
            Key,
            Schema
        >,
    );

/** Each triage role's label defaults to the role's own name. */
const labelsSchema = keyedBy(TRIAGE_ROLES, (role) =>
    nonEmptyString.default(role),
);

const sessionTimeoutSchema = z.strictObject({
    edit: positiveInteger.default(DEFAULT_EDIT_SESSION_TIMEOUT_MINUTES),
    readOnly: positiveInteger.default(
        DEFAULT_READ_ONLY_SESSION_TIMEOUT_MINUTES,
    ),
});

/** Where the skills injected into sessions come from. */
const skillsSchema = z.strictObject({
    dir: nonEmptyString.optional(),
});

const limitsSchema = z.strictObject({
    sessionTimeoutMinutes: sessionTimeoutSchema.prefault({}),
    maxBudgetUsd: z.number().positive().optional(),
    implementationAttempts: positiveInteger.default(
        DEFAULT_IMPLEMENTATION_ATTEMPTS,
    ),
    // Capped because review attempts are persisted and recovery validates
    // them against the same bound; verification fixes are never persisted.
    reviewRounds: positiveInteger
        .max(MAX_REVIEW_ROUNDS)
        .default(REVIEW_ITERATION_LIMIT),
    verificationFixes: positiveInteger.default(REVIEW_ITERATION_LIMIT),
    maxDecompositionDepth: positiveInteger.default(
        DEFAULT_MAX_DECOMPOSITION_DEPTH,
    ),
});

const harnessNameSchema = z.enum(HARNESS_NAMES);

/** `safe` runs editing roles under the harness's own approval or sandbox. */
const approvalSchema = z.enum(["safe", "yolo"]);

/** Model and reasoning effort for the sessions a harness runs. */
const harnessSettingsSchema = z.strictObject({
    model: nonEmptyString.optional(),
    effort: nonEmptyString.optional(),
    approval: approvalSchema.optional(),
    /** Opt in to a harness whose adapter is not verified live yet. */
    experimental: z.boolean().optional(),
});

const harnessesSchema = keyedBy(HARNESS_NAMES, () =>
    harnessSettingsSchema.optional(),
);

/** A role runs on a harness, optionally with its own model and effort. */
const roleAssignmentSchema = z.union([
    harnessNameSchema,
    z.strictObject({
        harness: harnessNameSchema,
        model: nonEmptyString.optional(),
        effort: nonEmptyString.optional(),
    }),
]);

const rolesSchema = z.strictObject({
    default: roleAssignmentSchema.optional(),
    reviewer: roleAssignmentSchema.optional(),
    triager: roleAssignmentSchema.optional(),
    preflight: roleAssignmentSchema.optional(),
    implementer: roleAssignmentSchema.optional(),
    fixer: roleAssignmentSchema.optional(),
    "standards-reviewer": roleAssignmentSchema.optional(),
    "spec-reviewer": roleAssignmentSchema.optional(),
    "resolution-verifier": roleAssignmentSchema.optional(),
    decomposer: roleAssignmentSchema.optional(),
});

/**
 * Keys allowed at the top level that a `repos:` entry may also override.
 * New repository-overridable settings belong here.
 */
const overridableSettings = {
    workspace: nonEmptyString.default(DEFAULT_WORKSPACE),
    approval: approvalSchema.default("safe"),
    harnesses: harnessesSchema.prefault({}),
    roles: rolesSchema.prefault({}),
    intake: intakeSchema.prefault({}),
    triage: triageSchema.prefault({}),
    labels: labelsSchema.prefault({}),
    skills: skillsSchema.prefault({}),
    limits: limitsSchema.prefault({}),
};

/** Keys that only make sense for a single repository. */
const repositoryOnlySettings = {
    branch: nonEmptyString.optional(),
    verify: z.array(nonEmptyString).default([]),
};

const repositoryEntrySchema = z.strictObject({
    ...overridableSettings,
    ...repositoryOnlySettings,
});

const repositoryKeySchema = z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "expected an owner/repo key");

const reposSchema = z
    .record(repositoryKeySchema, repositoryEntrySchema)
    .superRefine((repos, context) => {
        const seen = new Set<string>();
        for (const key of Object.keys(repos)) {
            const normalized = key.toLowerCase();
            if (seen.has(normalized)) {
                context.addIssue({
                    code: "custom",
                    path: [key],
                    message: "duplicates another repository key",
                });
            }
            seen.add(normalized);
        }
    });

/** The whole configuration file, after any `--set` overrides are applied. */
export const configFileSchema = z.strictObject({
    defaultOwner: z
        .string()
        .regex(SAFE_SEGMENT, "expected a GitHub user or organization name")
        .optional(),
    ...overridableSettings,
    repos: reposSchema.default({}),
});

const refineLabels = (labels: TriageLabels, context: z.RefinementCtx): void => {
    const roles = new Map<string, string>();
    for (const role of TRIAGE_ROLES) {
        const label = labels[role].toLowerCase();
        const other = roles.get(label);
        if (other !== undefined) {
            context.addIssue({
                code: "custom",
                path: ["labels", role],
                message: `uses the same label as ${other}`,
            });
        }
        roles.set(label, role);
    }
};

/** The effective settings for one repository, with every default applied. */
export const repositorySettingsSchema = repositoryEntrySchema.superRefine(
    (settings, context) => {
        refineLabels(settings.labels, context);
    },
);

export type RepositorySettings = z.output<typeof repositorySettingsSchema>;

/** Split an `intake.sort` value into the GitHub sort field and direction. */
export const intakeOrdering = (
    sort: RepositorySettings["intake"]["sort"],
): { readonly sort: IssueSort; readonly order: IssueOrder } => {
    const [field, order = IssueOrder.Ascending] = sort.split(":");
    return {
        sort: z.enum(IssueSort).parse(field),
        order: z.enum(IssueOrder).parse(order),
    };
};