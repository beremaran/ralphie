import { expect, test } from "bun:test";
import type { PiClient } from "../pi/client.ts";
import { Effect } from "effect";

import { registerPiAgentSemaphore, withPiAgentPermit } from "./concurrency.ts";

test("global Pi semaphore bounds tasks sharing one client", async () => {
  const client = {} as PiClient;
  const semaphore = await Effect.runPromise(Effect.makeSemaphore(2));
  registerPiAgentSemaphore(client, semaphore);
  let active = 0;
  let maximumActive = 0;

  await Effect.runPromise(
    Effect.all(
      Array.from({ length: 6 }, () =>
        withPiAgentPermit(
          client,
          Effect.acquireUseRelease(
            Effect.sync(() => {
              active += 1;
              maximumActive = Math.max(maximumActive, active);
            }),
            () => Effect.sleep("5 millis"),
            () => Effect.sync(() => (active -= 1)),
          ),
        ),
      ),
      { concurrency: "unbounded", discard: true },
    ),
  );

  expect(maximumActive).toBe(2);
});
