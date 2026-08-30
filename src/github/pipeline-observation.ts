/**
 * gpgreen-observation: a bounded, deterministic observer over normalized
 * pipeline snapshots for one exact commit SHA.
 *
 * The observer never decides green from a single snapshot. It polls through
 * an initial registration grace period while no checks are visible, keeps
 * polling while any item is pending, requires a stable quiescence window over
 * the normalized set and terminal states, fails closed on unknown, cancelled,
 * failing, and empty terminal results, and honors GitHub rate-limit hints, an
 * absolute deadline, and `AbortSignal`. It emits only meaningful state
 * transitions and finishes with a race-safe final HEAD check so a caller can
 * follow a newly advanced HEAD instead of treating an old SHA as success.
 *
 * The slice is read-only: snapshots come from an injected fetcher and remote
 * head reads from an injected reader, so every behavior is deterministic
 * under fake clocks, retrievers, and readers.
 */
import type {
    ExactCommitSha,
    PipelineItemStatus,
    PipelineSnapshot,
    PipelineSnapshotRequest,
} from "./pipeline-snapshot.ts";
import { normalizePipelineSnapshot } from "./pipeline-snapshot.ts";

/** Injected clock returning the current Unix epoch time in milliseconds. */
export type PipelineObservationClock = () => number;

/** Injected sleeper used between polls; must reject when `signal` aborts. */
export type PipelineObservationSleep = (
    milliseconds: number,
    signal?: AbortSignal,
) => Promise<void>;

/** Injected read-only snapshot fetcher for one exact commit SHA. */
export type PipelineSnapshotFetcher = (
    request: PipelineSnapshotRequest,
) => Promise<PipelineObservationRead>;

/** Injected read-only reader of the remote branch HEAD for a request. */
export type PipelineRemoteHeadReader = (
    request: PipelineSnapshotRequest,
) => Promise<ExactCommitSha>;

/** GitHub rate-limit/retry metadata surfaced with a read. */
export type PipelineObservationRateLimit = {
    /** Absolute window reset time in Unix epoch milliseconds. */
    readonly resetAtMs?: number;
    /** Server `Retry-After` hint in milliseconds. */
    readonly retryAfterMs?: number;
    /** Calls remaining in the current window. */
    readonly remaining?: number;
};

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

export type PipelineObservationOptions = {
    /** Poll through this window while no checks are visible. */
    readonly registrationGraceMs: number;
    /** Stable window over the normalized set and terminal states. */
    readonly quiescenceMs: number;
    /** Absolute observation deadline from the start of the observe call. */
    readonly deadlineMs: number;
    /** First backoff delay after a non-resolving poll. */
    readonly initialBackoffMs?: number;
    /** Upper bound for exponential backoff sleeps. */
    readonly maxBackoffMs?: number;
    /** Backoff multiplier. */
    readonly backoffFactor?: number;
};

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
    /** Fetch or head-read error details when `reason` is "invalid". */
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
    readonly fetchSnapshot: PipelineSnapshotFetcher;
    readonly readHead: PipelineRemoteHeadReader;
    readonly options: PipelineObservationOptions;
    readonly signal?: AbortSignal;
};

export type PipelineObservationResult = {
    readonly outcome: PipelineObservationOutcome;
    readonly transitions: ReadonlyArray<PipelineObservationTransition>;
};

export type PipelineObservationService = {
    readonly observe: (
        input: PipelineObservationInput,
    ) => Promise<PipelineObservationResult>;
};

export type PipelineObservationServiceDependencies = {
    readonly now?: PipelineObservationClock;
    readonly sleep?: PipelineObservationSleep;
};

const DEFAULT_INITIAL_BACKOFF_MS = 1000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const DEFAULT_BACKOFF_FACTOR = 2;
const MAX_BACKOFF_EXPONENT = 30;

const defaultNow: PipelineObservationClock = () => Date.now();

const defaultSleep: PipelineObservationSleep = async (milliseconds, signal) => {
    if (signal?.aborted === true) throw new Error("Observation aborted.");
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, milliseconds);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(new Error("Observation aborted."));
            },
            { once: true },
        );
    });
};

type ResolvedPipelineObservationOptions = Required<
    Omit<
        PipelineObservationOptions,
        "registrationGraceMs" | "quiescenceMs" | "deadlineMs"
    >
> &
    Pick<
        PipelineObservationOptions,
        "registrationGraceMs" | "quiescenceMs" | "deadlineMs"
    >;

const requireFiniteAtLeast = (
    value: number,
    minimum: number,
    message: string,
): number => {
    if (!Number.isFinite(value) || value < minimum)
        throw new RangeError(message);
    return value;
};

const resolveObservationOptions = (
    options: PipelineObservationOptions,
): ResolvedPipelineObservationOptions => {
    const registrationGraceMs = requireFiniteAtLeast(
        options.registrationGraceMs,
        0,
        "registrationGraceMs must be a non-negative number of milliseconds.",
    );
    const quiescenceMs = requireFiniteAtLeast(
        options.quiescenceMs,
        0,
        "quiescenceMs must be a non-negative number of milliseconds.",
    );
    const deadlineMs = requireFiniteAtLeast(
        options.deadlineMs,
        1,
        "deadlineMs must be a positive number of milliseconds.",
    );
    const initialBackoffMs = requireFiniteAtLeast(
        options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS,
        1,
        "initialBackoffMs must be a positive number of milliseconds.",
    );
    const maxBackoffMs = requireFiniteAtLeast(
        options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
        initialBackoffMs,
        "maxBackoffMs must be at least initialBackoffMs.",
    );
    const backoffFactor = requireFiniteAtLeast(
        options.backoffFactor ?? DEFAULT_BACKOFF_FACTOR,
        1,
        "backoffFactor must be at least 1.",
    );
    return {
        registrationGraceMs,
        quiescenceMs,
        deadlineMs,
        initialBackoffMs,
        maxBackoffMs,
        backoffFactor,
    };
};

const itemKey = (provider: string, name: string): string =>
    `${provider}\u0000${name}`;

type ObservationSetState = {
    readonly empty: boolean;
    readonly items: ReadonlyMap<string, PipelineItemStatus>;
    readonly hasErrors: boolean;
};

const stateForSnapshot = (snapshot: PipelineSnapshot): ObservationSetState => {
    const items = new Map<string, PipelineItemStatus>();
    for (const item of snapshot.items)
        items.set(itemKey(item.provider, item.name), item.status);
    return {
        empty: snapshot.items.length === 0,
        items,
        hasErrors:
            snapshot.sourceErrors.length > 0 ||
            snapshot.completenessErrors.length > 0,
    };
};

const signatureFor = (state: ObservationSetState): string =>
    JSON.stringify([
        [...state.items.entries()].sort((left, right) =>
            left[0] === right[0] ? 0 : left[0] > right[0] ? 1 : -1,
        ),
        state.hasErrors,
    ]);

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

const hasPending = (state: ObservationSetState): boolean =>
    [...state.items.values()].some((status) => status === "pending");

const resolvableGreen = (state: ObservationSetState): boolean => {
    if (state.empty || state.hasErrors) return false;
    for (const status of state.items.values())
        if (status !== "passing" && status !== "acceptable") return false;
    return true;
};

const verdictFor = (
    state: ObservationSetState,
): PipelineFailureReason | "green" => {
    if (state.hasErrors) return "invalid";
    for (const status of state.items.values()) {
        if (status === "failing") return "failing";
        if (status === "cancelled") return "cancelled";
        if (status === "unknown") return "unknown";
        if (status === "pending") return "unknown";
    }
    return "green";
};

const backoffDelayFor = (
    options: ResolvedPipelineObservationOptions,
    pollIndex: number,
): number => {
    const exponent = Math.min(pollIndex, MAX_BACKOFF_EXPONENT);
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
    const candidates: number[] = [];
    if (rateLimit.resetAtMs !== undefined)
        candidates.push(Math.max(0, rateLimit.resetAtMs - atMs));
    if (rateLimit.retryAfterMs !== undefined)
        candidates.push(Math.max(0, rateLimit.retryAfterMs));
    return candidates.length === 0 ? undefined : Math.max(...candidates);
};

const readOnce = async (
    input: PipelineObservationInput,
): Promise<PipelineObservationRead> => {
    try {
        return await input.fetchSnapshot(input.request);
    } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        return { kind: "failure", message };
    }
};

const snapshotOf = (
    read: PipelineObservationRead,
): PipelineSnapshot | undefined =>
    read.kind === "snapshot" ? read.snapshot : undefined;

const emptySnapshotFor = (request: PipelineSnapshotRequest): PipelineSnapshot =>
    normalizePipelineSnapshot({
        ...request,
        observations: [],
        sourceErrors: [],
    });

const continueAfter = async (
    ctx: ObserveContext,
    st: LoopState,
    read: PipelineObservationRead,
    at: number,
    maxDelayMs: number,
): Promise<void> => {
    if (maxDelayMs <= 0) return;
    const hint = rateLimitHintMs(read.rateLimit, at);
    const natural = backoffDelayFor(ctx.options, st.polls - 1);
    const bounded = Math.min(Math.max(natural, hint ?? 0), maxDelayMs);
    if (bounded > 0) await ctx.sleep(bounded, ctx.input.signal);
};

type ObserveContext = {
    readonly input: PipelineObservationInput;
    readonly options: ResolvedPipelineObservationOptions;
    readonly now: PipelineObservationClock;
    readonly sleep: PipelineObservationSleep;
    readonly startedAtMs: number;
    readonly deadlineAtMs: number;
    readonly observedSha: ExactCommitSha;
    readonly transitions: PipelineObservationTransition[];
};

type LoopState = {
    previous?: ObservationSetState;
    signature?: string;
    stableSinceMs: number;
    polls: number;
    lastSnapshot?: PipelineSnapshot;
};

const elapsedMsFor = (ctx: ObserveContext): number =>
    ctx.now() - ctx.startedAtMs;

const abortedOutcome = (
    ctx: ObserveContext,
    st: LoopState,
): AbortedPipelineObservation => ({
    kind: "aborted",
    observedSha: ctx.observedSha,
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
    elapsedMs: at - ctx.startedAtMs,
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
    | { readonly kind: "error"; readonly message: string };

const finalVerificationRead = async (
    ctx: ObserveContext,
): Promise<FinalVerificationRead> => {
    try {
        const headBefore = await ctx.input.readHead(ctx.input.request);
        const finalRead = await readOnce(ctx.input);
        const headAfter = await ctx.input.readHead(ctx.input.request);
        return { kind: "ok", headBefore, finalRead, headAfter };
    } catch (cause) {
        if (ctx.input.signal?.aborted === true) return { kind: "aborted" };
        return {
            kind: "error",
            message: cause instanceof Error ? cause.message : String(cause),
        };
    }
};

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
        snapshotOf(finalRead) ??
        st.lastSnapshot ??
        emptySnapshotFor(ctx.input.request),
    elapsedMs: elapsedMsFor(ctx),
    polls: st.polls,
});

const settleFinal = async (
    ctx: ObserveContext,
    st: LoopState,
): Promise<PipelineObservationOutcome | undefined> => {
    const verification = await finalVerificationRead(ctx);
    if (verification.kind === "aborted") return abortedOutcome(ctx, st);
    if (verification.kind === "error")
        return failedOutcome(
            ctx,
            st,
            "invalid",
            undefined,
            verification.message,
        );
    const { headBefore, finalRead, headAfter } = verification;
    if (headBefore !== ctx.observedSha || headAfter !== ctx.observedSha)
        return staleOutcome(ctx, st, headBefore, headAfter, finalRead);
    if (finalRead.kind === "failure")
        return failedOutcome(ctx, st, "invalid", undefined, finalRead.message);
    if (resolvableGreen(stateForSnapshot(finalRead.snapshot))) {
        return {
            kind: "green",
            observedSha: ctx.observedSha,
            snapshot: finalRead.snapshot,
            elapsedMs: elapsedMsFor(ctx),
            polls: st.polls,
        };
    }
    const finalState = stateForSnapshot(finalRead.snapshot);
    ctx.transitions.push(...transitionsFor(st.previous, finalState));
    st.previous = finalState;
    st.signature = signatureFor(finalState);
    st.stableSinceMs = ctx.now();
    st.lastSnapshot = finalRead.snapshot;
    return undefined;
};

const handlePoll = async (
    ctx: ObserveContext,
    st: LoopState,
    read: PipelineObservationRead,
    at: number,
): Promise<PipelineObservationOutcome | undefined> => {
    st.polls += 1;
    if (read.kind === "failure")
        return failedOutcome(ctx, st, "invalid", undefined, read.message);

    const state = stateForSnapshot(read.snapshot);
    st.lastSnapshot = read.snapshot;
    ctx.transitions.push(...transitionsFor(st.previous, state));
    st.previous = state;

    // Any normalized-set change (register, disappear, or status change)
    // restarts the quiescence window; empty states are a set change too.
    const current = signatureFor(state);
    if (current !== st.signature) {
        st.signature = current;
        st.stableSinceMs = at;
    }

    if (state.empty) {
        const graceRemaining =
            ctx.options.registrationGraceMs - (at - ctx.startedAtMs);
        if (graceRemaining <= 0) return noPipelinesOutcome(ctx, st, at);
        await continueAfter(
            ctx,
            st,
            read,
            at,
            Math.min(ctx.deadlineAtMs - at, graceRemaining),
        );
        return undefined;
    }

    if (hasPending(state)) {
        await continueAfter(ctx, st, read, at, ctx.deadlineAtMs - at);
        return undefined;
    }

    if (at - st.stableSinceMs < ctx.options.quiescenceMs) {
        await continueAfter(ctx, st, read, at, ctx.deadlineAtMs - at);
        return undefined;
    }

    const verdict = verdictFor(state);
    if (verdict !== "green")
        return failedOutcome(ctx, st, verdict, read.snapshot);
    return settleFinal(ctx, st);
};

const runLoop = async (
    ctx: ObserveContext,
    st: LoopState,
): Promise<PipelineObservationResult> => {
    try {
        while (true) {
            if (ctx.input.signal?.aborted === true)
                return {
                    outcome: abortedOutcome(ctx, st),
                    transitions: ctx.transitions,
                };
            const at = ctx.now();
            if (at >= ctx.deadlineAtMs)
                return {
                    outcome: timeoutOutcome(ctx, st),
                    transitions: ctx.transitions,
                };
            const read = await readOnce(ctx.input);
            const outcome = await handlePoll(ctx, st, read, at);
            if (outcome !== undefined)
                return { outcome, transitions: ctx.transitions };
        }
    } catch (cause) {
        if (ctx.input.signal?.aborted === true)
            return {
                outcome: abortedOutcome(ctx, st),
                transitions: ctx.transitions,
            };
        throw cause;
    }
};

export const makePipelineObservationService = (
    services: PipelineObservationServiceDependencies = {},
): PipelineObservationService => {
    const now = services.now ?? defaultNow;
    const sleep = services.sleep ?? defaultSleep;

    const observe = async (
        input: PipelineObservationInput,
    ): Promise<PipelineObservationResult> => {
        const options = resolveObservationOptions(input.options);
        const startedAtMs = now();
        const ctx: ObserveContext = {
            input,
            options,
            now,
            sleep,
            startedAtMs,
            deadlineAtMs: startedAtMs + options.deadlineMs,
            observedSha: input.request.commitSha,
            transitions: [],
        };
        const st: LoopState = { stableSinceMs: startedAtMs, polls: 0 };
        return runLoop(ctx, st);
    };

    return { observe };
};

export const PipelineObservationLive = makePipelineObservationService;
export const makePipelineObserver = makePipelineObservationService;