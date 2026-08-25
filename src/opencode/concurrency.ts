import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { Effect } from "effect";

const semaphores = new WeakMap<OpencodeClient, Effect.Semaphore>();

/** Attach the batch-wide semaphore used by all agent tasks sharing this client. */
export const registerOpenCodeAgentSemaphore = (
  client: OpencodeClient,
  semaphore: Effect.Semaphore,
): void => {
  semaphores.set(client, semaphore);
};

/** Hold one global agent permit for the complete session-and-prompt operation. */
export const withOpenCodeAgentPermit = <A, E, R>(
  client: OpencodeClient,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  const semaphore = semaphores.get(client);
  return semaphore === undefined ? effect : semaphore.withPermits(1)(effect);
};
