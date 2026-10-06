import { describe, expect, test } from "bun:test";

import {
    PreflightDisposition,
    handOffVerificationSchema,
    preflightDecisionSchema,
} from "../../src/issues/domain/decisions.ts";

describe("grounding decision schema", () => {
    test("accepts an actionable result", () => {
        const parsed = handOffVerificationSchema.safeParse({
            disposition: PreflightDisposition.Actionable,
        });
        expect(parsed.success).toBe(true);
        expect(parsed.data).toEqual({
            disposition: PreflightDisposition.Actionable,
        });
    });

    test("accepts an already-resolved result", () => {
        const parsed = handOffVerificationSchema.safeParse({
            disposition: PreflightDisposition.AlreadyResolved,
        });
        expect(parsed.success).toBe(true);
        expect(parsed.data).toEqual({
            disposition: PreflightDisposition.AlreadyResolved,
        });
    });

    test("still enforces hand-off branch requirements", () => {
        const parsed = handOffVerificationSchema.safeParse({
            disposition: PreflightDisposition.HandOff,
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
                disposition: PreflightDisposition.Actionable,
            }).success,
        ).toBe(false);
        expect(
            preflightDecisionSchema.safeParse({
                disposition: PreflightDisposition.Actionable,
                fitsOneSession: false,
            }).success,
        ).toBe(true);
    });

    test("accepts a blocked result naming open issues and rejects an empty list", () => {
        expect(
            preflightDecisionSchema.safeParse({
                disposition: PreflightDisposition.Blocked,
                blockedBy: [12],
            }).success,
        ).toBe(true);
        expect(
            preflightDecisionSchema.safeParse({
                disposition: PreflightDisposition.Blocked,
                blockedBy: [],
            }).success,
        ).toBe(false);
    });
});