import { describe, expect, test } from "bun:test";

import { stripExplicitNulls } from "../../src/agent/json-schema.ts";
import {
    GroundingDisposition,
    groundingDecisionSchema,
} from "../../src/issues/decisions.ts";

describe("grounding decision schema", () => {
    test("accepts an actionable result with flattened branch-only fields stripped", () => {
        const parsed = groundingDecisionSchema.safeParse(
            stripExplicitNulls({
                disposition: GroundingDisposition.Actionable,
                summary: "The grounded evidence remains.",
                evidence: ["src/cli.ts:3"],
                questions: ["What is missing?"],
            }),
        );
        expect(parsed.success).toBe(true);
        expect(parsed.data).toEqual({
            disposition: GroundingDisposition.Actionable,
        });
    });

    test("accepts an already-resolved result with flattened branch-only fields stripped", () => {
        const parsed = groundingDecisionSchema.safeParse(
            stripExplicitNulls({
                disposition: GroundingDisposition.AlreadyResolved,
                summary: "Already done.",
            }),
        );
        expect(parsed.success).toBe(true);
        expect(parsed.data).toEqual({
            disposition: GroundingDisposition.AlreadyResolved,
        });
    });

    test("still enforces needs-attention branch requirements", () => {
        const parsed = groundingDecisionSchema.safeParse({
            disposition: GroundingDisposition.NeedsAttention,
            reason: "missing_information",
            summary: "A prerequisite is still open.",
            evidence: [],
            questions: ["Complete the prerequisite, then retry."],
        });
        expect(parsed.success).toBe(false);
    });
});