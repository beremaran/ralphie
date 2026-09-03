import { RalphieError } from "../shared/error.ts";
import type { AgentModel } from "./client.ts";
import type { OpenCodeModelInfo } from "./client.ts";

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
    readonly models: ReadonlyArray<OpenCodeModelInfo>;
    readonly defaultModel?: OpenCodeModelInfo;
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

export const modelReference = (model?: AgentModel): string | undefined => {
    if (model === undefined) return undefined;
    return `${model.providerID}/${model.modelID}`;
};

export const findModelInfo = (
    models: ReadonlyArray<OpenCodeModelInfo>,
    model: AgentModel,
): OpenCodeModelInfo | undefined => {
    const qualified = `${model.providerID}/${model.modelID}`;
    return models.find(
        (m) =>
            (m.providerID === model.providerID &&
                m.modelID === model.modelID) ||
            m.id === qualified ||
            m.modelID === qualified,
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

const resolveTargetModelInfo = (
    check: StageVariantCheck,
    models: ReadonlyArray<OpenCodeModelInfo>,
    defaultModel?: OpenCodeModelInfo,
): OpenCodeModelInfo | undefined => {
    if (check.model !== undefined) {
        return findModelInfo(models, check.model);
    }
    return defaultModel;
};

export const collectVariantViolations = (
    input: ValidateModelVariantsInput,
): ReadonlyArray<VariantViolation> => {
    if (input.models.length === 0 && input.defaultModel === undefined) {
        return [];
    }

    const checks = plannedVariantChecks(input);
    const violations: VariantViolation[] = [];

    for (const check of checks) {
        if (
            check.variant === undefined ||
            check.variant === "" ||
            check.variant === "default"
        ) {
            continue;
        }

        const modelInfo = resolveTargetModelInfo(
            check,
            input.models,
            input.defaultModel,
        );
        if (modelInfo === undefined) {
            continue;
        }

        if (!isVariantAvailable(modelInfo.variants, check.variant)) {
            const modelName =
                modelReference(check.model) ??
                modelInfo.id ??
                `${modelInfo.providerID}/${modelInfo.modelID}`;
            violations.push({
                stage: check.stage,
                variant: check.variant,
                modelName,
                availableVariants: modelInfo.variants,
                flagOption: check.flagOption,
            });
        }
    }

    return violations;
};

export const formatVariantViolations = (
    violations: ReadonlyArray<VariantViolation>,
): string => {
    const formatted = violations.map((v) => {
        const available =
            v.availableVariants.length === 0
                ? 'none (model does not support reasoning variants; use "default" or omit)'
                : `${v.availableVariants.join(", ")} (or "default")`;
        return (
            `  • Stage "${v.stage}": variant "${v.variant}" is not supported by model "${v.modelName}".\n` +
            `    Available variants: ${available}.\n` +
            `    Override with: ${v.flagOption} <variant>`
        );
    });

    return (
        "OpenCode model variant validation failed before execution:\n" +
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