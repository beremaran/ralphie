import type { AgentModel } from "./model.ts";
import { RalphieError } from "../shared/error.ts";

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