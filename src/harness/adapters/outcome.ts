import {
    CommandAbortedError,
    CommandTimeoutError,
} from "../../process/ports.ts";
import { RalphieError } from "../../shared/error.ts";
import type { HarnessFailure, TurnOutcome } from "../ports.ts";

/**
 * The failure handling every adapter does the same way: the shape of a
 * failed outcome, and the meaning of the errors the process port throws.
 * Adapters settle exit codes and native streams for themselves; only this
 * half of a failed turn is shared.
 */

/** One failed turn, resumable under the harness's own session id. */
export const failure = (
    kind: HarnessFailure["kind"],
    message: string,
    harnessSessionID?: string,
): TurnOutcome => ({
    ok: false,
    failure: {
        kind,
        message,
        ...(harnessSessionID === undefined ? {} : { harnessSessionID }),
    },
});

/** Classify an error the process port threw while running a turn. */
export const classifyThrown = (error: unknown): TurnOutcome => {
    if (error instanceof CommandTimeoutError) {
        return failure("timeout", error.message);
    }
    if (error instanceof CommandAbortedError) {
        return failure("aborted", error.message);
    }
    const message = error instanceof Error ? error.message : String(error);
    return failure(
        error instanceof RalphieError ? "unavailable" : "harness",
        message,
    );
};