export class RalphieError extends Error {
    constructor(input: { readonly message: string; readonly cause?: unknown }) {
        super(input.message);
        this.name = "RalphieError";
        if (input.cause !== undefined) {
            this.cause = input.cause;
        }
    }
}

/** The run stopped early because the environment, not an issue, failed. */
export class RunHaltedError extends RalphieError {
    constructor(input: { readonly message: string; readonly cause?: unknown }) {
        super(input);
        this.name = "RunHaltedError";
    }
}
/** The message of an error, or the thrown value itself as text. */
export const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

/** Whether a thrown value carries a system error code such as `ENOENT`. */
export const hasErrorCode = (error: unknown, code: string): boolean =>
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code;

/**
 * The `cause` chain below a thrown value, nearest first. The walk follows the
 * whole chain and stops only at its end or at a cycle.
 */
export const causesOf = (error: unknown): ReadonlyArray<unknown> => {
    const causes: unknown[] = [];
    const seen = new Set<unknown>([error]);
    let current = error;
    while (
        typeof current === "object" &&
        current !== null &&
        "cause" in current &&
        current.cause !== undefined &&
        !seen.has(current.cause)
    ) {
        current = current.cause;
        seen.add(current);
        causes.push(current);
    }
    return causes;
};

/** Throw a `RalphieError` with the given message once the signal aborts. */
export const throwIfAborted = (
    signal: AbortSignal | undefined,
    message: string,
): void => {
    try {
        signal?.throwIfAborted();
    } catch (cause) {
        throw new RalphieError({ message, cause });
    }
};