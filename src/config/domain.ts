import { z } from "zod";

import { IssueOrder, IssueSort } from "../github/domain.ts";
import { DEFAULT_MAX_DECOMPOSITION_DEPTH } from "../issues/domain/decomposition-markdown.ts";

export const DEFAULT_WORKSPACE = "~/.ralphie";
export const DEFAULT_IMPLEMENTATION_ATTEMPTS = 3;
export const DEFAULT_REVIEW_ROUNDS = 5;
export const DEFAULT_VERIFICATION_FIXES = 5;
export const DEFAULT_ISSUE_SORT = "created:asc";

/** Matt Pocock's five canonical triage roles. */
export const TRIAGE_ROLES = [
    "needs-triage",
    "needs-info",
    "ready-for-agent",
    "ready-for-human",
    "wontfix",
] as const;
export type TriageRole = (typeof TRIAGE_ROLES)[number];

const nonEmpty = z.string().trim().min(1, "must not be empty");
const positiveInteger = z
    .number()
    .int("must be a positive integer")
    .positive("must be a positive integer");

const sortPattern = /^(created|updated|comments)(:(asc|desc))?$/;
const issueSortSchema = nonEmpty.regex(
    sortPattern,
    "must be created, updated or comments, optionally followed by :asc or :desc",
);

const labelsSchema = z.strictObject(
    Object.fromEntries(
        TRIAGE_ROLES.map((role) => [role, nonEmpty.optional()]),
    ) as Record<TriageRole, z.ZodOptional<typeof nonEmpty>>,
);

const settingsShape = {
    workspace: nonEmpty.optional(),
    intake: z
        .strictObject({
            requireLabels: z.array(nonEmpty).optional(),
            sort: issueSortSchema.optional(),
        })
        .optional(),
    labels: labelsSchema.optional(),
    limits: z
        .strictObject({
            implementationAttempts: positiveInteger.optional(),
            reviewRounds: positiveInteger.optional(),
            verificationFixes: positiveInteger.optional(),
            maxDecompositionDepth: positiveInteger.optional(),
        })
        .optional(),
};

const repositoryKey = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

const repoOverridesSchema = z.strictObject({
    ...settingsShape,
    branch: nonEmpty.optional(),
    verify: z.array(nonEmpty).optional(),
});

const reposSchema = z
    .record(z.string(), repoOverridesSchema)
    .superRefine((repos, context) => {
        const seen = new Set<string>();
        for (const key of Object.keys(repos)) {
            if (!repositoryKey.test(key)) {
                context.addIssue({
                    code: "custom",
                    path: [key],
                    message: "repository keys must look like owner/repo",
                });
            }
            if (seen.has(key.toLowerCase())) {
                context.addIssue({
                    code: "custom",
                    path: [key],
                    message:
                        "duplicates another repository key (GitHub names are case-insensitive)",
                });
            }
            seen.add(key.toLowerCase());
        }
    });

export const ralphieConfigSchema = z.strictObject({
    defaultOwner: nonEmpty.optional(),
    ...settingsShape,
    repos: reposSchema.optional(),
});

export type RalphieConfigDocument = z.infer<typeof ralphieConfigSchema>;
export type RepositoryOverrides = z.infer<typeof repoOverridesSchema>;

/** Every setting after defaults, the file, the repository entry and `--set`. */
export type ResolvedSettings = {
    readonly workspace: string;
    readonly branch?: string;
    readonly verify: ReadonlyArray<string>;
    readonly intake: {
        readonly requireLabels: ReadonlyArray<string>;
        readonly sort: IssueSort;
        readonly order: IssueOrder;
    };
    readonly labels: Readonly<Record<TriageRole, string>>;
    readonly limits: {
        readonly implementationAttempts: number;
        readonly reviewRounds: number;
        readonly verificationFixes: number;
        readonly maxDecompositionDepth: number;
    };
};

export const parseIssueSort = (
    value: string,
): { readonly sort: IssueSort; readonly order: IssueOrder } => {
    const [sort, order] = value.split(":");
    return {
        sort: sort as IssueSort,
        order: (order ?? "asc") as IssueOrder,
    };
};

export const applyDefaults = (
    settings: RepositoryOverrides,
): ResolvedSettings => {
    const { sort, order } = parseIssueSort(
        settings.intake?.sort ?? DEFAULT_ISSUE_SORT,
    );
    return {
        workspace: settings.workspace ?? DEFAULT_WORKSPACE,
        ...(settings.branch === undefined ? {} : { branch: settings.branch }),
        verify: settings.verify ?? [],
        intake: {
            requireLabels: settings.intake?.requireLabels ?? [],
            sort,
            order,
        },
        labels: Object.fromEntries(
            TRIAGE_ROLES.map((role) => [role, settings.labels?.[role] ?? role]),
        ) as Record<TriageRole, string>,
        limits: {
            implementationAttempts:
                settings.limits?.implementationAttempts ??
                DEFAULT_IMPLEMENTATION_ATTEMPTS,
            reviewRounds:
                settings.limits?.reviewRounds ?? DEFAULT_REVIEW_ROUNDS,
            verificationFixes:
                settings.limits?.verificationFixes ??
                DEFAULT_VERIFICATION_FIXES,
            maxDecompositionDepth:
                settings.limits?.maxDecompositionDepth ??
                DEFAULT_MAX_DECOMPOSITION_DEPTH,
        },
    };
};