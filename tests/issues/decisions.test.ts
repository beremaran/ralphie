import { describe, expect, test } from "bun:test";

import {
    GroundingDisposition,
    groundingDecisionSchema,
} from "../../src/issues/decisions.ts";

describe("grounding decision schema", () => {
    test("accepts an actionable result", () => {
        const parsed = groundingDecisionSchema.safeParse({
            disposition: GroundingDisposition.Actionable,
        });
        expect(parsed.success).toBe(true);
        expect(parsed.data).toEqual({
            disposition: GroundingDisposition.Actionable,
        });
    });

    test("accepts an already-resolved result", () => {
        const parsed = groundingDecisionSchema.safeParse({
            disposition: GroundingDisposition.AlreadyResolved,
        });
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