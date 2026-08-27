import { describe, expect, test } from "bun:test";

import {
    ComplexityLevel,
    complexityDecisionSchema,
    GroundingDisposition,
    groundingDecisionSchema,
    ImplementationComplexityLevel,
    issueBreakdownDecisionSchema,
    issueResolutionDecisionSchema,
    IssueResolutionStatus,
    NeedsAttentionReason,
    ReviewFindingSeverity,
    reviewDecisionSchema,
    ReviewVerdict,
} from "../../src/issues/decisions.ts";

describe("issue pipeline decisions", () => {
    test("only accepts complexity levels from 0 through 5", () => {
        expect(
            complexityDecisionSchema.safeParse({
                complexity: ComplexityLevel.Level3,
                rationale: "Small",
            }).success,
        ).toBe(true);
        expect(
            complexityDecisionSchema.safeParse({
                complexity: 3.5,
                rationale: "No",
            }).success,
        ).toBe(false);
        expect(
            complexityDecisionSchema.safeParse({
                complexity: 6,
                rationale: "No",
            }).success,
        ).toBe(false);
    });

    test("keeps review verdicts consistent with blocking findings", () => {
        expect(
            reviewDecisionSchema.safeParse({
                verdict: ReviewVerdict.Approved,
                summary: "Ready",
                findings: [],
            }).success,
        ).toBe(true);
        expect(
            reviewDecisionSchema.safeParse({
                verdict: ReviewVerdict.Approved,
                summary: "Contradictory",
                findings: [
                    {
                        severity: ReviewFindingSeverity.Blocking,
                        description: "Broken",
                    },
                ],
            }).success,
        ).toBe(false);
    });

    test("validates each grounding disposition and needs-attention evidence", () => {
        expect(
            groundingDecisionSchema.safeParse({
                disposition: GroundingDisposition.Actionable,
            }).success,
        ).toBe(true);
        expect(
            groundingDecisionSchema.safeParse({
                disposition: GroundingDisposition.AlreadyResolved,
            }).success,
        ).toBe(true);
        const needsAttention = {
            disposition: GroundingDisposition.NeedsAttention,
            reason: NeedsAttentionReason.MissingInformation,
            summary: "The issue does not identify the required runtime.",
            evidence: ["The repository supports multiple runtimes."],
            questions: ["Which runtime should the change support first?"],
        };
        expect(groundingDecisionSchema.safeParse(needsAttention).success).toBe(
            true,
        );
        for (const invalid of [
            { ...needsAttention, summary: "" },
            { ...needsAttention, summary: "   " },
            { ...needsAttention, evidence: [] },
            { ...needsAttention, evidence: ["   "] },
            { ...needsAttention, questions: [] },
            { ...needsAttention, questions: ["   "] },
            {
                disposition: GroundingDisposition.Actionable,
                reason: NeedsAttentionReason.MissingInformation,
            },
        ]) {
            expect(groundingDecisionSchema.safeParse(invalid).success).toBe(
                false,
            );
        }
    });

    test("requires concrete evidence for issue resolution decisions", () => {
        expect(
            issueResolutionDecisionSchema.safeParse({
                status: IssueResolutionStatus.Resolved,
                summary: "The finding no longer reproduces.",
                evidence: ["targeted linter reports zero findings"],
            }).success,
        ).toBeTrue();
        expect(
            issueResolutionDecisionSchema.safeParse({
                status: IssueResolutionStatus.Resolved,
                summary: "Probably fixed.",
                evidence: [],
            }).success,
        ).toBeFalse();
    });

    test("requires small child issues with valid dependency keys", () => {
        const valid = {
            rationale: "Two ordered pieces",
            issues: [
                {
                    key: "foundation",
                    title: "Build foundation",
                    body: "Implement the foundation.",
                    estimatedComplexity: ImplementationComplexityLevel.Level2,
                    dependsOn: [],
                },
                {
                    key: "integration",
                    title: "Integrate foundation",
                    body: "Connect the foundation.",
                    estimatedComplexity: ImplementationComplexityLevel.Level3,
                    dependsOn: ["foundation"],
                },
            ],
        };

        expect(issueBreakdownDecisionSchema.safeParse(valid).success).toBe(
            true,
        );
        expect(
            issueBreakdownDecisionSchema.safeParse({
                ...valid,
                issues: [
                    valid.issues[0],
                    {
                        ...valid.issues[1],
                        dependsOn: ["missing"],
                    },
                ],
            }).success,
        ).toBe(false);
        expect(
            issueBreakdownDecisionSchema.safeParse({
                ...valid,
                issues: [
                    {
                        ...valid.issues[0],
                        dependsOn: ["integration"],
                    },
                    valid.issues[1],
                ],
            }).success,
        ).toBe(false);
        expect(issueBreakdownDecisionSchema.safeParse(valid).success).toBe(
            true,
        );
    });
});