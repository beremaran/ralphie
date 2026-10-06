import type { HarnessFailure, HarnessFailureKind } from "./ports.ts";

/**
 * The one place that decides whether a harness failure says something about
 * the issue or about the environment. Limits, overload and network trouble
 * (`transient`) clear by themselves, expired credentials (`auth`) need the
 * operator; neither says anything about the issue, so neither hands it off.
 */

const TRANSIENT_TEXT: ReadonlyArray<RegExp> = [
    /session limit|usage limit|rate[ _-]?limit|quota|credit balance|insufficient credits|payment required/i,
    /overloaded|too many requests|service unavailable|temporarily unavailable|bad gateway|gateway time-?out|at capacity/i,
    /(?:status|http|error|code)\D{0,4}(?:429|5\d\d)\b|\b(?:429|529)\b/i,
    /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network error|unable to connect|connection (?:error|refused|reset)/i,
];

const AUTH_TEXT: ReadonlyArray<RegExp> = [
    /not logged in|please run \/?login|login required|invalid api key|authentication[ _](?:failed|error|required)|unauthori[sz]ed|token (?:has )?expired|expired (?:token|credentials)|subscription is required|\b401\b/i,
];

/** Kinds a harness reports without a cause; their text may still name one. */
const UNCLASSIFIED: ReadonlyArray<HarnessFailureKind> = ["harness", "exit"];

/** Failure kinds that end the whole run instead of handing the issue off. */
const HALTING_KINDS: ReadonlyArray<string> = ["transient", "auth"];

export const isHaltingFailure = (failure: { readonly kind: string }): boolean =>
    HALTING_KINDS.includes(failure.kind);

/** The reset time a limit message names, such as "resets 3:10pm". */
export const resetHint = (message: string): string | undefined =>
    /\bresets?\s+(?:at\s+)?([^.\n(]+?)\s*(?:[.\n(]|$)/i
        .exec(message)?.[1]
        ?.trim();

/** Classify an HTTP status the harness reported. */
export const kindForStatus = (
    status: number | undefined,
): HarnessFailureKind | undefined => {
    if (status === undefined) return undefined;
    if (status === 401) return "auth";
    return status === 429 || status >= 500 ? "transient" : undefined;
};

/** Classify failure text; `undefined` when it names no environmental cause. */
export const kindForText = (
    message: string,
): HarnessFailureKind | undefined => {
    if (AUTH_TEXT.some((pattern) => pattern.test(message))) return "auth";
    return TRANSIENT_TEXT.some((pattern) => pattern.test(message))
        ? "transient"
        : undefined;
};

/** Upgrade an unexplained failure whose text names a transient or auth cause. */
export const classifyFailure = (failure: HarnessFailure): HarnessFailure => {
    const kind = UNCLASSIFIED.includes(failure.kind)
        ? kindForText(failure.message)
        : failure.kind;
    if (kind === undefined) return failure;
    const reset = kind === "transient" ? resetHint(failure.message) : undefined;
    return {
        ...failure,
        kind,
        ...(reset === undefined ? {} : { resetHint: reset }),
    };
};