/**
 * Circuit breaker for the mandatory `submit_result` tool.
 *
 * A model or provider that cannot honor a tool's parameter schema (for
 * example, a relay that drops tool-call arguments for root-level unions) can
 * retry a failing `submit_result` call indefinitely: every rejection is fed
 * back to the model, which repeats the same broken call and burns tokens.
 * The guard observes every `submit_result` invocation and, once the limit of
 * consecutive attempts without a schema-valid result is exceeded, aborts the
 * session so the structured-output request fails fast with a diagnosable
 * error instead of looping.
 */

export const PI_SUBMIT_RESULT_FAILURE_LIMIT = 5;

export type SubmitResultGuard = {
    /** Observe an incoming submit_result call, before schema validation. */
    readonly beginAttempt: (args: unknown) => void;
    /** Confirm the observed call produced a schema-valid result. */
    readonly recordSuccess: () => void;
    /** Record the validation error of an observed call that failed validation. */
    readonly recordFailure: (error: string) => void;
    readonly isTripped: () => boolean;
    readonly tripReason: () => string | undefined;
    /** Bind the callback that aborts the session when the guard trips. */
    readonly onTrip: (abort: () => void) => void;
};

const argumentCount = (args: unknown): number => {
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
        return 0;
    }
    return Object.keys(args).length;
};

const describeEmptyAttempt = (args: unknown): string | undefined =>
    argumentCount(args) === 0
        ? "the tool call arrived with empty arguments (the model or provider likely dropped the tool-call arguments)"
        : undefined;

const tripMessage = (
    attempts: number,
    lastFailure: string | undefined,
): string =>
    [
        `submit_result failed ${attempts} consecutive attempts without a schema-valid result`,
        ...(lastFailure === undefined ? [] : [`last failure: ${lastFailure}`]),
        "aborting the session instead of granting another retry",
    ].join("; ");

export const makeSubmitResultGuard = (
    limit: number = PI_SUBMIT_RESULT_FAILURE_LIMIT,
): SubmitResultGuard => {
    let attemptsSinceSuccess = 0;
    let lastFailure: string | undefined;
    let trippedReason: string | undefined;
    let abort: (() => void) | undefined;

    return {
        beginAttempt: (args) => {
            if (trippedReason !== undefined) return;
            if (attemptsSinceSuccess >= limit) {
                trippedReason = tripMessage(attemptsSinceSuccess, lastFailure);
                abort?.();
                return;
            }
            attemptsSinceSuccess += 1;
            const emptyDescription = describeEmptyAttempt(args);
            if (emptyDescription !== undefined) lastFailure = emptyDescription;
        },
        recordSuccess: () => {
            attemptsSinceSuccess = 0;
            lastFailure = undefined;
        },
        recordFailure: (error) => {
            lastFailure = error;
        },
        isTripped: () => trippedReason !== undefined,
        tripReason: () => trippedReason,
        onTrip: (callback) => {
            abort = callback;
        },
    };
};