import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { RunEventLog } from "../ports.ts";

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