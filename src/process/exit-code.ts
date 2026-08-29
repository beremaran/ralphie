import { RalphieError } from "../shared/error.ts";

export enum RalphieExitCode {
    Success = 0,
    Failure = 1,
    NeedsAttention = 2,
    Cancelled = 130,
}

/** A handled stop raised when the selected policy halts on an issue needing attention. */
export class NeedsAttentionStop extends RalphieError {
    override readonly _tag = "NeedsAttentionStop" as const;
    readonly issueNumber: number;

    constructor(input: {
        readonly issueNumber: number;
        readonly summary: string;
    }) {
        super({
            message: `Run stopped because issue #${input.issueNumber} needs attention: ${input.summary}`,
        });
        this.name = "NeedsAttentionStop";
        this.issueNumber = input.issueNumber;
    }
}

export const isNeedsAttentionStop = (
    error: unknown,
): error is NeedsAttentionStop =>
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "NeedsAttentionStop";

export const exitCodeForFailure = (signal: AbortSignal): RalphieExitCode => {
    return signal.aborted ? RalphieExitCode.Cancelled : RalphieExitCode.Failure;
};

export const exitCodeForError = (
    error: unknown,
    signal: AbortSignal,
): RalphieExitCode =>
    signal.aborted
        ? RalphieExitCode.Cancelled
        : isNeedsAttentionStop(error)
          ? RalphieExitCode.NeedsAttention
          : RalphieExitCode.Failure;