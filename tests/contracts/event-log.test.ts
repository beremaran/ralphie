import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { makeRunEventLog } from "../../src/run/adapters/event-log.ts";
import type { RunEventLog } from "../../src/run/ports.ts";
import type { ProgressEvent } from "../../src/progress/ports.ts";
import { runEventLogContract } from "./event-log.contract.ts";

/** In-memory fake used by application tests; must satisfy the same contract. */
const makeMemoryEventLog = (): {
    readonly log: RunEventLog;
    readonly events: () => readonly ProgressEvent[];
} => {
    const events: ProgressEvent[] = [];
    let closed = false;
    return {
        log: {
            append: (next) => {
                if (!closed) events.push(next);
            },
            close: () => {
                closed = true;
            },
        },
        events: () => [...events],
    };
};

runEventLogContract({
    name: "in-memory",
    make: async () => {
        const memory = makeMemoryEventLog();
        return {
            log: memory.log,
            events: async () => memory.events(),
            cleanup: async () => {},
        };
    },
});

runEventLogContract({
    name: "node",
    make: async () => {
        const directory = await mkdtemp(join(tmpdir(), "ralphie-events-"));
        const path = join(directory, "runs", "events.jsonl");
        const log = makeRunEventLog({ path });
        return {
            log,
            events: async () => {
                let text: string;
                try {
                    text = await readFile(path, "utf8");
                } catch (cause) {
                    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
                        return [];
                    }
                    throw cause;
                }
                return text
                    .split("\n")
                    .filter((line) => line !== "")
                    .map((line) => JSON.parse(line) as ProgressEvent);
            },
            cleanup: async () => {
                await rm(directory, { recursive: true, force: true });
            },
        };
    },
});