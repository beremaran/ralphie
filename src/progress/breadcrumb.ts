import { canonicalBreadcrumbKey } from "./breadcrumb-label.ts";

export {
    breadcrumbCandidateFor,
    breadcrumbCandidateFromDisplayState,
    breadcrumbForDisplayState,
    breadcrumbLabelFor,
    breadcrumbLabelForDisplayState,
    canonicalBreadcrumbKey,
    createBreadcrumbCandidate,
    createBreadcrumbLabel,
    displayContextBreadcrumbLabel,
    makeBreadcrumbCandidate,
    makeBreadcrumbLabel,
    prepareBreadcrumbCandidate,
    prepareBreadcrumbLabel,
    renderBreadcrumb,
    renderBreadcrumbCandidate,
    renderBreadcrumbLabel,
    renderBreadcrumbLine,
    sanitizeBreadcrumbKey,
    sanitizeBreadcrumbLabel,
} from "./breadcrumb-label.ts";
export type {
    ApprovedBreadcrumbCandidate,
    BreadcrumbLabel,
    BreadcrumbLabelCandidate,
    BreadcrumbRenderOptions,
    BreadcrumbRenderResult,
    SanitizedBreadcrumb,
} from "./breadcrumb-label.ts";

/** Default number of visible rendered rows between breadcrumb opportunities. */
export const DEFAULT_BREADCRUMB_THRESHOLD = 30;

export type BreadcrumbPolicyState = {
    /** Visible rendered rows at the last emitted breadcrumb. */
    readonly renderedOutputBaseline: number;
    /** Number of threshold crossings consumed since that baseline. */
    readonly processedPeriodicCrossings: number;
    /** Sanitized key of the last emitted breadcrumb, when one exists. */
    readonly lastEmittedCanonicalKey?: string;
};

export type BreadcrumbCandidate = {
    readonly visibleLinePosition: number;
    readonly key: string;
};

/** Coordinate aliases keep the policy usable by line-accounting adapters. */
export type BreadcrumbCandidateInput =
    | BreadcrumbCandidate
    | {
          readonly visibleLinePosition?: number;
          readonly renderedLinePosition?: number;
          readonly linePosition?: number;
          readonly visibleLineCount?: number;
          readonly key?: string;
          readonly label?: string;
          readonly canonicalKey?: string;
      };

export type BreadcrumbPolicyOptions = {
    /** Number of visible rendered rows required for one cadence crossing. */
    readonly breadcrumbThreshold?: number;
    /** Short alias for callers that already have a generic threshold option. */
    readonly threshold?: number;
    readonly initialState?: BreadcrumbPolicyState;
};

export type BreadcrumbPolicyDecision = {
    readonly emit: boolean;
    /** Explicit alias for consumers that phrase the decision as emission. */
    readonly emitted: boolean;
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
        options.breadcrumbThreshold ??
            options.threshold ??
            DEFAULT_BREADCRUMB_THRESHOLD,
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

const positionFor = (candidate: BreadcrumbCandidateInput): number => {
    const position =
        candidate.visibleLinePosition ??
        ("renderedLinePosition" in candidate
            ? candidate.renderedLinePosition
            : undefined) ??
        ("linePosition" in candidate ? candidate.linePosition : undefined) ??
        ("visibleLineCount" in candidate
            ? candidate.visibleLineCount
            : undefined);
    return nonNegativeSafeInteger(position ?? 0, "visibleLinePosition");
};

const keyFor = (candidate: BreadcrumbCandidateInput): string =>
    canonicalBreadcrumbKey(
        ("label" in candidate ? candidate.label : undefined) ??
            candidate.key ??
            ("canonicalKey" in candidate
                ? candidate.canonicalKey
                : undefined) ??
            "",
    );

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
        emitted: emit,
        crossings,
        crossingCount: crossings.length,
        canonicalKey,
        reason,
        state: nextState,
    };
    return { state: nextState, decision };
};

/** Evaluate one candidate using a policy's configured threshold. */
export const evaluateBreadcrumbCandidate = (
    state: BreadcrumbPolicyState | undefined,
    candidate: BreadcrumbCandidateInput,
    options: BreadcrumbPolicyOptions = {},
): BreadcrumbPolicyResult => reduceBreadcrumbPolicy(state, candidate, options);

export type BreadcrumbPolicyConfiguration = BreadcrumbPolicyOptions | number;

const optionsFor = (
    options: BreadcrumbPolicyConfiguration,
): BreadcrumbPolicyOptions =>
    typeof options === "number" ? { breadcrumbThreshold: options } : options;

export type BreadcrumbPolicy = {
    readonly breadcrumbThreshold: number;
    readonly getState: () => BreadcrumbPolicyState;
    readonly state: () => BreadcrumbPolicyState;
    readonly consider: (
        candidate: BreadcrumbCandidateInput | number,
        key?: string,
    ) => BreadcrumbPolicyDecision;
    readonly evaluate: (
        candidate: BreadcrumbCandidateInput | number,
        key?: string,
    ) => BreadcrumbPolicyDecision;
    readonly shouldEmit: (
        candidate: BreadcrumbCandidateInput | number,
        key?: string,
    ) => boolean;
    /** Reset line accounting at a new visible-line accounting boundary. */
    readonly reset: (renderedOutputBaseline?: number) => void;
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

    return {
        breadcrumbThreshold,
        getState: () => state,
        state: () => state,
        consider,
        evaluate: consider,
        shouldEmit: (candidateInput, key) => consider(candidateInput, key).emit,
        reset: (renderedOutputBaseline = 0) => {
            state = stateFor({
                renderedOutputBaseline,
                processedPeriodicCrossings: 0,
            });
        },
    };
};

/** Naming aliases for callers that describe this as a cadence engine. */
export const makeBreadcrumbCadencePolicy = makeBreadcrumbPolicy;
export const makeBreadcrumbPolicyEngine = makeBreadcrumbPolicy;
export const createBreadcrumbPolicy = makeBreadcrumbPolicy;

export const createBreadcrumbPolicyState = (): BreadcrumbPolicyState => ({
    renderedOutputBaseline: 0,
    processedPeriodicCrossings: 0,
});

export const initialBreadcrumbPolicyState: BreadcrumbPolicyState =
    createBreadcrumbPolicyState();