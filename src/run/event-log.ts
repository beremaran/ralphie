import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { ProgressEvent } from "../ports/progress.ts";

/**
 * Append-only audit of run progress events (`events.jsonl`).
 *
 * The run that owns the workspace also owns this sink: it closes the log
 * before deleting the workspace so post-cleanup events cannot recreate it.
 * Presentation code only forwards already-stamped events.
 */
export type RunEventLog = {
    /** Append one event; a no-op after {@link RunEventLog.close}. */
    readonly append: (event: ProgressEvent) => void;
    /** Stop persisting; later appends are ignored. */
    readonly close: () => void;
};

export const makeRunEventLog = (input: {
    /** Destination of the JSON Lines audit file. */
    readonly path: string;
}): RunEventLog => {
    let closed = false;
    return {
        append: (event) => {
            if (closed) return;
            mkdirSync(dirname(input.path), { recursive: true });
            appendFileSync(input.path, `${JSON.stringify(event)}\n`, "utf8");
        },
        close: () => {
            closed = true;
        },
    };
};