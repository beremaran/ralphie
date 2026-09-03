import { z } from "zod";

export type AgentModel = {
    readonly providerID: string;
    readonly modelID: string;
};

export type AgentSelection = {
    readonly agent: string;
    readonly model?: AgentModel;
    readonly variant?: string;
};

export const DEFAULT_AGENT = "build";

export const agentModelSchema = z
    .string()
    .trim()
    .regex(/^[^/\s]+\/[^\s]+$/, "Model must use provider/model format.")
    .transform((value): AgentModel => {
        const separator = value.indexOf("/");
        return {
            providerID: value.slice(0, separator),
            modelID: value.slice(separator + 1),
        };
    });

export const agentModelVariantSchema = z.string().trim().min(1);
export const agentSchema = z.string().trim().min(1).default(DEFAULT_AGENT);

// Legacy Pi-era aliases (removed in the final cutover; kept for migration).
export type PiModel = AgentModel;
export type PiSelection = AgentSelection;
export const DEFAULT_PI_AGENT = DEFAULT_AGENT;
export const piModelSchema = agentModelSchema;
export const piModelVariantSchema = agentModelVariantSchema;
export const piAgentSchema = agentSchema;