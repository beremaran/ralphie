import type { PiClient } from "../pi/client.ts";

/** A tiny FIFO semaphore for the run-wide agent concurrency limit. */
export type PiAgentSemaphore = {
    readonly withPermit: <A>(operation: () => Promise<A>) => Promise<A>;
};

const makeSemaphore = (limit: number): PiAgentSemaphore => {
    let active = 0;
    const waiters: Array<() => void> = [];

    const acquire = async (): Promise<void> => {
        if (active < limit) {
            active += 1;
            return;
        }
        await new Promise<void>((resolve) => waiters.push(resolve));
        active += 1;
    };

    const release = () => {
        active -= 1;
        waiters.shift()?.();
    };

    return {
        withPermit: async <A>(operation: () => Promise<A>): Promise<A> => {
            await acquire();
            try {
                return await operation();
            } finally {
                release();
            }
        },
    };
};

export const makePiAgentSemaphore = (limit: number): PiAgentSemaphore => {
    if (!Number.isInteger(limit) || limit < 1) {
        throw new Error("Semaphore limit must be a positive integer.");
    }
    return makeSemaphore(limit);
};

const semaphores = new WeakMap<PiClient, PiAgentSemaphore>();

/** Attach the run-wide semaphore used by all agent tasks sharing this client. */
export const registerPiAgentSemaphore = (
    client: PiClient,
    semaphore: PiAgentSemaphore,
): void => {
    semaphores.set(client, semaphore);
};

/** Hold one run-wide agent permit for the complete session-and-prompt operation. */
export const withPiAgentPermit = <A>(
    client: PiClient,
    operation: () => Promise<A>,
): Promise<A> => {
    const semaphore = semaphores.get(client);
    return semaphore === undefined
        ? operation()
        : semaphore.withPermit(operation);
};