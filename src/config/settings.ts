import { z } from "zod";

import { IssueOrder, IssueSort } from "../github/domain.ts";
import { DEFAULT_MAX_DECOMPOSITION_DEPTH } from "../issues/domain/decomposition-markdown.ts";
import {
    DEFAULT_IMPLEMENTATION_ATTEMPTS,
    MAX_REVIEW_ROUNDS,
    REVIEW_ITERATION_LIMIT,
} from "../issues/domain/stage.ts";

export const DEFAULT_WORKSPACE = "~/.ralphie";

/** Matt Pocock's five canonical triage roles, in his documented order. */
export const TRIAGE_ROLES = [
    "needs-triage",
    "needs-info",
    "ready-for-agent",
    "ready-for-human",
    "wontfix",
] as const;

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

const labelsSchema = z.strictObject({
    "needs-triage": nonEmptyString.default("needs-triage"),
    "needs-info": nonEmptyString.default("needs-info"),
    "ready-for-agent": nonEmptyString.default("ready-for-agent"),
    "ready-for-human": nonEmptyString.default("ready-for-human"),
    wontfix: nonEmptyString.default("wontfix"),
});

const limitsSchema = z.strictObject({
    implementationAttempts: positiveInteger.default(
        DEFAULT_IMPLEMENTATION_ATTEMPTS,
    ),
    reviewRounds: positiveInteger
        .max(MAX_REVIEW_ROUNDS)
        .default(REVIEW_ITERATION_LIMIT),
    verificationFixes: positiveInteger.default(REVIEW_ITERATION_LIMIT),
    maxDecompositionDepth: positiveInteger.default(
        DEFAULT_MAX_DECOMPOSITION_DEPTH,
    ),
});

/** Temporary needs-attention notification opt-in, until hand-offs replace it. */
const notificationsSchema = z.strictObject({
    enabled: z.boolean().default(false),
    label: nonEmptyString.optional(),
});

/**
 * Keys allowed at the top level that a `repos:` entry may also override.
 * New repository-overridable settings belong here.
 */
const overridableSettings = {
    workspace: nonEmptyString.default(DEFAULT_WORKSPACE),
    intake: intakeSchema.prefault({}),
    labels: labelsSchema.prefault({}),
    limits: limitsSchema.prefault({}),
    notifications: notificationsSchema.prefault({}),
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

const refineLabels = (
    labels: Readonly<Record<(typeof TRIAGE_ROLES)[number], string>>,
    context: z.RefinementCtx,
): void => {
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
        if (
            settings.notifications.label !== undefined &&
            !settings.notifications.enabled
        ) {
            context.addIssue({
                code: "custom",
                path: ["notifications", "label"],
                message: "requires notifications.enabled: true",
            });
        }
    },
);

export type RepositorySettings = z.output<typeof repositorySettingsSchema>;

export type TriageLabels = RepositorySettings["labels"];

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