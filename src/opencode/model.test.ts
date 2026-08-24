import { describe, expect, test } from "bun:test";

import { openCodeModelSchema } from "./model.ts";

describe("OpenCode model selection", () => {
  test("splits provider from the complete model identifier", () => {
    expect(openCodeModelSchema.parse("openrouter/anthropic/claude-sonnet")).toEqual(
      {
        providerID: "openrouter",
        modelID: "anthropic/claude-sonnet",
      },
    );
  });

  test("rejects model identifiers without a provider", () => {
    expect(openCodeModelSchema.safeParse("claude-sonnet").success).toBe(false);
  });
});
