import { z } from "zod";

export type PiModel = {
    readonly providerID: string;
    readonly modelID: string;
};

export type PiSelection = {
    readonly agent: string;
    readonly model?: PiModel;
    readonly variant?: string;
};

export const DEFAULT_PI_AGENT = "build";

export const piModelSchema = z
    .string()
    .trim()
    .regex(/^[^/\s]+\/[^\s]+$/, "Model must use Pi's provider/model format.")
    .transform((value): PiModel => {
        const separator = value.indexOf("/");
        return {
            providerID: value.slice(0, separator),
            modelID: value.slice(separator + 1),
        };
    });

export const piModelVariantSchema = z.enum([
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
]);
export const piAgentSchema = z.string().trim().min(1).default(DEFAULT_PI_AGENT);