import { describe, expect, test } from "bun:test";

import {
    DEFAULT_CODEX_AGENT,
    codexAgentSchema,
    codexModelSchema,
    codexModelVariantSchema,
} from "../../src/agent/model.ts";

describe("Codex model selection", () => {
    test("defaults the agent to build", () => {
        expect(codexAgentSchema.parse(undefined)).toBe(DEFAULT_CODEX_AGENT);
        expect(codexAgentSchema.parse(" reviewer ")).toBe("reviewer");
    });

    test("splits provider from the complete model identifier", () => {
        expect(
            codexModelSchema.parse("openrouter/anthropic/claude-sonnet"),
        ).toEqual({
            providerID: "openrouter",
            modelID: "anthropic/claude-sonnet",
        });
    });

    test("rejects model identifiers without a provider", () => {
        expect(codexModelSchema.safeParse("claude-sonnet").success).toBe(false);
    });

    test("accepts only Codex thinking levels as model variants", () => {
        expect(codexModelVariantSchema.parse("high")).toBe("high");
        expect(
            codexModelVariantSchema.safeParse("provider-specific").success,
        ).toBe(false);
    });
});