import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { makeRunEventLog } from "../../src/run/event-log.ts";
import type { ProgressEvent } from "../../src/ports/progress.ts";

const event = (message: string): ProgressEvent => ({
    stage: "run",
    status: "info",
    message,
    runId: "run-1",
    timestamp: "2026-09-11T00:00:00.000Z",
});

describe("run event log", () => {
    test("appends one JSON line per event and creates parent directories", async () => {
        const directory = await mkdtemp(join(tmpdir(), "ralphie-events-"));
        const path = join(directory, "nested", "runs", "events.jsonl");
        try {
            const log = makeRunEventLog({ path });
            log.append(event("first"));
            log.append(event("second"));

            const lines = (await readFile(path, "utf8")).trim().split("\n");
            expect(lines.map((line) => JSON.parse(line))).toEqual([
                event("first"),
                event("second"),
            ]);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test("stops persisting after close", async () => {
        const directory = await mkdtemp(join(tmpdir(), "ralphie-events-"));
        const path = join(directory, "events.jsonl");
        try {
            const log = makeRunEventLog({ path });
            log.append(event("persisted"));
            log.close();
            log.append(event("dropped"));

            const lines = (await readFile(path, "utf8")).trim().split("\n");
            expect(lines).toHaveLength(1);
            expect(JSON.parse(lines[0] ?? "")).toEqual(event("persisted"));
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});