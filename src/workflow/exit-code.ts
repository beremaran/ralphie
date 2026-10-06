import { RunHaltedError } from "../shared/error.ts";

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
    return error instanceof RunHaltedError
        ? RalphieExitCode.Halted
        : RalphieExitCode.Failure;
};