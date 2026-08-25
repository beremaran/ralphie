import type { PiClient } from "../pi/client.ts";
import { Effect } from "effect";

const semaphores = new WeakMap<PiClient, Effect.Semaphore>();

/** Attach the batch-wide semaphore used by all agent tasks sharing this client. */
export const registerPiAgentSemaphore = (
  client: PiClient,
  semaphore: Effect.Semaphore,
): void => {
  semaphores.set(client, semaphore);
};

/** Hold one global agent permit for the complete session-and-prompt operation. */
export const withPiAgentPermit = <A, E, R>(
  client: PiClient,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  const semaphore = semaphores.get(client);
  return semaphore === undefined ? effect : semaphore.withPermits(1)(effect);
};
