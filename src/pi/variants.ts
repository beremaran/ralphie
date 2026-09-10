import type { AgentModel } from "../agent/model.ts";
import { RalphieError } from "../shared/error.ts";
import {
    modelReference,
    piModelLookup,
    thinkingLevelFor,
    type PiModelInfo,
} from "./models.ts";

export type StageVariantCheck = {
    readonly stage: string;
    readonly variant?: string;
    readonly model?: AgentModel;
    readonly flagOption: string;
};

export type VariantViolation = {
    readonly stage: string;
    readonly variant: string;
    readonly modelName: string;
    readonly availableVariants: ReadonlyArray<string>;
    readonly flagOption: string;
};

export type ValidateModelVariantsInput = {
    readonly models: ReadonlyArray<PiModelInfo>;
    readonly defaultModel?: AgentModel;
    readonly primaryModel?: AgentModel;
    readonly fallbackModel?: AgentModel;
    readonly defaultVariant?: string;
    readonly stageVariants?: {
        readonly grounding?: string;
        readonly complexity?: string;
        readonly implementation?: string;
        readonly review?: string;
        readonly commitMessage?: string;
    };
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

export const plannedVariantChecks = (
    input: ValidateModelVariantsInput,
): ReadonlyArray<StageVariantCheck> => {
    const primary = input.primaryModel;
    const stages = input.stageVariants;
    const fallback = input.defaultVariant;

    const checks: StageVariantCheck[] = [
        {
            stage: "grounding",
            variant: stages?.grounding ?? fallback,
            model: primary,
            flagOption: "--grounding-thinking",
        },
        {
            stage: "complexity",
            variant: stages?.complexity ?? fallback,
            model: primary,
            flagOption: "--complexity-thinking",
        },
        {
            stage: "implementation",
            variant: stages?.implementation ?? fallback,
            model: primary,
            flagOption: "--implementation-thinking",
        },
        {
            stage: "review",
            variant: stages?.review ?? fallback,
            model: primary,
            flagOption: "--review-thinking",
        },
        {
            stage: "commitMessage",
            variant: stages?.commitMessage ?? fallback,
            model: primary,
            flagOption: "--commit-thinking",
        },
    ];

    if (input.fallbackModel !== undefined) {
        checks.push({
            stage: "implementation (fallback model)",
            variant: stages?.implementation ?? fallback,
            model: input.fallbackModel,
            flagOption: "--implementation-thinking",
        });
    }

    return checks;
};

const normalizedLevel = (variant: string): string => {
    try {
        return thinkingLevelFor(variant);
    } catch {
        return variant;
    }
};

const modelInfoForCheck = (
    check: StageVariantCheck,
    input: ValidateModelVariantsInput,
): PiModelInfo | undefined => {
    if (check.model !== undefined) {
        return findModelInfo(input.models, check.model);
    }
    return input.defaultModel === undefined
        ? undefined
        : findModelInfo(input.models, input.defaultModel);
};

const violationForCheck = (
    check: StageVariantCheck,
    input: ValidateModelVariantsInput,
): VariantViolation | undefined => {
    if (
        check.variant === undefined ||
        check.variant === "" ||
        check.variant === "default"
    ) {
        return undefined;
    }
    const modelInfo = modelInfoForCheck(check, input);
    if (
        modelInfo === undefined ||
        isVariantAvailable(
            modelInfo.thinkingLevels,
            normalizedLevel(check.variant),
        )
    ) {
        return undefined;
    }
    return {
        stage: check.stage,
        variant: check.variant,
        modelName:
            modelReference(check.model) ??
            `${modelInfo.provider}/${modelInfo.id}`,
        availableVariants: modelInfo.thinkingLevels,
        flagOption: check.flagOption,
    };
};

export const collectVariantViolations = (
    input: ValidateModelVariantsInput,
): ReadonlyArray<VariantViolation> => {
    if (input.models.length === 0 && input.defaultModel === undefined) {
        return [];
    }
    return plannedVariantChecks(input).flatMap((check) => {
        const violation = violationForCheck(check, input);
        return violation === undefined ? [] : [violation];
    });
};

export const formatVariantViolations = (
    violations: ReadonlyArray<VariantViolation>,
): string => {
    const formatted = violations.map((v) => {
        const available =
            v.availableVariants.length === 0
                ? 'none (model does not support reasoning; use "default" or omit)'
                : `${v.availableVariants.join(", ")} (or "default")`;
        return (
            `  • Stage "${v.stage}": thinking level "${v.variant}" is not supported by model "${v.modelName}".\n` +
            `    Available levels: ${available}.\n` +
            `    Override with: ${v.flagOption} <level>`
        );
    });

    return (
        "Pi model thinking-level validation failed before execution:\n" +
        formatted.join("\n") +
        "\n\nAdjust the stage thinking options or pass --thinking default."
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