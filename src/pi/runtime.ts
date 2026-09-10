import type { AgentModel } from "../agent/model.ts";
import type { AgentClient, AgentEventListener } from "../agent/contracts.ts";
import { FileCredentialStore } from "./auth.ts";
import { makePiAgentClient } from "./client.ts";
import {
    piAuthPathFor,
    resolvePiAgentDir,
    type PiAgentConfig,
} from "./config.ts";
import {
    makePiModels,
    piModelCatalog,
    readPiDefaultModel,
    type PiModelInfo,
} from "./models.ts";

export type PiAgentRuntime = {
    readonly client: AgentClient;
    readonly close: () => Promise<void>;
    /** Static provider catalog used for pre-execution thinking validation. */
    readonly catalog: ReadonlyArray<PiModelInfo>;
    readonly defaultModel?: AgentModel;
};

export type PiAgentService = {
    readonly start: () => Promise<PiAgentRuntime>;
};

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