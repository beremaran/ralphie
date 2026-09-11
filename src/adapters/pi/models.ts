import { readFile } from "node:fs/promises";

import {
    getSupportedThinkingLevels,
    type CreateModelsOptions,
    type MutableModels,
    type Model,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

import type { AgentModel } from "../../core/domain/agent-model.ts";
import { RalphieError } from "../../shared/error.ts";
import { piSettingsPathFor } from "./config.ts";

export const THINKING_LEVELS = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
] as const;

export type PiThinkingLevel = (typeof THINKING_LEVELS)[number];

export const DEFAULT_THINKING_LEVEL: PiThinkingLevel = "medium";

export type PiModelSelection =
    | AgentModel
    | { readonly providerID: string; readonly id: string };

export type PiModelInfo = {
    readonly provider: string;
    readonly id: string;
    readonly name: string;
    readonly reasoning: boolean;
    readonly thinkingLevels: ReadonlyArray<string>;
};

export type PiModelLookup = {
    readonly provider: string;
    readonly id: string;
};

export const piModelLookup = (
    selection: PiModelSelection | undefined,
): PiModelLookup | undefined => {
    if (selection === undefined) return undefined;
    return "modelID" in selection
        ? { provider: selection.providerID, id: selection.modelID }
        : { provider: selection.providerID, id: selection.id };
};

export const modelReference = (
    selection: PiModelSelection | undefined,
): string | undefined => {
    const lookup = piModelLookup(selection);
    return lookup === undefined ? undefined : `${lookup.provider}/${lookup.id}`;
};

const isNotFound = (cause: unknown): boolean =>
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { readonly code?: unknown }).code === "ENOENT";

/** Build the pi provider catalog backed by the operator's stored credentials. */
export const makePiModels = (
    options: CreateModelsOptions = {},
): MutableModels => builtinModels(options);

export const piModelCatalog = (
    models: MutableModels,
): ReadonlyArray<PiModelInfo> =>
    models.getModels().map((model) => ({
        provider: model.provider,
        id: model.id,
        name: model.name,
        reasoning: model.reasoning,
        thinkingLevels: getSupportedThinkingLevels(model).map(String),
    }));

export const thinkingLevelFor = (variant?: string): PiThinkingLevel => {
    const normalized = variant?.trim();
    if (
        normalized === undefined ||
        normalized === "" ||
        normalized === "default"
    ) {
        return DEFAULT_THINKING_LEVEL;
    }
    if ((THINKING_LEVELS as ReadonlyArray<string>).includes(normalized)) {
        return normalized as PiThinkingLevel;
    }
    throw new RalphieError({
        message: `Unsupported thinking level "${variant}". Supported levels: ${THINKING_LEVELS.join(", ")}, or default.`,
    });
};

export const readPiDefaultModel = async (
    agentDir: string,
): Promise<AgentModel | undefined> => {
    const settingsPath = piSettingsPathFor(agentDir);
    let text: string;
    try {
        text = await readFile(settingsPath, "utf-8");
    } catch (cause) {
        if (isNotFound(cause)) return undefined;
        throw new RalphieError({
            message: `Failed to read pi settings at ${settingsPath}.`,
            cause,
        });
    }
    let settings: unknown;
    try {
        settings = JSON.parse(text.replace(/^\uFEFF/, "")) as unknown;
    } catch (cause) {
        throw new RalphieError({
            message: `Pi settings at ${settingsPath} are not valid JSON.`,
            cause,
        });
    }
    if (settings === null || typeof settings !== "object") return undefined;
    const provider = (settings as { readonly defaultProvider?: unknown })
        .defaultProvider;
    const modelId = (settings as { readonly defaultModel?: unknown })
        .defaultModel;
    if (
        typeof provider !== "string" ||
        provider === "" ||
        typeof modelId !== "string" ||
        modelId === ""
    ) {
        return undefined;
    }
    return { providerID: provider, modelID: modelId };
};

const findModel = (
    models: MutableModels,
    lookup: PiModelLookup,
): Model<never> | undefined =>
    models.getModel(lookup.provider, lookup.id) as Model<never> | undefined;

/**
 * Resolve one concrete pi model from an explicit selection, a configured
 * default, or the operator's pi settings.
 */
export const resolvePiModel = async (input: {
    readonly models: MutableModels;
    readonly selection?: PiModelSelection;
    readonly defaultModel?: AgentModel;
    readonly agentDir: string;
}): Promise<Model<never>> => {
    const explicit = piModelLookup(input.selection);
    const fallback = piModelLookup(input.defaultModel);
    const configured = explicit ?? fallback;
    if (configured !== undefined) {
        const model = findModel(input.models, configured);
        if (model !== undefined) return model;
        throw new RalphieError({
            message: `Model "${configured.provider}/${configured.id}" was not found in the pi catalog. Pass --model provider/model or run \`pi --list-models\` to see available models.`,
        });
    }

    const settingsModel = await readPiDefaultModel(input.agentDir);
    const lookup = piModelLookup(settingsModel);
    if (lookup === undefined) {
        throw new RalphieError({
            message: `No model selected and no default model is configured in ${piSettingsPathFor(input.agentDir)}. Pass --model provider/model or set a default in pi with /model.`,
        });
    }
    const model = findModel(input.models, lookup);
    if (model === undefined) {
        throw new RalphieError({
            message: `The default pi model "${lookup.provider}/${lookup.id}" was not found in the pi catalog. Pass --model provider/model or select a different default in pi.`,
        });
    }
    return model;
};