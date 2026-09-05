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
import type { IssueArtifactScope } from "./artifacts.ts";
import type {
    PipelineRepairExecutorInput,
    PipelineRepairExecutorService,
    PipelineRepairOutcome,
} from "./pipeline-repair-executor.ts";
import type { CommitMessageDecision } from "./decisions.ts";
import type { AgentClient } from "../opencode/client.ts";
import type {
    PipelineCheckoutState,
    PipelineCommitResult,
    PipelineDeliveryGitService,
    PipelinePushAttempt,
} from "../git/pipeline-delivery.ts";
import type { GitRemoteSafetyService } from "../git/remote-safety.ts";
import type { GitRepositoryInvariantService } from "../git/repository-invariant.ts";
import type {
    ProgressIssue,
    ProgressReporterService,
} from "../progress/progress.ts";
import { RalphieError } from "../shared/error.ts";

export const PIPELINE_DELIVERY_EXTERNAL_MOVEMENT_LIMIT = 3;

export type PipelineDeliveryPhase =
    | "remote-read"
    | "observation"
    | "prepare"
    | "diagnostics"
    | "repair"
    | "commit-message"
    | "commit"
    | "push"
    | "reconcile"
    | "final-verification";

export type PipelineDeliveryPhaseOutcome = {
    readonly phase: PipelineDeliveryPhase;
    readonly outcome: "succeeded" | "failed";
    readonly attempt?: number;
    readonly message?: string;
};

export type PipelineDeliveryCommitOutcome = {
    readonly status: "created" | "failed";
    readonly sha?: string;
    readonly parentSha?: string;
    readonly treeSha?: string;
    readonly message?: string;
};

export type PipelineDeliveryPushOutcome = {
    readonly status:
        | "confirmed"
        | "confirmed-after-response-loss"
        | "rejected"
        | "ambiguous"
        | "external-movement";
    readonly response: PipelinePushAttempt["response"];
    readonly failureKind?: PipelinePushAttempt["failureKind"];
    readonly remoteSha?: string;
    readonly message?: string;
};

export type PipelineDeliveryAttempt = {
    /** One-based prospective repair number; external movements do not charge it. */
    readonly attempt: number;
    readonly baseSha: string;
    readonly failureFingerprint: string;
    readonly repair?: PipelineRepairOutcome["status"];
    readonly commit?: PipelineDeliveryCommitOutcome;
    readonly push?: PipelineDeliveryPushOutcome;
};

export type PipelineDeliveryOutcomeKind =
    | "green"
    | "no-pipelines-discovered"
    | "no-change"
    | "review-exhausted"
    | "identical-failure"
    | "attempts-exhausted"
    | "external-movement"
    | "ambiguous-push"
    | "non-fast-forward"
    | "timeout"
    | "cancelled"
    | "dry-run"
    | "failed";

export type PipelineDeliveryOutcome = {
    readonly kind: PipelineDeliveryOutcomeKind;
    /** Alias used by durable state consumers that call terminal results status. */
    readonly status: PipelineDeliveryOutcomeKind;
    readonly source?: "already-green" | "pushed-repair";
    readonly repository: string;
    readonly branch: string;
    readonly remoteSha?: string;
    readonly failureFingerprint?: string;
    readonly diagnosticsPath?: string;
    readonly message?: string;
    readonly pushedAttempts: number;
    readonly externalMovements: number;
    readonly attempts: ReadonlyArray<PipelineDeliveryAttempt>;
    readonly phases: ReadonlyArray<PipelineDeliveryPhaseOutcome>;
    readonly snapshot?: PipelineSnapshot;
};

export type PipelineDeliveryPersistenceEvent = {
    readonly phase: PipelineDeliveryPhase;
    readonly status: "before" | "succeeded" | "failed" | "reconciled";
    readonly attempt?: number;
    readonly currentRemoteSha?: string;
    readonly pushedAttempts: number;
    readonly externalMovements: number;
    readonly failureFingerprint?: string;
    readonly snapshot?: PipelineSnapshot;
    readonly diagnosticsPath?: string;
    readonly message?: string;
    readonly attemptState?: PipelineDeliveryAttempt;
    readonly commit?: PipelineCommitResult;
};

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

export type PipelineDeliveryLoopInput = {
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
    readonly onPhase?: (
        event: PipelineDeliveryPersistenceEvent,
    ) => Promise<void>;
    /** Optional durable sink for terminal success, stop, failure, or cancel. */
    readonly onOutcome?: (outcome: PipelineDeliveryOutcome) => Promise<void>;
};

export type PipelineDeliveryLoopDependencies = {
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

export type PipelineDeliveryLoopService = {
    readonly execute: (
        input: PipelineDeliveryLoopInput,
    ) => Promise<PipelineDeliveryOutcome>;
};

export class PipelineDeliveryLoopError extends RalphieError {
    override readonly _tag = "PipelineDeliveryLoopError" as const;
    readonly kind: "invalid-input" | "safety-failed";

    constructor(input: {
        readonly kind: "invalid-input" | "safety-failed";
        readonly message: string;
        readonly cause?: unknown;
    }) {
        super(input);
        this.name = "PipelineDeliveryLoopError";
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

/**
 * Normalize a failure for loop detection without baking the immutable commit
 * identity into the fingerprint.  Provider IDs and raw records are omitted:
 * they are useful diagnostics, but run/commit-specific values must not allow
 * the same failing check to spin through every newly pushed SHA.
 */
export const pipelineFailureFingerprint = (
    snapshot: PipelineSnapshot,
): string =>
    JSON.stringify({
        state: snapshot.state,
        reason: snapshot.reason,
        items: snapshot.items.map((item) => ({
            source: item.source,
            provider: item.provider,
            name: item.name,
            status: item.status,
            rawState: item.rawState,
            errors: item.diagnostic.errors,
        })),
        sourceErrors: snapshot.sourceErrors.map(({ source, message }) => ({
            source,
            message,
        })),
        completenessErrors: snapshot.completenessErrors,
    });

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

const assertInput = (input: PipelineDeliveryLoopInput): void => {
    if (
        !nonBlank(input.repository) ||
        !nonBlank(input.repositoryPath) ||
        !nonBlank(input.workspace) ||
        !nonBlank(input.branch) ||
        !nonBlank(input.runId)
    ) {
        throw new PipelineDeliveryLoopError({
            kind: "invalid-input",
            message:
                "Pipeline delivery requires non-empty repository, checkout, workspace, branch, and run identifiers.",
        });
    }
    if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts <= 0) {
        throw new PipelineDeliveryLoopError({
            kind: "invalid-input",
            message:
                "Pipeline delivery maxAttempts must be a positive integer.",
        });
    }
    if (!Number.isFinite(input.deadlineAtMs) || input.deadlineAtMs <= 0) {
        throw new PipelineDeliveryLoopError({
            kind: "invalid-input",
            message:
                "Pipeline delivery deadlineAtMs must be a positive epoch time.",
        });
    }
    if (
        input.initialRemoteSha !== undefined &&
        !validSha(input.initialRemoteSha)
    ) {
        throw new PipelineDeliveryLoopError({
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
        throw new PipelineDeliveryLoopError({
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
        throw new PipelineDeliveryLoopError({
            kind: "invalid-input",
            message:
                "Pipeline delivery initialExternalMovements must be a non-negative integer.",
        });
    }
    if (
        input.commitMessage !== undefined &&
        !isValidPipelineCommitMessage(input.commitMessage)
    ) {
        throw new PipelineDeliveryLoopError({
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
    input: PipelineDeliveryLoopInput,
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
    input: PipelineDeliveryLoopInput,
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
    dependencies: PipelineDeliveryLoopDependencies,
    input: PipelineDeliveryLoopInput,
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
): PipelineDeliveryPushOutcome["status"] => {
    if (sameSha(remoteSha, expectedSha)) {
        return push.response === "accepted"
            ? "confirmed"
            : "confirmed-after-response-loss";
    }
    if (sameSha(remoteSha, priorSha)) {
        return push.failureKind === "non-fast-forward"
            ? "rejected"
            : "ambiguous";
    }
    return "external-movement";
};

const output = (
    kind: PipelineDeliveryOutcomeKind,
    input: PipelineDeliveryLoopInput,
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
 * Coordinate one direct base-branch repair loop.  The service owns the
 * ordering of observation, diagnosis, repair, commit, push, and final proof;
 * Git and agent details remain behind injected seams for deterministic tests.
 */
export const makePipelineDeliveryLoopService = (
    dependencies: PipelineDeliveryLoopDependencies,
): PipelineDeliveryLoopService => {
    const now = dependencies.now ?? (() => Date.now());
    const externalMovementLimit =
        dependencies.maxExternalMovements ??
        PIPELINE_DELIVERY_EXTERNAL_MOVEMENT_LIMIT;

    const executeOnce = async (
        input: PipelineDeliveryLoopInput,
    ): Promise<PipelineDeliveryOutcome> => {
        assertInput(input);
        if (
            !Number.isSafeInteger(externalMovementLimit) ||
            externalMovementLimit < 0
        ) {
            throw new PipelineDeliveryLoopError({
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
            readonly status: PipelineDeliveryPersistenceEvent["status"];
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
                throw new PipelineDeliveryLoopError({
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
                throw new PipelineDeliveryLoopError({
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
                throw new PipelineDeliveryLoopError({
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

        /** Rebase the clean local checkpoint onto a newer remote head. */
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
                throw new PipelineDeliveryLoopError({
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
                if (remoteAfterPush === undefined || remoteAfterPush === "") {
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
                        remoteSha: remoteAfterPush ?? currentSha,
                        failureFingerprint,
                        message:
                            "Push outcome is ambiguous because origin branch HEAD could not be read; no retry was attempted.",
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
        input: PipelineDeliveryLoopInput,
    ): Promise<PipelineDeliveryOutcome> => {
        const outcome = await executeOnce(input);
        await input.onOutcome?.(outcome);
        return outcome;
    };

    return { execute };
};

export const PipelineDeliveryLoopLive = makePipelineDeliveryLoopService;