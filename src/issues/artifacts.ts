import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

import type { IssueCheckpoint } from "../git/issue-checkpoint.ts";
import { RalphieError } from "../shared/error.ts";
import { resolveWorkspacePath } from "../workspace/workspace.ts";
import {
    commitMessageDecisionSchema,
    complexityDecisionSchema,
    issueBreakdownDecisionSchema,
    issueResolutionDecisionSchema,
    reviewDecisionSchema,
    type CommitMessageDecision,
    type ComplexityDecision,
    type IssueBreakdownDecision,
    type IssueResolutionDecision,
} from "./decisions.ts";
import type { ReviewAttempt } from "./recovery.ts";
import { REVIEW_ITERATION_LIMIT } from "./stage.ts";

export enum IssueArtifactKind {
    ComplexityDecision = "complexity-decision",
    IssueCheckpoint = "issue-checkpoint",
    ReviewAttempts = "review-attempts",
    CommitMessageDecision = "commit-message-decision",
    CreatedCommit = "created-commit",
    IssueResolutionDecision = "issue-resolution-decision",
    IssueBreakdownDecision = "issue-breakdown-decision",
    CreatedIssueNumbers = "created-issue-numbers",
}

export type CreatedIssueNumberMapping = Readonly<Record<string, number>>;
export type IssueArtifactValues = {
    readonly [IssueArtifactKind.ComplexityDecision]: ComplexityDecision;
    readonly [IssueArtifactKind.IssueCheckpoint]: IssueCheckpoint;
    readonly [IssueArtifactKind.ReviewAttempts]: ReadonlyArray<ReviewAttempt>;
    readonly [IssueArtifactKind.CommitMessageDecision]: CommitMessageDecision;
    readonly [IssueArtifactKind.CreatedCommit]: {
        readonly sha: string;
        readonly treeSha: string;
    };
    readonly [IssueArtifactKind.IssueResolutionDecision]: IssueResolutionDecision;
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
    readonly recordCreatedIssue: (
        key: string,
        issueNumber: number,
    ) => Promise<void>;
    /** Drop artifacts from an interrupted implementation attempt after checkout restore. */
    readonly resetImplementationAttempt: () => Promise<void>;
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
    decision: reviewDecisionSchema,
});

const issueCheckpointSchema = z.object({
    branch: z.string().min(1),
    sha: z.string().min(1),
});
const createdCommitSchema = z.object({
    sha: z.string().min(1),
    treeSha: z.string().min(1),
});

const persistedArtifactsSchema = z
    .object({
        [IssueArtifactKind.ComplexityDecision]:
            complexityDecisionSchema.optional(),
        [IssueArtifactKind.IssueCheckpoint]: issueCheckpointSchema.optional(),
        [IssueArtifactKind.ReviewAttempts]: z
            .array(reviewAttemptSchema)
            .max(REVIEW_ITERATION_LIMIT)
            .optional(),
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

const persistedArtifactStateSchema = z
    .object({
        version: z.literal(2),
        issueNumber: z.number().int().positive(),
        repository: z.string().min(1).optional(),
        artifacts: persistedArtifactsSchema,
    })
    .strict();

type PersistedArtifactState = z.infer<typeof persistedArtifactStateSchema>;
type ArtifactPersistence = (state: PersistedArtifactState) => Promise<void>;

const safeRunId = (runId: string): string =>
    runId.replace(/[^a-zA-Z0-9_-]/g, "_") || "run";

const artifactPath = (scope: IssueArtifactScope, issueNumber: number): string =>
    join(
        resolveWorkspacePath(scope.workspace),
        ".ralphie",
        "runs",
        safeRunId(scope.runId),
        "issues",
        String(issueNumber),
        "artifacts.json",
    );

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
        version: 2,
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

const loadPersistedState = async (
    filePath: string,
    issueNumber: number,
    scope?: IssueArtifactScope,
): Promise<PersistedArtifactState | undefined> => {
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
        const parsed = persistedArtifactStateSchema.parse(JSON.parse(encoded));
        if (parsed.issueNumber !== issueNumber) {
            throw new RalphieError({
                message: `Persisted artifacts at ${filePath} belong to issue ${parsed.issueNumber}, not issue ${issueNumber}.`,
            });
        }
        if (
            parsed.repository !== undefined &&
            scope?.repository !== undefined &&
            parsed.repository !== scope.repository
        ) {
            throw new RalphieError({
                message: `Persisted artifacts at ${filePath} belong to repository ${parsed.repository}, not ${scope.repository}.`,
            });
        }
        return parsed;
    } catch (cause) {
        if (cause instanceof RalphieError) throw cause;
        throw new RalphieError({
            message: `Failed to load issue artifacts at ${filePath}.`,
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

    return {
        issueNumber,
        write: async (kind, value) => {
            if (values.has(kind)) {
                throw new RalphieError({
                    message: `Artifact ${kind} has already been produced for issue ${issueNumber}.`,
                });
            }
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

export const makeDurableIssueArtifactStore = async (
    issueNumber: number,
    scope: IssueArtifactScope,
): Promise<IssueArtifactStore> => {
    if (!validIssueNumber(issueNumber)) {
        throw new RalphieError({
            message: `Cannot create an artifact store for issue ${issueNumber}.`,
        });
    }
    const filePath = artifactPath(scope, issueNumber);
    const state = await loadPersistedState(filePath, issueNumber, scope);
    const values = new Map<IssueArtifactKind, unknown>();
    if (state !== undefined) {
        for (const kind of Object.values(IssueArtifactKind)) {
            const value = state.artifacts[kind];
            if (value !== undefined) values.set(kind, value);
        }
    }
    return makeStore(
        issueNumber,
        values,
        (nextState) => persistAtomically(filePath, nextState),
        scope,
    );
};

export const makeIssueArtifactStoreService = (): IssueArtifactStoreService => {
    const stores = new Map<string, IssueArtifactStore>();

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
    };
};

export const IssueArtifactStoreLive = makeIssueArtifactStoreService;