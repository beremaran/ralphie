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
    readonly close: () => Promise<void>;
};

export type PiService = {
    readonly start: () => Promise<PiRuntime>;
};

type ModelRuntimeFactory = (
    options?: Parameters<typeof ModelRuntimeClass.create>[0],
) => ReturnType<typeof ModelRuntimeClass.create>;

const createModelRuntime: ModelRuntimeFactory = (options) =>
    ModelRuntimeClass.create(options);

/** Build the Pi service for a resolved run configuration. */
export const makePiService = (
    config: PiProviderConfig,
    eventListener?: PiEventListener,
    createRuntime: ModelRuntimeFactory = createModelRuntime,
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
                const modelRuntime = await createRuntime({
                    authPath: resolved.authPath,
                    modelsPath: resolved.modelsPath,
                });
                const client = makePiClient(
                    modelRuntime,
                    eventListener,
                    resolved.mode === "default" ? undefined : resolved.dir,
                );
                let closed = false;
                return {
                    url: "embedded://pi",
                    client,
                    close: async () => {
                        if (closed) return;
                        closed = true;
                        try {
                            client.close?.();
                        } finally {
                            if (resolved.cleanup) {
                                await cleanupPiAgentDir(resolved.dir);
                            }
                        }
                    },
                };
            } catch (cause) {
                if (resolved.cleanup) {
                    await cleanupPiAgentDir(resolved.dir).catch(
                        () => undefined,
                    );
                }
                throw new RalphieError({
                    message: "Failed to start the Pi runtime.",
                    cause,
                });
            }
        },
    };
};

export const PiLive = makePiService;