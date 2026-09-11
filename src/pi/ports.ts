import type { AgentModel } from "../agent/model.ts";
import type { AgentClient } from "../agent/ports.ts";
import type { PiModelInfo } from "../agent/pi-models.ts";

/** Configuration for starting the in-process pi runtime. */
export type PiAgentConfig = {
    /** Model selected by --model; when absent the pi settings default applies. */
    readonly model?: AgentModel;
    /** Test seam: override the pi agent directory (default `~/.pi/agent`). */
    readonly agentDir?: string;
};

/** A started pi runtime handle; `close` releases SDK resources. */
export type PiAgentRuntime = {
    readonly client: AgentClient;
    readonly close: () => Promise<void>;
    /** Static provider catalog used for pre-execution thinking validation. */
    readonly catalog: ReadonlyArray<PiModelInfo>;
    readonly defaultModel?: AgentModel;
};

/** Outbound port for the in-process pi agent runtime. */
export type PiAgentService = {
    readonly start: () => Promise<PiAgentRuntime>;
};