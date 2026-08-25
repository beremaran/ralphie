import { describe, expect, test } from "bun:test";

import {
  DEFAULT_PI_AGENT,
  piAgentSchema,
  piModelSchema,
  piModelVariantSchema,
} from "./model.ts";

describe("Pi model selection", () => {
  test("defaults the agent to build", () => {
    expect(piAgentSchema.parse(undefined)).toBe(DEFAULT_PI_AGENT);
    expect(piAgentSchema.parse(" reviewer ")).toBe("reviewer");
  });

  test("splits provider from the complete model identifier", () => {
    expect(piModelSchema.parse("openrouter/anthropic/claude-sonnet")).toEqual({
      providerID: "openrouter",
      modelID: "anthropic/claude-sonnet",
    });
  });

  test("rejects model identifiers without a provider", () => {
    expect(piModelSchema.safeParse("claude-sonnet").success).toBe(false);
  });

  test("accepts only Pi thinking levels as model variants", () => {
    expect(piModelVariantSchema.parse("high")).toBe("high");
    expect(piModelVariantSchema.safeParse("provider-specific").success).toBe(false);
  });
});
