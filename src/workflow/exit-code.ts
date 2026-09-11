export enum RalphieExitCode {
    Success = 0,
    Failure = 1,
    Cancelled = 130,
}

export const exitCodeForError = (
    _error: unknown,
    signal: AbortSignal,
): RalphieExitCode =>
    signal.aborted ? RalphieExitCode.Cancelled : RalphieExitCode.Failure;