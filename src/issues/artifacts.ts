import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

import type { IssueCheckpoint } from "../git/issue-checkpoint.ts";
import type { GitHubIssue } from "../github/issues.ts";
import {
    piNeedsAttentionRequestSchema,
    type PiNeedsAttentionRequest,
} from "../agent/task-session.ts";
import { RalphieError } from "../shared/error.ts";
import { resolveWorkspacePath } from "../workspace/workspace.ts";
import {
    commitMessageDecisionSchema,
    complexityDecisionSchema,
    issueBreakdownDecisionSchema,
    issueResolutionDecisionSchema,
    needsAttentionDecisionSchema,
    reviewDecisionSchema,
    type CommitMessageDecision,
    type ComplexityDecision,
    type IssueBreakdownDecision,
    type IssueResolutionDecision,
    type NeedsAttentionDecision,
} from "./decisions.ts";
import {
    approvedPullRequestReviewEvidenceSchema,
    pullRequestReviewAttemptsSchema,
    pullRequestReviewAttemptSchema,
    type ApprovedPullRequestReviewEvidence,
    type PullRequestReviewAttempt,
} from "./pull-request-review.ts";
import type { ReviewAttempt } from "./recovery.ts";
import { REVIEW_ITERATION_LIMIT } from "./stage.ts";
import { verificationEvidenceSchema } from "./verification.ts";

export enum IssueArtifactKind {
    ComplexityDecision = "complexity-decision",
    IssueCheckpoint = "issue-checkpoint",
    ReviewAttempts = "review-attempts",
    PullRequestReviewAttempts = "pull-request-review-attempts",
    ApprovedPullRequestReviewEvidence = "approved-pull-request-review-evidence",
    CommitMessageDecision = "commit-message-decision",
    CreatedCommit = "created-commit",
    IssueResolutionDecision = "issue-resolution-decision",
    NeedsAttentionDecision = "needs-attention-decision",
    NeedsAttentionHandoff = "needs-attention-handoff",
    IssueBreakdownDecision = "issue-breakdown-decision",
    CreatedIssueNumbers = "created-issue-numbers",
}

export type CreatedIssueNumberMapping = Readonly<Record<string, number>>;

export type IssueFreshnessFingerprint =
    | {
          readonly updatedAt: string;
          readonly commentCount: number;
          readonly commentVersion?: number | string;
      }
    | {
          readonly updatedAt: string;
          readonly commentCount?: number;
          readonly commentVersion: number | string;
      };

export type IssueFreshness = IssueFreshnessFingerprint;

export type NeedsAttentionDecisionArtifact = {
    readonly decision: NeedsAttentionDecision;
    readonly fingerprint: IssueFreshnessFingerprint;
};

export type ComplexityDecisionArtifact = {
    readonly decision: ComplexityDecision;
    readonly fingerprint: IssueFreshnessFingerprint;
};

export type IssueResolutionDecisionArtifact = {
    readonly decision: IssueResolutionDecision;
    readonly fingerprint: IssueFreshnessFingerprint;
};

export type NeedsAttentionArtifact = NeedsAttentionDecisionArtifact;

export type NeedsAttentionHandoffArtifact = {
    readonly request: PiNeedsAttentionRequest;
    readonly fingerprint: IssueFreshnessFingerprint;
    readonly checkpoint: IssueCheckpoint;
};

export type IssueArtifactValues = {
    readonly [IssueArtifactKind.ComplexityDecision]: ComplexityDecisionArtifact;
    readonly [IssueArtifactKind.IssueCheckpoint]: IssueCheckpoint;
    readonly [IssueArtifactKind.ReviewAttempts]: ReadonlyArray<ReviewAttempt>;
    readonly [IssueArtifactKind.PullRequestReviewAttempts]: ReadonlyArray<PullRequestReviewAttempt>;
    readonly [IssueArtifactKind.ApprovedPullRequestReviewEvidence]: ApprovedPullRequestReviewEvidence;
    readonly [IssueArtifactKind.CommitMessageDecision]: CommitMessageDecision;
    readonly [IssueArtifactKind.CreatedCommit]: {
        readonly sha: string;
        readonly treeSha: string;
    };
    readonly [IssueArtifactKind.IssueResolutionDecision]: IssueResolutionDecisionArtifact;
    readonly [IssueArtifactKind.NeedsAttentionDecision]: NeedsAttentionDecisionArtifact;
    readonly [IssueArtifactKind.NeedsAttentionHandoff]: NeedsAttentionHandoffArtifact;
    readonly [IssueArtifactKind.IssueBreakdownDecision]: IssueBreakdownDecision;
    readonly [IssueArtifactKind.CreatedIssueNumbers]: CreatedIssueNumberMapping;
};

export type IssueArtifactStore = {
    readonly issueNumber: number;
    readonly write: <K extends IssueArtifactKind>(
        kind: K,
        value: IssueArtifactValues[K],
    ) => Promise<void>;
    readonly read: <K extends IssueArtifactKind>(
        kind: K,
    ) => Promise<IssueArtifactValues[K]>;
    readonly has: (kind: IssueArtifactKind) => boolean;
    readonly appendReview: (review: ReviewAttempt) => Promise<void>;
    readonly appendPullRequestReview: (
        review: PullRequestReviewAttempt,
    ) => Promise<void>;
    readonly recordCreatedIssue: (
        key: string,
        issueNumber: number,
    ) => Promise<void>;
    /** Drop artifacts from an interrupted implementation attempt after checkout restore. */
    readonly resetImplementationAttempt: () => Promise<void>;
    /** Remove issue-derived decisions only when the live issue has changed. */
    readonly invalidateStaleIssueDecisions: (
        fingerprint: IssueFreshnessFingerprint,
    ) => Promise<boolean>;
    /** Remove a needs-attention decision only when the issue has changed. */
    readonly invalidateStaleNeedsAttentionDecision: (
        fingerprint: IssueFreshnessFingerprint,
    ) => Promise<boolean>;
    readonly invalidateNeedsAttentionDecision: (
        fingerprint: IssueFreshnessFingerprint,
    ) => Promise<boolean>;
    readonly clearNeedsAttentionHandoff: () => Promise<void>;
};

export type IssueArtifactScope = {
    readonly workspace: string;
    readonly runId: string;
    readonly repository?: string;
};

export type IssueArtifactStoreService = {
    readonly forIssue: (
        issueNumber: number,
        scope?: IssueArtifactScope,
    ) => Promise<IssueArtifactStore>;
    /** Load artifacts without migration or mutation persistence. */
    readonly forIssueReadOnly?: (
        issueNumber: number,
        scope?: IssueArtifactScope,
    ) => Promise<IssueArtifactStore>;
};

const validIssueNumber = (issueNumber: number): boolean =>
    Number.isInteger(issueNumber) && issueNumber > 0;

const validReviewOrder = (reviews: ReadonlyArray<ReviewAttempt>): boolean =>
    reviews.length <= REVIEW_ITERATION_LIMIT &&
    reviews.every((review, index) => review.attempt === index + 1);

const validCreatedIssueNumberMapping = (
    mapping: CreatedIssueNumberMapping,
): boolean =>
    Object.entries(mapping).every(
        ([key, issueNumber]) =>
            key.trim().length > 0 && validIssueNumber(issueNumber),
    );

const reviewAttemptSchema = z.object({
    attempt: z.number().int().positive(),
    sessionID: z.string().min(1),
    stagedTreeSha: z
        .string()
        .regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i)
        .optional(),
    verification: verificationEvidenceSchema.optional(),
    decision: reviewDecisionSchema,
});

const issueCheckpointSchema = z.object({
    branch: z.string().min(1),
    sha: z.string().min(1),
});

export const issueFreshnessFingerprintSchema = z
    .object({
        updatedAt: z.string().datetime(),
        commentCount: z.number().int().nonnegative().optional(),
        commentVersion: z
            .union([z.number().int().nonnegative(), z.string().min(1)])
            .optional(),
    })
    .strict()
    .superRefine((fingerprint, context) => {
        if (
            fingerprint.commentCount === undefined &&
            fingerprint.commentVersion === undefined
        ) {
            context.addIssue({
                code: "custom",
                message: "A freshness fingerprint must track issue comments.",
                path: ["commentCount"],
            });
        }
    });

export const needsAttentionDecisionArtifactSchema = z
    .object({
        decision: needsAttentionDecisionSchema,
        fingerprint: issueFreshnessFingerprintSchema,
    })
    .strict();

export const complexityDecisionArtifactSchema = z
    .object({
        decision: complexityDecisionSchema,
        fingerprint: issueFreshnessFingerprintSchema,
    })
    .strict();

export const issueResolutionDecisionArtifactSchema = z
    .object({
        decision: issueResolutionDecisionSchema,
        fingerprint: issueFreshnessFingerprintSchema,
    })
    .strict();

export const needsAttentionHandoffArtifactSchema = z
    .object({
        request: piNeedsAttentionRequestSchema,
        fingerprint: issueFreshnessFingerprintSchema,
        checkpoint: issueCheckpointSchema,
    })
    .strict();

const validatedArtifactSchemas: Partial<Record<IssueArtifactKind, z.ZodType>> =
    {
        [IssueArtifactKind.NeedsAttentionDecision]:
            needsAttentionDecisionArtifactSchema,
        [IssueArtifactKind.ComplexityDecision]:
            complexityDecisionArtifactSchema,
        [IssueArtifactKind.IssueResolutionDecision]:
            issueResolutionDecisionArtifactSchema,
        [IssueArtifactKind.ApprovedPullRequestReviewEvidence]:
            approvedPullRequestReviewEvidenceSchema,
        [IssueArtifactKind.NeedsAttentionHandoff]:
            needsAttentionHandoffArtifactSchema,
    };

const createdCommitSchema = z.object({
    sha: z.string().min(1),
    treeSha: z.string().min(1),
});

const matchingPullRequestApproval = (
    attempts: ReadonlyArray<PullRequestReviewAttempt> | undefined,
    evidence: ApprovedPullRequestReviewEvidence | undefined,
): boolean =>
    evidence === undefined ||
    attempts?.some(
        (attempt) =>
            attempt.pullRequestNumber === evidence.pullRequestNumber &&
            attempt.baseSha.toLowerCase() === evidence.baseSha.toLowerCase() &&
            attempt.reviewedHeadSha.toLowerCase() ===
                evidence.reviewedHeadSha.toLowerCase() &&
            attempt.attempt === evidence.attempt &&
            attempt.sessionID === evidence.sessionID &&
            JSON.stringify(attempt.decision) ===
                JSON.stringify(evidence.decision),
    ) === true;

const invalidateApprovalForDifferentHead = (
    nextValues: Map<IssueArtifactKind, unknown>,
    currentValues: ReadonlyMap<IssueArtifactKind, unknown>,
    reviewedHeadSha: string,
): void => {
    const approval = currentValues.get(
        IssueArtifactKind.ApprovedPullRequestReviewEvidence,
    ) as ApprovedPullRequestReviewEvidence | undefined;
    if (
        approval !== undefined &&
        approval.reviewedHeadSha.toLowerCase() !== reviewedHeadSha.toLowerCase()
    ) {
        nextValues.delete(IssueArtifactKind.ApprovedPullRequestReviewEvidence);
    }
};

const validatePullRequestApproval = (
    artifacts: {
        readonly [IssueArtifactKind.PullRequestReviewAttempts]?: ReadonlyArray<PullRequestReviewAttempt>;
        readonly [IssueArtifactKind.ApprovedPullRequestReviewEvidence]?: ApprovedPullRequestReviewEvidence;
    },
    context: z.RefinementCtx,
): void => {
    if (
        !matchingPullRequestApproval(
            artifacts[IssueArtifactKind.PullRequestReviewAttempts],
            artifacts[IssueArtifactKind.ApprovedPullRequestReviewEvidence],
        )
    ) {
        context.addIssue({
            code: "custom",
            message:
                "Approved pull request review evidence must match a stored approved attempt.",
            path: [IssueArtifactKind.ApprovedPullRequestReviewEvidence],
        });
    }
};

const persistedArtifactsV2BaseSchema = z
    .object({
        [IssueArtifactKind.ComplexityDecision]:
            complexityDecisionSchema.optional(),
        [IssueArtifactKind.IssueCheckpoint]: issueCheckpointSchema.optional(),
        [IssueArtifactKind.ReviewAttempts]: z
            .array(reviewAttemptSchema)
            .max(REVIEW_ITERATION_LIMIT)
            .optional(),
        [IssueArtifactKind.PullRequestReviewAttempts]:
            pullRequestReviewAttemptsSchema
                .max(REVIEW_ITERATION_LIMIT)
                .optional(),
        [IssueArtifactKind.ApprovedPullRequestReviewEvidence]:
            approvedPullRequestReviewEvidenceSchema.optional(),
        [IssueArtifactKind.CommitMessageDecision]:
            commitMessageDecisionSchema.optional(),
        [IssueArtifactKind.CreatedCommit]: createdCommitSchema.optional(),
        [IssueArtifactKind.IssueResolutionDecision]:
            issueResolutionDecisionSchema.optional(),
        [IssueArtifactKind.IssueBreakdownDecision]:
            issueBreakdownDecisionSchema.optional(),
        [IssueArtifactKind.CreatedIssueNumbers]: z
            .record(z.string(), z.number().int().positive())
            .optional(),
    })
    .strict();

const persistedArtifactsV2Schema = persistedArtifactsV2BaseSchema.superRefine(
    validatePullRequestApproval,
);

const persistedArtifactsSchema = persistedArtifactsV2BaseSchema
    .omit({
        [IssueArtifactKind.ComplexityDecision]: true,
        [IssueArtifactKind.IssueResolutionDecision]: true,
    })
    .extend({
        [IssueArtifactKind.ComplexityDecision]:
            complexityDecisionArtifactSchema.optional(),
        [IssueArtifactKind.IssueResolutionDecision]:
            issueResolutionDecisionArtifactSchema.optional(),
        [IssueArtifactKind.NeedsAttentionDecision]:
            needsAttentionDecisionArtifactSchema.optional(),
        [IssueArtifactKind.NeedsAttentionHandoff]:
            needsAttentionHandoffArtifactSchema.optional(),
    })
    .strict()
    .superRefine(validatePullRequestApproval);

// Keep the needs-attention artifact unparsed while loading so a malformed
// freshness record can be removed without discarding the other artifacts for
// the issue. Writes still use persistedArtifactsSchema, so invalid values can
// never be produced by this store.
const persistedArtifactsLoadSchema = persistedArtifactsV2BaseSchema
    .omit({
        [IssueArtifactKind.ComplexityDecision]: true,
        [IssueArtifactKind.IssueResolutionDecision]: true,
    })
    .extend({
        [IssueArtifactKind.ComplexityDecision]: z.unknown().optional(),
        [IssueArtifactKind.IssueResolutionDecision]: z.unknown().optional(),
        [IssueArtifactKind.NeedsAttentionDecision]: z.unknown().optional(),
        [IssueArtifactKind.NeedsAttentionHandoff]: z.unknown().optional(),
    })
    .strict();

export const ISSUE_ARTIFACT_VERSION = 4 as const;

const persistedArtifactStateSchema = z
    .object({
        version: z.literal(ISSUE_ARTIFACT_VERSION),
        issueNumber: z.number().int().positive(),
        repository: z.string().min(1).optional(),
        artifacts: persistedArtifactsSchema,
    })
    .strict();

const persistedArtifactStateLoadSchema = z
    .object({
        version: z.literal(ISSUE_ARTIFACT_VERSION),
        issueNumber: z.number().int().positive(),
        repository: z.string().min(1).optional(),
        artifacts: persistedArtifactsLoadSchema,
    })
    .strict();

const legacyPersistedArtifactStateSchema = z
    .object({
        version: z.literal(2),
        issueNumber: z.number().int().positive(),
        repository: z.string().min(1).optional(),
        artifacts: persistedArtifactsV2Schema,
    })
    .strict();

const legacyV3PersistedArtifactStateSchema = z
    .object({
        version: z.literal(3),
        issueNumber: z.number().int().positive(),
        repository: z.string().min(1).optional(),
        artifacts: persistedArtifactsLoadSchema,
    })
    .strict();

type PersistedArtifactState = z.infer<typeof persistedArtifactStateSchema>;
type ArtifactPersistence = (state: PersistedArtifactState) => Promise<void>;

const safeRunId = (runId: string): string =>
    runId.replace(/[^a-zA-Z0-9_-]/g, "_") || "run";

export const issueArtifactPath = (
    scope: IssueArtifactScope,
    issueNumber: number,
): string =>
    join(
        resolveWorkspacePath(scope.workspace),
        ".ralphie",
        "runs",
        safeRunId(scope.runId),
        "issues",
        String(issueNumber),
        "artifacts.json",
    );

export const getIssueArtifactPath = issueArtifactPath;
export const artifactPath = issueArtifactPath;

const toPersistedState = (
    issueNumber: number,
    values: ReadonlyMap<IssueArtifactKind, unknown>,
    scope?: IssueArtifactScope,
): PersistedArtifactState => {
    const artifacts: Record<string, unknown> = {};
    for (const kind of Object.values(IssueArtifactKind)) {
        const value = values.get(kind);
        if (value !== undefined) artifacts[kind] = value;
    }
    return persistedArtifactStateSchema.parse({
        version: ISSUE_ARTIFACT_VERSION,
        issueNumber,
        ...(scope?.repository === undefined
            ? {}
            : { repository: scope.repository }),
        artifacts,
    });
};

const persistAtomically = async (
    filePath: string,
    state: PersistedArtifactState,
): Promise<void> => {
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    try {
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
            encoding: "utf8",
            flag: "wx",
        });
        await rename(temporaryPath, filePath);
    } catch (cause) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw new RalphieError({
            message: `Failed to persist issue artifacts at ${filePath}.`,
            cause,
        });
    }
};

type LoadedArtifactState = {
    readonly state: PersistedArtifactState;
    readonly migrated: boolean;
    readonly decisionsInvalidated: boolean;
};

const loadCurrentArtifactState = (value: unknown): LoadedArtifactState => {
    const loaded = persistedArtifactStateLoadSchema.parse(value);
    const schemas = {
        [IssueArtifactKind.ComplexityDecision]:
            complexityDecisionArtifactSchema,
        [IssueArtifactKind.IssueResolutionDecision]:
            issueResolutionDecisionArtifactSchema,
        [IssueArtifactKind.NeedsAttentionDecision]:
            needsAttentionDecisionArtifactSchema,
        [IssueArtifactKind.NeedsAttentionHandoff]:
            needsAttentionHandoffArtifactSchema,
    } as const;
    const stale = Object.entries(schemas).filter(([kind, schema]) => {
        const artifact = loaded.artifacts[kind as keyof typeof schemas];
        return artifact !== undefined && !schema.safeParse(artifact).success;
    });
    if (stale.length > 0) {
        const remainingArtifacts = { ...loaded.artifacts };
        for (const [kind] of stale) {
            delete remainingArtifacts[kind as keyof typeof remainingArtifacts];
        }
        return {
            state: persistedArtifactStateSchema.parse({
                ...loaded,
                artifacts: remainingArtifacts,
            }),
            migrated: false,
            decisionsInvalidated: true,
        };
    }
    return {
        state: persistedArtifactStateSchema.parse(loaded),
        migrated: false,
        decisionsInvalidated: false,
    };
};

const migrateArtifactState = (
    value: unknown,
    filePath: string,
): LoadedArtifactState => {
    if (
        typeof value === "object" &&
        value !== null &&
        "version" in value &&
        value.version === 2
    ) {
        const legacy = legacyPersistedArtifactStateSchema.parse(value);
        return {
            state: persistedArtifactStateSchema.parse({
                ...legacy,
                version: ISSUE_ARTIFACT_VERSION,
                artifacts: Object.fromEntries(
                    Object.entries(legacy.artifacts).filter(
                        ([kind]) =>
                            kind !== IssueArtifactKind.ComplexityDecision &&
                            kind !== IssueArtifactKind.IssueResolutionDecision,
                    ),
                ),
            }),
            migrated: true,
            decisionsInvalidated: true,
        };
    }
    if (
        typeof value === "object" &&
        value !== null &&
        "version" in value &&
        value.version === 3
    ) {
        const legacy = legacyV3PersistedArtifactStateSchema.parse(value);
        const loaded = loadCurrentArtifactState({
            ...legacy,
            version: ISSUE_ARTIFACT_VERSION,
        });
        return { ...loaded, migrated: true };
    }
    if (
        typeof value === "object" &&
        value !== null &&
        "version" in value &&
        value.version !== ISSUE_ARTIFACT_VERSION
    ) {
        throw new RalphieError({
            message: `Persisted artifacts at ${filePath} use unsupported version ${String(value.version)}; expected version ${ISSUE_ARTIFACT_VERSION}.`,
        });
    }
    return loadCurrentArtifactState(value);
};

const loadPersistedState = async (
    filePath: string,
    issueNumber: number,
    scope?: IssueArtifactScope,
): Promise<LoadedArtifactState | undefined> => {
    let encoded: string;
    try {
        encoded = await readFile(filePath, "utf8");
    } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT")
            return undefined;
        throw new RalphieError({
            message: `Failed to load issue artifacts at ${filePath}.`,
            cause,
        });
    }

    try {
        const loaded = migrateArtifactState(JSON.parse(encoded), filePath);
        const { state } = loaded;
        if (state.issueNumber !== issueNumber) {
            throw new RalphieError({
                message: `Persisted artifacts at ${filePath} belong to issue ${state.issueNumber}, not issue ${issueNumber}.`,
            });
        }
        if (
            state.repository !== undefined &&
            scope?.repository !== undefined &&
            state.repository !== scope.repository
        ) {
            throw new RalphieError({
                message: `Persisted artifacts at ${filePath} belong to repository ${state.repository}, not ${scope.repository}.`,
            });
        }
        return loaded;
    } catch (cause) {
        if (cause instanceof RalphieError) {
            throw new RalphieError({
                message: `Failed to load issue artifacts at ${filePath}: ${cause.message}`,
                cause,
            });
        }
        throw new RalphieError({
            message: `Failed to load issue artifacts at ${filePath}.`,
            cause,
        });
    }
};

export const sameIssueFreshnessFingerprint = (
    left: IssueFreshnessFingerprint,
    right: IssueFreshnessFingerprint,
): boolean =>
    left.updatedAt === right.updatedAt &&
    left.commentCount === right.commentCount &&
    left.commentVersion === right.commentVersion;

export const issueFreshnessFingerprint = (
    issue: GitHubIssue,
): IssueFreshnessFingerprint => {
    const parsed = issueFreshnessFingerprintSchema.safeParse({
        ...(issue.updatedAt === undefined
            ? {}
            : { updatedAt: issue.updatedAt }),
        ...(issue.commentCount === undefined
            ? {}
            : { commentCount: issue.commentCount }),
        ...(issue.commentVersion === undefined
            ? {}
            : { commentVersion: issue.commentVersion }),
    });
    if (parsed.success) return parsed.data as IssueFreshnessFingerprint;
    throw new RalphieError({
        message:
            `Issue #${issue.number} does not have a valid freshness fingerprint; ` +
            "live decisions require updatedAt and a comment count or comment version.",
        cause: parsed.error,
    });
};

const validateArtifactValue = (
    issueNumber: number,
    kind: IssueArtifactKind,
    value: unknown,
): void => {
    const schema = validatedArtifactSchemas[kind];
    if (!schema) return;
    try {
        schema.parse(value);
    } catch (cause) {
        throw new RalphieError({
            message: `Artifact ${kind} for issue ${issueNumber} is invalid.`,
            cause,
        });
    }
};

const makeStore = (
    issueNumber: number,
    initialValues = new Map<IssueArtifactKind, unknown>(),
    persistence?: ArtifactPersistence,
    scope?: IssueArtifactScope,
): IssueArtifactStore => {
    const values = initialValues;
    const save = async (
        nextValues: ReadonlyMap<IssueArtifactKind, unknown>,
    ): Promise<void> => {
        if (persistence === undefined) {
            values.clear();
            for (const [kind, value] of nextValues) values.set(kind, value);
            return;
        }
        const state = toPersistedState(issueNumber, nextValues, scope);
        await persistence(state);
        values.clear();
        for (const [kind, value] of nextValues) values.set(kind, value);
    };

    const invalidateStaleNeedsAttentionDecision = async (
        fingerprint: IssueFreshnessFingerprint,
    ): Promise<boolean> => {
        try {
            issueFreshnessFingerprintSchema.parse(fingerprint);
        } catch (cause) {
            throw new RalphieError({
                message: `Freshness fingerprint for issue ${issueNumber} is invalid.`,
                cause,
            });
        }
        const existing = values.get(IssueArtifactKind.NeedsAttentionDecision);
        const handoff = values.get(IssueArtifactKind.NeedsAttentionHandoff) as
            | NeedsAttentionHandoffArtifact
            | undefined;
        const decisionMatches =
            existing === undefined ||
            sameIssueFreshnessFingerprint(
                (existing as NeedsAttentionDecisionArtifact).fingerprint,
                fingerprint,
            );
        const handoffMatches =
            handoff === undefined ||
            sameIssueFreshnessFingerprint(handoff.fingerprint, fingerprint);
        if (decisionMatches && handoffMatches) {
            return false;
        }
        const nextValues = new Map(values);
        nextValues.delete(IssueArtifactKind.NeedsAttentionDecision);
        nextValues.delete(IssueArtifactKind.NeedsAttentionHandoff);
        await save(nextValues);
        return true;
    };

    const invalidateStaleIssueDecisions = async (
        fingerprint: IssueFreshnessFingerprint,
    ): Promise<boolean> => {
        issueFreshnessFingerprintSchema.parse(fingerprint);
        const kinds = [
            IssueArtifactKind.ComplexityDecision,
            IssueArtifactKind.IssueResolutionDecision,
            IssueArtifactKind.NeedsAttentionDecision,
        ] as const;
        const stale = kinds.filter((kind) => {
            const artifact = values.get(kind) as
                | { readonly fingerprint: IssueFreshnessFingerprint }
                | undefined;
            return (
                artifact !== undefined &&
                !sameIssueFreshnessFingerprint(
                    artifact.fingerprint,
                    fingerprint,
                )
            );
        });
        if (stale.length === 0) return false;
        const nextValues = new Map(values);
        for (const kind of stale) nextValues.delete(kind);
        await save(nextValues);
        return true;
    };

    return {
        issueNumber,
        write: async (kind, value) => {
            if (values.has(kind)) {
                throw new RalphieError({
                    message: `Artifact ${kind} has already been produced for issue ${issueNumber}.`,
                });
            }
            validateArtifactValue(issueNumber, kind, value);
            if (
                kind === IssueArtifactKind.ReviewAttempts &&
                !validReviewOrder(value as ReadonlyArray<ReviewAttempt>)
            ) {
                throw new RalphieError({
                    message: `Review attempts for issue ${issueNumber} must be ordered from 1 through ${REVIEW_ITERATION_LIMIT}.`,
                });
            }
            if (
                kind === IssueArtifactKind.CreatedIssueNumbers &&
                !validCreatedIssueNumberMapping(
                    value as CreatedIssueNumberMapping,
                )
            ) {
                throw new RalphieError({
                    message: `Created issue numbers for issue ${issueNumber} must use non-empty keys and positive issue numbers.`,
                });
            }
            if (
                kind === IssueArtifactKind.ApprovedPullRequestReviewEvidence &&
                !matchingPullRequestApproval(
                    values.get(IssueArtifactKind.PullRequestReviewAttempts) as
                        | ReadonlyArray<PullRequestReviewAttempt>
                        | undefined,
                    value as ApprovedPullRequestReviewEvidence,
                )
            ) {
                throw new RalphieError({
                    message: `Approved pull request review evidence for issue ${issueNumber} must match a stored approved attempt.`,
                });
            }
            const nextValues = new Map(values);
            nextValues.set(kind, value);
            await save(nextValues);
        },

        read: async (kind) => {
            const value = values.get(kind);
            if (value === undefined) {
                throw new RalphieError({
                    message: `Artifact ${kind} has not been produced for issue ${issueNumber}.`,
                });
            }
            return value as IssueArtifactValues[typeof kind];
        },

        has: (kind) => values.has(kind),

        appendPullRequestReview: async (review) => {
            let validated: PullRequestReviewAttempt;
            try {
                validated = pullRequestReviewAttemptSchema.parse(review);
            } catch (cause) {
                throw new RalphieError({
                    message: `Invalid pull request review attempt for issue ${issueNumber}.`,
                    cause,
                });
            }
            const existing = (values.get(
                IssueArtifactKind.PullRequestReviewAttempts,
            ) ?? []) as ReadonlyArray<PullRequestReviewAttempt>;
            if (validated.attempt !== existing.length + 1) {
                throw new RalphieError({
                    message: `Pull request review attempts for issue ${issueNumber} must be appended in order.`,
                });
            }
            if (existing.length >= REVIEW_ITERATION_LIMIT) {
                throw new RalphieError({
                    message: `Pull request review attempt budget exhausted for issue ${issueNumber}.`,
                });
            }
            const first = existing[0];
            if (
                first &&
                (first.pullRequestNumber !== validated.pullRequestNumber ||
                    first.baseSha !== validated.baseSha)
            ) {
                throw new RalphieError({
                    message: `Pull request review attempt does not match the stored PR/base for issue ${issueNumber}.`,
                });
            }
            const nextValues = new Map(values);
            nextValues.set(IssueArtifactKind.PullRequestReviewAttempts, [
                ...existing,
                validated,
            ]);
            invalidateApprovalForDifferentHead(
                nextValues,
                values,
                validated.reviewedHeadSha,
            );
            await save(nextValues);
        },

        appendReview: async (review) => {
            if (!review || !Number.isInteger(review.attempt)) {
                throw new RalphieError({
                    message: `Invalid review attempt for issue ${issueNumber}.`,
                });
            }
            const existing = (values.get(IssueArtifactKind.ReviewAttempts) ??
                []) as ReadonlyArray<ReviewAttempt>;
            if (review.attempt !== existing.length + 1) {
                throw new RalphieError({
                    message: `Review attempts for issue ${issueNumber} must be appended in order; expected attempt ${existing.length + 1}.`,
                });
            }
            if (existing.length >= REVIEW_ITERATION_LIMIT) {
                throw new RalphieError({
                    message: `Review attempt budget exhausted for issue ${issueNumber}.`,
                });
            }
            const nextValues = new Map(values);
            nextValues.set(IssueArtifactKind.ReviewAttempts, [
                ...existing,
                review,
            ]);
            await save(nextValues);
        },

        recordCreatedIssue: async (key, createdIssueNumber) => {
            if (
                key.trim().length === 0 ||
                !validIssueNumber(createdIssueNumber)
            ) {
                throw new RalphieError({
                    message: `Created issue mapping for issue ${issueNumber} requires a non-empty key and positive issue number.`,
                });
            }
            const existing = (values.get(
                IssueArtifactKind.CreatedIssueNumbers,
            ) ?? {}) as CreatedIssueNumberMapping;
            if (existing[key] !== undefined) {
                throw new RalphieError({
                    message: `Created issue mapping already contains key ${key} for issue ${issueNumber}.`,
                });
            }
            const nextValues = new Map(values);
            nextValues.set(IssueArtifactKind.CreatedIssueNumbers, {
                ...existing,
                [key]: createdIssueNumber,
            });
            await save(nextValues);
        },

        resetImplementationAttempt: async () => {
            const nextValues = new Map(values);
            nextValues.delete(IssueArtifactKind.ReviewAttempts);
            nextValues.delete(IssueArtifactKind.CommitMessageDecision);
            nextValues.delete(IssueArtifactKind.CreatedCommit);
            nextValues.delete(IssueArtifactKind.IssueResolutionDecision);
            await save(nextValues);
        },

        invalidateStaleIssueDecisions,
        invalidateStaleNeedsAttentionDecision,
        invalidateNeedsAttentionDecision: invalidateStaleNeedsAttentionDecision,
        clearNeedsAttentionHandoff: async () => {
            if (!values.has(IssueArtifactKind.NeedsAttentionHandoff)) return;
            const nextValues = new Map(values);
            nextValues.delete(IssueArtifactKind.NeedsAttentionHandoff);
            await save(nextValues);
        },
    };
};

export const makeIssueArtifactStore = async (
    issueNumber: number,
): Promise<IssueArtifactStore> => {
    if (!validIssueNumber(issueNumber)) {
        throw new RalphieError({
            message: `Cannot create an artifact store for issue ${issueNumber}.`,
        });
    }
    return makeStore(issueNumber);
};

const valuesFromLoadedState = (
    loaded: LoadedArtifactState | undefined,
): Map<IssueArtifactKind, unknown> => {
    const values = new Map<IssueArtifactKind, unknown>();
    if (loaded === undefined) return values;
    for (const kind of Object.values(IssueArtifactKind)) {
        const value = loaded.state.artifacts[kind];
        if (value !== undefined) values.set(kind, value);
    }
    return values;
};

export const makeDurableIssueArtifactStore = async (
    issueNumber: number,
    scope: IssueArtifactScope,
): Promise<IssueArtifactStore> => {
    if (!validIssueNumber(issueNumber)) {
        throw new RalphieError({
            message: `Cannot create an artifact store for issue ${issueNumber}.`,
        });
    }
    const filePath = issueArtifactPath(scope, issueNumber);
    const loaded = await loadPersistedState(filePath, issueNumber, scope);
    if (loaded?.migrated === true || loaded?.decisionsInvalidated === true) {
        await persistAtomically(filePath, loaded.state);
    }
    return makeStore(
        issueNumber,
        valuesFromLoadedState(loaded),
        (nextState) => persistAtomically(filePath, nextState),
        scope,
    );
};

/**
 * Read a durable issue record while keeping all subsequent writes in memory.
 * Dry runs use this variant so loading a legacy or stale record cannot rewrite
 * the per-issue artifact file.
 */
export const makeReadOnlyDurableIssueArtifactStore = async (
    issueNumber: number,
    scope: IssueArtifactScope,
): Promise<IssueArtifactStore> => {
    if (!validIssueNumber(issueNumber)) {
        throw new RalphieError({
            message: `Cannot create an artifact store for issue ${issueNumber}.`,
        });
    }
    const loaded = await loadPersistedState(
        issueArtifactPath(scope, issueNumber),
        issueNumber,
        scope,
    );
    return makeStore(issueNumber, valuesFromLoadedState(loaded));
};

export const makeIssueArtifactStoreService = (): IssueArtifactStoreService => {
    const stores = new Map<string, IssueArtifactStore>();
    const readOnlyStores = new Map<string, IssueArtifactStore>();

    return {
        forIssue: async (issueNumber, scope) => {
            const key = scope
                ? `${resolveWorkspacePath(scope.workspace)}\u0000${safeRunId(scope.runId)}\u0000${issueNumber}`
                : `memory\u0000${issueNumber}`;
            const existing = stores.get(key);
            if (existing !== undefined) return existing;

            const store = scope
                ? await makeDurableIssueArtifactStore(issueNumber, scope)
                : await makeIssueArtifactStore(issueNumber);
            stores.set(key, store);
            return store;
        },
        forIssueReadOnly: async (issueNumber, scope) => {
            const key = scope
                ? `${resolveWorkspacePath(scope.workspace)}\u0000${safeRunId(scope.runId)}\u0000${issueNumber}`
                : `memory\u0000${issueNumber}`;
            const existing = readOnlyStores.get(key);
            if (existing !== undefined) return existing;

            const store = scope
                ? await makeReadOnlyDurableIssueArtifactStore(
                      issueNumber,
                      scope,
                  )
                : await makeIssueArtifactStore(issueNumber);
            readOnlyStores.set(key, store);
            return store;
        },
    };
};

export const IssueArtifactStoreLive = makeIssueArtifactStoreService;