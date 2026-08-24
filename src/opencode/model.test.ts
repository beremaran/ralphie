import { describe, expect, test } from "bun:test";

import {
  DEFAULT_OPENCODE_AGENT,
  openCodeAgentSchema,
  openCodeModelSchema,
} from "./model.ts";

describe("OpenCode model selection", () => {
  test("defaults the agent to build", () => {
    expect(openCodeAgentSchema.parse(undefined)).toBe(DEFAULT_OPENCODE_AGENT);
    expect(openCodeAgentSchema.parse(" reviewer ")).toBe("reviewer");
  });

  test("splits provider from the complete model identifier", () => {
    expect(openCodeModelSchema.parse("openrouter/anthropic/claude-sonnet")).toEqual({
      providerID: "openrouter",
      modelID: "anthropic/claude-sonnet",
    });
  });

  test("rejects model identifiers without a provider", () => {
    expect(openCodeModelSchema.safeParse("claude-sonnet").success).toBe(false);
  });
});
