// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: delivery is an explicit safety state machine

import type { AgentSelection } from "../agent/model.ts";
import type { AgentSessionDiagnostics } from "../agent/task-session.ts";
import type { Octokit } from "octokit";
import type { PipelineDiagnosticsBoundary } from "../github/pipeline-diagnostics-boundary.ts";
import type {
    FailedPipelineObservation,
    PipelineObservationOptions,
    PipelineObservationResult,
    PipelineObservationService,
} from "../github/pipeline-observation.ts";
import type {
    PipelineSnapshot,
    PipelineSnapshotRequest,
} from "../github/pipeline-snapshot.ts";
import type { IssueArtifactScope } from "../issues/artifacts.ts";
import type {
    PipelineRepairExecutorService,
    PipelineRepairOutcome,
} from "../issues/pipeline-repair-executor.ts";
import type { CommitMessageDecision } from "../issues/decisions.ts";
import type { AgentClient } from "../opencode/client.ts";
import type {
    PipelineCheckoutState,
    PipelineCommitResult,
    PipelineDeliveryGitService,
    PipelinePushAttempt,
} from "../git/pipeline-delivery.ts";
import type { GitRemoteSafetyService } from "../git/remote-safety.ts";
import { reconcilePipelinePush } from "../git/push-reconciliation.ts";
import type { GitRepositoryService } from "../git/repository.ts";
import type { GitRepositoryInvariantService } from "../git/repository-invariant.ts";
import type {
    ProgressIssue,
    ProgressStage,
    ProgressStatus,
    ProgressReporterService,
} from "../progress/progress.ts";
import { RalphieError } from "../shared/error.ts";
import {
    DEFAULT_PIPELINE_TIMEOUT,
    durationToMilliseconds,
} from "../options.ts";
import {
    pipelineRunStatePath,
    type PipelineAttemptState,
    type PipelineDeliveryStateSession,
    type PipelineRunState,
} from "../run/pipeline-state.ts";

import {
    PIPELINE_DELIVERY_EXTERNAL_MOVEMENT_LIMIT,
    type PipelineDeliveryAttempt,
    type PipelineDeliveryEvent,
    type PipelineDeliveryOutcome,
    type PipelineDeliveryOutcomeKind,
    type PipelineDeliveryPhaseEvent,
    type PipelineDeliveryPhase,
    type PipelineDeliveryPhaseOutcome,
    type PipelineDeliveryPushOutcome,
    type PipelineDeliveryRequest,
    type PipelineDeliveryResult,
    type PipelineDeliveryContext,
    type PipelineDeliveryLifecycle,
} from "./delivery-types.ts";
import { pipelineFailureFingerprint } from "./snapshot-identity.ts";
import type { PipelineDeliveryStateAdapter } from "../run/pipeline-state.ts";

export type { PipelineDeliveryLifecycle } from "./delivery-types.ts";

export type PipelineDiagnosticsRunnerInput = {
    readonly request: PipelineSnapshotRequest;
    readonly snapshot: PipelineSnapshot;
    readonly observation: FailedPipelineObservation;
    readonly scope: IssueArtifactScope;
    readonly client?: Octokit;
    readonly signal?: AbortSignal;
};

export type PipelineDiagnosticsRunnerResult = {
    readonly boundary: PipelineDiagnosticsBoundary;
    readonly path?: string;
};

export type PipelineDiagnosticsRunner = (
    input: PipelineDiagnosticsRunnerInput,
) => Promise<PipelineDiagnosticsRunnerResult>;

export type PipelineCommitMessageInput = {
    readonly repository: string;
    readonly repositoryPath: string;
    readonly workspace: string;
    readonly runId: string;
    readonly branch: string;
    readonly failingHeadSha: string;
    readonly snapshot: PipelineSnapshot;
    readonly diagnostics: PipelineDiagnosticsBoundary;
    readonly stagedDiff: string;
    readonly signal?: AbortSignal;
};

export type PipelineCommitMessageRunner = (
    input: PipelineCommitMessageInput,
) => Promise<CommitMessageDecision>;

type PipelineDeliveryExecutionInput = {
    readonly repository: string;
    readonly repositoryPath: string;
    readonly workspace: string;
    readonly branch: string;
    readonly runId: string;
    readonly client?: Octokit;
    readonly agent: AgentClient;
    readonly agentSelection: AgentSelection;
    /** Resume inputs are already reconciled by the state layer. */
    readonly initialRemoteSha?: string;
    readonly initialPushedAttempts?: number;
    readonly initialExternalMovements?: number;
    readonly initialAttempts?: ReadonlyArray<PipelineDeliveryAttempt>;
    /** Number of repairs that may actually be confirmed on the remote. */
    readonly maxAttempts: number;
    /** Absolute Unix epoch deadline; it is not restarted after a push. */
    readonly deadlineAtMs: number;
    readonly observationOptions?: PipelineObservationOptions;
    readonly agentDiagnostics?: AgentSessionDiagnostics;
    readonly signal?: AbortSignal;
    readonly progress?: ProgressReporterService;
    readonly progressIssue?: ProgressIssue;
    readonly reviewBudget?: number;
    /** A caller-provided validated message is useful for deterministic resume. */
    readonly commitMessage?: CommitMessageDecision;
    /** Optional durable sink invoked around every observable phase boundary. */
    readonly onPhase?: (event: PipelineDeliveryPhaseEvent) => Promise<void>;
    /** Optional durable sink for terminal success, stop, failure, or cancel. */
    readonly onOutcome?: (outcome: PipelineDeliveryOutcome) => Promise<void>;
};

export type PipelineDeliveryEngineDependencies = {
    readonly git: PipelineDeliveryGitService;
    readonly observation: Pick<PipelineObservationService, "observe">;
    readonly diagnostics: PipelineDiagnosticsRunner;
    readonly repair: Pick<PipelineRepairExecutorService, "execute">;
    readonly repositoryInvariant: GitRepositoryInvariantService;
    /** Optional GitHub-origin/ancestry check for the production direct-push path. */
    readonly remoteSafety?: Pick<GitRemoteSafetyService, "verifyDirectPush">;
    readonly commitMessage?: PipelineCommitMessageRunner;
    readonly now?: () => number;
    readonly maxExternalMovements?: number;
};

type PipelineDeliveryEngine = {
    readonly execute: (
        input: PipelineDeliveryExecutionInput,
    ) => Promise<PipelineDeliveryOutcome>;
};

export class PipelineDeliveryLifecycleError extends RalphieError {
    override readonly _tag = "PipelineDeliveryLifecycleError" as const;
    readonly kind: "invalid-input" | "safety-failed";

    constructor(input: {
        readonly kind: "invalid-input" | "safety-failed";
        readonly message: string;
        readonly cause?: unknown;
    }) {
        super(input);
        this.name = "PipelineDeliveryLifecycleError";
        this.kind = input.kind;
    }
}

const FULL_GIT_OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const sameSha = (left: string, right: string): boolean =>
    left.toLowerCase() === right.toLowerCase();

const messageOf = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

const nonBlank = (value: string): boolean => value.trim().length > 0;

const validSha = (value: string): boolean => FULL_GIT_OBJECT_ID.test(value);

export const isValidPipelineCommitMessage = (
    message: CommitMessageDecision,
): boolean =>
    nonBlank(message.subject) &&
    message.subject.length <= 72 &&
    (message.body === undefined || nonBlank(message.body));

const defaultCommitMessage = (
    branch: string,
    failureFingerprint: string,
): CommitMessageDecision => {
    const subjectPrefix = "Fix failing pipeline on ";
    const available = Math.max(1, 72 - subjectPrefix.length);
    const branchPart = branch.slice(0, available);
    return {
        subject: `${subjectPrefix}${branchPart}`.slice(0, 72),
        body: `Repair normalized failure ${failureFingerprint}.`,
    };
};

const assertInput = (input: PipelineDeliveryExecutionInput): void => {
    if (
        !nonBlank(input.repository) ||
        !nonBlank(input.repositoryPath) ||
        !nonBlank(input.workspace) ||
        !nonBlank(input.branch) ||
        !nonBlank(input.runId)
    ) {
        throw new PipelineDeliveryLifecycleError({
            kind: "invalid-input",
            message:
                "Pipeline delivery requires non-empty repository, checkout, workspace, branch, and run identifiers.",
        });
    }
    if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts <= 0) {
        throw new PipelineDeliveryLifecycleError({
            kind: "invalid-input",
            message:
                "Pipeline delivery maxAttempts must be a positive integer.",
        });
    }
    if (!Number.isFinite(input.deadlineAtMs) || input.deadlineAtMs <= 0) {
        throw new PipelineDeliveryLifecycleError({
            kind: "invalid-input",
            message:
                "Pipeline delivery deadlineAtMs must be a positive epoch time.",
        });
    }
    if (
        input.initialRemoteSha !== undefined &&
        !validSha(input.initialRemoteSha)
    ) {
        throw new PipelineDeliveryLifecycleError({
            kind: "invalid-input",
            message:
                "Pipeline delivery initialRemoteSha must be a full Git object ID.",
        });
    }
    if (
        input.initialPushedAttempts !== undefined &&
        (!Number.isSafeInteger(input.initialPushedAttempts) ||
            input.initialPushedAttempts < 0 ||
            input.initialPushedAttempts > input.maxAttempts)
    ) {
        throw new PipelineDeliveryLifecycleError({
            kind: "invalid-input",
            message:
                "Pipeline delivery initialPushedAttempts must be a non-negative integer within maxAttempts.",
        });
    }
    if (
        input.initialExternalMovements !== undefined &&
        (!Number.isSafeInteger(input.initialExternalMovements) ||
            input.initialExternalMovements < 0)
    ) {
        throw new PipelineDeliveryLifecycleError({
            kind: "invalid-input",
            message:
                "Pipeline delivery initialExternalMovements must be a non-negative integer.",
        });
    }
    if (
        input.commitMessage !== undefined &&
        !isValidPipelineCommitMessage(input.commitMessage)
    ) {
        throw new PipelineDeliveryLifecycleError({
            kind: "invalid-input",
            message: "Pipeline delivery received an invalid commit message.",
        });
    }
};

type DeadlineControl = {
    readonly signal: AbortSignal;
    readonly isDeadlineExpired: () => boolean;
    readonly isCallerCancelled: () => boolean;
    readonly dispose: () => void;
};

type ReconcileResult = PipelineDeliveryOutcome | "moved" | undefined;

const makeDeadlineControl = (
    input: PipelineDeliveryExecutionInput,
    now: () => number,
): DeadlineControl => {
    const controller = new AbortController();
    let deadlineExpired = false;
    let callerCancelled = input.signal?.aborted === true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abortForDeadline = (): void => {
        deadlineExpired = true;
        if (!controller.signal.aborted) {
            controller.abort(new Error("Pipeline delivery deadline expired."));
        }
    };
    const onCallerAbort = (): void => {
        callerCancelled = true;
        if (!controller.signal.aborted) controller.abort(input.signal?.reason);
    };
    input.signal?.addEventListener("abort", onCallerAbort, { once: true });
    if (now() >= input.deadlineAtMs) {
        abortForDeadline();
    } else {
        const remaining = input.deadlineAtMs - now();
        timer = setTimeout(
            abortForDeadline,
            Math.min(remaining, 2_147_000_000),
        );
    }
    return {
        signal: controller.signal,
        isDeadlineExpired: () => deadlineExpired || now() >= input.deadlineAtMs,
        isCallerCancelled: () =>
            callerCancelled || input.signal?.aborted === true,
        dispose: () => {
            if (timer !== undefined) clearTimeout(timer);
            input.signal?.removeEventListener("abort", onCallerAbort);
        },
    };
};

const phaseMessage = (error: unknown): string => {
    const value = messageOf(error).trim();
    return value.length > 0
        ? value.slice(0, 2000)
        : "Pipeline delivery phase failed.";
};

const matchesObservationRequest = (
    outcome: PipelineObservationResult["outcome"],
    request: PipelineSnapshotRequest,
): boolean =>
    outcome.observedSha.toLowerCase() === request.commitSha.toLowerCase();

const observationSnapshot = (
    outcome: PipelineObservationResult["outcome"],
): PipelineSnapshot | undefined => {
    if (
        outcome.kind === "green" ||
        outcome.kind === "stale" ||
        outcome.kind === "failed"
    ) {
        return outcome.snapshot;
    }
    return outcome.kind === "timeout" ? outcome.lastSnapshot : undefined;
};

const safeRemoteRead = async (
    git: PipelineDeliveryGitService,
    input: PipelineDeliveryExecutionInput,
): Promise<string | undefined> => {
    try {
        return await git.readRemoteHead(input.repositoryPath, input.branch);
    } catch {
        return undefined;
    }
};

const isFailedObservation = (
    outcome: PipelineObservationResult["outcome"],
): outcome is Extract<
    PipelineObservationResult["outcome"],
    { kind: "failed" }
> => outcome.kind === "failed";

const isFailureSnapshot = (
    snapshot: PipelineSnapshot | undefined,
): snapshot is PipelineSnapshot =>
    snapshot !== undefined &&
    !snapshot.greenCandidate &&
    nonBlank(snapshot.fingerprint);

const checkoutAt = (
    checkout: PipelineCheckoutState,
    branch: string,
    sha: string,
): boolean => checkout.branch === branch && sameSha(checkout.head, sha);

/** Restore only an uncommitted repair after cancellation/timeout. */
const restoreUncommittedCheckpoint = async (
    dependencies: PipelineDeliveryEngineDependencies,
    input: PipelineDeliveryExecutionInput,
    checkpointSha: string | undefined,
): Promise<void> => {
    if (checkpointSha === undefined) return;
    try {
        const checkout = await dependencies.git.readCheckout(
            input.repositoryPath,
        );
        if (
            !checkoutAt(checkout, input.branch, checkpointSha) ||
            checkout.status === ""
        ) {
            return;
        }
        await dependencies.git.discardToExactCheckout(
            input.repositoryPath,
            input.branch,
            checkpointSha,
        );
    } catch {
        // The original cancellation/timeout result is safer than replacing it
        // with a cleanup error. A moved branch or committed local head is left
        // intact for the state-layer reconciliation path.
    }
};

const repairStatus = (
    repair: PipelineRepairOutcome,
): PipelineRepairOutcome["status"] => repair.status;

const pushStatusFor = (
    push: PipelinePushAttempt,
    remoteSha: string,
    expectedSha: string,
    priorSha: string,
): PipelineDeliveryPushOutcome["status"] =>
    reconcilePipelinePush({
        remoteSha,
        expectedSha,
        priorSha,
        response: push.response,
        ...(push.failureKind === undefined
            ? {}
            : { failureKind: push.failureKind }),
    });

const output = (
    kind: PipelineDeliveryOutcomeKind,
    input: PipelineDeliveryExecutionInput,
    state: {
        readonly remoteSha?: string;
        readonly source?: "already-green" | "pushed-repair";
        readonly failureFingerprint?: string;
        readonly diagnosticsPath?: string;
        readonly message?: string;
        readonly pushedAttempts: number;
        readonly externalMovements: number;
        readonly attempts: ReadonlyArray<PipelineDeliveryAttempt>;
        readonly phases: ReadonlyArray<PipelineDeliveryPhaseOutcome>;
        readonly snapshot?: PipelineSnapshot;
    },
): PipelineDeliveryOutcome => ({
    kind,
    status: kind,
    repository: input.repository,
    branch: input.branch,
    ...(state.source === undefined ? {} : { source: state.source }),
    ...(state.remoteSha === undefined ? {} : { remoteSha: state.remoteSha }),
    ...(state.failureFingerprint === undefined
        ? {}
        : { failureFingerprint: state.failureFingerprint }),
    ...(state.diagnosticsPath === undefined
        ? {}
        : { diagnosticsPath: state.diagnosticsPath }),
    ...(state.message === undefined ? {} : { message: state.message }),
    pushedAttempts: state.pushedAttempts,
    externalMovements: state.externalMovements,
    attempts: [...state.attempts],
    phases: [...state.phases],
    ...(state.snapshot === undefined ? {} : { snapshot: state.snapshot }),
});

/**
 * Implement the direct base-branch repair safety machine. The lifecycle owns the
 * ordering of observation, diagnosis, repair, commit, push, and final proof;
 * Git and agent details remain behind injected seams for deterministic tests.
 */
const makePipelineDeliveryEngine = (
    dependencies: PipelineDeliveryEngineDependencies,
): PipelineDeliveryEngine => {
    const now = dependencies.now ?? (() => Date.now());
    const externalMovementLimit =
        dependencies.maxExternalMovements ??
        PIPELINE_DELIVERY_EXTERNAL_MOVEMENT_LIMIT;

    const executeOnce = async (
        input: PipelineDeliveryExecutionInput,
    ): Promise<PipelineDeliveryOutcome> => {
        assertInput(input);
        if (
            !Number.isSafeInteger(externalMovementLimit) ||
            externalMovementLimit < 0
        ) {
            throw new PipelineDeliveryLifecycleError({
                kind: "invalid-input",
                message:
                    "Pipeline delivery external movement limit must be a non-negative integer.",
            });
        }

        const deadline = makeDeadlineControl(input, now);
        const phases: PipelineDeliveryPhaseOutcome[] = [];
        const attempts: PipelineDeliveryAttempt[] = [
            ...(input.initialAttempts ?? []),
        ];
        let pushedAttempts = input.initialPushedAttempts ?? 0;
        let externalMovements = input.initialExternalMovements ?? 0;
        let currentSha: string | undefined = input.initialRemoteSha;
        let lastFailureFingerprint: string | undefined;
        let lastDiagnosticsPath: string | undefined;

        const notifyPhase = async (event: {
            readonly phase: PipelineDeliveryPhase;
            readonly status: PipelineDeliveryPhaseEvent["status"];
            readonly attempt?: number;
            readonly snapshot?: PipelineSnapshot;
            readonly diagnosticsPath?: string;
            readonly message?: string;
            readonly attemptState?: PipelineDeliveryAttempt;
            readonly commit?: PipelineCommitResult;
        }): Promise<void> => {
            await input.onPhase?.({
                ...event,
                ...(currentSha === undefined
                    ? {}
                    : { currentRemoteSha: currentSha }),
                pushedAttempts,
                externalMovements,
                ...(lastFailureFingerprint === undefined
                    ? {}
                    : { failureFingerprint: lastFailureFingerprint }),
                ...(lastDiagnosticsPath === undefined
                    ? {}
                    : { diagnosticsPath: lastDiagnosticsPath }),
                ...(event.snapshot === undefined
                    ? {}
                    : { snapshot: event.snapshot }),
                ...(event.diagnosticsPath === undefined
                    ? {}
                    : { diagnosticsPath: event.diagnosticsPath }),
                ...(event.message === undefined
                    ? {}
                    : { message: event.message }),
            });
        };

        const replaceLastAttempt = (
            update: Partial<PipelineDeliveryAttempt>,
        ): void => {
            const existing = attempts[attempts.length - 1];
            if (existing === undefined) {
                throw new PipelineDeliveryLifecycleError({
                    kind: "safety-failed",
                    message:
                        "Pipeline delivery lost its current attempt record.",
                });
            }
            attempts[attempts.length - 1] = { ...existing, ...update };
        };

        const addPhase = (
            phase: PipelineDeliveryPhase,
            outcome: "succeeded" | "failed",
            attempt: number | undefined,
            message: string | undefined,
        ): void => {
            phases.push({
                phase,
                outcome,
                ...(attempt === undefined ? {} : { attempt }),
                ...(message === undefined
                    ? {}
                    : { message: message.slice(0, 2000) }),
            });
        };

        const runPhase = async <Value>(
            phase: PipelineDeliveryPhase,
            attempt: number | undefined,
            work: () => Promise<Value>,
        ): Promise<Value> => {
            try {
                await notifyPhase({ phase, status: "before", attempt });
                const value = await work();
                addPhase(phase, "succeeded", attempt, undefined);
                await notifyPhase({ phase, status: "succeeded", attempt });
                return value;
            } catch (error) {
                addPhase(phase, "failed", attempt, phaseMessage(error));
                await notifyPhase({
                    phase,
                    status: "failed",
                    attempt,
                    message: phaseMessage(error),
                }).catch(() => undefined);
                throw error;
            }
        };

        const checkDeadline = (): void => {
            if (deadline.isDeadlineExpired()) {
                throw new PipelineDeliveryLifecycleError({
                    kind: "safety-failed",
                    message: "Pipeline delivery deadline expired.",
                });
            }
            if (deadline.isCallerCancelled()) {
                throw (
                    input.signal?.reason ??
                    new Error("Pipeline delivery cancelled.")
                );
            }
        };

        const readRemote = async (attempt?: number): Promise<string> => {
            checkDeadline();
            const sha = await runPhase("remote-read", attempt, () =>
                dependencies.git.readRemoteHead(
                    input.repositoryPath,
                    input.branch,
                    deadline.signal,
                ),
            );
            if (sha === "" || !validSha(sha)) {
                throw new PipelineDeliveryLifecycleError({
                    kind: "safety-failed",
                    message: `origin/${input.branch} did not provide a full remote commit SHA.`,
                });
            }
            return sha;
        };

        const terminalOnMovement = (
            remoteSha: string | undefined,
            message: string,
        ): PipelineDeliveryOutcome =>
            output("external-movement", input, {
                remoteSha,
                message,
                failureFingerprint: lastFailureFingerprint,
                diagnosticsPath: lastDiagnosticsPath,
                pushedAttempts,
                externalMovements,
                attempts,
                phases,
            });

        /** Rebase the clean local checkpoint onto a newer remote head. Unpushed commits are orphaned locally but retained in the attempt record; revision delivery intentionally never follows. */
        const reconcileMovement = async (options: {
            readonly expectedRemoteSha: string;
            readonly actualRemoteSha: string;
            readonly localSha: string;
            readonly attempt?: number;
            readonly reason: string;
        }): Promise<ReconcileResult> => {
            externalMovements += 1;
            addPhase(
                "reconcile",
                "succeeded",
                options.attempt,
                `${options.reason}: origin/${input.branch} advanced from ${options.expectedRemoteSha} to ${options.actualRemoteSha}.`,
            );
            if (externalMovements > externalMovementLimit) {
                await runPhase("reconcile", options.attempt, () =>
                    dependencies.git.discardToExactCheckout(
                        input.repositoryPath,
                        input.branch,
                        options.localSha,
                        deadline.signal,
                    ),
                );
                return terminalOnMovement(
                    options.actualRemoteSha,
                    `Stopped after ${externalMovements} external remote movements; the branch was not overwritten.`,
                );
            }
            await runPhase("reconcile", options.attempt, async () => {
                await dependencies.git.discardToExactCheckout(
                    input.repositoryPath,
                    input.branch,
                    options.localSha,
                    deadline.signal,
                );
                await dependencies.git.prepareExactCheckout(
                    input.repositoryPath,
                    input.branch,
                    options.actualRemoteSha,
                    deadline.signal,
                );
            });
            currentSha = options.actualRemoteSha;
            return "moved";
        };

        const reconcileIfMoved = async (options: {
            readonly expectedRemoteSha: string;
            readonly localSha: string;
            readonly attempt?: number;
            readonly reason: string;
        }): Promise<ReconcileResult> => {
            const actual = await readRemote(options.attempt);
            if (sameSha(actual, options.expectedRemoteSha)) return undefined;
            return reconcileMovement({
                ...options,
                actualRemoteSha: actual,
            });
        };

        const commitMessage = async (options: {
            readonly request: PipelineSnapshotRequest;
            readonly snapshot: PipelineSnapshot;
            readonly diagnostics: PipelineDiagnosticsBoundary;
            readonly stagedDiff: string;
            readonly failureFingerprint: string;
            readonly attempt: number;
        }): Promise<CommitMessageDecision> => {
            if (input.commitMessage !== undefined) return input.commitMessage;
            if (dependencies.commitMessage === undefined) {
                return defaultCommitMessage(
                    input.branch,
                    options.failureFingerprint,
                );
            }
            const message = await runPhase(
                "commit-message",
                options.attempt,
                () =>
                    dependencies.commitMessage?.({
                        repository: input.repository,
                        repositoryPath: input.repositoryPath,
                        workspace: input.workspace,
                        runId: input.runId,
                        branch: input.branch,
                        failingHeadSha: options.request.commitSha,
                        snapshot: options.snapshot,
                        diagnostics: options.diagnostics,
                        stagedDiff: options.stagedDiff,
                        signal: deadline.signal,
                    }) ??
                    Promise.reject(
                        new Error(
                            "Pipeline commit message service is unavailable.",
                        ),
                    ),
            );
            if (!isValidPipelineCommitMessage(message)) {
                throw new PipelineDeliveryLifecycleError({
                    kind: "safety-failed",
                    message:
                        "Pipeline commit message service returned an invalid message.",
                });
            }
            return message;
        };

        const complete = (
            kind: PipelineDeliveryOutcomeKind,
            state: {
                readonly remoteSha?: string;
                readonly source?: "already-green" | "pushed-repair";
                readonly failureFingerprint?: string;
                readonly message?: string;
                readonly snapshot?: PipelineSnapshot;
            },
        ): PipelineDeliveryOutcome =>
            output(kind, input, {
                ...state,
                diagnosticsPath: lastDiagnosticsPath,
                pushedAttempts,
                externalMovements,
                attempts,
                phases,
            });

        try {
            checkDeadline();
            if (currentSha === undefined) currentSha = await readRemote();

            while (true) {
                checkDeadline();
                const request: PipelineSnapshotRequest = {
                    repository: input.repository,
                    branch: input.branch,
                    commitSha: currentSha,
                };
                const remaining = Math.max(1, input.deadlineAtMs - now());
                const observationOptions: PipelineObservationOptions = {
                    ...(input.observationOptions ?? {}),
                    deadlineMs: Math.min(
                        input.observationOptions?.deadlineMs ?? remaining,
                        remaining,
                    ),
                };
                const observed = await runPhase("observation", undefined, () =>
                    dependencies.observation.observe({
                        request,
                        client: input.client,
                        options: observationOptions,
                        signal: deadline.signal,
                    }),
                );
                const outcome = observed.outcome;
                if (!matchesObservationRequest(outcome, request)) {
                    return complete("failed", {
                        remoteSha: currentSha,
                        message:
                            "Pipeline observation returned evidence for a different commit; refusing repair.",
                    });
                }

                const movement = await reconcileIfMoved({
                    expectedRemoteSha: currentSha,
                    localSha: currentSha,
                    reason: "observation",
                });
                if (movement === "moved") continue;
                if (movement !== undefined) return movement;
                if (currentSha === undefined) {
                    return complete("failed", {
                        message:
                            "Pipeline delivery lost its current remote SHA.",
                    });
                }

                if (outcome.kind === "green") {
                    const finalRemote = await runPhase(
                        "final-verification",
                        undefined,
                        () =>
                            dependencies.git.readRemoteHead(
                                input.repositoryPath,
                                input.branch,
                                deadline.signal,
                            ),
                    );
                    if (!sameSha(finalRemote, currentSha)) {
                        if (finalRemote === "") {
                            return complete("external-movement", {
                                message:
                                    "The remote branch disappeared during final green verification.",
                                snapshot: outcome.snapshot,
                            });
                        }
                        const finalMovement = await reconcileMovement({
                            expectedRemoteSha: currentSha,
                            actualRemoteSha: finalRemote,
                            localSha: currentSha,
                            reason: "final green verification",
                        });
                        if (finalMovement === "moved") continue;
                        if (finalMovement !== undefined) return finalMovement;
                    }
                    return complete("green", {
                        remoteSha: currentSha,
                        source:
                            pushedAttempts > 0
                                ? "pushed-repair"
                                : "already-green",
                        snapshot: outcome.snapshot,
                    });
                }
                if (outcome.kind === "stale") {
                    return complete("external-movement", {
                        remoteSha: currentSha,
                        message:
                            "Pipeline observation detected a stale branch head; the newer head must be observed before repair.",
                        snapshot: outcome.snapshot,
                    });
                }
                if (outcome.kind === "no-pipelines-discovered") {
                    return complete("no-pipelines-discovered", {
                        remoteSha: currentSha,
                        message:
                            "No pipeline checks were discovered within the observation grace period.",
                    });
                }
                if (outcome.kind === "timeout") {
                    return complete("timeout", {
                        remoteSha: currentSha,
                        message: "Pipeline observation timed out.",
                        snapshot: outcome.lastSnapshot,
                    });
                }
                if (outcome.kind === "aborted") {
                    return complete("cancelled", {
                        remoteSha: currentSha,
                        message:
                            "Pipeline delivery was cancelled during observation.",
                    });
                }
                if (!isFailedObservation(outcome)) {
                    return complete("failed", {
                        remoteSha: currentSha,
                        message:
                            "Pipeline observation returned an unsupported outcome.",
                    });
                }
                if (outcome.reason === "cancelled") {
                    return complete("cancelled", {
                        remoteSha: currentSha,
                        message:
                            outcome.message ??
                            "Pipeline observation was cancelled.",
                    });
                }
                if (
                    outcome.reason !== "failing" ||
                    !isFailureSnapshot(outcome.snapshot)
                ) {
                    return complete("failed", {
                        remoteSha: currentSha,
                        message:
                            outcome.message ??
                            "Pipeline observation could not establish a repairable failure.",
                        snapshot: observationSnapshot(outcome),
                    });
                }

                const snapshot = outcome.snapshot;
                const failureFingerprint = pipelineFailureFingerprint(snapshot);
                if (lastFailureFingerprint === failureFingerprint) {
                    return complete("identical-failure", {
                        remoteSha: currentSha,
                        failureFingerprint,
                        message:
                            "The normalized pipeline failure is identical after a delivered repair; stopping to prevent a repair loop.",
                        snapshot,
                    });
                }
                lastFailureFingerprint = failureFingerprint;
                await notifyPhase({
                    phase: "observation",
                    status: "reconciled",
                    snapshot,
                });
                if (pushedAttempts >= input.maxAttempts) {
                    return complete("attempts-exhausted", {
                        remoteSha: currentSha,
                        failureFingerprint,
                        message: `Maximum pushed pipeline repairs reached (${input.maxAttempts}).`,
                        snapshot,
                    });
                }

                const attemptNumber = pushedAttempts + 1;
                const attempt: PipelineDeliveryAttempt = {
                    attempt: attemptNumber,
                    baseSha: currentSha,
                    failureFingerprint,
                };
                attempts.push(attempt);

                try {
                    await runPhase("prepare", attemptNumber, () =>
                        dependencies.git.prepareExactCheckout(
                            input.repositoryPath,
                            input.branch,
                            currentSha ?? "",
                            deadline.signal,
                        ),
                    );
                } catch (error) {
                    const actual = await safeRemoteRead(
                        dependencies.git,
                        input,
                    );
                    if (
                        actual !== undefined &&
                        actual !== "" &&
                        currentSha !== undefined &&
                        !sameSha(actual, currentSha)
                    ) {
                        const movementAfterPrepare = await reconcileMovement({
                            expectedRemoteSha: currentSha,
                            actualRemoteSha: actual,
                            localSha: currentSha,
                            attempt: attemptNumber,
                            reason: "checkout preparation",
                        });
                        if (movementAfterPrepare === "moved") continue;
                        if (movementAfterPrepare !== undefined)
                            return movementAfterPrepare;
                        continue;
                    }
                    throw error;
                }

                const diagnostics = await runPhase(
                    "diagnostics",
                    attemptNumber,
                    () =>
                        dependencies.diagnostics({
                            request,
                            snapshot,
                            observation: outcome,
                            scope: {
                                workspace: input.workspace,
                                runId: input.runId,
                                repository: input.repository,
                            },
                            client: input.client,
                            signal: deadline.signal,
                        }),
                );
                lastDiagnosticsPath = diagnostics.path;
                await notifyPhase({
                    phase: "diagnostics",
                    status: "reconciled",
                    attempt: attemptNumber,
                    snapshot,
                    diagnosticsPath: diagnostics.path,
                });

                const repair = await runPhase("repair", attemptNumber, () =>
                    dependencies.repair.execute({
                        repository: input.repository,
                        repositoryPath: input.repositoryPath,
                        workspace: input.workspace,
                        branch: input.branch,
                        failingHeadSha: currentSha ?? "",
                        snapshot,
                        diagnostics: diagnostics.boundary,
                        runId: input.runId,
                        agent: input.agent,
                        agentSelection: input.agentSelection,
                        repositoryInvariant: dependencies.repositoryInvariant,
                        ...(input.agentDiagnostics === undefined
                            ? {}
                            : { agentDiagnostics: input.agentDiagnostics }),
                        signal: deadline.signal,
                        ...(input.progress === undefined
                            ? {}
                            : { progress: input.progress }),
                        ...(input.progressIssue === undefined
                            ? {}
                            : { progressIssue: input.progressIssue }),
                        ...(diagnostics.path === undefined
                            ? {}
                            : { diagnosticsPath: diagnostics.path }),
                        ...(input.reviewBudget === undefined
                            ? {}
                            : { reviewBudget: input.reviewBudget }),
                    }),
                );
                replaceLastAttempt({ repair: repairStatus(repair) });
                await notifyPhase({
                    phase: "repair",
                    status: "reconciled",
                    attempt: attemptNumber,
                    snapshot,
                    attemptState: attempts[attempts.length - 1],
                });

                const afterRepair = await readRemote(attemptNumber);
                if (!sameSha(afterRepair, currentSha ?? "")) {
                    const movementAfterRepair = await reconcileMovement({
                        expectedRemoteSha: currentSha ?? "",
                        actualRemoteSha: afterRepair,
                        localSha: currentSha ?? "",
                        attempt: attemptNumber,
                        reason: "agent repair",
                    });
                    if (movementAfterRepair === "moved") continue;
                    if (movementAfterRepair !== undefined)
                        return movementAfterRepair;
                    continue;
                }

                if (repair.status === "no-change") {
                    return complete("no-change", {
                        remoteSha: currentSha,
                        failureFingerprint,
                        message:
                            "The pipeline repair agent produced no changes.",
                        snapshot,
                    });
                }
                if (repair.status === "review-exhausted") {
                    return complete("review-exhausted", {
                        remoteSha: currentSha,
                        failureFingerprint,
                        message:
                            "Pipeline repair review budget was exhausted without approval.",
                        snapshot,
                    });
                }
                if (repair.stagedDiff.length === 0) {
                    await dependencies.git.discardToExactCheckout(
                        input.repositoryPath,
                        input.branch,
                        currentSha,
                        deadline.signal,
                    );
                    return complete("no-change", {
                        remoteSha: currentSha,
                        failureFingerprint,
                        message:
                            "The approved pipeline repair contained no staged diff.",
                        snapshot,
                    });
                }

                const checkout = await dependencies.git.readCheckout(
                    input.repositoryPath,
                    deadline.signal,
                );
                if (!checkoutAt(checkout, input.branch, currentSha)) {
                    return complete("failed", {
                        remoteSha: currentSha,
                        failureFingerprint,
                        message:
                            "The pipeline repair changed the local branch or HEAD; refusing to commit.",
                        snapshot,
                    });
                }
                const stagedTreeSha = await dependencies.git.readStagedTreeSha(
                    input.repositoryPath,
                    deadline.signal,
                );
                if (
                    repair.stagedTreeSha !== undefined &&
                    !sameSha(repair.stagedTreeSha, stagedTreeSha)
                ) {
                    return complete("failed", {
                        remoteSha: currentSha,
                        failureFingerprint,
                        message:
                            "The staged pipeline tree differs from the repair executor's approved tree.",
                        snapshot,
                    });
                }

                const movementBeforeCommit = await reconcileIfMoved({
                    expectedRemoteSha: currentSha,
                    localSha: currentSha,
                    attempt: attemptNumber,
                    reason: "pre-commit safety check",
                });
                if (movementBeforeCommit === "moved") continue;
                if (movementBeforeCommit !== undefined)
                    return movementBeforeCommit;

                if (dependencies.remoteSafety !== undefined) {
                    try {
                        await runPhase(
                            "commit-message",
                            attemptNumber,
                            async () => {
                                await dependencies.remoteSafety?.verifyDirectPush(
                                    {
                                        repository: input.repository,
                                        repositoryPath: input.repositoryPath,
                                        branch: input.branch,
                                        intendedBaseSha: currentSha ?? "",
                                        pushMode: "non-force",
                                    },
                                );
                            },
                        );
                    } catch (error) {
                        return complete("failed", {
                            remoteSha: currentSha,
                            failureFingerprint,
                            message: `Pre-commit repository safety proof failed: ${phaseMessage(error)}`,
                            snapshot,
                        });
                    }
                }

                let message: CommitMessageDecision;
                try {
                    message = await commitMessage({
                        request,
                        snapshot,
                        diagnostics: diagnostics.boundary,
                        stagedDiff: repair.stagedDiff,
                        failureFingerprint,
                        attempt: attemptNumber,
                    });
                } catch (error) {
                    await dependencies.git.discardToExactCheckout(
                        input.repositoryPath,
                        input.branch,
                        currentSha,
                        deadline.signal,
                    );
                    return complete("failed", {
                        remoteSha: currentSha,
                        failureFingerprint,
                        message: `Pipeline commit message generation failed: ${phaseMessage(error)}`,
                        snapshot,
                    });
                }

                let commit: PipelineCommitResult;
                try {
                    commit = await runPhase("commit", attemptNumber, () =>
                        dependencies.git.commitStaged({
                            repositoryPath: input.repositoryPath,
                            branch: input.branch,
                            expectedParentSha: currentSha ?? "",
                            expectedTreeSha: stagedTreeSha,
                            message,
                            signal: deadline.signal,
                        }),
                    );
                } catch (error) {
                    const remoteAfterCommitFailure = await safeRemoteRead(
                        dependencies.git,
                        input,
                    );
                    return complete("failed", {
                        remoteSha: remoteAfterCommitFailure ?? currentSha,
                        failureFingerprint,
                        message: `Pipeline commit failed or could not be verified: ${phaseMessage(error)}`,
                        snapshot,
                    });
                }
                replaceLastAttempt({
                    commit: {
                        status: "created",
                        sha: commit.sha,
                        parentSha: commit.parentSha,
                        treeSha: commit.treeSha,
                    },
                });
                await notifyPhase({
                    phase: "commit",
                    status: "reconciled",
                    attempt: attemptNumber,
                    snapshot,
                    commit,
                    attemptState: attempts[attempts.length - 1],
                });

                const movementAfterCommit = await reconcileIfMoved({
                    expectedRemoteSha: currentSha,
                    localSha: commit.sha,
                    attempt: attemptNumber,
                    reason: "post-commit safety check",
                });
                if (movementAfterCommit === "moved") continue;
                if (movementAfterCommit !== undefined)
                    return movementAfterCommit;

                if (dependencies.remoteSafety !== undefined) {
                    try {
                        await runPhase(
                            "commit-message",
                            attemptNumber,
                            async () => {
                                await dependencies.remoteSafety?.verifyDirectPush(
                                    {
                                        repository: input.repository,
                                        repositoryPath: input.repositoryPath,
                                        branch: input.branch,
                                        intendedBaseSha: currentSha ?? "",
                                        expectedCommitSha: commit.sha,
                                        pushMode: "non-force",
                                    },
                                );
                            },
                        );
                    } catch (error) {
                        const remoteAfterSafetyFailure = await safeRemoteRead(
                            dependencies.git,
                            input,
                        );
                        return complete("failed", {
                            remoteSha: remoteAfterSafetyFailure ?? currentSha,
                            failureFingerprint,
                            message: `Pre-push repository safety proof failed; created commit retained for reconciliation: ${phaseMessage(error)}`,
                            snapshot,
                        });
                    }
                }

                const push = await runPhase("push", attemptNumber, () =>
                    dependencies.git.pushNonForce({
                        repositoryPath: input.repositoryPath,
                        branch: input.branch,
                        expectedCommitSha: commit.sha,
                        signal: deadline.signal,
                    }),
                );
                const remoteAfterPush = await safeRemoteRead(
                    dependencies.git,
                    input,
                );
                if (remoteAfterPush === undefined) {
                    replaceLastAttempt({
                        push: {
                            status: "ambiguous",
                            response: push.response,
                            ...(push.failureKind === undefined
                                ? {}
                                : { failureKind: push.failureKind }),
                            message:
                                "The push response could not be reconciled with an authoritative remote branch head.",
                        },
                    });
                    return complete("ambiguous-push", {
                        remoteSha: currentSha,
                        failureFingerprint,
                        message:
                            "Push outcome is ambiguous because origin branch HEAD could not be read; no retry was attempted.",
                        snapshot,
                    });
                }
                if (remoteAfterPush === "") {
                    replaceLastAttempt({
                        push: {
                            status: "external-movement",
                            response: push.response,
                            ...(push.failureKind === undefined
                                ? {}
                                : { failureKind: push.failureKind }),
                            remoteSha: remoteAfterPush,
                            message:
                                "The remote branch is missing after the push; delivery halted without overwriting it.",
                        },
                    });
                    return complete("external-movement", {
                        failureFingerprint,
                        message:
                            "The remote branch disappeared during push reconciliation; delivery halted without overwriting it.",
                        snapshot,
                    });
                }
                const pushStatus = pushStatusFor(
                    push,
                    remoteAfterPush,
                    commit.sha,
                    currentSha,
                );
                replaceLastAttempt({
                    push: {
                        status: pushStatus,
                        response: push.response,
                        ...(push.failureKind === undefined
                            ? {}
                            : { failureKind: push.failureKind }),
                        remoteSha: remoteAfterPush,
                        ...(pushStatus === "confirmed" ||
                        pushStatus === "confirmed-after-response-loss"
                            ? {}
                            : {
                                  message:
                                      "Remote branch did not resolve to the created commit; the created commit was not retried or force-pushed.",
                              }),
                    },
                });
                await notifyPhase({
                    phase: "push",
                    status: "reconciled",
                    attempt: attemptNumber,
                    snapshot,
                    commit,
                    attemptState: attempts[attempts.length - 1],
                });
                if (
                    pushStatus === "confirmed" ||
                    pushStatus === "confirmed-after-response-loss"
                ) {
                    pushedAttempts += 1;
                    currentSha = remoteAfterPush;
                    continue;
                }
                if (pushStatus === "rejected") {
                    return complete("non-fast-forward", {
                        remoteSha: remoteAfterPush,
                        failureFingerprint,
                        message:
                            "The non-force push was rejected as non-fast-forward; the created commit was retained and no retry was attempted.",
                        snapshot,
                    });
                }
                if (pushStatus === "ambiguous") {
                    return complete("ambiguous-push", {
                        remoteSha: remoteAfterPush,
                        failureFingerprint,
                        message:
                            "The push response and remote branch HEAD disagree; no retry or force-push was attempted.",
                        snapshot,
                    });
                }
                return complete("external-movement", {
                    remoteSha: remoteAfterPush,
                    failureFingerprint,
                    message:
                        "The remote branch moved to an unrelated SHA during push reconciliation; delivery halted without overwriting it.",
                    snapshot,
                });
            }
        } catch (error) {
            if (deadline.isDeadlineExpired()) {
                await restoreUncommittedCheckpoint(
                    dependencies,
                    input,
                    currentSha,
                );
                return complete("timeout", {
                    remoteSha: currentSha,
                    failureFingerprint: lastFailureFingerprint,
                    message:
                        "Pipeline delivery exceeded its absolute deadline.",
                });
            }
            if (deadline.isCallerCancelled()) {
                await restoreUncommittedCheckpoint(
                    dependencies,
                    input,
                    currentSha,
                );
                return complete("cancelled", {
                    remoteSha: currentSha,
                    failureFingerprint: lastFailureFingerprint,
                    message:
                        "Pipeline delivery was cancelled; no further mutation was attempted.",
                });
            }
            return complete("failed", {
                remoteSha: currentSha,
                failureFingerprint: lastFailureFingerprint,
                message: phaseMessage(error),
            });
        } finally {
            deadline.dispose();
        }
    };

    const execute = async (
        input: PipelineDeliveryExecutionInput,
    ): Promise<PipelineDeliveryOutcome> => {
        const outcome = await executeOnce(input);
        await input.onOutcome?.(outcome);
        return outcome;
    };

    return { execute };
};

const stateAttemptsToDelivery = (
    attempts: ReadonlyArray<PipelineAttemptState>,
): ReadonlyArray<PipelineDeliveryAttempt> =>
    attempts.map((attempt) => ({
        attempt: attempt.attempt,
        baseSha: attempt.baseSha,
        failureFingerprint: attempt.failureFingerprint,
        ...(attempt.repair === undefined ? {} : { repair: attempt.repair }),
        ...(attempt.commit === undefined
            ? {}
            : {
                  commit: {
                      status: attempt.commit.status,
                      ...(attempt.commit.sha === undefined
                          ? {}
                          : { sha: attempt.commit.sha }),
                      ...(attempt.commit.parentSha === undefined
                          ? {}
                          : { parentSha: attempt.commit.parentSha }),
                      ...(attempt.commit.treeSha === undefined
                          ? {}
                          : { treeSha: attempt.commit.treeSha }),
                      ...(attempt.commit.message === undefined
                          ? {}
                          : { message: attempt.commit.message }),
                  },
              }),
        ...(attempt.push === undefined
            ? {}
            : {
                  push: {
                      status: attempt.push.status,
                      response: attempt.push.response,
                      ...(attempt.push.failureKind === undefined
                          ? {}
                          : { failureKind: attempt.push.failureKind }),
                      ...(attempt.push.remoteSha === undefined
                          ? {}
                          : { remoteSha: attempt.push.remoteSha }),
                      ...(attempt.push.message === undefined
                          ? {}
                          : { message: attempt.push.message }),
                  },
              }),
    }));

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
    readonly observation: PipelineObservationResult["outcome"];
    readonly state: PipelineRunState;
    readonly remoteSha: string;
}): PipelineDeliveryOutcome => {
    const base = {
        repository: input.state.repository,
        branch: input.state.branch,
        remoteSha: input.remoteSha,
        pushedAttempts: input.state.pushedAttempts,
        externalMovements: input.state.externalMovements,
        attempts: stateAttemptsToDelivery(input.state.attempts),
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
                externalMovements: input.state.externalMovements + 1,
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
    readonly priorSha: string;
    readonly response: "accepted" | "rejected";
    readonly failureKind?: "non-fast-forward" | "other";
}): NonNullable<PipelineDeliveryAttempt["push"]>["status"] =>
    reconcilePipelinePush({
        remoteSha: input.remoteSha,
        expectedSha: input.createdSha,
        priorSha: input.priorSha,
        response: input.response,
        ...(input.failureKind === undefined
            ? {}
            : { failureKind: input.failureKind }),
    });

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
    const priorAttempt =
        prior === undefined ? {} : (stateAttemptsToDelivery([prior])[0] ?? {});
    const priorSha =
        input.state.checkpoint?.sha ?? prior?.baseSha ?? input.parentSha;
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
                priorSha,
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
    status: PipelineDeliveryPhaseEvent["status"],
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

const phaseMessageFor = (event: PipelineDeliveryPhaseEvent): string => {
    if (event.message !== undefined) return event.message;
    if (event.status === "before") return `Pipeline ${event.phase} started.`;
    if (event.status === "reconciled")
        return `Pipeline ${event.phase} state reconciled.`;
    return `Pipeline ${event.phase} ${event.status}.`;
};

const trackLifecycle = async <Value>(input: {
    readonly progress?: ProgressReporterService;
    readonly stage: ProgressStage;
    readonly message: string;
    readonly operation: () => Promise<Value>;
    readonly success: string | ((value: Value) => string);
    readonly repository?: string;
    readonly details?: Readonly<Record<string, unknown>>;
}): Promise<Value> => {
    if (input.progress === undefined) return await input.operation();
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
            message: `${input.message.replace(/\.{3}$/, "")} failed: ${phaseMessage(error)}`,
            ...(input.repository === undefined
                ? {}
                : { repository: input.repository }),
            ...(input.details === undefined ? {} : { details: input.details }),
        });
        throw error;
    }
};

const emitOutcomeProgress = async (input: {
    readonly progress?: ProgressReporterService;
    readonly outcome: PipelineDeliveryOutcome;
    readonly statePath: string;
    readonly dryRun: boolean;
}): Promise<void> => {
    if (input.progress === undefined) return;
    await input.progress.emit({
        stage: "pipeline-outcome",
        status: input.outcome.kind === "green" ? "succeeded" : "failed",
        message:
            input.outcome.message ??
            (input.outcome.kind === "green"
                ? "All observed pipelines are green."
                : `Pipeline delivery ended with ${input.outcome.kind}.`),
        repository: input.outcome.repository,
        details: {
            kind: input.outcome.kind,
            status: input.outcome.status,
            branch: input.outcome.branch,
            ...(input.outcome.remoteSha === undefined
                ? {}
                : { remoteSha: input.outcome.remoteSha }),
            pushedAttempts: input.outcome.pushedAttempts,
            externalMovements: input.outcome.externalMovements,
            attempts: input.outcome.attempts.length,
            ...(input.outcome.failureFingerprint === undefined
                ? {}
                : { failureFingerprint: input.outcome.failureFingerprint }),
            ...(input.outcome.diagnosticsPath === undefined
                ? {}
                : { diagnosticsPath: input.outcome.diagnosticsPath }),
            statePath: input.statePath,
            dryRun: input.dryRun,
        },
    });
};

export type PipelineDeliveryLifecycleDependencies =
    PipelineDeliveryEngineDependencies & {
        readonly repository: Pick<GitRepositoryService, "prepare">;
        readonly state: PipelineDeliveryStateAdapter;
        readonly progress?: ProgressReporterService;
    };

const makeEventEmitter =
    (input: {
        readonly session: PipelineDeliveryStateSession;
        readonly context: PipelineDeliveryContext;
        readonly progress?: ProgressReporterService;
        readonly statePath: string;
        readonly dryRun: boolean;
    }): ((event: PipelineDeliveryEvent) => Promise<void>) =>
    async (event) => {
        await input.session.emit(event);
        if (input.progress === undefined) return;
        if (event.kind === "phase") {
            const phase = event.event;
            await input.progress.emit({
                stage: stageForPhase[phase.phase],
                status: progressStatusFor(phase.status),
                message: phaseMessageFor(phase),
                repository:
                    phase.snapshot?.repository ?? input.context.repository,
                ...(phase.attempt === undefined
                    ? {}
                    : { attempt: phase.attempt }),
                ...(phase.attempt === undefined
                    ? {}
                    : { maxAttempts: input.session.getState().maxAttempts }),
                details: {
                    phase: phase.phase,
                    boundary: phase.status,
                    ...(phase.currentRemoteSha === undefined
                        ? {}
                        : { remoteSha: phase.currentRemoteSha }),
                    pushedAttempts: phase.pushedAttempts,
                    externalMovements: phase.externalMovements,
                    ...(phase.failureFingerprint === undefined
                        ? {}
                        : { failureFingerprint: phase.failureFingerprint }),
                    ...(phase.diagnosticsPath === undefined
                        ? {}
                        : { diagnosticsPath: phase.diagnosticsPath }),
                    dryRun: input.dryRun,
                },
            });
            return;
        }
        await emitOutcomeProgress({
            progress: input.progress,
            outcome: event.outcome,
            statePath: input.statePath,
            dryRun: input.dryRun,
        });
    };

const emitPhase = async (input: {
    readonly emit: (event: PipelineDeliveryEvent) => Promise<void>;
    readonly session: PipelineDeliveryStateSession;
    readonly event: Omit<
        PipelineDeliveryPhaseEvent,
        "pushedAttempts" | "externalMovements"
    > & {
        readonly pushedAttempts?: number;
        readonly externalMovements?: number;
    };
}): Promise<void> => {
    const state = input.session.getState();
    await input.emit({
        kind: "phase",
        event: {
            ...input.event,
            pushedAttempts: input.event.pushedAttempts ?? state.pushedAttempts,
            externalMovements:
                input.event.externalMovements ?? state.externalMovements,
        },
    });
};

const dryRunOutcome = async (input: {
    readonly dependencies: PipelineDeliveryLifecycleDependencies;
    readonly context: PipelineDeliveryContext;
    readonly repositoryPath: string;
    readonly branch: string;
    readonly session: PipelineDeliveryStateSession;
    readonly emit: (event: PipelineDeliveryEvent) => Promise<void>;
}): Promise<{
    readonly outcome: PipelineDeliveryOutcome;
    readonly wouldRepair: boolean;
}> => {
    const { dependencies, context, repositoryPath, branch, session, emit } =
        input;
    const initialState = session.getState();
    const request: PipelineSnapshotRequest = {
        repository: context.repository,
        branch,
        commitSha: initialState.currentRemoteSha,
    };
    await emitPhase({
        emit,
        session,
        event: { phase: "observation", status: "before" },
    });
    let observed: PipelineObservationResult;
    try {
        const remaining = Math.max(
            1,
            session.getState().deadlineAtMs -
                (dependencies.now?.() ?? Date.now()),
        );
        observed = await dependencies.observation.observe({
            request,
            client: context.client,
            options: {
                ...context.observationOptions,
                deadlineMs: remaining,
            },
            signal: context.signal,
        });
        await emitPhase({
            emit,
            session,
            event: {
                phase: "observation",
                status: "succeeded",
                ...(observed.outcome.kind === "green" ||
                observed.outcome.kind === "failed" ||
                observed.outcome.kind === "stale"
                    ? { snapshot: observed.outcome.snapshot }
                    : {}),
            },
        });
    } catch (error) {
        await emitPhase({
            emit,
            session,
            event: {
                phase: "observation",
                status: "failed",
                message: phaseMessage(error),
            },
        });
        throw error;
    }

    await emitPhase({
        emit,
        session,
        event: { phase: "final-verification", status: "before" },
    });
    let remoteAfter: string;
    try {
        remoteAfter = await dependencies.git.readRemoteHead(
            repositoryPath,
            branch,
            context.signal,
        );
        await emitPhase({
            emit,
            session,
            event: {
                phase: "final-verification",
                status: "succeeded",
                currentRemoteSha: remoteAfter,
            },
        });
    } catch (error) {
        await emitPhase({
            emit,
            session,
            event: {
                phase: "final-verification",
                status: "failed",
                message: phaseMessage(error),
            },
        });
        throw error;
    }

    const state = session.getState();
    if (!validSha(remoteAfter)) {
        return {
            outcome: outcomeFromState({
                state,
                remoteSha: state.currentRemoteSha,
                kind: "failed",
                message:
                    "The remote branch could not be read after dry-run observation.",
            }),
            wouldRepair: false,
        };
    }
    if (!sameSha(remoteAfter, initialState.currentRemoteSha)) {
        return {
            outcome: outcomeFromState({
                state,
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
            outcome: outcomeForObservation({
                observation: observed.outcome,
                state,
                remoteSha: remoteAfter,
            }),
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
                state,
                remoteSha: remoteAfter,
            }),
            wouldRepair: false,
        };
    }

    const snapshot = observed.outcome.snapshot;
    const failureFingerprint = pipelineFailureFingerprint(snapshot);
    await emitPhase({
        emit,
        session,
        event: {
            phase: "diagnostics",
            status: "before",
            currentRemoteSha: remoteAfter,
            snapshot,
            failureFingerprint,
        },
    });
    let diagnosticsPath: string | undefined;
    try {
        const diagnostics = await dependencies.diagnostics({
            request,
            snapshot,
            observation: observed.outcome,
            scope: {
                workspace: context.workspace,
                runId: session.getState().runId,
                repository: context.repository,
            },
            client: context.client,
            signal: context.signal,
        });
        diagnosticsPath = diagnostics.path;
        await emitPhase({
            emit,
            session,
            event: {
                phase: "diagnostics",
                status: "reconciled",
                currentRemoteSha: remoteAfter,
                snapshot,
                failureFingerprint,
                ...(diagnostics.path === undefined
                    ? {}
                    : { diagnosticsPath: diagnostics.path }),
            },
        });
    } catch (error) {
        await emitPhase({
            emit,
            session,
            event: {
                phase: "diagnostics",
                status: "failed",
                currentRemoteSha: remoteAfter,
                snapshot,
                failureFingerprint,
                message: phaseMessage(error),
            },
        });
        throw error;
    }
    return {
        outcome: {
            ...outcomeForObservation({
                observation: observed.outcome,
                state: session.getState(),
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
    readonly dependencies: PipelineDeliveryLifecycleDependencies;
    readonly context: PipelineDeliveryContext;
    readonly repositoryPath: string;
    readonly branch: string;
    readonly session: PipelineDeliveryStateSession;
    readonly emit: (event: PipelineDeliveryEvent) => Promise<void>;
}): Promise<PipelineDeliveryOutcome | undefined> => {
    const { dependencies, context, repositoryPath, branch, session, emit } =
        input;
    const state = session.getState();
    const created = state.createdCommit;
    const checkpoint = state.checkpoint;
    if (created === undefined || checkpoint === undefined) {
        return outcomeFromState({
            state,
            remoteSha: state.currentRemoteSha,
            kind: "failed",
            message:
                "A pending pipeline push had no complete checkpoint and cannot be resumed safely.",
        });
    }
    const checkout = await dependencies.git.readCheckout(
        repositoryPath,
        context.signal,
    );
    if (
        checkout.branch !== branch ||
        !sameSha(checkout.head, created.sha) ||
        checkout.status !== ""
    ) {
        return outcomeFromState({
            state,
            remoteSha: state.currentRemoteSha,
            kind: "failed",
            message:
                "The recorded pipeline commit is not the clean local checkout; the pending push was not retried.",
        });
    }
    await dependencies.remoteSafety?.verifyDirectPush({
        repository: context.repository,
        repositoryPath,
        branch,
        intendedBaseSha: checkpoint.sha,
        expectedCommitSha: created.sha,
        pushMode: "non-force",
    });
    const push = await dependencies.git.pushNonForce({
        repositoryPath,
        branch,
        expectedCommitSha: created.sha,
        signal: context.signal,
    });
    const remoteAfter = await dependencies.git.readRemoteHead(
        repositoryPath,
        branch,
        context.signal,
    );
    const attemptState = resumedPushAttempt({
        state,
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
    await emit({
        kind: "phase",
        event: {
            phase: "push",
            status: "reconciled",
            currentRemoteSha: validSha(remoteAfter)
                ? remoteAfter
                : state.currentRemoteSha,
            pushedAttempts: state.pushedAttempts,
            externalMovements: state.externalMovements,
            attempt: attemptState.attempt,
            attemptState,
            commit: created,
            ...(confirmed
                ? {}
                : { message: "The resumed non-force push was not confirmed." }),
        },
    });
    if (confirmed) return undefined;
    const nextState = session.getState();
    const pushStatus = attemptState.push?.status;
    return outcomeFromState({
        state: nextState,
        remoteSha: validSha(remoteAfter)
            ? remoteAfter
            : nextState.currentRemoteSha,
        kind:
            pushStatus === "external-movement"
                ? "external-movement"
                : push.failureKind === "non-fast-forward"
                  ? "non-fast-forward"
                  : "ambiguous-push",
        message:
            pushStatus === "external-movement"
                ? "The remote branch moved to an unrelated SHA during push reconciliation; delivery halted without overwriting it."
                : push.failureKind === "non-fast-forward"
                  ? "The resumed non-force push was rejected as non-fast-forward."
                  : "The resumed push outcome could not be reconciled; no retry was attempted.",
    });
};

const assertLifecycleRequest = (request: PipelineDeliveryRequest): void => {
    const context = request.context;
    if (
        !nonBlank(context.repository) ||
        !nonBlank(context.workspace) ||
        !nonBlank(context.runId)
    ) {
        throw new PipelineDeliveryLifecycleError({
            kind: "invalid-input",
            message:
                "Pipeline delivery requires non-empty repository, workspace, and run identifiers.",
        });
    }
    if (context.branch !== undefined && !nonBlank(context.branch)) {
        throw new PipelineDeliveryLifecycleError({
            kind: "invalid-input",
            message:
                "Pipeline delivery branch must be non-empty when supplied.",
        });
    }
    if (
        !Number.isSafeInteger(context.maxAttempts) ||
        context.maxAttempts <= 0
    ) {
        throw new PipelineDeliveryLifecycleError({
            kind: "invalid-input",
            message:
                "Pipeline delivery maxAttempts must be a positive integer.",
        });
    }
    if (
        context.pipelineTimeoutMs !== undefined &&
        (!Number.isSafeInteger(context.pipelineTimeoutMs) ||
            context.pipelineTimeoutMs < 0)
    ) {
        throw new PipelineDeliveryLifecycleError({
            kind: "invalid-input",
            message:
                "Pipeline delivery pipelineTimeoutMs must be a non-negative safe integer.",
        });
    }
    if (request.mode === "resume" && !nonBlank(request.resumePath)) {
        throw new PipelineDeliveryLifecycleError({
            kind: "invalid-input",
            message: "Pipeline delivery resumePath must be non-empty.",
        });
    }
};

/**
 * Coordinate the complete Pipeline delivery lifecycle. The command supplies
 * normalized context and, for live mode, an agent; this module owns branch
 * preparation, state transitions, observation, repair, delivery, resume, and
 * the terminal result.
 */
export const makePipelineDeliveryLifecycle = (
    dependencies: PipelineDeliveryLifecycleDependencies,
): PipelineDeliveryLifecycle => {
    const engine = makePipelineDeliveryEngine(dependencies);
    const now = dependencies.now ?? (() => Date.now());

    const execute = async (
        request: PipelineDeliveryRequest,
    ): Promise<PipelineDeliveryResult> => {
        assertLifecycleRequest(request);
        const context = request.context;
        context.signal?.throwIfAborted();
        const dryRun =
            request.mode === "dry-run" ||
            (request.mode === "resume" && request.dryRun === true);
        const resumePath =
            request.mode === "resume" ? request.resumePath : undefined;
        const saved =
            resumePath === undefined
                ? undefined
                : await dependencies.state.load(resumePath, {
                      repository: context.repository,
                      ...(context.branch === undefined
                          ? {}
                          : { branch: context.branch }),
                  });
        const prepared = await trackLifecycle({
            progress: dependencies.progress,
            stage: "repository-preparation",
            message: `Preparing ${context.repository} on ${saved?.branch ?? context.branch ?? "main/master"}...`,
            operation: () =>
                dependencies.repository.prepare(
                    context.repository,
                    saved?.branch ?? context.branch,
                    context.workspace,
                    undefined,
                    context.signal,
                ),
            success: (value) => `Repository ready: ${value.path}.`,
            repository: context.repository,
            details: {
                branch: saved?.branch ?? context.branch ?? "main/master",
                workspace: context.workspace,
            },
        });
        if (saved !== undefined && prepared.branch !== saved.branch) {
            throw new RalphieError({
                message: `Cannot resume pipeline run ${saved.runId}: prepared branch is ${prepared.branch}, saved branch is ${saved.branch}.`,
            });
        }
        const remoteSha = await trackLifecycle({
            progress: dependencies.progress,
            stage: "pipeline-remote-read",
            message: `Reading origin/${prepared.branch}...`,
            operation: () =>
                dependencies.git.readRemoteHead(
                    prepared.path,
                    prepared.branch,
                    context.signal,
                ),
            success: (value) => `Remote pipeline head: ${value}.`,
            repository: context.repository,
            details: { branch: prepared.branch },
        });
        if (!validSha(remoteSha)) {
            throw new RalphieError({
                message: `origin/${prepared.branch} did not provide a full remote commit SHA.`,
            });
        }

        const statePath =
            resumePath ??
            pipelineRunStatePath(context.workspace, context.runId);
        const opened =
            saved === undefined
                ? await dependencies.state.open({
                      mode: "new",
                      path: statePath,
                      runId: context.runId,
                      repository: context.repository,
                      branch: prepared.branch,
                      workspace: context.workspace,
                      deadlineAtMs:
                          now() +
                          (context.pipelineTimeoutMs ??
                              durationToMilliseconds(DEFAULT_PIPELINE_TIMEOUT)),
                      maxAttempts: context.maxAttempts,
                      currentRemoteSha: remoteSha,
                  })
                : await dependencies.state.open({
                      mode: "resume",
                      path: statePath,
                      state: saved,
                      remoteSha,
                  });
        const session = opened.session;
        const emit = makeEventEmitter({
            session,
            context,
            progress: dependencies.progress,
            statePath,
            dryRun,
        });
        try {
            await emitPhase({
                emit,
                session,
                event: {
                    phase: "remote-read",
                    status: "succeeded",
                    currentRemoteSha: remoteSha,
                },
            });
            if (opened.reconciliation?.message !== undefined) {
                await dependencies.progress?.emit({
                    stage: "pipeline-resume",
                    status: "info",
                    message: opened.reconciliation.message,
                    repository: context.repository,
                    details: {
                        action: opened.reconciliation.action,
                        branch: prepared.branch,
                        remoteSha,
                        deadlineAtMs: session.getState().deadlineAtMs,
                    },
                });
            }

            const finish = async (
                outcome: PipelineDeliveryOutcome,
                wouldRepair: boolean,
            ): Promise<PipelineDeliveryResult> => {
                await emit({ kind: "outcome", outcome });
                const state = session.getState();
                return {
                    runId: state.runId,
                    repository: state.repository,
                    branch: state.branch,
                    statePath,
                    outcome,
                    wouldRepair,
                };
            };

            const action = opened.reconciliation?.action;
            if (action === "already-complete") {
                return await finish(
                    outcomeFromState({
                        state: session.getState(),
                        remoteSha,
                        kind: "green",
                        message: "The saved green result is still current.",
                    }),
                    false,
                );
            }
            if (action === "deadline-expired" || action === "stale-remote") {
                return await finish(
                    outcomeFromState({
                        state: session.getState(),
                        remoteSha,
                        kind:
                            action === "deadline-expired"
                                ? "timeout"
                                : "external-movement",
                        message: session.getState().lastError,
                    }),
                    false,
                );
            }
            if (action === "resume-push" && !dryRun) {
                const resumedOutcome = await resumePendingPush({
                    dependencies,
                    context,
                    repositoryPath: prepared.path,
                    branch: prepared.branch,
                    session,
                    emit,
                });
                if (resumedOutcome !== undefined) {
                    return await finish(resumedOutcome, false);
                }
            }
            if (dryRun) {
                const dryRunResult = await dryRunOutcome({
                    dependencies,
                    context,
                    repositoryPath: prepared.path,
                    branch: prepared.branch,
                    session,
                    emit,
                });
                return await finish(
                    dryRunResult.outcome,
                    dryRunResult.wouldRepair,
                );
            }

            if (request.mode === "resume" && request.dryRun === true) {
                throw new PipelineDeliveryLifecycleError({
                    kind: "invalid-input",
                    message:
                        "Live pipeline delivery requires an agent and agent selection.",
                });
            }
            const agentRequest = await request.acquireAgent();
            const state = session.getState();
            const outcome = await engine.execute({
                repository: context.repository,
                repositoryPath: prepared.path,
                workspace: context.workspace,
                branch: prepared.branch,
                runId: state.runId,
                client: context.client,
                agent: agentRequest.agent,
                agentSelection: agentRequest.agentSelection,
                initialRemoteSha: state.currentRemoteSha,
                initialPushedAttempts: state.pushedAttempts,
                initialExternalMovements: state.externalMovements,
                initialAttempts: stateAttemptsToDelivery(state.attempts),
                maxAttempts: state.maxAttempts,
                deadlineAtMs: state.deadlineAtMs,
                observationOptions: context.observationOptions,
                agentDiagnostics: agentRequest.agentDiagnostics,
                signal: context.signal,
                progress: dependencies.progress,
                progressIssue: context.progressIssue,
                reviewBudget: context.reviewBudget,
                commitMessage: context.commitMessage,
                onPhase: async (event) => await emit({ kind: "phase", event }),
                onOutcome: async (result) =>
                    await emit({ kind: "outcome", outcome: result }),
            });
            return {
                runId: state.runId,
                repository: state.repository,
                branch: state.branch,
                statePath,
                outcome,
                wouldRepair: false,
            };
        } catch (error) {
            const state = session.getState();
            const outcome = outcomeFromState({
                state,
                remoteSha: state.currentRemoteSha,
                kind: context.signal?.aborted === true ? "cancelled" : "failed",
                message:
                    context.signal?.aborted === true
                        ? "Pipeline delivery was cancelled; resumable state was preserved."
                        : phaseMessage(error),
            });
            await emit({ kind: "outcome", outcome }).catch(() => undefined);
            throw error;
        }
    };

    return { execute };
};