import { describe, expect, test } from "bun:test";

import {
    GroundingDisposition,
    groundingDecisionSchema,
    preflightDecisionSchema,
} from "../../src/issues/domain/decisions.ts";

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

    test("still enforces hand-off branch requirements", () => {
        const parsed = groundingDecisionSchema.safeParse({
            disposition: GroundingDisposition.HandOff,
            reason: "missing_information",
            summary: "A prerequisite is still open.",
            evidence: [],
            questions: ["Complete the prerequisite, then retry."],
        });
        expect(parsed.success).toBe(false);
    });
});
describe("pre-flight decision schema", () => {
    test("requires fitsOneSession for an actionable result", () => {
        expect(
            preflightDecisionSchema.safeParse({
                disposition: GroundingDisposition.Actionable,
            }).success,
        ).toBe(false);
        expect(
            preflightDecisionSchema.safeParse({
                disposition: GroundingDisposition.Actionable,
                fitsOneSession: false,
            }).success,
        ).toBe(true);
    });

    test("accepts a blocked result naming open issues and rejects an empty list", () => {
        expect(
            preflightDecisionSchema.safeParse({
                disposition: GroundingDisposition.Blocked,
                blockedBy: [12],
            }).success,
        ).toBe(true);
        expect(
            preflightDecisionSchema.safeParse({
                disposition: GroundingDisposition.Blocked,
                blockedBy: [],
            }).success,
        ).toBe(false);
    });
});