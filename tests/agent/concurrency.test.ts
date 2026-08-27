import { expect, test } from "bun:test";
import type { PiClient } from "../../src/pi/client.ts";

import {
    makePiAgentSemaphore,
    registerPiAgentSemaphore,
    withPiAgentPermit,
} from "../../src/agent/concurrency.ts";

test("global Pi semaphore bounds tasks sharing one client", async () => {
    const client = {} as PiClient;
    registerPiAgentSemaphore(client, makePiAgentSemaphore(2));
    let active = 0;
    let maximumActive = 0;

    await Promise.all(
        Array.from({ length: 6 }, () =>
            withPiAgentPermit(client, async () => {
                active += 1;
                maximumActive = Math.max(maximumActive, active);
                await Bun.sleep(5);
                active -= 1;
            }),
        ),
    );

    expect(maximumActive).toBe(2);
});