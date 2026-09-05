// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: orchestration is an explicit lifecycle state machine with terminal resume branches

/**
 * The get-pipelines-green command is a direct base-branch workflow.  It owns
 * command concerns (authentication, workspace setup, progress, resume, and
 * exit semantics) while the delivery loop owns the repair safety machine.
 */
import { makeAgentSessionDiagnostics } from "./agent/task-session.ts";
import type { AgentSelection } from "./agent/model.ts";
import type {
    FailedPipelineObservation,
    PipelineObservationOutcome,
    PipelineObservationOptions,
} from "./github/pipeline-observation.ts";
import type {
    PipelineSnapshot,
    PipelineSnapshotRequest,
} from "./github/pipeline-snapshot.ts";
import {
    pipelineFailureFingerprint,
    type PipelineDeliveryAttempt,
    type PipelineDeliveryOutcome,
    type PipelineDeliveryPersistenceEvent,
    type PipelineDeliveryPhase,
} from "./issues/pipeline-delivery-loop.ts";
import {
    DEFAULT_PIPELINE_TIMEOUT,
    durationToMilliseconds,
    type GetPipelinesGreenRalphieConfig,
} from "./options.ts";
import type {
    ProgressReporterService,
    ProgressStage,
    ProgressStatus,
} from "./progress/progress.ts";
import type { OpenCodeRuntime } from "./opencode/server.ts";
import type { RalphieRuntime } from "./runtime.ts";
import {
    makePipelineRunState,
    makePipelineRunStatePersistence,
    pipelineRunStatePath,
    reconcilePipelineRunStateOnResume,
    type PipelineAttemptState,
    type PipelineRunState,
    type PipelineRunStatePersistence,
} from "./run/pipeline-state.ts";
import { RalphieError } from "./shared/error.ts";

const FULL_GIT_OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

export type GetPipelinesGreenOptions = {
    readonly config: GetPipelinesGreenRalphieConfig;
    readonly runId: string;
    readonly signal?: AbortSignal;
    /** Loaded and compatibility-checked by the command before runtime setup. */
    readonly resumeState?: PipelineRunState;
};

export type PipelineRunSummary = {
    readonly runId: string;
    readonly repository: string;
    readonly branch: string;
    readonly statePath: string;
    readonly outcome: PipelineDeliveryOutcome;
    readonly dryRun: boolean;
    /** True when dry-run found a repairable failure but made no edits. */
    readonly wouldRepair: boolean;
};

export type GetPipelinesGreenEntryPoint = (
    options: GetPipelinesGreenOptions,
    runtime: RalphieRuntime,
) => Promise<PipelineRunSummary>;

export class PipelineDeliveryOutcomeError extends RalphieError {
    override readonly _tag = "PipelineDeliveryOutcomeError" as const;
    readonly outcome: PipelineDeliveryOutcome;

    constructor(outcome: PipelineDeliveryOutcome) {
        super({
            message:
                outcome.message ??
                `Pipeline delivery stopped with outcome ${outcome.kind}.`,
        });
        this.name = "PipelineDeliveryOutcomeError";
        this.outcome = outcome;
    }
}

const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

const sameSha = (left: string, right: string): boolean =>
    left.toLowerCase() === right.toLowerCase();

const validSha = (value: string | undefined): value is string =>
    value !== undefined && FULL_GIT_OBJECT_ID.test(value);

const checkCancellation = (signal: AbortSignal | undefined): void => {
    signal?.throwIfAborted();
};

const stageForPhase: Record<PipelineDeliveryPhase, ProgressStage> = {
    "remote-read": "pipeline-remote-read",
    observation: "pipeline-observation",
    prepare: "repository-preparation",
    diagnostics: "pipeline-diagnostics",
    repair: "pipeline-repair",
    "commit-message": "pipeline-commit-message",
    commit: "pipeline-commit",
    push: "pipeline-push",
    reconcile: "pipeline-reconcile",
    "final-verification": "pipeline-final-verification",
};

const progressStatusFor = (
    status: PipelineDeliveryPersistenceEvent["status"],
): ProgressStatus => {
    switch (status) {
        case "before":
            return "started";
        case "succeeded":
            return "succeeded";
        case "failed":
            return "failed";
        case "reconciled":
            return "info";
    }
};

const phaseMessageFor = (event: PipelineDeliveryPersistenceEvent): string => {
    if (event.message !== undefined) return event.message;
    if (event.status === "before") return `Pipeline ${event.phase} started.`;
    if (event.status === "reconciled")
        return `Pipeline ${event.phase} state reconciled.`;
    return `Pipeline ${event.phase} ${event.status}.`;
};

const emitPhaseProgress = async (
    progress: ProgressReporterService,
    event: PipelineDeliveryPersistenceEvent,
    dryRun: boolean,
): Promise<void> => {
    await progress.emit({
        stage: stageForPhase[event.phase],
        status: progressStatusFor(event.status),
        message: phaseMessageFor(event),
        repository: event.snapshot?.repository,
        ...(event.attempt === undefined ? {} : { attempt: event.attempt }),
        ...(event.attempt === undefined
            ? {}
            : { maxAttempts: event.pushedAttempts + 1 }),
        details: {
            phase: event.phase,
            boundary: event.status,
            ...(event.currentRemoteSha === undefined
                ? {}
                : { remoteSha: event.currentRemoteSha }),
            pushedAttempts: event.pushedAttempts,
            externalMovements: event.externalMovements,
            ...(event.failureFingerprint === undefined
                ? {}
                : { failureFingerprint: event.failureFingerprint }),
            ...(event.diagnosticsPath === undefined
                ? {}
                : { diagnosticsPath: event.diagnosticsPath }),
            dryRun,
        },
    });
};

const emitOutcomeProgress = async (
    progress: ProgressReporterService,
    outcome: PipelineDeliveryOutcome,
    statePath: string,
    dryRun: boolean,
): Promise<void> => {
    await progress.emit({
        stage: "pipeline-outcome",
        status: outcome.kind === "green" ? "succeeded" : "failed",
        message:
            outcome.message ??
            (outcome.kind === "green"
                ? "All observed pipelines are green."
                : `Pipeline delivery ended with ${outcome.kind}.`),
        repository: outcome.repository,
        details: {
            kind: outcome.kind,
            status: outcome.status,
            branch: outcome.branch,
            ...(outcome.remoteSha === undefined
                ? {}
                : { remoteSha: outcome.remoteSha }),
            pushedAttempts: outcome.pushedAttempts,
            externalMovements: outcome.externalMovements,
            attempts: outcome.attempts.length,
            ...(outcome.failureFingerprint === undefined
                ? {}
                : { failureFingerprint: outcome.failureFingerprint }),
            ...(outcome.diagnosticsPath === undefined
                ? {}
                : { diagnosticsPath: outcome.diagnosticsPath }),
            statePath,
            dryRun,
        },
    });
};

const track = async <Value>(input: {
    readonly progress: ProgressReporterService;
    readonly stage: ProgressStage;
    readonly message: string;
    readonly operation: () => Promise<Value>;
    readonly success: string | ((value: Value) => string);
    readonly repository?: string;
    readonly details?: Readonly<Record<string, unknown>>;
}): Promise<Value> => {
    await input.progress.emit({
        stage: input.stage,
        status: "started",
        message: input.message,
        ...(input.repository === undefined
            ? {}
            : { repository: input.repository }),
        ...(input.details === undefined ? {} : { details: input.details }),
    });
    try {
        const value = await input.operation();
        await input.progress.emit({
            stage: input.stage,
            status: "succeeded",
            message:
                typeof input.success === "function"
                    ? input.success(value)
                    : input.success,
            ...(input.repository === undefined
                ? {}
                : { repository: input.repository }),
            ...(input.details === undefined ? {} : { details: input.details }),
        });
        return value;
    } catch (error) {
        await input.progress.emit({
            stage: input.stage,
            status: "failed",
            message: `${input.message.replace(/\.{3}$/, "")} failed: ${errorMessage(error)}`,
            ...(input.repository === undefined
                ? {}
                : { repository: input.repository }),
            ...(input.details === undefined ? {} : { details: input.details }),
        });
        throw error;
    }
};

const stateAttemptsToDelivery = (
    attempts: ReadonlyArray<PipelineAttemptState>,
): ReadonlyArray<PipelineDeliveryAttempt> => attempts.map(deliveryAttemptFrom);

const deliveryCommitFrom = (
    commit: NonNullable<PipelineAttemptState["commit"]>,
): NonNullable<PipelineDeliveryAttempt["commit"]> => ({
    status: commit.status,
    ...(commit.sha === undefined ? {} : { sha: commit.sha }),
    ...(commit.parentSha === undefined ? {} : { parentSha: commit.parentSha }),
    ...(commit.treeSha === undefined ? {} : { treeSha: commit.treeSha }),
    ...(commit.message === undefined ? {} : { message: commit.message }),
});

const deliveryPushFrom = (
    push: NonNullable<PipelineAttemptState["push"]>,
): NonNullable<PipelineDeliveryAttempt["push"]> => ({
    status: push.status,
    response: push.response,
    ...(push.failureKind === undefined
        ? {}
        : { failureKind: push.failureKind }),
    ...(push.remoteSha === undefined ? {} : { remoteSha: push.remoteSha }),
    ...(push.message === undefined ? {} : { message: push.message }),
});

const deliveryAttemptFrom = (
    attempt: PipelineAttemptState,
): PipelineDeliveryAttempt => ({
    attempt: attempt.attempt,
    baseSha: attempt.baseSha,
    failureFingerprint: attempt.failureFingerprint,
    ...(attempt.repair === undefined ? {} : { repair: attempt.repair }),
    ...(attempt.commit === undefined
        ? {}
        : { commit: deliveryCommitFrom(attempt.commit) }),
    ...(attempt.push === undefined
        ? {}
        : { push: deliveryPushFrom(attempt.push) }),
});

const outcomeFromState = (input: {
    readonly state: PipelineRunState;
    readonly remoteSha: string;
    readonly kind: PipelineDeliveryOutcome["kind"];
    readonly message?: string;
}): PipelineDeliveryOutcome => ({
    kind: input.kind,
    status: input.kind,
    repository: input.state.repository,
    branch: input.state.branch,
    remoteSha: input.remoteSha,
    ...(input.state.failureFingerprint === undefined
        ? {}
        : { failureFingerprint: input.state.failureFingerprint }),
    ...(input.state.diagnostics?.path === undefined
        ? {}
        : { diagnosticsPath: input.state.diagnostics.path }),
    ...(input.message === undefined ? {} : { message: input.message }),
    pushedAttempts: input.state.pushedAttempts,
    externalMovements: input.state.externalMovements,
    attempts: stateAttemptsToDelivery(input.state.attempts),
    phases: [],
});

const outcomeForObservation = (input: {
    readonly observation: PipelineObservationOutcome;
    readonly repository: string;
    readonly branch: string;
    readonly remoteSha: string;
}): PipelineDeliveryOutcome => {
    const base = {
        repository: input.repository,
        branch: input.branch,
        remoteSha: input.remoteSha,
        pushedAttempts: 0,
        externalMovements: 0,
        attempts: [],
        phases: [],
    } as const;
    switch (input.observation.kind) {
        case "green":
            return {
                ...base,
                kind: "green",
                status: "green",
                source: "already-green",
                snapshot: input.observation.snapshot,
            };
        case "no-pipelines-discovered":
            return {
                ...base,
                kind: "no-pipelines-discovered",
                status: "no-pipelines-discovered",
                message:
                    "No pipeline checks were discovered within the observation grace period.",
            };
        case "timeout":
            return {
                ...base,
                kind: "timeout",
                status: "timeout",
                message: "Pipeline observation timed out.",
                ...(input.observation.lastSnapshot === undefined
                    ? {}
                    : { snapshot: input.observation.lastSnapshot }),
            };
        case "aborted":
            return {
                ...base,
                kind: "cancelled",
                status: "cancelled",
                message: "Pipeline observation was cancelled.",
            };
        case "stale":
            return {
                ...base,
                kind: "external-movement",
                status: "external-movement",
                remoteSha: input.observation.headAfter,
                externalMovements: 1,
                message:
                    "Pipeline observation saw the branch advance before the result could be used.",
                snapshot: input.observation.snapshot,
            };
        case "failed":
            return {
                ...base,
                kind: "failed",
                status: "failed",
                message:
                    input.observation.message ??
                    "Pipeline observation did not establish a repairable result.",
                ...(input.observation.snapshot === undefined
                    ? {}
                    : { snapshot: input.observation.snapshot }),
            };
    }
};

const resumedPushStatus = (input: {
    readonly remoteSha: string;
    readonly createdSha: string;
    readonly response: "accepted" | "rejected";
    readonly failureKind?: "non-fast-forward" | "other";
}): NonNullable<PipelineDeliveryAttempt["push"]>["status"] =>
    validSha(input.remoteSha) && sameSha(input.remoteSha, input.createdSha)
        ? input.response === "accepted"
            ? "confirmed"
            : "confirmed-after-response-loss"
        : input.failureKind === "non-fast-forward"
          ? "rejected"
          : "ambiguous";

const resumedPushAttempt = (input: {
    readonly state: PipelineRunState;
    readonly createdSha: string;
    readonly parentSha: string;
    readonly push: {
        readonly response: "accepted" | "rejected";
        readonly failureKind?: "non-fast-forward" | "other";
        readonly remoteSha: string;
    };
}): PipelineDeliveryAttempt => {
    const prior = [...input.state.attempts]
        .reverse()
        .find((attempt) => attempt.commit?.sha === input.createdSha);
    const priorAttempt = prior === undefined ? {} : deliveryAttemptFrom(prior);
    return {
        ...priorAttempt,
        attempt: prior?.attempt ?? input.state.pushedAttempts + 1,
        baseSha: prior?.baseSha ?? input.parentSha,
        failureFingerprint:
            prior?.failureFingerprint ??
            input.state.failureFingerprint ??
            "resumed-pipeline-push",
        push: {
            status: resumedPushStatus({
                remoteSha: input.push.remoteSha,
                createdSha: input.createdSha,
                response: input.push.response,
                failureKind: input.push.failureKind,
            }),
            response: input.push.response,
            ...(input.push.failureKind === undefined
                ? {}
                : { failureKind: input.push.failureKind }),
            ...(validSha(input.push.remoteSha)
                ? { remoteSha: input.push.remoteSha }
                : {}),
        },
    };
};

const dryRunOutcome = async (input: {
    readonly runtime: RalphieRuntime;
    readonly octokit: Awaited<
        ReturnType<RalphieRuntime["githubClient"]["initialize"]>
    >;
    readonly repository: string;
    readonly branch: string;
    readonly repositoryPath: string;
    readonly workspace: string;
    readonly runId: string;
    readonly remoteSha: string;
    readonly deadlineAtMs: number;
    readonly persistence: PipelineRunStatePersistence;
    readonly signal?: AbortSignal;
    readonly progress: ProgressReporterService;
}): Promise<{
    readonly outcome: PipelineDeliveryOutcome;
    readonly wouldRepair: boolean;
}> => {
    const request: PipelineSnapshotRequest = {
        repository: input.repository,
        branch: input.branch,
        commitSha: input.remoteSha,
    };
    const emitBoundary = async (
        event: PipelineDeliveryPersistenceEvent,
    ): Promise<void> => {
        await input.persistence.onPhase(event);
        await emitPhaseProgress(input.progress, event, true);
    };
    await emitBoundary({
        phase: "observation",
        status: "before",
        currentRemoteSha: input.remoteSha,
        pushedAttempts: input.persistence.getState().pushedAttempts,
        externalMovements: input.persistence.getState().externalMovements,
    });
    let observed: Awaited<
        ReturnType<RalphieRuntime["pipelineObservation"]["observe"]>
    >;
    try {
        const remaining = Math.max(1, input.deadlineAtMs - Date.now());
        const options: PipelineObservationOptions = {
            deadlineMs: remaining,
        };
        observed = await input.runtime.pipelineObservation.observe({
            request,
            client: input.octokit,
            options,
            signal: input.signal,
        });
        await emitBoundary({
            phase: "observation",
            status: "succeeded",
            currentRemoteSha: input.remoteSha,
            pushedAttempts: input.persistence.getState().pushedAttempts,
            externalMovements: input.persistence.getState().externalMovements,
            ...(observed.outcome.kind === "green" ||
            observed.outcome.kind === "failed" ||
            observed.outcome.kind === "stale"
                ? { snapshot: observed.outcome.snapshot }
                : {}),
        });
    } catch (error) {
        await emitBoundary({
            phase: "observation",
            status: "failed",
            currentRemoteSha: input.remoteSha,
            pushedAttempts: input.persistence.getState().pushedAttempts,
            externalMovements: input.persistence.getState().externalMovements,
            message: errorMessage(error),
        });
        throw error;
    }

    await emitBoundary({
        phase: "final-verification",
        status: "before",
        currentRemoteSha: input.remoteSha,
        pushedAttempts: input.persistence.getState().pushedAttempts,
        externalMovements: input.persistence.getState().externalMovements,
    });
    let remoteAfter: string;
    try {
        remoteAfter = await input.runtime.pipelineDeliveryGit.readRemoteHead(
            input.repositoryPath,
            input.branch,
            input.signal,
        );
        await emitBoundary({
            phase: "final-verification",
            status: "succeeded",
            currentRemoteSha: remoteAfter,
            pushedAttempts: input.persistence.getState().pushedAttempts,
            externalMovements: input.persistence.getState().externalMovements,
        });
    } catch (error) {
        await emitBoundary({
            phase: "final-verification",
            status: "failed",
            currentRemoteSha: input.remoteSha,
            pushedAttempts: input.persistence.getState().pushedAttempts,
            externalMovements: input.persistence.getState().externalMovements,
            message: errorMessage(error),
        });
        throw error;
    }
    if (!validSha(remoteAfter)) {
        return {
            outcome: outcomeFromState({
                state: input.persistence.getState(),
                remoteSha: input.remoteSha,
                kind: "failed",
                message:
                    "The remote branch could not be read after dry-run observation.",
            }),
            wouldRepair: false,
        };
    }
    if (!sameSha(remoteAfter, input.remoteSha)) {
        return {
            outcome: outcomeFromState({
                state: input.persistence.getState(),
                remoteSha: remoteAfter,
                kind: "external-movement",
                message:
                    "The remote branch advanced during dry-run observation; no stale repair would be applied.",
            }),
            wouldRepair: false,
        };
    }

    if (observed.outcome.kind === "green") {
        return {
            outcome: {
                ...outcomeForObservation({
                    observation: observed.outcome,
                    repository: input.repository,
                    branch: input.branch,
                    remoteSha: input.remoteSha,
                }),
                remoteSha: remoteAfter,
            },
            wouldRepair: false,
        };
    }
    if (
        observed.outcome.kind !== "failed" ||
        observed.outcome.reason !== "failing" ||
        observed.outcome.snapshot === undefined
    ) {
        return {
            outcome: outcomeForObservation({
                observation: observed.outcome,
                repository: input.repository,
                branch: input.branch,
                remoteSha: remoteAfter,
            }),
            wouldRepair: false,
        };
    }

    const snapshot = observed.outcome.snapshot;
    const failureFingerprint = pipelineFailureFingerprint(snapshot);
    let diagnosticsPath: string | undefined;
    await emitBoundary({
        phase: "diagnostics",
        status: "before",
        currentRemoteSha: remoteAfter,
        pushedAttempts: input.persistence.getState().pushedAttempts,
        externalMovements: input.persistence.getState().externalMovements,
        snapshot,
        failureFingerprint,
    });
    try {
        const diagnostics =
            await input.runtime.pipelineDiagnostics.collectAndStore({
                request,
                snapshot,
                observation: observed.outcome as FailedPipelineObservation,
                scope: {
                    workspace: input.workspace,
                    runId: input.runId,
                    repository: input.repository,
                },
                client: input.octokit,
                signal: input.signal,
            });
        diagnosticsPath = diagnostics.path;
        await emitBoundary({
            phase: "diagnostics",
            status: "reconciled",
            currentRemoteSha: remoteAfter,
            pushedAttempts: input.persistence.getState().pushedAttempts,
            externalMovements: input.persistence.getState().externalMovements,
            snapshot,
            failureFingerprint,
            diagnosticsPath,
        });
    } catch (error) {
        await emitBoundary({
            phase: "diagnostics",
            status: "failed",
            currentRemoteSha: remoteAfter,
            pushedAttempts: input.persistence.getState().pushedAttempts,
            externalMovements: input.persistence.getState().externalMovements,
            snapshot,
            failureFingerprint,
            message: errorMessage(error),
        });
        throw error;
    }
    return {
        outcome: {
            ...outcomeForObservation({
                observation: observed.outcome,
                repository: input.repository,
                branch: input.branch,
                remoteSha: remoteAfter,
            }),
            kind: "dry-run",
            status: "dry-run",
            failureFingerprint,
            ...(diagnosticsPath === undefined ? {} : { diagnosticsPath }),
            message:
                "Dry run found a failing pipeline; a repair would be attempted, but no agent or Git mutation was performed.",
            snapshot,
        },
        wouldRepair: true,
    };
};

const resumePendingPush = async (input: {
    readonly state: PipelineRunState;
    readonly persistence: PipelineRunStatePersistence;
    readonly runtime: RalphieRuntime;
    readonly repository: string;
    readonly repositoryPath: string;
    readonly branch: string;
    readonly signal?: AbortSignal;
}): Promise<{
    readonly state: PipelineRunState;
    readonly outcome?: PipelineDeliveryOutcome;
}> => {
    const created = input.state.createdCommit;
    const checkpoint = input.state.checkpoint;
    if (created === undefined || checkpoint === undefined) {
        return {
            state: input.state,
            outcome: outcomeFromState({
                state: input.state,
                remoteSha: input.state.currentRemoteSha,
                kind: "failed",
                message:
                    "A pending pipeline push had no complete checkpoint and cannot be resumed safely.",
            }),
        };
    }
    const checkout = await input.runtime.pipelineDeliveryGit.readCheckout(
        input.repositoryPath,
        input.signal,
    );
    if (
        checkout.branch !== input.branch ||
        !sameSha(checkout.head, created.sha) ||
        checkout.status !== ""
    ) {
        return {
            state: input.state,
            outcome: outcomeFromState({
                state: input.state,
                remoteSha: input.state.currentRemoteSha,
                kind: "failed",
                message:
                    "The recorded pipeline commit is not the clean local checkout; the pending push was not retried.",
            }),
        };
    }
    await input.runtime.gitRemoteSafety.verifyDirectPush({
        repository: input.repository,
        repositoryPath: input.repositoryPath,
        branch: input.branch,
        intendedBaseSha: checkpoint.sha,
        expectedCommitSha: created.sha,
        pushMode: "non-force",
    });
    const push = await input.runtime.pipelineDeliveryGit.pushNonForce({
        repositoryPath: input.repositoryPath,
        branch: input.branch,
        expectedCommitSha: created.sha,
        signal: input.signal,
    });
    const remoteAfter = await input.runtime.pipelineDeliveryGit.readRemoteHead(
        input.repositoryPath,
        input.branch,
        input.signal,
    );
    const attemptState = resumedPushAttempt({
        state: input.state,
        createdSha: created.sha,
        parentSha: created.parentSha,
        push: {
            response: push.response,
            ...(push.failureKind === undefined
                ? {}
                : { failureKind: push.failureKind }),
            remoteSha: remoteAfter,
        },
    });
    const confirmed =
        validSha(remoteAfter) && sameSha(remoteAfter, created.sha);
    const resumedEvent: PipelineDeliveryPersistenceEvent = {
        phase: "push",
        status: "reconciled",
        currentRemoteSha: validSha(remoteAfter)
            ? remoteAfter
            : input.state.currentRemoteSha,
        pushedAttempts: input.state.pushedAttempts,
        externalMovements: input.state.externalMovements,
        attempt: attemptState.attempt,
        attemptState,
        commit: created,
        ...(confirmed
            ? {}
            : { message: "The resumed non-force push was not confirmed." }),
    };
    await input.persistence.onPhase(resumedEvent);
    const nextState = input.persistence.getState();
    if (confirmed) return { state: nextState };
    return {
        state: nextState,
        outcome: outcomeFromState({
            state: nextState,
            remoteSha: validSha(remoteAfter)
                ? remoteAfter
                : nextState.currentRemoteSha,
            kind:
                push.failureKind === "non-fast-forward"
                    ? "non-fast-forward"
                    : "ambiguous-push",
            message:
                push.failureKind === "non-fast-forward"
                    ? "The resumed non-force push was rejected as non-fast-forward."
                    : "The resumed push outcome could not be reconciled; no retry was attempted.",
        }),
    };
};

const terminalOutcomeForError = (input: {
    readonly state: PipelineRunState;
    readonly signal?: AbortSignal;
    readonly error: unknown;
}): PipelineDeliveryOutcome =>
    outcomeFromState({
        state: input.state,
        remoteSha: input.state.currentRemoteSha,
        kind: input.signal?.aborted === true ? "cancelled" : "failed",
        message:
            input.signal?.aborted === true
                ? "Pipeline delivery was cancelled; resumable state was preserved."
                : errorMessage(input.error),
    });

const finalize = async (input: {
    readonly runtime: RalphieRuntime;
    readonly config: GetPipelinesGreenRalphieConfig;
    readonly statePath: string;
    readonly state: PipelineRunState;
    readonly persistence: PipelineRunStatePersistence;
    readonly outcome: PipelineDeliveryOutcome;
    readonly wouldRepair: boolean;
    readonly progress: ProgressReporterService;
}): Promise<PipelineRunSummary> => {
    await emitOutcomeProgress(
        input.progress,
        input.outcome,
        input.statePath,
        input.config.dryRun,
    );
    if (input.outcome.kind !== "green") {
        throw new PipelineDeliveryOutcomeError(input.outcome);
    }
    if (input.config.cleanEnd) {
        await track({
            progress: input.progress,
            stage: "workspace-cleanup",
            message: `Removing completed workspace ${input.config.workspace}...`,
            operation: () =>
                input.runtime.workspace.remove(input.config.workspace),
            success: `Completed workspace removed: ${input.config.workspace}.`,
            repository: input.config.repo,
        });
    }
    return {
        runId: input.state.runId,
        repository: input.state.repository,
        branch: input.state.branch,
        statePath: input.statePath,
        outcome: input.outcome,
        dryRun: input.config.dryRun,
        wouldRepair: input.wouldRepair,
    };
};

/** Execute get-pipelines-green through the runtime's explicit seams. */
export const getPipelinesGreen: GetPipelinesGreenEntryPoint = async (
    options,
    runtime,
): Promise<PipelineRunSummary> => {
    const { config } = options;
    const resume = options.resumeState;
    const runId = resume?.runId ?? options.runId;
    const statePath =
        config.resume ?? pipelineRunStatePath(config.workspace, runId);
    let persistence: PipelineRunStatePersistence | undefined;
    let state: PipelineRunState | undefined;
    let outcomePersisted = false;
    let server: OpenCodeRuntime | undefined;
    try {
        if (config.cleanStart && resume === undefined) {
            await track({
                progress: runtime.progress,
                stage: "workspace-cleanup",
                message: `Removing existing workspace ${config.workspace}...`,
                operation: () => runtime.workspace.remove(config.workspace),
                success: `Existing workspace removed: ${config.workspace}.`,
                repository: config.repo,
            });
        }
        await track({
            progress: runtime.progress,
            stage: "workspace-preparation",
            message: `Preparing workspace ${config.workspace}...`,
            operation: () => runtime.workspace.prepare(config.workspace),
            success: `Workspace ready: ${config.workspace}.`,
            repository: config.repo,
        });
        checkCancellation(options.signal);
        const octokit = await track({
            progress: runtime.progress,
            stage: "github-authentication",
            message: "Checking GitHub authentication...",
            operation: () => runtime.githubClient.initialize(),
            success: "GitHub authentication verified and Octokit initialized.",
            repository: config.repo,
        });
        checkCancellation(options.signal);
        await track({
            progress: runtime.progress,
            stage: "git-verification",
            message: "Checking Git installation...",
            operation: () => runtime.gitRepository.verifyInstalled(),
            success: "Git installation verified.",
            repository: config.repo,
        });
        checkCancellation(options.signal);
        const prepared = await track({
            progress: runtime.progress,
            stage: "repository-preparation",
            message: `Preparing ${config.repo} on ${resume?.branch ?? config.branch ?? "main/master"}...`,
            operation: () =>
                runtime.gitRepository.prepare(
                    config.repo,
                    resume?.branch ?? config.branch,
                    config.workspace,
                ),
            success: (value) => `Repository ready: ${value.path}.`,
            repository: config.repo,
            details: {
                branch: resume?.branch ?? config.branch ?? "main/master",
                workspace: config.workspace,
            },
        });
        const branch = prepared.branch;
        if (resume !== undefined && branch !== resume.branch) {
            throw new RalphieError({
                message: `Cannot resume pipeline run ${resume.runId}: prepared branch is ${branch}, saved branch is ${resume.branch}.`,
            });
        }
        const remoteSha = await track({
            progress: runtime.progress,
            stage: "pipeline-remote-read",
            message: `Reading origin/${branch}...`,
            operation: () =>
                runtime.pipelineDeliveryGit.readRemoteHead(
                    prepared.path,
                    branch,
                    options.signal,
                ),
            success: (value) => `Remote pipeline head: ${value}.`,
            repository: config.repo,
            details: { branch },
        });
        if (!validSha(remoteSha)) {
            throw new RalphieError({
                message: `origin/${branch} did not provide a full remote commit SHA.`,
            });
        }

        let resumeAction: string | undefined;
        if (resume === undefined) {
            const deadlineAtMs =
                Date.now() +
                durationToMilliseconds(
                    config.pipelineTimeout ?? DEFAULT_PIPELINE_TIMEOUT,
                );
            state = makePipelineRunState({
                runId,
                repository: config.repo,
                branch,
                workspace: config.workspace,
                deadlineAtMs,
                maxAttempts: config.maxAttempts,
                currentRemoteSha: remoteSha,
            });
        } else {
            const reconciliation = reconcilePipelineRunStateOnResume({
                state: resume,
                remoteSha,
            });
            resumeAction = reconciliation.action;
            state = reconciliation.state;
            if (reconciliation.message !== undefined) {
                await runtime.progress.emit({
                    stage: "pipeline-resume",
                    status: "info",
                    message: reconciliation.message,
                    repository: config.repo,
                    details: {
                        action: reconciliation.action,
                        branch,
                        remoteSha,
                        deadlineAtMs: state.deadlineAtMs,
                    },
                });
            }
        }
        persistence = makePipelineRunStatePersistence({
            path: statePath,
            initialState: state,
            store: runtime.pipelineRunStateStore,
        });
        await runtime.pipelineRunStateStore.save(statePath, state);
        await persistence.onPhase({
            phase: "remote-read",
            status: "succeeded",
            currentRemoteSha: remoteSha,
            pushedAttempts: state.pushedAttempts,
            externalMovements: state.externalMovements,
        });

        if (resumeAction === "already-complete") {
            const outcome = outcomeFromState({
                state: persistence.getState(),
                remoteSha,
                kind: "green",
                message: "The saved green result is still current.",
            });
            await persistence.onOutcome(outcome);
            outcomePersisted = true;
            return await finalize({
                runtime,
                config,
                statePath,
                state: persistence.getState(),
                persistence,
                outcome,
                wouldRepair: false,
                progress: runtime.progress,
            });
        }
        if (
            resumeAction === "deadline-expired" ||
            resumeAction === "stale-remote"
        ) {
            const outcome = outcomeFromState({
                state: persistence.getState(),
                remoteSha,
                kind:
                    resumeAction === "deadline-expired"
                        ? "timeout"
                        : "external-movement",
                message: state.lastError,
            });
            await persistence.onOutcome(outcome);
            outcomePersisted = true;
            return await finalize({
                runtime,
                config,
                statePath,
                state: persistence.getState(),
                persistence,
                outcome,
                wouldRepair: false,
                progress: runtime.progress,
            });
        }

        if (resumeAction === "resume-push" && !config.dryRun) {
            const resumedPush = await resumePendingPush({
                state: persistence.getState(),
                persistence,
                runtime,
                repository: config.repo,
                repositoryPath: prepared.path,
                branch,
                signal: options.signal,
            });
            state = resumedPush.state;
            if (resumedPush.outcome !== undefined) {
                await persistence.onOutcome(resumedPush.outcome);
                outcomePersisted = true;
                return await finalize({
                    runtime,
                    config,
                    statePath,
                    state: persistence.getState(),
                    persistence,
                    outcome: resumedPush.outcome,
                    wouldRepair: false,
                    progress: runtime.progress,
                });
            }
        }

        if (config.dryRun) {
            const result = await dryRunOutcome({
                runtime,
                octokit,
                repository: config.repo,
                branch,
                repositoryPath: prepared.path,
                workspace: config.workspace,
                runId,
                remoteSha: persistence.getState().currentRemoteSha,
                deadlineAtMs: persistence.getState().deadlineAtMs,
                persistence,
                signal: options.signal,
                progress: runtime.progress,
            });
            await persistence.onOutcome(result.outcome);
            outcomePersisted = true;
            return await finalize({
                runtime,
                config,
                statePath,
                state: persistence.getState(),
                persistence,
                outcome: result.outcome,
                wouldRepair: result.wouldRepair,
                progress: runtime.progress,
            });
        }

        const startedServer = await track({
            progress: runtime.progress,
            stage: "opencode-runtime",
            message: "Starting OpenCode runtime...",
            operation: () => runtime.opencode.start(),
            success: "OpenCode runtime ready.",
            repository: config.repo,
        });
        server = startedServer;
        const selection: AgentSelection = {
            agent: config.agent,
            ...(config.model === undefined ? {} : { model: config.model }),
            ...(config.thinking === undefined
                ? {}
                : { variant: config.thinking }),
        };
        const onPhase = async (
            event: PipelineDeliveryPersistenceEvent,
        ): Promise<void> => {
            await persistence?.onPhase(event);
            await emitPhaseProgress(runtime.progress, event, false);
        };
        const onOutcome = async (
            outcome: PipelineDeliveryOutcome,
        ): Promise<void> => {
            await persistence?.onOutcome(outcome);
            outcomePersisted = true;
        };
        const outcome = await runtime.pipelineDeliveryLoop.execute({
            repository: config.repo,
            repositoryPath: prepared.path,
            workspace: config.workspace,
            branch,
            runId,
            client: octokit,
            agent: startedServer.client,
            agentSelection: selection,
            initialRemoteSha: persistence.getState().currentRemoteSha,
            initialPushedAttempts: persistence.getState().pushedAttempts,
            initialExternalMovements: persistence.getState().externalMovements,
            initialAttempts: stateAttemptsToDelivery(
                persistence.getState().attempts,
            ),
            maxAttempts: persistence.getState().maxAttempts,
            deadlineAtMs: persistence.getState().deadlineAtMs,
            agentDiagnostics: makeAgentSessionDiagnostics(),
            signal: options.signal,
            progress: runtime.progress,
            onPhase,
            onOutcome,
        });
        return await finalize({
            runtime,
            config,
            statePath,
            state: persistence.getState(),
            persistence,
            outcome,
            wouldRepair: false,
            progress: runtime.progress,
        });
    } catch (error) {
        if (error instanceof PipelineDeliveryOutcomeError) throw error;
        if (
            state !== undefined &&
            persistence !== undefined &&
            !outcomePersisted
        ) {
            const outcome = terminalOutcomeForError({
                state: persistence.getState(),
                signal: options.signal,
                error,
            });
            await persistence.onOutcome(outcome);
            await emitOutcomeProgress(
                runtime.progress,
                outcome,
                statePath,
                config.dryRun,
            );
        }
        throw error;
    } finally {
        await server?.close();
    }
};

export const runGetPipelinesGreen = getPipelinesGreen;