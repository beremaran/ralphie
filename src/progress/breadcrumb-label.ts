import { stripTerminalControls } from "../shared/terminal.ts";
import { dim } from "./colors.ts";
import {
    DISPLAY_ACTIVITY_LABELS,
    progressStageLabel,
    type DisplayState,
} from "./display-state.ts";

/**
 * Normalize text to one terminal-safe breadcrumb label line.
 *
 * Breadcrumbs are deliberately a presentation of already-reduced display
 * state. Only ANSI/control removal and whitespace normalization apply here;
 * label content, including token-like values, passes through unchanged.
 */
export const normalizeBreadcrumbLabel = (value: unknown): string => {
    const text = typeof value === "string" ? value : "";
    return stripTerminalControls(text).replace(/\s+/g, " ").trim();
};

/** Canonical key shared by breadcrumb rendering and adjacent de-duplication. */
export const canonicalBreadcrumbKey = (value: unknown): string =>
    normalizeBreadcrumbLabel(value);

const nonEmpty = (value: unknown): string | undefined => {
    const clean = normalizeBreadcrumbLabel(value);
    return clean === "" ? undefined : clean;
};

const appendIssueContext = (parts: string[], state: DisplayState): void => {
    if (state.issue === undefined) return;
    parts.push(`[${state.issue.current}/${state.issue.total}]`);
    parts.push(`#${state.issue.number}`);
    const title = nonEmpty(state.issue.title);
    if (title !== undefined) parts.push(title);
};

const contextPartsFor = (state: DisplayState): string[] => {
    const parts: string[] = [];
    const repository = nonEmpty(state.repository);
    if (repository !== undefined) parts.push(`[${repository}]`);
    appendIssueContext(parts, state);
    if (state.reviewAttempt !== undefined) {
        parts.push(
            `Review ${state.reviewAttempt.current}/${state.reviewAttempt.total}`,
        );
    }
    if (state.stage !== undefined) {
        parts.push(`› ${progressStageLabel(state.stage)}`);
    }
    const activity = nonEmpty(
        state.activityLabel || DISPLAY_ACTIVITY_LABELS[state.activity],
    );
    if (activity !== undefined) parts.push(`› ${activity}`);
    return parts;
};

/**
 * Build a breadcrumb from the normalized display context and current activity.
 * Agent events, tool arguments, and tool output are intentionally not inputs to
 * this function.
 */
export const breadcrumbLabelFor = (state: DisplayState): string =>
    normalizeBreadcrumbLabel(contextPartsFor(state).join(" "));

declare const displayContextCandidateBrand: unique symbol;

const approvedCandidates = new WeakSet<object>();

export type NormalizedBreadcrumb = {
    readonly label: string;
    readonly canonicalKey: string;
};

/**
 * A candidate created from reduced display state by breadcrumbCandidateFor.
 * The private brand and runtime provenance set prevent raw strings from being
 * supplied to preparation or rendering as if they were approved labels.
 */
export type BreadcrumbLabelCandidate = NormalizedBreadcrumb & {
    readonly [displayContextCandidateBrand]: true;
};

export type BreadcrumbLabel = NormalizedBreadcrumb;
export type BreadcrumbRenderResult = NormalizedBreadcrumb;
export type ApprovedBreadcrumbCandidate = BreadcrumbLabelCandidate;

const isApprovedBreadcrumbCandidate = (
    value: unknown,
): value is BreadcrumbLabelCandidate => {
    if (typeof value !== "object" || value === null) return false;
    if (!approvedCandidates.has(value)) return false;
    const candidate = value as {
        readonly label?: unknown;
        readonly canonicalKey?: unknown;
    };
    return (
        typeof candidate.label === "string" &&
        typeof candidate.canonicalKey === "string"
    );
};

const requireApprovedBreadcrumbCandidate = (
    candidate: BreadcrumbLabelCandidate,
): void => {
    if (!isApprovedBreadcrumbCandidate(candidate)) {
        throw new TypeError(
            "Breadcrumb candidate must be created from display context.",
        );
    }
};

const candidateFromLabel = (value: string): BreadcrumbLabelCandidate => {
    const label = normalizeBreadcrumbLabel(value);
    const candidate = Object.freeze({
        label,
        canonicalKey: canonicalBreadcrumbKey(label),
    }) as BreadcrumbLabelCandidate;
    approvedCandidates.add(candidate);
    return candidate;
};

/** Normalize an approved candidate and derive its key from the label. */
export const prepareBreadcrumbCandidate = (
    candidate: BreadcrumbLabelCandidate,
): NormalizedBreadcrumb => {
    requireApprovedBreadcrumbCandidate(candidate);
    const label = normalizeBreadcrumbLabel(candidate.label);
    return { label, canonicalKey: canonicalBreadcrumbKey(label) };
};

/** Return an approved candidate from the current display context. */
export const breadcrumbCandidateFor = (
    state: DisplayState,
): BreadcrumbLabelCandidate => candidateFromLabel(breadcrumbLabelFor(state));

export type BreadcrumbRenderOptions = {
    /** Apply the repository's subdued terminal style when true. */
    readonly colors?: boolean;
    /** Custom subdued style, useful to share a renderer's color policy. */
    readonly style?: (text: string) => string;
};

const styleFor = (
    options: BreadcrumbRenderOptions,
): ((text: string) => string) =>
    options.style ?? (options.colors === true ? dim : (text) => text);

/** Render only the normalized, subdued label text. */
export const renderBreadcrumbLabel = (
    candidate: BreadcrumbLabelCandidate,
    options: BreadcrumbRenderOptions = {},
): string => {
    const { label } = prepareBreadcrumbCandidate(candidate);
    if (label === "") return "";
    return styleFor(options)(label);
};

/** Render one complete transcript breadcrumb row. */
export const renderBreadcrumbLine = (
    candidate: BreadcrumbLabelCandidate,
    options: BreadcrumbRenderOptions = {},
): string => {
    const label = renderBreadcrumbLabel(candidate, options);
    return label === "" ? "" : `│  ${label}\n`;
};

/** Default number of visible rendered rows between breadcrumb opportunities. */
export const DEFAULT_BREADCRUMB_THRESHOLD = 30;

export type BreadcrumbPolicyState = {
    /** Visible rendered rows at the last emitted breadcrumb. */
    readonly renderedOutputBaseline: number;
    /** Number of threshold crossings consumed since that baseline. */
    readonly processedPeriodicCrossings: number;
    /** Normalized key of the last emitted breadcrumb, when one exists. */
    readonly lastEmittedCanonicalKey?: string;
};

export type BreadcrumbCandidate = {
    readonly visibleLinePosition: number;
    readonly key: string;
};

export type BreadcrumbCandidateInput = BreadcrumbCandidate;

export type BreadcrumbPolicyOptions = {
    /** Number of visible rendered rows required for one cadence crossing. */
    readonly breadcrumbThreshold?: number;
    readonly initialState?: BreadcrumbPolicyState;
};

export type BreadcrumbPolicyDecision = {
    readonly emit: boolean;
    /** Relative crossing numbers consumed by this candidate. */
    readonly crossings: ReadonlyArray<number>;
    readonly crossingCount: number;
    readonly canonicalKey: string;
    readonly reason: "emitted" | "below-threshold" | "duplicate" | "empty-key";
    readonly state: BreadcrumbPolicyState;
};

export type BreadcrumbPolicyResult = {
    readonly state: BreadcrumbPolicyState;
    readonly decision: BreadcrumbPolicyDecision;
};

const positiveSafeInteger = (value: number, name: string): number => {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(`${name} must be a positive safe integer.`);
    }
    return value;
};

const nonNegativeSafeInteger = (value: number, name: string): number => {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${name} must be a non-negative safe integer.`);
    }
    return value;
};

const thresholdFor = (options: BreadcrumbPolicyOptions): number =>
    positiveSafeInteger(
        options.breadcrumbThreshold ?? DEFAULT_BREADCRUMB_THRESHOLD,
        "breadcrumbThreshold",
    );

const stateFor = (
    state: BreadcrumbPolicyState | undefined,
): BreadcrumbPolicyState => {
    const baseline = nonNegativeSafeInteger(
        state?.renderedOutputBaseline ?? 0,
        "renderedOutputBaseline",
    );
    const crossings = nonNegativeSafeInteger(
        state?.processedPeriodicCrossings ?? 0,
        "processedPeriodicCrossings",
    );
    const key =
        state?.lastEmittedCanonicalKey === undefined
            ? undefined
            : canonicalBreadcrumbKey(state.lastEmittedCanonicalKey);
    return {
        renderedOutputBaseline: baseline,
        processedPeriodicCrossings: crossings,
        ...(key === undefined || key === ""
            ? {}
            : { lastEmittedCanonicalKey: key }),
    };
};

const positionFor = (candidate: BreadcrumbCandidateInput): number =>
    nonNegativeSafeInteger(
        candidate.visibleLinePosition ?? 0,
        "visibleLinePosition",
    );

const keyFor = (candidate: BreadcrumbCandidateInput): string =>
    canonicalBreadcrumbKey(candidate.key ?? "");

const candidateFor = (
    candidate: BreadcrumbCandidateInput | number,
    key?: string,
): BreadcrumbCandidate =>
    typeof candidate === "number"
        ? {
              visibleLinePosition: nonNegativeSafeInteger(
                  candidate,
                  "visibleLinePosition",
              ),
              key: key ?? "",
          }
        : {
              visibleLinePosition: positionFor(candidate),
              key: keyFor(candidate),
          };

const crossingNumbersFor = (
    state: BreadcrumbPolicyState,
    position: number,
    threshold: number,
): ReadonlyArray<number> => {
    const crossed = Math.floor(
        (position - state.renderedOutputBaseline) / threshold,
    );
    const first = state.processedPeriodicCrossings + 1;
    if (crossed < first) return [];
    return Array.from(
        { length: crossed - state.processedPeriodicCrossings },
        (_, index) => first + index,
    );
};

/**
 * Pure breadcrumb cadence and adjacent de-duplication transition.
 *
 * Only the supplied visible rendered-line position advances cadence. A
 * candidate may consume several crossings in one transition; consuming all
 * of them prevents a large output event from leaving a stale backlog for a
 * later lifecycle event.
 */
export const reduceBreadcrumbPolicy = (
    currentState: BreadcrumbPolicyState | undefined,
    candidateInput: BreadcrumbCandidateInput,
    options: BreadcrumbPolicyOptions = {},
): BreadcrumbPolicyResult => {
    const state = stateFor(currentState);
    const threshold = thresholdFor(options);
    const candidate = candidateFor(candidateInput);
    const canonicalKey = canonicalBreadcrumbKey(candidate.key);
    const crossings = crossingNumbersFor(
        state,
        candidate.visibleLinePosition,
        threshold,
    );
    const crossed =
        crossings.length === 0
            ? state.processedPeriodicCrossings
            : crossings.at(-1)!;
    const processedState: BreadcrumbPolicyState = {
        ...state,
        processedPeriodicCrossings: crossed,
    };
    const reason =
        crossings.length === 0
            ? "below-threshold"
            : canonicalKey === ""
              ? "empty-key"
              : canonicalKey === state.lastEmittedCanonicalKey
                ? "duplicate"
                : "emitted";
    const emit = reason === "emitted";
    const nextState: BreadcrumbPolicyState = emit
        ? {
              renderedOutputBaseline: candidate.visibleLinePosition,
              processedPeriodicCrossings: 0,
              lastEmittedCanonicalKey: canonicalKey,
          }
        : processedState;
    const decision: BreadcrumbPolicyDecision = {
        emit,
        crossings,
        crossingCount: crossings.length,
        canonicalKey,
        reason,
        state: nextState,
    };
    return { state: nextState, decision };
};

export type BreadcrumbPolicyConfiguration = BreadcrumbPolicyOptions | number;

const optionsFor = (
    options: BreadcrumbPolicyConfiguration,
): BreadcrumbPolicyOptions =>
    typeof options === "number" ? { breadcrumbThreshold: options } : options;

export type BreadcrumbPolicy = {
    readonly breadcrumbThreshold: number;
    readonly getState: () => BreadcrumbPolicyState;
    readonly consider: (
        candidate: BreadcrumbCandidateInput | number,
        key?: string,
    ) => BreadcrumbPolicyDecision;
    readonly shouldEmit: (
        candidate: BreadcrumbCandidateInput | number,
        key?: string,
    ) => boolean;
    /** Reset line accounting at a new visible-line accounting boundary. */
    readonly reset: (renderedOutputBaseline?: number) => void;
    /** Rebase after inserting a breadcrumb without clearing its adjacent key. */
    readonly rebase: (renderedOutputBaseline: number) => void;
};

export type BreadcrumbCandidateKind = "lifecycle" | "periodic";

export type BreadcrumbArbitrationCandidate = {
    readonly kind: BreadcrumbCandidateKind;
    readonly candidate: BreadcrumbCandidateInput;
};

export type BreadcrumbArbitrationResult = {
    readonly decisions: ReadonlyArray<{
        readonly kind: BreadcrumbCandidateKind;
        readonly decision: BreadcrumbPolicyDecision;
    }>;
    readonly emitted?: {
        readonly kind: BreadcrumbCandidateKind;
        readonly decision: BreadcrumbPolicyDecision;
    };
    readonly state: BreadcrumbPolicyState;
};

/**
 * Consider lifecycle work before periodic work at one rendered boundary.
 *
 * Both candidates are evaluated against the same policy state and position.
 * The first emission wins; the second consideration can still consume a
 * duplicate crossing, but cannot fund another breadcrumb from that interval.
 */
export const arbitrateBreadcrumbCandidates = (
    policy: BreadcrumbPolicy,
    candidates: ReadonlyArray<BreadcrumbArbitrationCandidate>,
): BreadcrumbArbitrationResult => {
    const ordered = [...candidates].sort((left, right) =>
        left.kind === right.kind ? 0 : left.kind === "lifecycle" ? -1 : 1,
    );
    const decisions: Array<{
        readonly kind: BreadcrumbCandidateKind;
        readonly decision: BreadcrumbPolicyDecision;
    }> = [];
    let emitted:
        | {
              readonly kind: BreadcrumbCandidateKind;
              readonly decision: BreadcrumbPolicyDecision;
          }
        | undefined;
    for (const { kind, candidate } of ordered) {
        const decision = policy.consider(candidate);
        decisions.push({ kind, decision });
        if (emitted === undefined && decision.emit) {
            emitted = { kind, decision };
        }
    }
    return {
        decisions,
        ...(emitted === undefined ? {} : { emitted }),
        state: policy.getState(),
    };
};

/** Create a stateful policy adapter for the transcript/coordinator seam. */
export const makeBreadcrumbPolicy = (
    configuration: BreadcrumbPolicyConfiguration = {},
): BreadcrumbPolicy => {
    const options = optionsFor(configuration);
    const breadcrumbThreshold = thresholdFor(options);
    let state = stateFor(options.initialState);

    const consider = (
        candidateInput: BreadcrumbCandidateInput | number,
        key?: string,
    ): BreadcrumbPolicyDecision => {
        const candidate = candidateFor(candidateInput, key);
        const result = reduceBreadcrumbPolicy(state, candidate, {
            breadcrumbThreshold,
        });
        state = result.state;
        return result.decision;
    };

    const reset = (renderedOutputBaseline = 0): void => {
        state = stateFor({
            renderedOutputBaseline,
            processedPeriodicCrossings: 0,
        });
    };

    const rebase = (renderedOutputBaseline: number): void => {
        const normalized = nonNegativeSafeInteger(
            renderedOutputBaseline,
            "renderedOutputBaseline",
        );
        state = {
            ...state,
            renderedOutputBaseline: normalized,
            processedPeriodicCrossings: 0,
        };
    };

    return {
        breadcrumbThreshold,
        getState: () => state,
        consider,
        shouldEmit: (candidateInput, key) => consider(candidateInput, key).emit,
        reset,
        rebase,
    };
};

export const createBreadcrumbPolicyState = (): BreadcrumbPolicyState => ({
    renderedOutputBaseline: 0,
    processedPeriodicCrossings: 0,
});

export const initialBreadcrumbPolicyState: BreadcrumbPolicyState =
    createBreadcrumbPolicyState();