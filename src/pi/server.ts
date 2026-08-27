import { ModelRuntime as ModelRuntimeClass } from "@earendil-works/pi-coding-agent";

import { RalphieError } from "../shared/error.ts";
import {
    cleanupPiAgentDir,
    resolvePiAgentDir,
    type PiProviderConfig,
} from "./config.ts";
import { makePiClient, type PiClient, type PiEventListener } from "./client.ts";

export type PiRuntime = {
    readonly url: string;
    readonly client: PiClient;
    readonly close: () => void;
};

export type PiService = {
    readonly start: () => Promise<PiRuntime>;
};

/** Build the Pi service for a resolved run configuration. */
export const makePiService = (
    config: PiProviderConfig,
    eventListener?: PiEventListener,
): PiService => {
    let resolvedPromise:
        | Promise<Awaited<ReturnType<typeof resolvePiAgentDir>>>
        | undefined;
    const resolveConfig = () => {
        resolvedPromise ??= resolvePiAgentDir(config).catch((cause) => {
            throw new RalphieError({
                message: "Failed to configure the Pi runtime.",
                cause,
            });
        });
        return resolvedPromise;
    };

    return {
        start: async () => {
            const resolved = await resolveConfig();
            try {
                const modelRuntime = await ModelRuntimeClass.create({
                    authPath: resolved.authPath,
                    modelsPath: resolved.modelsPath,
                });
                const client = makePiClient(modelRuntime, eventListener);
                return {
                    url: "embedded://pi",
                    client,
                    close: () => {
                        client.close?.();
                        if (resolved.cleanup)
                            void cleanupPiAgentDir(resolved.dir);
                    },
                };
            } catch (cause) {
                throw new RalphieError({
                    message: "Failed to start the Pi runtime.",
                    cause,
                });
            }
        },
    };
};

export const PiLive = makePiService;