import { z } from "zod";

export type CodexModel = {
    /** Retained only to deserialize pre-migration test fixtures; ignored. */
    readonly providerID?: string;
    readonly modelID: string;
};

export type CodexSelection = {
    /** Deprecated internal field; Codex CLI has no agent selection. */
    readonly agent?: string;
    readonly model?: CodexModel;
    readonly variant?: string;
};

export const codexModelSchema = z
    .string()
    .trim()
    .min(1, "Model must be a non-empty Codex model ID.")
    .transform((value): CodexModel => {
        return {
            modelID: value,
        };
    });

export const codexModelVariantSchema = z.enum([
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
]);
/** @deprecated Codex CLI has no internal Ralphie agent setting. */
export const DEFAULT_CODEX_AGENT = "codex";
/** @deprecated Codex CLI has no internal Ralphie agent setting. */
export const codexAgentSchema = z
    .string()
    .trim()
    .min(1)
    .default(DEFAULT_CODEX_AGENT);