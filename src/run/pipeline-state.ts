/**
 * Durable state for get-pipelines-green.
 *
 * Pipeline delivery is a direct base-branch state machine, not an issue
 * queue.  Its state has a separate discriminator and store so an issue-mode
 * resume can never accidentally consume a pipeline checkpoint or treat a
 * partially reconciled push as an ordinary issue outcome.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

import type { PipelineSnapshot } from "../github/pipeline-snapshot.ts";
import { pipelineFailureFingerprint } from "../issues/pipeline-delivery-loop.ts";
import type {
    PipelineDeliveryAttempt,
    PipelineDeliveryOutcome,
    PipelineDeliveryPersistenceEvent,
    PipelineDeliveryPhase,
} from "../issues/pipeline-delivery-loop.ts";
import { RalphieError } from "../shared/error.ts";
import { resolveWorkspacePath } from "../workspace/workspace.ts";

export const PIPELINE_RUN_STATE_VERSION = 1 as const;
export const PIPELINE_STATE_VERSION = PIPELINE_RUN_STATE_VERSION;
export const PIPELINE_RUN_MODE = "get-pipelines-green" as const;

export const PIPELINE_RUN_STATUSES = ["active", "stopped", "complete"] as const;
export type PipelineRunStatus = (typeof PIPELINE_RUN_STATUSES)[number];

export const PIPELINE_RUN_PHASES = [
    "remote-read",
    "observation",
    "prepare",
    "diagnostics",
    "repair",
    "commit-message",
    "commit",
    "push",
    "reconcile",
    "final-verification",
    "complete",
    "stopped",
    "cancelled",
] as const satisfies ReadonlyArray<
    PipelineDeliveryPhase | "complete" | "stopped" | "cancelled"
>;
export type PipelineRunPhase = (typeof PIPELINE_RUN_PHASES)[number];

export const PIPELINE_RESUME_ACTIONS = [
    "resume-observation",
    "resume-push",
    "reconciled-push",
    "stale-remote",
    "deadline-expired",
    "already-complete",
] as const;
export type PipelineResumeAction = (typeof PIPELINE_RESUME_ACTIONS)[number];

const FULL_GIT_OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const MAX_TEXT = 8 * 1024;
const MAX_SHORT_TEXT = 512;
const MAX_ITEMS = 100;
const MAX_ATTEMPTS_RECORDED = 100;

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
const fullSha = z.string().regex(FULL_GIT_OBJECT_ID);
const text = z.string().min(1).max(MAX_TEXT);
const shortText = z.string().min(1).max(MAX_SHORT_TEXT);
const timestamp = z.string().datetime();

const snapshotItemSchema = z
    .object({
        source: shortText,
        provider: shortText,
        name: shortText,
        status: z.enum([
            "pending",
            "passing",
            "acceptable",
            "failing",
            "cancelled",
            "unknown",
        ]),
    })
    .strict();

const snapshotSourceErrorSchema = z
    .object({ source: shortText, message: shortText })
    .strict();

const safeSnapshotSchema = z
    .object({
        request: z
            .object({
                repository: shortText,
                branch: shortText,
                commitSha: fullSha,
            })
            .strict(),
        state: z.enum(["empty", "non-empty"]),
        items: z.array(snapshotItemSchema).max(MAX_ITEMS).readonly(),
        sourceErrors: z
            .array(snapshotSourceErrorSchema)
            .max(MAX_ITEMS)
            .readonly(),
        completenessErrors: z.array(shortText).max(MAX_ITEMS).readonly(),
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
        fingerprint: text,
    })
    .strict();

const checkpointSchema = z.object({ branch: shortText, sha: fullSha }).strict();

const diagnosticReferenceSchema = z
    .object({
        path: shortText.optional(),
        commitSha: fullSha,
        failureFingerprint: text,
    })
    .strict();

const createdCommitSchema = z
    .object({ sha: fullSha, parentSha: fullSha, treeSha: fullSha })
    .strict();

const pushedCommitSchema = z
    .object({ sha: fullSha, confirmedAt: timestamp })
    .strict();

const attemptSchema = z
    .object({
        attempt: positiveInteger,
        baseSha: fullSha,
        failureFingerprint: text,
        repair: z
            .enum(["approved", "no-change", "review-exhausted"])
            .optional(),
        commit: z
            .object({
                status: z.enum(["created", "failed"]),
                sha: fullSha.optional(),
                parentSha: fullSha.optional(),
                treeSha: fullSha.optional(),
                message: shortText.optional(),
            })
            .strict()
            .optional(),
        push: z
            .object({
                status: z.enum([
                    "confirmed",
                    "confirmed-after-response-loss",
                    "rejected",
                    "ambiguous",
                    "external-movement",
                ]),
                response: z.enum(["accepted", "rejected"]),
                failureKind: z.enum(["non-fast-forward", "other"]).optional(),
                remoteSha: fullSha.optional(),
                message: shortText.optional(),
            })
            .strict()
            .optional(),
    })
    .strict();

const terminalOutcomeSchema = z
    .object({
        kind: z.enum([
            "green",
            "no-pipelines-discovered",
            "no-change",
            "review-exhausted",
            "identical-failure",
            "attempts-exhausted",
            "external-movement",
            "ambiguous-push",
            "non-fast-forward",
            "timeout",
            "cancelled",
            "dry-run",
            "failed",
        ]),
        remoteSha: fullSha.optional(),
        message: shortText.optional(),
        pushedAttempts: nonNegativeInteger,
    })
    .strict();

export const pipelineRunStateSchema = z
    .object({
        version: z.literal(PIPELINE_RUN_STATE_VERSION),
        mode: z.literal(PIPELINE_RUN_MODE),
        status: z.enum(PIPELINE_RUN_STATUSES),
        runId: shortText,
        repository: shortText,
        branch: shortText,
        workspace: shortText,
        /** Absolute epoch deadline; resume never replaces this with a new one. */
        deadlineAtMs: z
            .number()
            .int()
            .positive()
            .refine(Number.isSafeInteger, "Expected a safe deadline."),
        maxAttempts: positiveInteger,
        currentRemoteSha: fullSha,
        phase: z.enum(PIPELINE_RUN_PHASES),
        pushedAttempts: nonNegativeInteger,
        externalMovements: nonNegativeInteger,
        checkpoint: checkpointSchema.optional(),
        snapshot: safeSnapshotSchema.optional(),
        diagnostics: diagnosticReferenceSchema.optional(),
        createdCommit: createdCommitSchema.optional(),
        pushedCommit: pushedCommitSchema.optional(),
        failureFingerprint: text.optional(),
        attempts: z.array(attemptSchema).max(MAX_ATTEMPTS_RECORDED).readonly(),
        lastError: shortText.optional(),
        outcome: terminalOutcomeSchema.optional(),
        createdAt: timestamp,
        updatedAt: timestamp,
    })
    .strict();

export type PipelineSafeSnapshot = z.infer<typeof safeSnapshotSchema>;
export type PipelineCheckpointState = z.infer<typeof checkpointSchema>;
export type PipelineDiagnosticReference = z.infer<
    typeof diagnosticReferenceSchema
>;
export type PipelineCreatedCommit = z.infer<typeof createdCommitSchema>;
export type PipelinePushedCommit = z.infer<typeof pushedCommitSchema>;
export type PipelineAttemptState = z.infer<typeof attemptSchema>;
export type PipelineTerminalOutcome = z.infer<typeof terminalOutcomeSchema>;
export type PipelineRunState = z.infer<typeof pipelineRunStateSchema>;

const bounded = (value: string, maximum: number): string =>
    value.length <= maximum ? value : value.slice(0, maximum);

/** Store a bounded identity/status projection, never raw provider payloads. */
export const safePipelineSnapshot = (
    snapshot: PipelineSnapshot,
): PipelineSafeSnapshot => ({
    request: {
        repository: bounded(snapshot.repository, MAX_SHORT_TEXT),
        branch: bounded(snapshot.branch, MAX_SHORT_TEXT),
        commitSha: snapshot.commitSha,
    },
    state: snapshot.state,
    items: snapshot.items.slice(0, MAX_ITEMS).map((item) => ({
        source: bounded(item.source, MAX_SHORT_TEXT),
        provider: bounded(item.provider, MAX_SHORT_TEXT),
        name: bounded(item.name, MAX_SHORT_TEXT),
        status: item.status,
    })),
    sourceErrors: snapshot.sourceErrors.slice(0, MAX_ITEMS).map((error) => ({
        source: bounded(error.source, MAX_SHORT_TEXT),
        message: bounded(error.message, MAX_SHORT_TEXT),
    })),
    completenessErrors: snapshot.completenessErrors
        .slice(0, MAX_ITEMS)
        .map((error) => bounded(error, MAX_SHORT_TEXT)),
    reason: snapshot.reason,
    greenCandidate: snapshot.greenCandidate,
    fingerprint: bounded(pipelineFailureFingerprint(snapshot), MAX_TEXT),
});

export type NewPipelineRunStateInput = {
    readonly runId: string;
    readonly repository: string;
    readonly branch: string;
    readonly workspace: string;
    readonly deadlineAtMs: number;
    readonly maxAttempts: number;
    readonly currentRemoteSha: string;
    readonly now?: Date;
};

const iso = (date: Date | undefined): string =>
    (date ?? new Date()).toISOString();

export const makePipelineRunState = (
    input: NewPipelineRunStateInput,
): PipelineRunState =>
    pipelineRunStateSchema.parse({
        version: PIPELINE_RUN_STATE_VERSION,
        mode: PIPELINE_RUN_MODE,
        status: "active",
        runId: input.runId,
        repository: input.repository,
        branch: input.branch,
        workspace: input.workspace,
        deadlineAtMs: input.deadlineAtMs,
        maxAttempts: input.maxAttempts,
        currentRemoteSha: input.currentRemoteSha,
        phase: "remote-read",
        pushedAttempts: 0,
        externalMovements: 0,
        attempts: [],
        createdAt: iso(input.now),
        updatedAt: iso(input.now),
    });

export type PipelineRunStatePatch = Partial<
    Omit<PipelineRunState, "version" | "mode" | "createdAt" | "updatedAt">
>;

export const updatePipelineRunState = (
    state: PipelineRunState,
    patch: PipelineRunStatePatch,
    now = new Date(),
): PipelineRunState =>
    pipelineRunStateSchema.parse({
        ...state,
        ...patch,
        updatedAt: now.toISOString(),
    });

export const setPipelineRunPhase = (
    state: PipelineRunState,
    phase: PipelineRunPhase,
    patch: PipelineRunStatePatch = {},
    now = new Date(),
): PipelineRunState => updatePipelineRunState(state, { ...patch, phase }, now);

const safeRunId = (runId: string): string =>
    runId.replace(/[^a-zA-Z0-9_-]/g, "_") || "run";

export const pipelineRunStatePath = (
    workspace: string,
    runId: string,
): string =>
    join(
        resolveWorkspacePath(workspace),
        ".ralphie",
        "runs",
        safeRunId(runId),
        "pipeline",
        "state.json",
    );

export const getPipelineRunStatePath = pipelineRunStatePath;

const persistAtomically = async (
    path: string,
    state: PipelineRunState,
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
            message: `Failed to persist pipeline run state at ${path}.`,
            cause,
        });
    }
};

export type PipelineRunStateStoreService = {
    readonly save: (path: string, state: PipelineRunState) => Promise<void>;
    readonly load: (path: string) => Promise<PipelineRunState>;
    readonly remove: (path: string) => Promise<void>;
};

export type PipelineRunStatePersistence = {
    readonly getState: () => PipelineRunState;
    readonly onPhase: (
        event: PipelineDeliveryPersistenceEvent,
    ) => Promise<void>;
    readonly onOutcome: (outcome: PipelineDeliveryOutcome) => Promise<void>;
};

export type PipelineRunStatePersistenceInput = {
    readonly path: string;
    readonly initialState: PipelineRunState;
    readonly store?: PipelineRunStateStoreService;
    readonly now?: () => Date;
};

const validFullSha = (value: string | undefined): value is string =>
    value !== undefined && FULL_GIT_OBJECT_ID.test(value);

const optionalBounded = (
    value: string | undefined,
    maximum: number,
): string | undefined =>
    value === undefined || value.length === 0
        ? undefined
        : bounded(value, maximum);

const commitStateFrom = (
    commit: NonNullable<PipelineDeliveryAttempt["commit"]>,
): PipelineAttemptState["commit"] => ({
    status: commit.status,
    ...(validFullSha(commit.sha) ? { sha: commit.sha } : {}),
    ...(validFullSha(commit.parentSha) ? { parentSha: commit.parentSha } : {}),
    ...(validFullSha(commit.treeSha) ? { treeSha: commit.treeSha } : {}),
    ...(optionalBounded(commit.message, MAX_SHORT_TEXT) === undefined
        ? {}
        : { message: bounded(commit.message ?? "", MAX_SHORT_TEXT) }),
});

const pushStateFrom = (
    push: NonNullable<PipelineDeliveryAttempt["push"]>,
): PipelineAttemptState["push"] => ({
    status: push.status,
    response: push.response,
    ...(push.failureKind === undefined
        ? {}
        : { failureKind: push.failureKind }),
    ...(validFullSha(push.remoteSha) ? { remoteSha: push.remoteSha } : {}),
    ...(optionalBounded(push.message, MAX_SHORT_TEXT) === undefined
        ? {}
        : { message: bounded(push.message ?? "", MAX_SHORT_TEXT) }),
});

const attemptStateFrom = (
    attempt: PipelineDeliveryAttempt,
): PipelineAttemptState => ({
    attempt: attempt.attempt,
    baseSha: attempt.baseSha,
    failureFingerprint: bounded(attempt.failureFingerprint, MAX_TEXT),
    ...(attempt.repair === undefined ? {} : { repair: attempt.repair }),
    ...(attempt.commit === undefined
        ? {}
        : { commit: commitStateFrom(attempt.commit) }),
    ...(attempt.push === undefined
        ? {}
        : { push: pushStateFrom(attempt.push) }),
});

const upsertAttempt = (
    attempts: ReadonlyArray<PipelineAttemptState>,
    next: PipelineAttemptState | undefined,
): ReadonlyArray<PipelineAttemptState> => {
    if (next === undefined) return attempts;
    const retained = attempts.filter(
        (attempt) => attempt.attempt !== next.attempt,
    );
    return [...retained, next]
        .sort((left, right) => left.attempt - right.attempt)
        .slice(-MAX_ATTEMPTS_RECORDED);
};

const diagnosticReferenceFrom = (input: {
    readonly state: PipelineRunState;
    readonly path?: string;
    readonly snapshot?: PipelineSafeSnapshot;
    readonly currentRemoteSha: string;
    readonly failureFingerprint?: string;
}): PipelineDiagnosticReference | undefined => {
    const commitSha =
        input.snapshot?.request.commitSha ?? input.currentRemoteSha;
    const failureFingerprint =
        input.failureFingerprint ??
        input.snapshot?.fingerprint ??
        input.state.failureFingerprint;
    if (
        input.path === undefined ||
        !validFullSha(commitSha) ||
        failureFingerprint === undefined ||
        failureFingerprint.length === 0
    ) {
        return undefined;
    }
    return {
        ...(optionalBounded(input.path, MAX_SHORT_TEXT) === undefined
            ? {}
            : {
                  path: bounded(input.path, MAX_SHORT_TEXT),
              }),
        commitSha,
        failureFingerprint: bounded(failureFingerprint, MAX_TEXT),
    };
};

const createdCommitFrom = (
    event: PipelineDeliveryPersistenceEvent,
): PipelineCreatedCommit | undefined => {
    const commit = event.commit;
    if (
        commit !== undefined &&
        validFullSha(commit.sha) &&
        validFullSha(commit.parentSha) &&
        validFullSha(commit.treeSha)
    ) {
        return {
            sha: commit.sha,
            parentSha: commit.parentSha,
            treeSha: commit.treeSha,
        };
    }
    const attemptCommit = event.attemptState?.commit;
    if (
        attemptCommit?.status === "created" &&
        validFullSha(attemptCommit.sha) &&
        validFullSha(attemptCommit.parentSha) &&
        validFullSha(attemptCommit.treeSha)
    ) {
        return {
            sha: attemptCommit.sha,
            parentSha: attemptCommit.parentSha,
            treeSha: attemptCommit.treeSha,
        };
    }
    return undefined;
};

const confirmedPushShaFrom = (
    event: PipelineDeliveryPersistenceEvent,
): string | undefined => {
    const push = event.attemptState?.push;
    if (
        push === undefined ||
        (push.status !== "confirmed" &&
            push.status !== "confirmed-after-response-loss")
    ) {
        return undefined;
    }
    const sha = push.remoteSha ?? event.attemptState?.commit?.sha;
    return validFullSha(sha) ? sha : undefined;
};

const terminalOutcomeFrom = (
    outcome: PipelineDeliveryOutcome,
): PipelineTerminalOutcome => ({
    kind: outcome.kind,
    ...(validFullSha(outcome.remoteSha)
        ? { remoteSha: outcome.remoteSha }
        : {}),
    ...(optionalBounded(outcome.message, MAX_SHORT_TEXT) === undefined
        ? {}
        : { message: bounded(outcome.message ?? "", MAX_SHORT_TEXT) }),
    pushedAttempts: outcome.pushedAttempts,
});

const phaseRemoteShaFrom = (
    state: PipelineRunState,
    event: PipelineDeliveryPersistenceEvent,
): string =>
    validFullSha(event.currentRemoteSha)
        ? event.currentRemoteSha
        : state.currentRemoteSha;

const phaseSnapshotFrom = (
    event: PipelineDeliveryPersistenceEvent,
): PipelineSafeSnapshot | undefined =>
    event.snapshot === undefined
        ? undefined
        : safePipelineSnapshot(event.snapshot);

const phaseEvidencePatch = (
    state: PipelineRunState,
    snapshot: PipelineSafeSnapshot | undefined,
): PipelineRunStatePatch => {
    if (snapshot === undefined) return {};
    const moved =
        state.snapshot !== undefined &&
        !sameSha(snapshot.request.commitSha, state.snapshot.request.commitSha);
    return {
        snapshot,
        ...(moved ? { diagnostics: undefined } : {}),
    };
};

const phaseFailurePatch = (
    event: PipelineDeliveryPersistenceEvent,
): PipelineRunStatePatch =>
    event.failureFingerprint === undefined
        ? {}
        : {
              failureFingerprint: bounded(event.failureFingerprint, MAX_TEXT),
          };

const phaseAttemptPatch = (
    state: PipelineRunState,
    event: PipelineDeliveryPersistenceEvent,
): PipelineRunStatePatch =>
    event.attemptState === undefined
        ? {}
        : {
              attempts: upsertAttempt(
                  state.attempts,
                  attemptStateFrom(event.attemptState),
              ),
          };

const phasePushState = (input: {
    readonly state: PipelineRunState;
    readonly event: PipelineDeliveryPersistenceEvent;
    readonly confirmedSha?: string;
}): number => {
    const alreadyConfirmed =
        input.confirmedSha !== undefined &&
        input.state.pushedCommit !== undefined &&
        sameSha(input.state.pushedCommit.sha, input.confirmedSha);
    const pushedAttempts = Math.max(
        input.state.pushedAttempts,
        input.event.pushedAttempts,
        input.confirmedSha !== undefined && !alreadyConfirmed
            ? input.state.pushedAttempts + 1
            : input.state.pushedAttempts,
    );
    return pushedAttempts;
};

const phasePatchFrom = (
    state: PipelineRunState,
    event: PipelineDeliveryPersistenceEvent,
    now: Date,
): PipelineRunStatePatch => {
    const currentRemoteSha = phaseRemoteShaFrom(state, event);
    const snapshot = phaseSnapshotFrom(event);
    const createdCommit = createdCommitFrom(event);
    const confirmedSha = confirmedPushShaFrom(event);
    const pushState = phasePushState({ state, event, confirmedSha });
    const diagnostic = diagnosticReferenceFrom({
        state,
        path: event.diagnosticsPath,
        snapshot,
        currentRemoteSha,
        failureFingerprint: event.failureFingerprint,
    });
    const checkpoint =
        event.phase === "prepare" &&
        event.status === "before" &&
        validFullSha(currentRemoteSha)
            ? { branch: state.branch, sha: currentRemoteSha }
            : undefined;
    return {
        status: "active",
        phase: event.phase,
        currentRemoteSha,
        pushedAttempts: pushState,
        externalMovements: Math.max(
            state.externalMovements,
            event.externalMovements,
        ),
        ...phaseFailurePatch(event),
        ...phaseEvidencePatch(state, snapshot),
        ...phaseAttemptPatch(state, event),
        ...(diagnostic === undefined ? {} : { diagnostics: diagnostic }),
        ...(createdCommit === undefined ? {} : { createdCommit }),
        ...(confirmedSha === undefined
            ? {}
            : {
                  pushedCommit: {
                      sha: confirmedSha,
                      confirmedAt: now.toISOString(),
                  },
              }),
        ...(checkpoint === undefined ? {} : { checkpoint }),
        ...(event.message === undefined
            ? {}
            : { lastError: bounded(event.message, MAX_SHORT_TEXT) }),
    };
};

const outcomePhaseFrom = (
    kind: PipelineDeliveryOutcome["kind"],
): "complete" | "stopped" | "cancelled" =>
    kind === "cancelled"
        ? "cancelled"
        : kind === "green"
          ? "complete"
          : "stopped";

const outcomeDiagnosticPatch = (input: {
    readonly state: PipelineRunState;
    readonly outcome: PipelineDeliveryOutcome;
    readonly snapshot?: PipelineSafeSnapshot;
    readonly remoteSha: string;
}): PipelineRunStatePatch => {
    const diagnostics = diagnosticReferenceFrom({
        state: input.state,
        path: input.outcome.diagnosticsPath,
        snapshot: input.snapshot,
        currentRemoteSha: input.remoteSha,
        failureFingerprint: input.outcome.failureFingerprint,
    });
    return diagnostics === undefined ? {} : { diagnostics };
};

const outcomeErrorPatch = (
    outcome: PipelineDeliveryOutcome,
): PipelineRunStatePatch =>
    outcome.kind === "green"
        ? { lastError: undefined }
        : outcome.message === undefined
          ? {}
          : { lastError: bounded(outcome.message, MAX_SHORT_TEXT) };

const outcomePatchFrom = (
    state: PipelineRunState,
    outcome: PipelineDeliveryOutcome,
): PipelineRunStatePatch => {
    const snapshot =
        outcome.snapshot === undefined
            ? undefined
            : safePipelineSnapshot(outcome.snapshot);
    const remoteSha = validFullSha(outcome.remoteSha)
        ? outcome.remoteSha
        : state.currentRemoteSha;
    return {
        status: outcome.kind === "green" ? "complete" : "stopped",
        phase: outcomePhaseFrom(outcome.kind),
        currentRemoteSha: remoteSha,
        pushedAttempts: Math.max(state.pushedAttempts, outcome.pushedAttempts),
        externalMovements: Math.max(
            state.externalMovements,
            outcome.externalMovements,
        ),
        attempts: outcome.attempts
            .map(attemptStateFrom)
            .slice(-MAX_ATTEMPTS_RECORDED),
        ...(snapshot === undefined ? {} : { snapshot }),
        ...(outcome.failureFingerprint === undefined
            ? outcome.kind === "green"
                ? { failureFingerprint: undefined }
                : {}
            : {
                  failureFingerprint: bounded(
                      outcome.failureFingerprint,
                      MAX_TEXT,
                  ),
              }),
        ...outcomeDiagnosticPatch({ state, outcome, snapshot, remoteSha }),
        ...outcomeErrorPatch(outcome),
        ...(outcome.kind === "green" ? { diagnostics: undefined } : {}),
        outcome: terminalOutcomeFrom(outcome),
    };
};

/**
 * Turn delivery-loop boundary events into one atomic, resume-safe state file.
 * The adapter is intentionally separate from the loop: tests and other
 * callers can use the loop without opting into persistence, while the CLI can
 * attach this sink before the first observation boundary.
 */
export const makePipelineRunStatePersistence = (
    input: PipelineRunStatePersistenceInput,
): PipelineRunStatePersistence => {
    const store = input.store ?? PipelineRunStateStoreLive;
    const now = input.now ?? (() => new Date());
    let state = input.initialState;

    const onPhase = async (
        event: PipelineDeliveryPersistenceEvent,
    ): Promise<void> => {
        const nextState = updatePipelineRunState(
            state,
            phasePatchFrom(state, event, now()),
            now(),
        );
        await store.save(input.path, nextState);
        state = nextState;
    };

    const onOutcome = async (
        outcome: PipelineDeliveryOutcome,
    ): Promise<void> => {
        const nextState = updatePipelineRunState(
            state,
            outcomePatchFrom(state, outcome),
            now(),
        );
        await store.save(input.path, nextState);
        state = nextState;
    };

    return {
        getState: () => state,
        onPhase,
        onOutcome,
    };
};

const legacyPipelineRunStateSchema = z
    .object({
        version: z.literal(0),
        runId: shortText,
        repository: shortText,
        branch: shortText,
        workspace: shortText,
        deadlineAtMs: z.number().int().positive(),
        maxAttempts: positiveInteger,
        currentRemoteSha: fullSha,
        phase: z.enum(PIPELINE_RUN_PHASES).optional(),
        pushedAttempts: nonNegativeInteger.optional(),
        createdAt: timestamp.optional(),
        updatedAt: timestamp.optional(),
    })
    .passthrough();

const migratePipelineRunState = (
    value: unknown,
): {
    readonly state: PipelineRunState;
    readonly migrated: boolean;
} => {
    if (
        typeof value === "object" &&
        value !== null &&
        "version" in value &&
        value.version === 0
    ) {
        const legacy = legacyPipelineRunStateSchema.parse(value);
        const migrated = pipelineRunStateSchema.parse({
            version: PIPELINE_RUN_STATE_VERSION,
            mode: PIPELINE_RUN_MODE,
            status: "active",
            runId: legacy.runId,
            repository: legacy.repository,
            branch: legacy.branch,
            workspace: legacy.workspace,
            deadlineAtMs: legacy.deadlineAtMs,
            maxAttempts: legacy.maxAttempts,
            currentRemoteSha: legacy.currentRemoteSha,
            phase: legacy.phase ?? "observation",
            pushedAttempts: legacy.pushedAttempts ?? 0,
            externalMovements: 0,
            attempts: [],
            ...(legacy.createdAt === undefined
                ? { createdAt: new Date().toISOString() }
                : { createdAt: legacy.createdAt }),
            ...(legacy.updatedAt === undefined
                ? { updatedAt: new Date().toISOString() }
                : { updatedAt: legacy.updatedAt }),
        });
        return { state: migrated, migrated: true };
    }
    if (
        typeof value === "object" &&
        value !== null &&
        "version" in value &&
        value.version !== PIPELINE_RUN_STATE_VERSION
    ) {
        throw new RalphieError({
            message:
                `Pipeline run state uses unsupported version ${String(value.version)}; ` +
                `expected version ${String(PIPELINE_RUN_STATE_VERSION)}.`,
        });
    }
    return {
        state: pipelineRunStateSchema.parse(value),
        migrated: false,
    };
};

export const PipelineRunStateStoreLive: PipelineRunStateStoreService = {
    save: async (path, state) => {
        try {
            await persistAtomically(path, pipelineRunStateSchema.parse(state));
        } catch (cause) {
            if (cause instanceof RalphieError) throw cause;
            throw new RalphieError({
                message: `Failed to persist pipeline run state at ${path}.`,
                cause,
            });
        }
    },

    load: async (path) => {
        try {
            const loaded = migratePipelineRunState(
                JSON.parse(await readFile(path, "utf8")),
            );
            if (loaded.migrated) await persistAtomically(path, loaded.state);
            return loaded.state;
        } catch (cause) {
            throw new RalphieError({
                message:
                    cause instanceof RalphieError
                        ? `Pipeline run state at ${path} is invalid or unreadable: ${cause.message}`
                        : `Pipeline run state at ${path} is invalid or unreadable.`,
                cause,
            });
        }
    },

    remove: async (path) => {
        try {
            await rm(path, { force: true });
        } catch (cause) {
            throw new RalphieError({
                message: `Failed to remove completed pipeline run state at ${path}.`,
                cause,
            });
        }
    },
};

export const PipelineStateStoreLive = PipelineRunStateStoreLive;

export type PipelineResumeExpectations = {
    readonly repository: string;
    readonly branch?: string;
    readonly workspace?: string;
    readonly maxAttempts?: number;
    /** A supplied timeout must describe the same original deadline. */
    readonly deadlineAtMs?: number;
};

export const validatePipelineResumeState = (
    state: PipelineRunState,
    expected: PipelineResumeExpectations,
): PipelineRunState => {
    const reasons: string[] = [];
    if (state.mode !== PIPELINE_RUN_MODE)
        reasons.push(`saved mode is ${state.mode}`);
    if (state.repository !== expected.repository) {
        reasons.push(
            `saved repository is ${state.repository}, not ${expected.repository}`,
        );
    }
    if (expected.branch !== undefined && state.branch !== expected.branch) {
        reasons.push(`saved branch is ${state.branch}, not ${expected.branch}`);
    }
    if (
        expected.workspace !== undefined &&
        state.workspace !== expected.workspace
    ) {
        reasons.push(
            `saved workspace is ${state.workspace}, not ${expected.workspace}`,
        );
    }
    if (
        expected.maxAttempts !== undefined &&
        state.maxAttempts !== expected.maxAttempts
    ) {
        reasons.push(
            `saved maximum attempts is ${state.maxAttempts}, not ${expected.maxAttempts}`,
        );
    }
    if (
        expected.deadlineAtMs !== undefined &&
        state.deadlineAtMs !== expected.deadlineAtMs
    ) {
        reasons.push(
            "saved pipeline deadline differs from the requested original deadline",
        );
    }
    if (reasons.length > 0) {
        throw new RalphieError({
            message: `Cannot resume pipeline run ${state.runId}: ${reasons.join("; ")}.`,
        });
    }
    return state;
};

export const loadPipelineRunState = async (
    path: string,
    expected: PipelineResumeExpectations,
    store: PipelineRunStateStoreService = PipelineRunStateStoreLive,
): Promise<PipelineRunState> =>
    validatePipelineResumeState(await store.load(path), expected);

export const loadPipelineState = loadPipelineRunState;

export type PipelineResumeReconciliation = {
    readonly action: PipelineResumeAction;
    readonly state: PipelineRunState;
    readonly remoteSha: string;
    readonly message?: string;
};

const sameSha = (left: string, right: string): boolean =>
    left.toLowerCase() === right.toLowerCase();

const snapshotMatchesRemote = (
    snapshot: PipelineSafeSnapshot | undefined,
    remoteSha: string,
): boolean =>
    snapshot !== undefined && sameSha(snapshot.request.commitSha, remoteSha);

const clearStaleEvidence = (
    state: PipelineRunState,
    remoteSha: string,
    now: Date,
): PipelineRunState =>
    updatePipelineRunState(
        state,
        {
            status: "active",
            currentRemoteSha: remoteSha,
            phase: "observation",
            snapshot: undefined,
            diagnostics: undefined,
            failureFingerprint: undefined,
            lastError: undefined,
            outcome: undefined,
        },
        now,
    );

const reconciledPushState = (input: {
    readonly state: PipelineRunState;
    readonly remoteSha: string;
    readonly now: Date;
}): PipelineResumeReconciliation | undefined => {
    const { state, remoteSha, now } = input;
    const pushed = state.pushedCommit;
    if (pushed !== undefined && sameSha(pushed.sha, remoteSha)) {
        const next = snapshotMatchesRemote(state.snapshot, remoteSha)
            ? updatePipelineRunState(
                  state,
                  {
                      currentRemoteSha: remoteSha,
                      phase: "observation",
                      lastError: undefined,
                  },
                  now,
              )
            : clearStaleEvidence(state, remoteSha, now);
        return {
            action: "reconciled-push",
            state: next,
            remoteSha,
            message:
                "The previously confirmed pushed SHA is still authoritative; resume continues with observation.",
        };
    }

    const created = state.createdCommit;
    if (created === undefined || !sameSha(created.sha, remoteSha))
        return undefined;
    const next = updatePipelineRunState(
        state,
        {
            currentRemoteSha: remoteSha,
            phase: "observation",
            pushedAttempts:
                state.pushedCommit === undefined
                    ? state.pushedAttempts + 1
                    : state.pushedAttempts,
            pushedCommit: state.pushedCommit ?? {
                sha: created.sha,
                confirmedAt: now.toISOString(),
            },
            lastError: undefined,
        },
        now,
    );
    return {
        action: "reconciled-push",
        state: next,
        remoteSha,
        message:
            "The remote already contains the created commit; resume records the push once and skips re-pushing it.",
    };
};

const pendingPushState = (input: {
    readonly state: PipelineRunState;
    readonly remoteSha: string;
    readonly now: Date;
}): PipelineResumeReconciliation | undefined => {
    const { state, remoteSha, now } = input;
    const pending =
        state.createdCommit !== undefined &&
        state.checkpoint !== undefined &&
        ["commit", "push", "reconcile"].includes(state.phase) &&
        sameSha(state.checkpoint.sha, remoteSha);
    if (!pending) return undefined;
    return {
        action: "resume-push",
        state: updatePipelineRunState(
            state,
            { currentRemoteSha: remoteSha, lastError: undefined },
            now,
        ),
        remoteSha,
        message:
            "The remote is still at the recorded checkpoint; local commit verification is required before retrying the non-force push.",
    };
};

const unrelatedPendingCommitState = (input: {
    readonly state: PipelineRunState;
    readonly remoteSha: string;
    readonly now: Date;
}): PipelineResumeReconciliation | undefined => {
    const { state, remoteSha, now } = input;
    const created = state.createdCommit;
    if (
        created === undefined ||
        sameSha(created.parentSha, remoteSha) ||
        sameSha(state.currentRemoteSha, remoteSha)
    ) {
        return undefined;
    }
    const message =
        "The remote branch moved to an unrelated SHA while a local pipeline commit was pending; no push was retried.";
    return {
        action: "stale-remote",
        state: setPipelineRunPhase(
            state,
            "stopped",
            {
                status: "stopped",
                currentRemoteSha: remoteSha,
                lastError: message,
            },
            now,
        ),
        remoteSha,
        message,
    };
};

/**
 * Reconcile remote state before resume.  This is pure with respect to Git:
 * callers must verify the local checkout before retrying a pending push.
 */
export const reconcilePipelineRunStateOnResume = (input: {
    readonly state: PipelineRunState;
    readonly remoteSha: string;
    readonly now?: Date;
}): PipelineResumeReconciliation => {
    if (!FULL_GIT_OBJECT_ID.test(input.remoteSha)) {
        throw new RalphieError({
            message: `Cannot resume pipeline run: remote branch returned an invalid SHA ${input.remoteSha}.`,
        });
    }
    const now = input.now ?? new Date();
    const state = input.state;
    if (state.status === "complete") {
        if (!sameSha(state.currentRemoteSha, input.remoteSha)) {
            return {
                action: "resume-observation",
                state: clearStaleEvidence(state, input.remoteSha, now),
                remoteSha: input.remoteSha,
                message:
                    "The saved green result is stale for the current remote SHA; it was invalidated before observation.",
            };
        }
        return {
            action: "already-complete",
            state,
            remoteSha: input.remoteSha,
        };
    }
    if (now.getTime() >= state.deadlineAtMs) {
        return {
            action: "deadline-expired",
            state: setPipelineRunPhase(
                state,
                "stopped",
                {
                    status: "stopped",
                    currentRemoteSha: input.remoteSha,
                    lastError:
                        "The original pipeline delivery deadline has expired; resume cannot restart it.",
                },
                now,
            ),
            remoteSha: input.remoteSha,
            message:
                "The original pipeline delivery deadline has expired; resume cannot restart it.",
        };
    }

    const specialCase =
        reconciledPushState({ state, remoteSha: input.remoteSha, now }) ??
        pendingPushState({ state, remoteSha: input.remoteSha, now }) ??
        unrelatedPendingCommitState({ state, remoteSha: input.remoteSha, now });
    if (specialCase !== undefined) return specialCase;

    if (!snapshotMatchesRemote(state.snapshot, input.remoteSha)) {
        return {
            action: "resume-observation",
            state: clearStaleEvidence(state, input.remoteSha, now),
            remoteSha: input.remoteSha,
            message:
                "The saved snapshot is stale for the current remote SHA; it was invalidated before observation.",
        };
    }
    return {
        action: "resume-observation",
        state: updatePipelineRunState(
            state,
            { currentRemoteSha: input.remoteSha, lastError: undefined },
            now,
        ),
        remoteSha: input.remoteSha,
    };
};