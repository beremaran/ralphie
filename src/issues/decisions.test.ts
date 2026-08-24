import { describe, expect, test } from "bun:test";

import {
  complexityDecisionSchema,
  issueBreakdownDecisionSchema,
  reviewDecisionSchema,
} from "./decisions.ts";

describe("issue pipeline decisions", () => {
  test("only accepts complexity levels from 0 through 5", () => {
    expect(
      complexityDecisionSchema.safeParse({ complexity: 3, rationale: "Small" })
        .success,
    ).toBe(true);
    expect(
      complexityDecisionSchema.safeParse({ complexity: 3.5, rationale: "No" })
        .success,
    ).toBe(false);
    expect(
      complexityDecisionSchema.safeParse({ complexity: 6, rationale: "No" })
        .success,
    ).toBe(false);
  });

  test("keeps review verdicts consistent with blocking findings", () => {
    expect(
      reviewDecisionSchema.safeParse({
        verdict: "approved",
        summary: "Ready",
        findings: [],
      }).success,
    ).toBe(true);
    expect(
      reviewDecisionSchema.safeParse({
        verdict: "approved",
        summary: "Contradictory",
        findings: [{ severity: "blocking", description: "Broken" }],
      }).success,
    ).toBe(false);
  });

  test("requires small child issues with valid dependency keys", () => {
    const valid = {
      rationale: "Two ordered pieces",
      issues: [
        {
          key: "foundation",
          title: "Build foundation",
          body: "Implement the foundation.",
          estimatedComplexity: 2,
          dependsOn: [],
        },
        {
          key: "integration",
          title: "Integrate foundation",
          body: "Connect the foundation.",
          estimatedComplexity: 3,
          dependsOn: ["foundation"],
        },
      ],
    };

    expect(issueBreakdownDecisionSchema.safeParse(valid).success).toBe(true);
    expect(
      issueBreakdownDecisionSchema.safeParse({
        ...valid,
        issues: [
          valid.issues[0],
          { ...valid.issues[1], dependsOn: ["missing"] },
        ],
      }).success,
    ).toBe(false);
    expect(
      issueBreakdownDecisionSchema.safeParse({
        ...valid,
        issues: [
          { ...valid.issues[0], dependsOn: ["integration"] },
          valid.issues[1],
        ],
      }).success,
    ).toBe(false);
  });
});
