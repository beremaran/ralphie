import type { AgentEventListener } from "../../agent/ports.ts";
import type { PiAgentService } from "../ports.ts";
import { FileCredentialStore } from "./auth.ts";
import { makePiAgentClient } from "./client.ts";
import type { PiAgentConfig } from "../ports.ts";
import { piAuthPathFor, resolvePiAgentDir } from "./config.ts";
import { makePiModels, piModelCatalog, readPiDefaultModel } from "./models.ts";

/**
 * In-process pi agent runtime.
 *
 * There is no server to discover or start: the pi provider catalog is static
 * and credentials resolve through pi's `auth.json` plus provider environment
 * variables when no stored credential exists.
 */
export const makePiAgentService = (
    config: PiAgentConfig = {},
    eventListener?: AgentEventListener,
): PiAgentService => ({
    start: async () => {
        const agentDir = config.agentDir ?? resolvePiAgentDir();
        const credentials = new FileCredentialStore({
            path: piAuthPathFor(agentDir),
        });
        const models = makePiModels({ credentials });
        const defaultModel =
            config.model ?? (await readPiDefaultModel(agentDir));
        const client = makePiAgentClient({
            models,
            agentDir,
            ...(defaultModel === undefined ? {} : { defaultModel }),
            ...(config.liveSelection === undefined
                ? {}
                : { liveSelection: config.liveSelection }),
            ...(eventListener === undefined ? {} : { eventListener }),
        });
        let closed = false;
        return {
            client,
            catalog: piModelCatalog(models),
            ...(defaultModel === undefined ? {} : { defaultModel }),
            close: async () => {
                if (closed) return;
                closed = true;
                await client.close?.();
            },
        };
    },
});