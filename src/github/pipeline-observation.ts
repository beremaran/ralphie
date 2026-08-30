/**
 * Deadline-aware, read-only observation of checks for one immutable commit.
 *
 * The observer works on normalized snapshots, never treats a branch ref as the
 * commit being observed, and can either use an injected snapshot fetcher or an
 * Octokit client.  GitHub reads are paginated by the check collector.  Every
 * request and sleep receives a signal derived from the caller's signal and an
 * absolute deadline; caller cancellation remains distinguishable from a
 * timeout or a GitHub failure.  Green results always pass a final branch-HEAD
 * check; an Octokit client supplies that check through `repos.getBranch`.
 */
import type { Octokit } from "octokit";

import {
    makePipelineChecksSnapshotCollectorService,
    type PipelineSnapshotRequestExecutor,
} from "./pipeline-snapshot-collector.ts";
import { rateLimitFromUnknown, type RateLimitMetadata } from "./rate-limit.ts";
import { parseRepositorySlug } from "./repository.ts";
import {
    normalizePipelineSnapshot,
    type ExactCommitSha,
    type PipelineItemStatus,
    type PipelineSnapshot,
    type PipelineSnapshotRequest,
} from "./pipeline-snapshot.ts";

/** Injected clock returning the current Unix epoch time in milliseconds. */
export type PipelineObservationClock = () => number;

/** Injected sleeper used between polls; it must honor the supplied signal. */
export type PipelineObservationSleep = (
    milliseconds: number,
    signal?: AbortSignal,
) => Promise<void>;

/** Injected read-only snapshot fetcher for one exact commit SHA. */
export type PipelineSnapshotFetcher = (
    request: PipelineSnapshotRequest,
    signal?: AbortSignal,
) => Promise<PipelineObservationRead>;

/** Injected read-only reader of the remote branch HEAD for a request. */
export type PipelineRemoteHeadReader = (
    request: PipelineSnapshotRequest,
    signal?: AbortSignal,
) => Promise<ExactCommitSha>;

/** GitHub rate-limit metadata surfaced with a read. */
export type PipelineObservationRateLimit = RateLimitMetadata;

/** The result of one injected snapshot read. */
export type PipelineObservationRead =
    | {
          readonly kind: "snapshot";
          readonly snapshot: PipelineSnapshot;
          readonly rateLimit?: PipelineObservationRateLimit;
      }
    | {
          readonly kind: "failure";
          readonly message: string;
          readonly rateLimit?: PipelineObservationRateLimit;
      };

/** Explicit bounds and confirmation policy for one observation. */
export type PipelineObservationOptions = {
    /** Keep polling while no checks are visible during this window. */
    readonly registrationGraceMs?: number;
    /** Alias for registrationGraceMs. */
    readonly registrationGracePeriodMs?: number;
    /** Optional time for which a terminal snapshot must remain unchanged. */
    readonly quiescenceMs?: number;
    /** Alias for quiescenceMs. */
    readonly stableTerminalConfirmationMs?: number;
    /** Absolute observation timeout measured from observe() start. */
    readonly deadlineMs?: number;
    /** Alias for deadlineMs used by callers describing a total timeout. */
    readonly totalTimeoutMs?: number;
    /** Alias for deadlineMs. */
    readonly timeoutMs?: number;
    /** First ordinary polling backoff delay. */
    readonly initialBackoffMs?: number;
    /** Alias for initialBackoffMs. */
    readonly pollingBackoffMs?: number;
    /** Alias for initialBackoffMs. */
    readonly pollBackoffMs?: number;
    /** Upper bound for ordinary polling backoff. */
    readonly maxBackoffMs?: number;
    /** Alias for maxBackoffMs. */
    readonly maximumBackoffMs?: number;
    /** Alias for maxBackoffMs. */
    readonly maxPollingBackoffMs?: number;
    /** Exponential ordinary-backoff multiplier. */
    readonly backoffFactor?: number;
    /** Maximum retries of a rate-limited read, per poll. */
    readonly rateLimitRetries?: number;
    /** Alias for rateLimitRetries. */
    readonly maxRateLimitRetries?: number;
    /** Alias for rateLimitRetries. */
    readonly rateLimitRetryCount?: number;
    /** Maximum permitted server-directed retry delay. */
    readonly maxRateLimitDelayMs?: number;
    /** Alias for maxRateLimitDelayMs. */
    readonly maxRateLimitRetryDelayMs?: number;
    /** Number of identical green terminal observations required. */
    readonly stableTerminalConfirmations?: number;
    /** Alias for stableTerminalConfirmations. */
    readonly stableTerminalConfirmation?: number;
    /** Alias for stableTerminalConfirmations. */
    readonly stableTerminalPolls?: number;
    /** Alias for stableTerminalConfirmations. */
    readonly stableTerminalChecks?: number;
};

export type PipelineObservationSettings = PipelineObservationOptions;

export type PipelineObservationTransition =
    | { readonly kind: "registration" }
    | { readonly kind: "registered"; readonly itemCount: number }
    | { readonly kind: "checked-in"; readonly items: ReadonlyArray<string> }
    | { readonly kind: "disappeared"; readonly items: ReadonlyArray<string> }
    | {
          readonly kind: "status-changed";
          readonly item: string;
          readonly from: PipelineItemStatus;
          readonly to: PipelineItemStatus;
      };

type PipelineFailureReason = "failing" | "cancelled" | "unknown" | "invalid";

export type GreenPipelineObservation = {
    readonly kind: "green";
    readonly observedSha: ExactCommitSha;
    readonly snapshot: PipelineSnapshot;
    readonly elapsedMs: number;
    readonly polls: number;
};

export type FailedPipelineObservation = {
    readonly kind: "failed";
    readonly observedSha: ExactCommitSha;
    readonly reason: PipelineFailureReason;
    /** Fetch or head-read error details when reason is invalid. */
    readonly message?: string;
    /** The offending normalized set when a set-level failure was observed. */
    readonly snapshot?: PipelineSnapshot;
    readonly elapsedMs: number;
    readonly polls: number;
};

export type NoPipelinesPipelineObservation = {
    readonly kind: "no-pipelines-discovered";
    readonly observedSha: ExactCommitSha;
    readonly elapsedMs: number;
    readonly polls: number;
};

export type TimedOutPipelineObservation = {
    readonly kind: "timeout";
    readonly observedSha: ExactCommitSha;
    readonly elapsedMs: number;
    readonly polls: number;
    readonly lastSnapshot?: PipelineSnapshot;
};

export type AbortedPipelineObservation = {
    readonly kind: "aborted";
    readonly observedSha: ExactCommitSha;
    /** The caller's original AbortSignal.reason, when available. */
    readonly reason?: unknown;
    /** Explicit alias for consumers that prefer a named abort field. */
    readonly abortReason?: unknown;
    readonly elapsedMs: number;
    readonly polls: number;
};

export type StalePipelineObservation = {
    readonly kind: "stale";
    readonly observedSha: ExactCommitSha;
    readonly headBefore: ExactCommitSha;
    readonly headAfter: ExactCommitSha;
    readonly snapshot: PipelineSnapshot;
    readonly elapsedMs: number;
    readonly polls: number;
};

export type PipelineObservationOutcome =
    | GreenPipelineObservation
    | FailedPipelineObservation
    | NoPipelinesPipelineObservation
    | TimedOutPipelineObservation
    | AbortedPipelineObservation
    | StalePipelineObservation;

export type PipelineObservationInput = {
    readonly request: PipelineSnapshotRequest;
    /** Optional when client is supplied for the built-in check collector. */
    readonly fetchSnapshot?: PipelineSnapshotFetcher;
    /** Optional only when an Octokit client can provide repos.getBranch; missing readers fail closed. */
    readonly readHead?: PipelineRemoteHeadReader;
    readonly client?: Octokit;
    readonly options?: PipelineObservationOptions;
    readonly settings?: PipelineObservationOptions;
    readonly signal?: AbortSignal;
};

/** Coordinate-shaped input for using the built-in paginated GitHub reader. */
export type GitHubPipelineObservationInput = {
    readonly client?: Octokit;
    readonly fetchSnapshot?: PipelineSnapshotFetcher;
    readonly request?: PipelineSnapshotRequest;
    readonly repository?: string;
    readonly owner?: string;
    readonly repo?: string;
    readonly branch?: string;
    readonly commitSha?: ExactCommitSha;
    readonly sha?: ExactCommitSha;
    /** Optional when the supplied Octokit client can provide repos.getBranch. */
    readonly readHead?: PipelineRemoteHeadReader;
    readonly options?: PipelineObservationOptions;
    readonly settings?: PipelineObservationOptions;
    readonly signal?: AbortSignal;
};

export type PipelineObservationResult = {
    readonly outcome: PipelineObservationOutcome;
    readonly transitions: ReadonlyArray<PipelineObservationTransition>;
};

export type PipelineObservationService = {
    readonly observe: (
        input: PipelineObservationInput | GitHubPipelineObservationInput,
    ) => Promise<PipelineObservationResult>;
};

export type PipelineObservationServiceDependencies = {
    readonly now?: PipelineObservationClock;
    readonly sleep?: PipelineObservationSleep;
    /** Optional default Octokit client for coordinate-shaped inputs. */
    readonly client?: Octokit;
    /** Injectable endpoint transport for deterministic paginated tests. */
    readonly request?: PipelineSnapshotRequestExecutor;
};

const DEFAULT_INITIAL_BACKOFF_MS = 1000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const DEFAULT_BACKOFF_FACTOR = 2;
const DEFAULT_RATE_LIMIT_RETRIES = 3;
const DEFAULT_STABLE_TERMINAL_CONFIRMATIONS = 1;
const MAX_BACKOFF_EXPONENT = 30;
const MAX_TIMER_MS = 2_147_000_000;

const defaultNow: PipelineObservationClock = () => Date.now();

const defaultSleep: PipelineObservationSleep = async (milliseconds, signal) => {
    if (signal?.aborted === true) throw signal.reason;
    await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (callback: () => void) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener("abort", onAbort);
            callback();
        };
        const timer = setTimeout(() => finish(resolve), milliseconds);
        const onAbort = () => {
            clearTimeout(timer);
            finish(() => reject(signal?.reason));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted === true) onAbort();
    });
};

type ResolvedPipelineObservationOptions = {
    readonly registrationGraceMs: number;
    readonly quiescenceMs: number;
    readonly deadlineMs: number;
    readonly initialBackoffMs: number;
    readonly maxBackoffMs: number;
    readonly backoffFactor: number;
    readonly rateLimitRetries: number;
    readonly maxRateLimitDelayMs: number;
    readonly stableTerminalConfirmations: number;
};

const finiteAtLeast = (value: number, minimum: number, message: string) => {
    if (!Number.isFinite(value) || value < minimum)
        throw new RangeError(message);
    return value;
};

const nonNegativeInteger = (value: number, message: string): number => {
    finiteAtLeast(value, 0, message);
    if (!Number.isSafeInteger(value)) throw new RangeError(message);
    return value;
};

const positiveInteger = (value: number, message: string): number => {
    finiteAtLeast(value, 1, message);
    if (!Number.isSafeInteger(value)) throw new RangeError(message);
    return value;
};

const resolveObservationOptions = (
    options: PipelineObservationOptions,
): ResolvedPipelineObservationOptions => {
    const registrationGraceMs = finiteAtLeast(
        options.registrationGraceMs ?? options.registrationGracePeriodMs ?? 0,
        0,
        "registrationGraceMs must be a non-negative number of milliseconds.",
    );
    const quiescenceMs = finiteAtLeast(
        options.quiescenceMs ?? options.stableTerminalConfirmationMs ?? 0,
        0,
        "quiescenceMs must be a non-negative number of milliseconds.",
    );
    const deadlineMs = finiteAtLeast(
        options.deadlineMs ??
            options.totalTimeoutMs ??
            options.timeoutMs ??
            30_000,
        1,
        "deadlineMs must be a positive number of milliseconds.",
    );
    const initialBackoffMs = finiteAtLeast(
        options.initialBackoffMs ??
            options.pollingBackoffMs ??
            options.pollBackoffMs ??
            DEFAULT_INITIAL_BACKOFF_MS,
        0,
        "initialBackoffMs must be a non-negative number of milliseconds.",
    );
    const maxBackoffMs = finiteAtLeast(
        options.maxBackoffMs ??
            options.maximumBackoffMs ??
            options.maxPollingBackoffMs ??
            DEFAULT_MAX_BACKOFF_MS,
        initialBackoffMs,
        "maxBackoffMs must be at least initialBackoffMs.",
    );
    const backoffFactor = finiteAtLeast(
        options.backoffFactor ?? DEFAULT_BACKOFF_FACTOR,
        1,
        "backoffFactor must be at least 1.",
    );
    const rateLimitRetries = nonNegativeInteger(
        options.rateLimitRetries ??
            options.maxRateLimitRetries ??
            options.rateLimitRetryCount ??
            DEFAULT_RATE_LIMIT_RETRIES,
        "rateLimitRetries must be a non-negative integer.",
    );
    const maxRateLimitDelayMs = finiteAtLeast(
        options.maxRateLimitDelayMs ??
            options.maxRateLimitRetryDelayMs ??
            maxBackoffMs,
        0,
        "maxRateLimitDelayMs must be a non-negative number of milliseconds.",
    );
    const stableTerminalConfirmations = positiveInteger(
        options.stableTerminalConfirmations ??
            options.stableTerminalConfirmation ??
            options.stableTerminalPolls ??
            options.stableTerminalChecks ??
            DEFAULT_STABLE_TERMINAL_CONFIRMATIONS,
        "stableTerminalConfirmations must be a positive integer.",
    );
    return {
        registrationGraceMs,
        quiescenceMs,
        deadlineMs,
        initialBackoffMs,
        maxBackoffMs,
        backoffFactor,
        rateLimitRetries,
        maxRateLimitDelayMs,
        stableTerminalConfirmations,
    };
};

const itemKey = (source: string, provider: string, name: string): string =>
    `${source}\u0000${provider}\u0000${name}`;

type ObservationSetState = {
    readonly empty: boolean;
    readonly items: ReadonlyMap<string, PipelineItemStatus>;
    readonly reason: PipelineSnapshot["reason"];
    readonly fingerprint: string;
};

const stateForSnapshot = (snapshot: PipelineSnapshot): ObservationSetState => {
    const items = new Map<string, PipelineItemStatus>();
    for (const item of snapshot.items)
        items.set(itemKey(item.source, item.provider, item.name), item.status);
    return {
        empty: snapshot.items.length === 0,
        items,
        reason: snapshot.reason,
        fingerprint: snapshot.fingerprint,
    };
};

const diffTransitions = (
    previous: ObservationSetState,
    current: ObservationSetState,
): ReadonlyArray<PipelineObservationTransition> => {
    const transitions: PipelineObservationTransition[] = [];
    const added: string[] = [];
    const removed: string[] = [];
    for (const [key, status] of current.items) {
        const before = previous.items.get(key);
        if (before === undefined) added.push(key);
        else if (before !== status)
            transitions.push({
                kind: "status-changed",
                item: key,
                from: before,
                to: status,
            });
    }
    for (const key of previous.items.keys())
        if (!current.items.has(key)) removed.push(key);
    if (added.length > 0)
        transitions.push({ kind: "checked-in", items: added });
    if (removed.length > 0)
        transitions.push({ kind: "disappeared", items: removed });
    return transitions;
};

const transitionsFor = (
    previous: ObservationSetState | undefined,
    current: ObservationSetState,
): ReadonlyArray<PipelineObservationTransition> => {
    if (previous === undefined)
        return current.empty
            ? [{ kind: "registration" }]
            : [{ kind: "registered", itemCount: current.items.size }];
    if (previous.empty && !current.empty)
        return [{ kind: "registered", itemCount: current.items.size }];
    return diffTransitions(previous, current);
};

const verdictFor = (
    state: ObservationSetState,
): PipelineFailureReason | "green" => {
    if (state.reason === "success") return "green";
    if (state.reason === "failure") return "failing";
    if (state.reason === "cancelled") return "cancelled";
    if (state.reason === "unknown" || state.reason === "pending")
        return "unknown";
    return "invalid";
};

const backoffDelayFor = (
    options: ResolvedPipelineObservationOptions,
    pollIndex: number,
): number => {
    const exponent = Math.min(Math.max(pollIndex, 0), MAX_BACKOFF_EXPONENT);
    const multiplier = options.backoffFactor ** exponent;
    return Math.min(
        options.maxBackoffMs,
        options.initialBackoffMs * multiplier,
    );
};

const rateLimitHintMs = (
    rateLimit: PipelineObservationRateLimit | undefined,
    atMs: number,
): number | undefined => {
    if (rateLimit === undefined) return undefined;
    const parsed = rateLimitFromUnknown(rateLimit, atMs) ?? rateLimit;
    const candidates: number[] = [];
    if (parsed.resetAtMs !== undefined && Number.isFinite(parsed.resetAtMs))
        candidates.push(Math.max(0, parsed.resetAtMs - atMs));
    if (
        parsed.retryAfterMs !== undefined &&
        Number.isFinite(parsed.retryAfterMs)
    )
        candidates.push(Math.max(0, parsed.retryAfterMs));
    return candidates.length === 0 ? undefined : Math.max(...candidates);
};

const errorMessage = (cause: unknown): string =>
    cause instanceof Error ? cause.message : String(cause);

const rateLimitForSnapshot = (
    snapshot: PipelineSnapshot,
    atMs: number,
):
    | { readonly message: string; readonly rateLimit: RateLimitMetadata }
    | undefined => {
    for (const sourceError of snapshot.sourceErrors) {
        const rateLimit =
            sourceError.rateLimit ??
            rateLimitFromUnknown(sourceError.rawValues, atMs);
        if (rateLimit !== undefined)
            return { message: sourceError.message, rateLimit };
    }
    return undefined;
};

type DeadlineMarker = { readonly kind: "observation-deadline" };

const isDeadlineMarker = (
    value: unknown,
    marker: DeadlineMarker,
): value is DeadlineMarker => value === marker;

type ObserveContext = {
    readonly input: PipelineObservationInput | GitHubPipelineObservationInput;
    readonly request: PipelineSnapshotRequest;
    readonly fetchSnapshot: PipelineSnapshotFetcher;
    readonly readHead?: PipelineRemoteHeadReader;
    readonly options: ResolvedPipelineObservationOptions;
    readonly now: PipelineObservationClock;
    readonly sleep: PipelineObservationSleep;
    readonly startedAtMs: number;
    readonly deadlineAtMs: number;
    readonly observedSha: ExactCommitSha;
    readonly transitions: PipelineObservationTransition[];
    readonly controller: AbortController;
    readonly deadlineMarker: DeadlineMarker;
    readonly dispose: () => void;
};

type LoopState = {
    previous?: ObservationSetState;
    signature?: string;
    stableSinceMs: number;
    greenConfirmations: number;
    polls: number;
    lastSnapshot?: PipelineSnapshot;
};

const elapsedMsFor = (ctx: ObserveContext): number =>
    Math.max(0, ctx.now() - ctx.startedAtMs);

const callerAborted = (ctx: ObserveContext): boolean =>
    ctx.input.signal?.aborted === true;

const callerReason = (ctx: ObserveContext): unknown => ctx.input.signal?.reason;

const deadlineReached = (ctx: ObserveContext): boolean =>
    ctx.now() >= ctx.deadlineAtMs;

const deadlineSignalled = (ctx: ObserveContext): boolean =>
    ctx.controller.signal.aborted &&
    ctx.controller.signal.reason === ctx.deadlineMarker;

const throwIfInactive = (ctx: ObserveContext): void => {
    if (callerAborted(ctx)) throw callerReason(ctx);
    if (deadlineReached(ctx)) throw ctx.deadlineMarker;
    if (ctx.controller.signal.aborted) throw ctx.controller.signal.reason;
};

const awaitWithObservationSignal = async <Value>(
    ctx: ObserveContext,
    operation: (signal: AbortSignal) => Promise<Value>,
): Promise<Value> => {
    throwIfInactive(ctx);
    const operationPromise = operation(ctx.controller.signal);
    let onAbort: (() => void) | undefined;
    const abortPromise = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(ctx.controller.signal.reason);
        if (ctx.controller.signal.aborted) onAbort();
        else
            ctx.controller.signal.addEventListener("abort", onAbort, {
                once: true,
            });
    });
    try {
        return await Promise.race([operationPromise, abortPromise]);
    } finally {
        if (onAbort !== undefined)
            ctx.controller.signal.removeEventListener("abort", onAbort);
    }
};

const yieldToTimer = async (ctx: ObserveContext): Promise<void> => {
    await awaitWithObservationSignal(
        ctx,
        (signal) =>
            new Promise<void>((resolve, reject) => {
                let settled = false;
                const onAbort = () => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    signal.removeEventListener("abort", onAbort);
                    reject(signal.reason);
                };
                const timer = setTimeout(() => {
                    if (settled) return;
                    settled = true;
                    signal.removeEventListener("abort", onAbort);
                    resolve();
                }, 0);
                signal.addEventListener("abort", onAbort, { once: true });
            }),
    );
};

const sleepFor = async (
    ctx: ObserveContext,
    milliseconds: number,
): Promise<void> => {
    throwIfInactive(ctx);
    const delay = Math.max(0, milliseconds);
    await awaitWithObservationSignal(ctx, (signal) => ctx.sleep(delay, signal));
    if (delay === 0) await yieldToTimer(ctx);
    throwIfInactive(ctx);
};

const readValueFor = (
    ctx: ObserveContext,
    value: PipelineObservationRead,
): PipelineObservationRead => {
    if (value.kind === "failure") return value;
    if (value.kind !== "snapshot" || value.snapshot === undefined)
        return { kind: "failure", message: "Snapshot read was ambiguous." };
    const rateLimit = rateLimitForSnapshot(value.snapshot, ctx.now());
    return rateLimit === undefined
        ? value
        : {
              kind: "failure",
              message: rateLimit.message,
              rateLimit: value.rateLimit ?? rateLimit.rateLimit,
          };
};

const failureFromCause = (
    ctx: ObserveContext,
    cause: unknown,
): PipelineObservationRead => {
    const rateLimit = rateLimitFromUnknown(cause, ctx.now());
    return {
        kind: "failure",
        message: errorMessage(cause),
        ...(rateLimit === undefined ? {} : { rateLimit }),
    };
};

const readOnce = async (
    ctx: ObserveContext,
): Promise<PipelineObservationRead> => {
    try {
        const read = await awaitWithObservationSignal(ctx, (signal) =>
            ctx.fetchSnapshot(ctx.request, signal),
        );
        if (callerAborted(ctx)) throw callerReason(ctx);
        if (read === undefined || read === null || typeof read !== "object")
            return { kind: "failure", message: "Snapshot read was malformed." };
        return readValueFor(ctx, read);
    } catch (cause) {
        if (callerAborted(ctx)) throw callerReason(ctx);
        if (
            isDeadlineMarker(cause, ctx.deadlineMarker) ||
            deadlineSignalled(ctx) ||
            deadlineReached(ctx)
        )
            throw ctx.deadlineMarker;
        return failureFromCause(ctx, cause);
    }
};

const rateLimitRetryFailure = (message: string): PipelineObservationRead => ({
    kind: "failure",
    message,
});

const readWithRetries = async (
    ctx: ObserveContext,
): Promise<PipelineObservationRead> => {
    let retries = 0;
    while (true) {
        const read = await readOnce(ctx);
        if (read.kind !== "failure" || read.rateLimit === undefined)
            return read;
        if (retries >= ctx.options.rateLimitRetries) return read;
        const at = ctx.now();
        const delay = rateLimitHintMs(read.rateLimit, at);
        if (delay === undefined) return read;
        if (delay > ctx.options.maxRateLimitDelayMs)
            return rateLimitRetryFailure(
                `Rate-limit retry delay ${delay}ms exceeds maxRateLimitDelayMs ${ctx.options.maxRateLimitDelayMs}ms.`,
            );
        const remaining = ctx.deadlineAtMs - at;
        if (delay > remaining)
            return rateLimitRetryFailure(
                `Rate-limit retry delay ${delay}ms exceeds the remaining observation deadline ${Math.max(0, remaining)}ms.`,
            );
        retries += 1;
        await sleepFor(ctx, delay);
    }
};

const scheduleNextPoll = async (
    ctx: ObserveContext,
    st: LoopState,
    read: PipelineObservationRead,
    at: number,
    maxDelayMs: number,
): Promise<string | undefined> => {
    if (maxDelayMs < 0) return undefined;
    const hint = rateLimitHintMs(read.rateLimit, at);
    if (hint !== undefined) {
        if (hint > ctx.options.maxRateLimitDelayMs)
            return `Rate-limit delay ${hint}ms exceeds maxRateLimitDelayMs ${ctx.options.maxRateLimitDelayMs}ms.`;
        if (hint > maxDelayMs)
            return `Rate-limit delay ${hint}ms exceeds the remaining observation window ${maxDelayMs}ms.`;
        await sleepFor(ctx, hint);
        return undefined;
    }
    const natural = backoffDelayFor(ctx.options, st.polls - 1);
    await sleepFor(ctx, Math.min(natural, maxDelayMs));
    return undefined;
};

const abortedOutcome = (
    ctx: ObserveContext,
    st: LoopState,
): AbortedPipelineObservation => ({
    kind: "aborted",
    observedSha: ctx.observedSha,
    ...(callerReason(ctx) === undefined ? {} : { reason: callerReason(ctx) }),
    ...(callerReason(ctx) === undefined
        ? {}
        : { abortReason: callerReason(ctx) }),
    elapsedMs: elapsedMsFor(ctx),
    polls: st.polls,
});

const timeoutOutcome = (
    ctx: ObserveContext,
    st: LoopState,
): TimedOutPipelineObservation => ({
    kind: "timeout",
    observedSha: ctx.observedSha,
    elapsedMs: elapsedMsFor(ctx),
    polls: st.polls,
    ...(st.lastSnapshot === undefined ? {} : { lastSnapshot: st.lastSnapshot }),
});

const noPipelinesOutcome = (
    ctx: ObserveContext,
    st: LoopState,
    at: number,
): NoPipelinesPipelineObservation => ({
    kind: "no-pipelines-discovered",
    observedSha: ctx.observedSha,
    elapsedMs: Math.max(0, at - ctx.startedAtMs),
    polls: st.polls,
});

const failedOutcome = (
    ctx: ObserveContext,
    st: LoopState,
    reason: PipelineFailureReason,
    snapshot?: PipelineSnapshot,
    message?: string,
): FailedPipelineObservation => ({
    kind: "failed",
    observedSha: ctx.observedSha,
    reason,
    ...(snapshot === undefined ? {} : { snapshot }),
    ...(message === undefined ? {} : { message }),
    elapsedMs: elapsedMsFor(ctx),
    polls: st.polls,
});

type FinalVerificationRead =
    | {
          readonly kind: "ok";
          readonly headBefore: ExactCommitSha;
          readonly finalRead: PipelineObservationRead;
          readonly headAfter: ExactCommitSha;
      }
    | { readonly kind: "aborted" }
    | { readonly kind: "timeout" }
    | { readonly kind: "error"; readonly message: string };

const finalVerificationRead = async (
    ctx: ObserveContext,
): Promise<FinalVerificationRead> => {
    if (ctx.readHead === undefined)
        return { kind: "error", message: "No HEAD reader was supplied." };
    try {
        throwIfInactive(ctx);
        const headBefore = await awaitWithObservationSignal(ctx, (signal) =>
            ctx.readHead!(ctx.request, signal),
        );
        throwIfInactive(ctx);
        const finalRead = await readWithRetries(ctx);
        throwIfInactive(ctx);
        const headAfter = await awaitWithObservationSignal(ctx, (signal) =>
            ctx.readHead!(ctx.request, signal),
        );
        throwIfInactive(ctx);
        return { kind: "ok", headBefore, finalRead, headAfter };
    } catch (cause) {
        if (callerAborted(ctx)) return { kind: "aborted" };
        if (
            isDeadlineMarker(cause, ctx.deadlineMarker) ||
            deadlineSignalled(ctx) ||
            deadlineReached(ctx)
        )
            return { kind: "timeout" };
        return { kind: "error", message: errorMessage(cause) };
    }
};

/* The final verification without a head reader still needs the candidate. */
const finalSnapshotFor = (
    ctx: ObserveContext,
    st: LoopState,
): PipelineSnapshot => st.lastSnapshot ?? emptySnapshotFor(ctx.request);

const emptySnapshotFor = (request: PipelineSnapshotRequest): PipelineSnapshot =>
    normalizePipelineSnapshot({
        ...request,
        observations: [],
        sourceErrors: [],
    });

const sameSha = (left: ExactCommitSha, right: ExactCommitSha): boolean =>
    left.trim().toLowerCase() === right.trim().toLowerCase();

const staleOutcome = (
    ctx: ObserveContext,
    st: LoopState,
    headBefore: ExactCommitSha,
    headAfter: ExactCommitSha,
    finalRead: PipelineObservationRead,
): StalePipelineObservation => ({
    kind: "stale",
    observedSha: ctx.observedSha,
    headBefore,
    headAfter,
    snapshot:
        finalRead.kind === "snapshot"
            ? finalRead.snapshot
            : finalSnapshotFor(ctx, st),
    elapsedMs: elapsedMsFor(ctx),
    polls: st.polls,
});

const greenOutcome = (
    ctx: ObserveContext,
    st: LoopState,
    snapshot: PipelineSnapshot,
): GreenPipelineObservation => ({
    kind: "green",
    observedSha: ctx.observedSha,
    snapshot,
    elapsedMs: elapsedMsFor(ctx),
    polls: st.polls,
});

const updateFinalState = (
    ctx: ObserveContext,
    st: LoopState,
    state: ObservationSetState,
    snapshot: PipelineSnapshot,
): void => {
    ctx.transitions.push(...transitionsFor(st.previous, state));
    st.previous = state;
    st.signature = state.fingerprint;
    st.stableSinceMs = ctx.now();
    st.greenConfirmations = state.reason === "success" ? 1 : 0;
    st.lastSnapshot = snapshot;
};

const settleVerified = (
    ctx: ObserveContext,
    st: LoopState,
    verification: FinalVerificationRead,
): PipelineObservationOutcome | undefined => {
    if (verification.kind === "aborted") return abortedOutcome(ctx, st);
    if (verification.kind === "timeout") return timeoutOutcome(ctx, st);
    if (verification.kind === "error")
        return failedOutcome(
            ctx,
            st,
            "invalid",
            undefined,
            verification.message,
        );
    const { headBefore, finalRead, headAfter } = verification;
    if (
        !sameSha(headBefore, ctx.observedSha) ||
        !sameSha(headAfter, ctx.observedSha)
    )
        return staleOutcome(ctx, st, headBefore, headAfter, finalRead);
    if (finalRead.kind === "failure")
        return failedOutcome(ctx, st, "invalid", undefined, finalRead.message);
    const finalState = stateForSnapshot(finalRead.snapshot);
    if (
        finalState.reason === "success" &&
        finalState.fingerprint === st.signature
    )
        return greenOutcome(ctx, st, finalRead.snapshot);
    updateFinalState(ctx, st, finalState, finalRead.snapshot);
    return undefined;
};

const settleFinal = async (
    ctx: ObserveContext,
    st: LoopState,
): Promise<PipelineObservationOutcome | undefined> => {
    if (callerAborted(ctx)) return abortedOutcome(ctx, st);
    if (deadlineSignalled(ctx) || deadlineReached(ctx))
        return timeoutOutcome(ctx, st);
    const verification = await finalVerificationRead(ctx);
    if (callerAborted(ctx)) return abortedOutcome(ctx, st);
    if (deadlineSignalled(ctx) || deadlineReached(ctx))
        return timeoutOutcome(ctx, st);
    return settleVerified(ctx, st, verification);
};

type PollOutcome = PipelineObservationOutcome | undefined;

const updateState = (
    ctx: ObserveContext,
    st: LoopState,
    snapshot: PipelineSnapshot,
    at: number,
): ObservationSetState => {
    const state = stateForSnapshot(snapshot);
    st.lastSnapshot = snapshot;
    ctx.transitions.push(...transitionsFor(st.previous, state));
    st.previous = state;
    const changed = state.fingerprint !== st.signature;
    if (changed) {
        st.signature = state.fingerprint;
        st.stableSinceMs = at;
    }
    st.greenConfirmations =
        state.reason === "success"
            ? changed
                ? 1
                : st.greenConfirmations + 1
            : 0;
    return state;
};

const continueOrFailure = async (
    ctx: ObserveContext,
    st: LoopState,
    read: PipelineObservationRead,
    at: number,
    maxDelayMs: number,
): Promise<PollOutcome> => {
    const schedulingError = await scheduleNextPoll(
        ctx,
        st,
        read,
        at,
        maxDelayMs,
    );
    return schedulingError === undefined
        ? undefined
        : failedOutcome(ctx, st, "invalid", undefined, schedulingError);
};

const registrationOutcome = async (
    ctx: ObserveContext,
    st: LoopState,
    read: Extract<PipelineObservationRead, { readonly kind: "snapshot" }>,
    _state: ObservationSetState,
    at: number,
): Promise<PollOutcome> => {
    const graceRemaining =
        ctx.options.registrationGraceMs - (at - ctx.startedAtMs);
    if (graceRemaining <= 0) return noPipelinesOutcome(ctx, st, at);
    return continueOrFailure(
        ctx,
        st,
        read,
        at,
        Math.min(ctx.deadlineAtMs - at, graceRemaining),
    );
};

const terminalOutcome = async (
    ctx: ObserveContext,
    st: LoopState,
    read: Extract<PipelineObservationRead, { readonly kind: "snapshot" }>,
    state: ObservationSetState,
    at: number,
): Promise<PollOutcome> => {
    const stableFor = at - st.stableSinceMs >= ctx.options.quiescenceMs;
    const confirmed =
        state.reason !== "success" ||
        st.greenConfirmations >= ctx.options.stableTerminalConfirmations;
    if (!stableFor || !confirmed)
        return continueOrFailure(ctx, st, read, at, ctx.deadlineAtMs - at);
    const verdict = verdictFor(state);
    return verdict === "green"
        ? settleFinal(ctx, st)
        : failedOutcome(ctx, st, verdict, read.snapshot);
};

const handlePoll = async (
    ctx: ObserveContext,
    st: LoopState,
    read: PipelineObservationRead,
    at: number,
): Promise<PollOutcome> => {
    if (read.kind === "failure")
        return failedOutcome(ctx, st, "invalid", undefined, read.message);
    const state = updateState(ctx, st, read.snapshot, at);
    if (state.empty && state.reason === "no-checks")
        return registrationOutcome(ctx, st, read, state, at);
    if (state.reason === "pending")
        return continueOrFailure(ctx, st, read, at, ctx.deadlineAtMs - at);
    return terminalOutcome(ctx, st, read, state, at);
};

const resultWithOutcome = (
    ctx: ObserveContext,
    outcome: PipelineObservationOutcome,
): PipelineObservationResult => ({
    outcome,
    transitions: ctx.transitions,
});

const boundaryResult = (
    ctx: ObserveContext,
    st: LoopState,
): PipelineObservationResult | undefined =>
    callerAborted(ctx)
        ? resultWithOutcome(ctx, abortedOutcome(ctx, st))
        : deadlineReached(ctx)
          ? resultWithOutcome(ctx, timeoutOutcome(ctx, st))
          : undefined;

const pollOnce = async (
    ctx: ObserveContext,
    st: LoopState,
): Promise<PipelineObservationOutcome | undefined> => {
    st.polls += 1;
    const read = await readWithRetries(ctx);
    if (read.kind === "snapshot") st.lastSnapshot = read.snapshot;
    const at = ctx.now();
    if (callerAborted(ctx)) throw callerReason(ctx);
    if (deadlineSignalled(ctx) || at >= ctx.deadlineAtMs)
        throw ctx.deadlineMarker;
    return handlePoll(ctx, st, read, at);
};

const caughtResult = (
    ctx: ObserveContext,
    st: LoopState,
    cause: unknown,
): PipelineObservationResult =>
    callerAborted(ctx)
        ? resultWithOutcome(ctx, abortedOutcome(ctx, st))
        : isDeadlineMarker(cause, ctx.deadlineMarker) ||
            deadlineSignalled(ctx) ||
            deadlineReached(ctx)
          ? resultWithOutcome(ctx, timeoutOutcome(ctx, st))
          : resultWithOutcome(
                ctx,
                failedOutcome(
                    ctx,
                    st,
                    "invalid",
                    undefined,
                    errorMessage(cause),
                ),
            );

const runLoop = async (
    ctx: ObserveContext,
    st: LoopState,
): Promise<PipelineObservationResult> => {
    try {
        while (true) {
            const boundary = boundaryResult(ctx, st);
            if (boundary !== undefined) return boundary;
            const outcome = await pollOnce(ctx, st);
            if (outcome !== undefined) return resultWithOutcome(ctx, outcome);
        }
    } catch (cause) {
        return caughtResult(ctx, st, cause);
    }
};

const exactCommitSha = (value: string): boolean =>
    /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(value);

const requestForInput = (
    input: PipelineObservationInput | GitHubPipelineObservationInput,
): PipelineSnapshotRequest => {
    if ("request" in input && input.request !== undefined)
        return {
            repository: input.request.repository,
            branch: input.request.branch,
            commitSha: input.request.commitSha,
        };
    const coordinates = input as GitHubPipelineObservationInput;
    const repository =
        coordinates.repository ??
        ([coordinates.owner, coordinates.repo].filter(Boolean).join("/") || "");
    const branch = coordinates.branch ?? "";
    const commitSha = coordinates.commitSha ?? coordinates.sha ?? "";
    return { repository, branch, commitSha };
};

const clientForInput = (
    input: PipelineObservationInput | GitHubPipelineObservationInput,
    defaultClient?: Octokit,
): Octokit | undefined => input.client ?? defaultClient;

const fetcherForInput = (
    input: PipelineObservationInput | GitHubPipelineObservationInput,
    collector: ReturnType<typeof makePipelineChecksSnapshotCollectorService>,
    defaultClient?: Octokit,
): PipelineSnapshotFetcher => {
    if (input.fetchSnapshot !== undefined) return input.fetchSnapshot;
    const client = clientForInput(input, defaultClient);
    if (client !== undefined)
        return (request, signal) =>
            collector.collect(client, request, signal).then((snapshot) => ({
                kind: "snapshot",
                snapshot,
            }));
    return async () => ({
        kind: "failure",
        message: "A snapshot fetcher or Octokit client is required.",
    });
};

type GitHubRestEndpoint = (
    parameters: Record<string, unknown>,
) => Promise<unknown>;

const requestDirectlyForObservation: PipelineSnapshotRequestExecutor = async (
    endpoint,
    parameters,
    signal,
) =>
    endpoint({
        ...parameters,
        ...(signal === undefined ? {} : { request: { signal } }),
    });

const recordFor = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;

const readHeadForInput = (
    input: PipelineObservationInput | GitHubPipelineObservationInput,
    defaultClient: Octokit | undefined,
    requestExecutor: PipelineSnapshotRequestExecutor | undefined,
): PipelineRemoteHeadReader | undefined => {
    if (input.readHead !== undefined) return input.readHead;
    const client = clientForInput(input, defaultClient);
    const rest = recordFor(
        (client as unknown as { readonly rest?: unknown } | undefined)?.rest,
    );
    const repos = recordFor(rest?.repos);
    const endpoint = repos?.getBranch;
    if (typeof endpoint !== "function") return undefined;
    const execute = requestExecutor ?? requestDirectlyForObservation;
    return async (request, signal) => {
        const { owner, name } = parseRepositorySlug(request.repository);
        const response = await execute(
            endpoint as GitHubRestEndpoint,
            { owner, repo: name, branch: request.branch },
            signal,
        );
        const responseRecord = recordFor(response);
        const data = responseRecord?.data ?? response;
        const commit = recordFor(recordFor(data)?.commit);
        const headSha = commit?.sha;
        if (typeof headSha !== "string" || !exactCommitSha(headSha))
            throw new Error(
                "HEAD response did not contain an exact commit SHA.",
            );
        return headSha;
    };
};

const makeDeadlineTimer = (
    controller: AbortController,
    marker: DeadlineMarker,
    durationMs: number,
): (() => void) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (remainingMs: number) => {
        timer = setTimeout(
            () => {
                if (remainingMs <= MAX_TIMER_MS) controller.abort(marker);
                else arm(remainingMs - MAX_TIMER_MS);
            },
            Math.min(remainingMs, MAX_TIMER_MS),
        );
    };
    arm(durationMs);
    return () => {
        if (timer !== undefined) clearTimeout(timer);
    };
};

const makeContext = (
    input: PipelineObservationInput | GitHubPipelineObservationInput,
    options: ResolvedPipelineObservationOptions,
    now: PipelineObservationClock,
    sleep: PipelineObservationSleep,
    fetchSnapshot: PipelineSnapshotFetcher,
    readHead: PipelineRemoteHeadReader | undefined,
): ObserveContext => {
    const startedAtMs = now();
    const controller = new AbortController();
    const deadlineMarker: DeadlineMarker = { kind: "observation-deadline" };
    const deadlineAtMs = startedAtMs + options.deadlineMs;
    const onCallerAbort = () => controller.abort(input.signal?.reason);
    if (input.signal?.aborted === true) onCallerAbort();
    else input.signal?.addEventListener("abort", onCallerAbort, { once: true });
    const cancelDeadline = makeDeadlineTimer(
        controller,
        deadlineMarker,
        options.deadlineMs,
    );
    return {
        input,
        request: requestForInput(input),
        fetchSnapshot,
        readHead,
        options,
        now,
        sleep,
        startedAtMs,
        deadlineAtMs,
        observedSha: requestForInput(input).commitSha,
        transitions: [],
        controller,
        deadlineMarker,
        dispose: () => {
            cancelDeadline();
            input.signal?.removeEventListener("abort", onCallerAbort);
        },
    };
};

export const makePipelineObservationService = (
    services: PipelineObservationServiceDependencies = {},
): PipelineObservationService => {
    const now = services.now ?? defaultNow;
    const sleep = services.sleep ?? defaultSleep;
    const collector = makePipelineChecksSnapshotCollectorService({
        request: services.request,
    });

    const observe = async (
        input: PipelineObservationInput | GitHubPipelineObservationInput,
    ): Promise<PipelineObservationResult> => {
        const options = resolveObservationOptions(
            input.options ?? input.settings ?? {},
        );
        const request = requestForInput(input);
        const normalizedInput = { ...input, request } as
            | PipelineObservationInput
            | GitHubPipelineObservationInput;
        const ctx = makeContext(
            normalizedInput,
            options,
            now,
            sleep,
            fetcherForInput(normalizedInput, collector, services.client),
            readHeadForInput(
                normalizedInput,
                services.client,
                services.request,
            ),
        );
        const st: LoopState = {
            stableSinceMs: ctx.startedAtMs,
            greenConfirmations: 0,
            polls: 0,
        };
        try {
            if (!exactCommitSha(ctx.request.commitSha))
                return resultWithOutcome(
                    ctx,
                    failedOutcome(
                        ctx,
                        st,
                        "invalid",
                        undefined,
                        "requested commit SHA is not an exact Git object ID",
                    ),
                );
            return await runLoop(ctx, st);
        } finally {
            ctx.dispose();
        }
    };

    return { observe };
};

export const PipelineObservationLive = makePipelineObservationService;
export const makePipelineObserver = makePipelineObservationService;
export const makeGitHubPipelineObservationService =
    makePipelineObservationService;
export const makeGitHubCheckObserver = makePipelineObservationService;
export const makeGitHubPipelineObserver = makePipelineObservationService;
export const makeGitHubPipelineCheckObserver = makePipelineObservationService;
export const makePipelineCheckObserver = makePipelineObservationService;

export {
    parseRetryAfter,
    rateLimitFromHeaders,
    rateLimitFromUnknown,
} from "./rate-limit.ts";
export type { RateLimitMetadata } from "./rate-limit.ts";