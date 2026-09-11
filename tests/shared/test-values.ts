import type { IdGenerator, RunLayout } from "../../src/run/ports.ts";
import type { Clock } from "../../src/run/ports.ts";
import { makeRunLayout } from "../../src/run/adapters/layout.ts";

/** Fixed wall clock so persisted timestamps are deterministic. */
export const fixedClock = (iso = "2026-09-11T00:00:00.000Z"): Clock => ({
    now: () => new Date(iso),
});

/** Monotonic id generator so temporary names are deterministic. */
export const countingIds = (prefix = "id"): IdGenerator => {
    let next = 0;
    return {
        next: () => {
            next += 1;
            return `${prefix}-${next}`;
        },
    };
};

/** Run layout rooted in a test workspace. */
export const testLayout = (
    workspace = "/tmp/ralphie",
    runId = "test-run",
): RunLayout => makeRunLayout(workspace, runId);