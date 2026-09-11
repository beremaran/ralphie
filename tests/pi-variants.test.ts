import { describe, expect, test } from "bun:test";

import { type PiModelInfo } from "../src/agent/pi-models.ts";
import {
    collectVariantViolations,
    findModelInfo,
    formatVariantViolations,
    isVariantAvailable,
    validateModelVariants,
} from "../src/agent/variants.ts";

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

describe("thinking-level violations", () => {
    test("skips validation when no level or catalog is available", () => {
        expect(
            collectVariantViolations({
                models: [],
                primaryModel: {
                    providerID: "opencode-go",
                    modelID: "deepseek-v4-flash",
                },
                variant: "medium",
            }),
        ).toEqual([]);
        expect(
            collectVariantViolations({
                models: [deepseekFlash],
                primaryModel: {
                    providerID: "opencode-go",
                    modelID: "deepseek-v4-flash",
                },
            }),
        ).toEqual([]);
        expect(
            collectVariantViolations({
                models: [deepseekFlash],
                primaryModel: {
                    providerID: "opencode-go",
                    modelID: "deepseek-v4-flash",
                },
                variant: "default",
            }),
        ).toEqual([]);
    });

    test("flags an unsupported level for the primary model", () => {
        const violations = collectVariantViolations({
            models: [deepseekFlash],
            primaryModel: {
                providerID: "opencode-go",
                modelID: "deepseek-v4-flash",
            },
            variant: "medium",
        });

        expect(violations).toEqual([
            {
                variant: "medium",
                modelName: "opencode-go/deepseek-v4-flash",
                availableVariants: ["off", "low", "high", "max"],
            },
        ]);
    });

    test("skips unknown models instead of failing the run", () => {
        expect(
            collectVariantViolations({
                models: [deepseekFlash],
                primaryModel: {
                    providerID: "opencode-go",
                    modelID: "unknown-model",
                },
                variant: "medium",
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
            variant: "banana",
        });

        expect(violations).toHaveLength(1);
        expect(violations[0]?.variant).toBe("banana");
    });

    test("formats actionable guidance with available levels", () => {
        const message = formatVariantViolations([
            {
                variant: "medium",
                modelName: "opencode-go/deepseek-v4-flash",
                availableVariants: ["off", "low", "high", "max"],
            },
        ]);

        expect(message).toMatch(/opencode-go\/deepseek-v4-flash/);
        expect(message).toMatch(/off, low, high, max/);
        expect(message).toMatch(/--thinking <level>/);
    });

    test("explains models without reasoning support", () => {
        const message = formatVariantViolations([
            {
                variant: "low",
                modelName: "opencode-go/kimi-k2.7-code",
                availableVariants: ["off"],
            },
        ]);

        expect(message).toMatch(/does not support thinking level "low"/);
    });

    test("validateModelVariants throws with remediation", () => {
        expect(() =>
            validateModelVariants({
                models: [deepseekFlash],
                primaryModel: {
                    providerID: "opencode-go",
                    modelID: "deepseek-v4-flash",
                },
                variant: "medium",
            }),
        ).toThrow(/--thinking/);
    });

    test("validateModelVariants passes for supported levels", () => {
        expect(() =>
            validateModelVariants({
                models: [deepseekFlash],
                primaryModel: {
                    providerID: "opencode-go",
                    modelID: "deepseek-v4-flash",
                },
                variant: "high",
            }),
        ).not.toThrow();
    });
});