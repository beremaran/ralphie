/**
 * Failure-closed classification of transport and payload failures into
 * DiagnosticError dispositions for the GitHub Actions pipeline diagnostics
 * collector (runs -> jobs -> steps -> check runs -> annotations).
 *
 * `classifyDiagnosticError` converts a raw failure (typically an Octokit
 * error) into a `DiagnosticError` carrying the contracts' disposition union.
 * Transport failures are introspected: errors recognized by
 * `rateLimitFromUnknown` - Octokit 403s with rate-limit headers or any error
 * carrying rate-limit metadata - become "rate-limited" with the rateLimit
 * metadata attached, and 5xx server errors become "unavailable" with their
 * source and message. Outcomes that cannot be introspected from a thrown
 * value - envelope-validation failures ("malformed") and caps enforced by
 * the pagination helpers ("truncated") - are supplied through `disposition`
 * and `message`; the classifier still bounds whatever partial evidence the
 * caller recovered.
 *
 * Every emitted error keeps `source`, a `message`, evidence bounded through
 * the shared evidence budget (the unbounded original payload is never
 * embedded), and `rateLimit` when the raw failure carried one, and stays
 * assignable to the `PipelineSourceError` shape from the contracts. Partial
 * evidence present at failure time is never thrown away, and an unrecognized
 * failure defaults to "unavailable" so a failed source is never reported as
 * fully ok.
 */
import { budgetRawEvidence } from "./evidence-budget.ts";
import type {
    DiagnosticError,
    DiagnosticRecordDisposition,
} from "./pipeline-diagnostics-contracts.ts";
import { rateLimitFromUnknown } from "./rate-limit.ts";
import type { RateLimitMetadata } from "./rate-limit.ts";

type FailureDisposition = Exclude<DiagnosticRecordDisposition, "ok">;

/**
 * Non-transport outcomes supplied explicitly because no thrown value can
 * introspect them. "rate-limited" is never explicit: it is derived from the
 * raw failure's rate-limit metadata.
 */
export type DiagnosticFailureDisposition = Exclude<
    FailureDisposition,
    "rate-limited"
>;

/** Input for one failure classification. */
export type ClassifyDiagnosticErrorInput = {
    /** Diagnostic label carried by the emitted error. */
    readonly source: string;
    /** Raw transport failure; introspected for rate-limit and 5xx signals. */
    readonly cause?: unknown;
    /**
     * Known outcome for failures that cannot be introspected: malformed
     * response envelopes or shapes, or a cap enforced by the collector.
     */
    readonly disposition?: DiagnosticFailureDisposition;
    /** Message override; defaults to the cause's message or a disposition default. */
    readonly message?: string;
    /** Partial evidence collected before the failure; always budget-bounded. */
    readonly evidence?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

/** Octokit errors carry the status directly and on `response`. */
const statusOf = (cause: unknown): number | undefined => {
    if (!isRecord(cause)) return undefined;
    const responseStatus = isRecord(cause.response)
        ? cause.response.status
        : undefined;
    const status = responseStatus ?? cause.status;
    return typeof status === "number" && Number.isFinite(status)
        ? status
        : undefined;
};

const causeText = (cause: unknown): string | undefined => {
    const text =
        cause instanceof Error
            ? cause.message
            : typeof cause === "string"
              ? cause
              : undefined;
    if (text === undefined) return undefined;
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};

const DEFAULT_MESSAGES: Record<FailureDisposition, string> = {
    unavailable: "Source is unavailable.",
    malformed: "Source response was malformed.",
    truncated: "Source evidence exceeded the shared evidence budget.",
    "rate-limited": "Source is rate limited.",
};

/**
 * Introspect a raw transport failure. A failure carrying rate-limit metadata
 * is rate limited (Octokit 403s with rate-limit headers are the common
 * case); a 5xx server error is unavailable. Anything else defers to the
 * caller's evidence and the failure-closed default.
 */
const dispositionFromCause = (
    cause: unknown,
    rateLimit: RateLimitMetadata | undefined,
): Exclude<FailureDisposition, "truncated"> | undefined => {
    if (rateLimit !== undefined) return "rate-limited";
    const status = statusOf(cause);
    return status !== undefined && status >= 500 ? "unavailable" : undefined;
};

/**
 * Convert a raw failure into a `DiagnosticError`. The emitted disposition is
 * never "ok": an explicit known outcome wins, then the cause is introspected,
 * then evidence that overflowed the shared budget is "truncated", and any
 * remaining failure defaults to "unavailable". `rawValues` always carries
 * the budget-bounded evidence, never the unbounded original payload.
 */
export const classifyDiagnosticError = (
    input: ClassifyDiagnosticErrorInput,
): DiagnosticError => {
    const bounded = budgetRawEvidence(input.evidence);
    const rateLimit = rateLimitFromUnknown(input.cause);
    const disposition: FailureDisposition =
        input.disposition ??
        dispositionFromCause(input.cause, rateLimit) ??
        (bounded.disposition === "truncated" ? "truncated" : "unavailable");
    return {
        source: input.source,
        disposition,
        message:
            input.message ??
            causeText(input.cause) ??
            DEFAULT_MESSAGES[disposition],
        rawValues: bounded.value,
        ...(rateLimit === undefined ? {} : { rateLimit }),
    };
};