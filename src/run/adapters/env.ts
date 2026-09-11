import { randomUUID } from "node:crypto";

import type { Clock, IdGenerator } from "../ports.ts";

/** System wall clock for production runs. */
export const systemClock: Clock = {
    now: () => new Date(),
};

/** Cryptographically random run/artifact ids. */
export const makeIdGenerator = (): IdGenerator => ({
    next: () => randomUUID(),
});