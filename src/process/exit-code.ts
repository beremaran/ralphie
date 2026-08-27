export enum RalphieExitCode {
    Success = 0,
    Failure = 1,
    Cancelled = 130,
}

export const exitCodeForFailure = (signal: AbortSignal): RalphieExitCode => {
    return signal.aborted ? RalphieExitCode.Cancelled : RalphieExitCode.Failure;
};