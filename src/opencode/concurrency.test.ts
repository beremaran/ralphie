import { expect, test } from "bun:test";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { Effect } from "effect";

import {
  registerOpenCodeAgentSemaphore,
  withOpenCodeAgentPermit,
} from "./concurrency.ts";

test("global OpenCode semaphore bounds tasks sharing one client", async () => {
  const client = {} as OpencodeClient;
  const semaphore = await Effect.runPromise(Effect.makeSemaphore(2));
  registerOpenCodeAgentSemaphore(client, semaphore);
  let active = 0;
  let maximumActive = 0;

  await Effect.runPromise(
    Effect.all(
      Array.from({ length: 6 }, () =>
        withOpenCodeAgentPermit(
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
