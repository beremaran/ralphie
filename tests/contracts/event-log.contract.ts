import { describe, expect, test } from "bun:test";

import type { RunEventLog } from "../../src/run/ports.ts";
import type { ProgressEvent } from "../../src/progress/ports.ts";

export type EventLogHarness = {
    readonly name: string;
    readonly make: () => Promise<{
        readonly log: RunEventLog;
        readonly events: () => Promise<readonly ProgressEvent[]>;
        readonly cleanup: () => Promise<void>;
    }>;
};

const event = (message: string): ProgressEvent => ({
    stage: "run",
    status: "info",
    message,
    runId: "contract-run",
    timestamp: "2026-09-11T00:00:00.000Z",
});

/**
 * Shared behavioral contract for every `RunEventLog` adapter.
 *
 * Fakes used in application tests must pass this same suite as the live
 * adapter so their behavior cannot drift.
 */
export const runEventLogContract = (harness: EventLogHarness): void => {
    describe(`${harness.name} run event log contract`, () => {
        test("appends one event per append in order", async () => {
            const { log, events, cleanup } = await harness.make();
            try {
                log.append(event("first"));
                log.append(event("second"));
                expect(await events()).toEqual([
                    event("first"),
                    event("second"),
                ]);
            } finally {
                await cleanup();
            }
        });

        test("stops persisting after close", async () => {
            const { log, events, cleanup } = await harness.make();
            try {
                log.append(event("persisted"));
                log.close();
                log.append(event("dropped"));
                expect(await events()).toEqual([event("persisted")]);
            } finally {
                await cleanup();
            }
        });
    });
};