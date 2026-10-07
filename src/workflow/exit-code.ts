import { causesOf, RunHaltedError } from "../shared/error.ts";

export enum RalphieExitCode {
    Success = 0,
    Failure = 1,
    /** A limit, outage or expired login halted the run (EX_TEMPFAIL). */
    Halted = 75,
    Cancelled = 130,
}

export const exitCodeForError = (
    error: unknown,
    signal: AbortSignal,
): RalphieExitCode => {
    if (signal.aborted) return RalphieExitCode.Cancelled;
    return isHalt(error) ? RalphieExitCode.Halted : RalphieExitCode.Failure;
};

/** The command boundary wraps errors, so look through the cause chain. */
const isHalt = (error: unknown): boolean =>
    [error, ...causesOf(error)].some(
        (current) => current instanceof RunHaltedError,
    );