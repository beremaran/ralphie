import type { AgentModel } from "../../domain/agent-model.ts";
import { RalphieError } from "../../../shared/error.ts";
import {
    modelReference,
    piModelLookup,
    thinkingLevelFor,
    type PiModelInfo,
} from "../../domain/pi-models.ts";

export type VariantViolation = {
    readonly variant: string;
    readonly modelName: string;
    readonly availableVariants: ReadonlyArray<string>;
};

export type ValidateModelVariantsInput = {
    readonly models: ReadonlyArray<PiModelInfo>;
    readonly defaultModel?: AgentModel;
    readonly primaryModel?: AgentModel;
    /** The single --thinking level applied to every session. */
    readonly variant?: string;
};

export const findModelInfo = (
    models: ReadonlyArray<PiModelInfo>,
    selection: AgentModel,
): PiModelInfo | undefined => {
    const lookup = piModelLookup(selection);
    if (lookup === undefined) return undefined;
    return models.find(
        (model) => model.provider === lookup.provider && model.id === lookup.id,
    );
};

export const isVariantAvailable = (
    availableVariants: ReadonlyArray<string>,
    variant?: string,
): boolean => {
    if (variant === undefined || variant === "" || variant === "default") {
        return true;
    }
    return availableVariants.includes(variant);
};

const normalizedLevel = (variant: string): string => {
    try {
        return thinkingLevelFor(variant);
    } catch {
        return variant;
    }
};

const violationForModel = (
    variant: string,
    selection: AgentModel,
    models: ReadonlyArray<PiModelInfo>,
): VariantViolation | undefined => {
    if (variant === "" || variant === "default") return undefined;
    const modelInfo = findModelInfo(models, selection);
    if (
        modelInfo === undefined ||
        isVariantAvailable(modelInfo.thinkingLevels, normalizedLevel(variant))
    ) {
        return undefined;
    }
    return {
        variant,
        modelName:
            modelReference(selection) ??
            `${modelInfo.provider}/${modelInfo.id}`,
        availableVariants: modelInfo.thinkingLevels,
    };
};

export const collectVariantViolations = (
    input: ValidateModelVariantsInput,
): ReadonlyArray<VariantViolation> => {
    if (input.models.length === 0 && input.defaultModel === undefined) {
        return [];
    }
    const variant = input.variant;
    if (variant === undefined || variant === "") return [];
    const selection = input.primaryModel ?? input.defaultModel;
    if (selection === undefined) return [];
    const violation = violationForModel(variant, selection, input.models);
    return violation === undefined ? [] : [violation];
};

export const formatVariantViolations = (
    violations: ReadonlyArray<VariantViolation>,
): string => {
    const formatted = violations.map((v) => {
        const available =
            v.availableVariants.length === 0
                ? 'none (model does not support reasoning; omit --thinking or use "default")'
                : `${v.availableVariants.join(", ")} (or "default")`;
        return (
            `  • Model "${v.modelName}" does not support thinking level "${v.variant}".\n` +
            `    Available levels: ${available}.\n` +
            `    Override with: --thinking <level>`
        );
    });

    return (
        "Pi model thinking-level validation failed before execution:\n" +
        formatted.join("\n") +
        "\n\nAdjust --thinking or omit it to use the pi default."
    );
};

export const validateModelVariants = (
    input: ValidateModelVariantsInput,
): void => {
    const violations = collectVariantViolations(input);
    if (violations.length > 0) {
        throw new RalphieError({
            message: formatVariantViolations(violations),
        });
    }
};