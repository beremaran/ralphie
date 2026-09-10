import { describe, expect, test } from "bun:test";

import type { PiModelInfo } from "../src/pi/models.ts";
import {
    collectVariantViolations,
    findModelInfo,
    formatVariantViolations,
    isVariantAvailable,
    plannedVariantChecks,
    validateModelVariants,
} from "../src/pi/variants.ts";

const deepseekFlash: PiModelInfo = {
    provider: "opencode-go",
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    reasoning: true,
    thinkingLevels: ["off", "low", "high", "max"],
};

const geminiFlash: PiModelInfo = {
    provider: "openrouter",
    id: "google/gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    reasoning: true,
    thinkingLevels: ["off", "low", "medium", "high"],
};

describe("thinking-level availability", () => {
    test("accepts unset and default variants without a catalog lookup", () => {
        expect(isVariantAvailable([], undefined)).toBe(true);
        expect(isVariantAvailable([], "")).toBe(true);
        expect(isVariantAvailable([], "default")).toBe(true);
    });

    test("matches only advertised thinking levels", () => {
        expect(isVariantAvailable(deepseekFlash.thinkingLevels, "low")).toBe(
            true,
        );
        expect(isVariantAvailable(deepseekFlash.thinkingLevels, "medium")).toBe(
            false,
        );
    });

    test("rejects every non-default level when the model supports none", () => {
        expect(isVariantAvailable([], "low")).toBe(false);
    });
});

describe("model lookup", () => {
    test("matches provider and model identifiers", () => {
        expect(
            findModelInfo([deepseekFlash, geminiFlash], {
                providerID: "opencode-go",
                modelID: "deepseek-v4-flash",
            }),
        ).toEqual(deepseekFlash);
    });

    test("returns undefined for unknown models", () => {
        expect(
            findModelInfo([deepseekFlash], {
                providerID: "opencode-go",
                modelID: "missing-model",
            }),
        ).toBeUndefined();
    });
});

describe("planned stage checks", () => {
    test("covers every stage and the implementation fallback model", () => {
        const checks = plannedVariantChecks({
            models: [deepseekFlash],
            primaryModel: {
                providerID: "opencode-go",
                modelID: "deepseek-v4-flash",
            },
            fallbackModel: {
                providerID: "openrouter",
                modelID: "google/gemini-3.8-flash",
            },
            defaultVariant: "low",
            stageVariants: {
                complexity: "medium",
            },
        });

        expect(checks.map((check) => check.stage)).toEqual([
            "grounding",
            "complexity",
            "implementation",
            "review",
            "commitMessage",
            "implementation (fallback model)",
        ]);
        expect(
            checks.find((check) => check.stage === "complexity")?.variant,
        ).toBe("medium");
        expect(
            checks.find((check) => check.stage === "grounding")?.variant,
        ).toBe("low");
    });
});

describe("thinking-level violations", () => {
    test("flags the exact stage, model, and flag for an unsupported level", () => {
        const violations = collectVariantViolations({
            models: [deepseekFlash],
            primaryModel: {
                providerID: "opencode-go",
                modelID: "deepseek-v4-flash",
            },
            stageVariants: {
                grounding: "low",
                complexity: "medium",
                implementation: "high",
                review: "max",
                commitMessage: "low",
            },
        });

        expect(violations).toHaveLength(1);
        expect(violations[0]).toMatchObject({
            stage: "complexity",
            variant: "medium",
            modelName: "opencode-go/deepseek-v4-flash",
            flagOption: "--complexity-thinking",
        });
        expect(violations[0]?.availableVariants).toEqual([
            "off",
            "low",
            "high",
            "max",
        ]);
    });

    test("skips validation when no catalog is available", () => {
        expect(
            collectVariantViolations({
                models: [],
                primaryModel: {
                    providerID: "opencode-go",
                    modelID: "deepseek-v4-flash",
                },
                stageVariants: { complexity: "medium" },
            }),
        ).toEqual([]);
    });

    test("skips unknown models instead of failing the run", () => {
        expect(
            collectVariantViolations({
                models: [deepseekFlash],
                primaryModel: {
                    providerID: "opencode-go",
                    modelID: "unknown-model",
                },
                stageVariants: { complexity: "medium" },
            }),
        ).toEqual([]);
    });

    test("flags an unknown thinking level for a known model", () => {
        const violations = collectVariantViolations({
            models: [deepseekFlash],
            primaryModel: {
                providerID: "opencode-go",
                modelID: "deepseek-v4-flash",
            },
            stageVariants: { complexity: "banana" },
        });

        expect(violations).toHaveLength(1);
        expect(violations[0]?.variant).toBe("banana");
    });

    test("validates the fallback model with the implementation level", () => {
        const violations = collectVariantViolations({
            models: [deepseekFlash, geminiFlash],
            primaryModel: {
                providerID: "opencode-go",
                modelID: "deepseek-v4-flash",
            },
            fallbackModel: {
                providerID: "opencode-go",
                modelID: "deepseek-v4-flash",
            },
            stageVariants: {
                implementation: "medium",
            },
        });

        expect(violations.map((violation) => violation.stage)).toContain(
            "implementation (fallback model)",
        );
    });

    test("formats actionable guidance with available levels", () => {
        const message = formatVariantViolations([
            {
                stage: "complexity",
                variant: "medium",
                modelName: "opencode-go/deepseek-v4-flash",
                availableVariants: ["off", "low", "high", "max"],
                flagOption: "--complexity-thinking",
            },
        ]);

        expect(message).toMatch(/complexity/);
        expect(message).toMatch(/opencode-go\/deepseek-v4-flash/);
        expect(message).toMatch(/off, low, high, max/);
        expect(message).toMatch(/--complexity-thinking/);
    });

    test("explains models without reasoning support", () => {
        const message = formatVariantViolations([
            {
                stage: "implementation",
                variant: "low",
                modelName: "opencode-go/kimi-k2.7-code",
                availableVariants: [],
                flagOption: "--implementation-thinking",
            },
        ]);

        expect(message).toMatch(/does not support reasoning/);
    });

    test("validateModelVariants throws with remediation", () => {
        expect(() =>
            validateModelVariants({
                models: [deepseekFlash],
                primaryModel: {
                    providerID: "opencode-go",
                    modelID: "deepseek-v4-flash",
                },
                stageVariants: { complexity: "medium" },
            }),
        ).toThrow(/--complexity-thinking/);
    });

    test("validateModelVariants passes for supported levels", () => {
        expect(() =>
            validateModelVariants({
                models: [deepseekFlash],
                primaryModel: {
                    providerID: "opencode-go",
                    modelID: "deepseek-v4-flash",
                },
                stageVariants: {
                    grounding: "low",
                    complexity: "max",
                    implementation: "high",
                    review: "high",
                    commitMessage: "low",
                },
            }),
        ).not.toThrow();
    });
});