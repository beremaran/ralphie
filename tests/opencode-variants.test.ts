import { describe, expect, test } from "bun:test";

import type { OpenCodeModelInfo } from "../src/opencode/client.ts";
import {
    collectVariantViolations,
    findModelInfo,
    formatVariantViolations,
    isVariantAvailable,
    plannedVariantChecks,
    validateModelVariants,
} from "../src/opencode/variants.ts";

const deepseekFlash: OpenCodeModelInfo = {
    providerID: "opencode-go",
    modelID: "deepseek-v4-flash",
    variants: ["low", "high", "max"],
};

const geminiFlash: OpenCodeModelInfo = {
    providerID: "openrouter",
    modelID: "google/gemini-3.8-flash",
    variants: ["low", "medium", "high"],
};

describe("variant availability", () => {
    test("accepts unset and default variants without a catalog lookup", () => {
        expect(isVariantAvailable([], undefined)).toBe(true);
        expect(isVariantAvailable([], "")).toBe(true);
        expect(isVariantAvailable([], "default")).toBe(true);
    });

    test("matches only advertised variants", () => {
        expect(isVariantAvailable(deepseekFlash.variants, "low")).toBe(true);
        expect(isVariantAvailable(deepseekFlash.variants, "medium")).toBe(
            false,
        );
    });

    test("rejects every non-default variant when the model advertises none", () => {
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

describe("variant violations", () => {
    test("flags the exact stage, model, and flag for an unsupported variant", () => {
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

    test("validates the fallback model with the implementation variant", () => {
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

    test("formats actionable guidance with available variants", () => {
        const message = formatVariantViolations([
            {
                stage: "complexity",
                variant: "medium",
                modelName: "opencode-go/deepseek-v4-flash",
                availableVariants: ["low", "high", "max"],
                flagOption: "--complexity-thinking",
            },
        ]);

        expect(message).toMatch(/complexity/);
        expect(message).toMatch(/opencode-go\/deepseek-v4-flash/);
        expect(message).toMatch(/low, high, max/);
        expect(message).toMatch(/--complexity-thinking/);
    });

    test("explains models without any advertised variants", () => {
        const message = formatVariantViolations([
            {
                stage: "implementation",
                variant: "low",
                modelName: "opencode-go/kimi-k2.7-code",
                availableVariants: [],
                flagOption: "--implementation-thinking",
            },
        ]);

        expect(message).toMatch(/does not support reasoning variants/);
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

    test("validateModelVariants passes for supported variants", () => {
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