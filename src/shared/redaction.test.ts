import { describe, expect, test } from "bun:test";

import { redactSensitiveText, redactSensitiveValue } from "./redaction.ts";

describe("sensitive-value redaction", () => {
  test("redacts GitHub tokens, bearer values, query credentials, and URL passwords", () => {
    const text = redactSensitiveText(
      "github_pat_abc_DEF ghp_abcdef Bearer topsecret https://user:password@example.test/?token=querysecret",
    );
    expect(text).not.toContain("github_pat_abc_DEF");
    expect(text).not.toContain("ghp_abcdef");
    expect(text).not.toContain("topsecret");
    expect(text).not.toContain("password");
    expect(text).not.toContain("querysecret");
  });

  test("redacts nested values under sensitive keys", () => {
    expect(
      redactSensitiveValue({
        token: "anything",
        nested: {
          apiKey: "value",
        },
      }),
    ).toEqual({
      token: "[REDACTED]",
      nested: {
        apiKey: "[REDACTED]",
      },
    });
  });

  test("redacts values sourced from sensitive environment keys", () => {
    process.env.RALPHIE_TEST_API_KEY = "unique-environment-secret";
    try {
      expect(redactSensitiveText("failed: unique-environment-secret")).toBe(
        "failed: [REDACTED]",
      );
    } finally {
      delete process.env.RALPHIE_TEST_API_KEY;
    }
  });
});