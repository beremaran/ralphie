import { describe, expect, test } from "bun:test";

import {
    ReviewFindingSeverity,
    ReviewVerdict,
} from "../../src/issues/domain/decisions.ts";
import {
    combineReviews,
    SpecFindingKind,
    StandardsFindingKind,
    type SpecReview,
    type StandardsReview,
} from "../../src/issues/domain/review-gate.ts";

const cleanStandards: StandardsReview = { summary: "Clean.", findings: [] };
const cleanSpec: SpecReview = { summary: "Met.", findings: [] };

const standardsWith = (kind: StandardsFindingKind): StandardsReview => ({
    summary: "Standards.",
    findings: [
        {
            kind,
            standard: "AGENTS.md: small functions",
            description: "Too long.",
            file: "src/a.ts",
            line: 3,
        },
    ],
});

const specWith = (kind: SpecFindingKind): SpecReview => ({
    summary: "Spec.",
    findings: [{ kind, requirement: "Story 4", description: "Not as asked." }],
});

describe("combineReviews", () => {
    test("approves when neither reviewer has findings", () => {
        const decision = combineReviews(cleanStandards, cleanSpec);
        expect(decision.verdict).toBe(ReviewVerdict.Approved);
        expect(decision.findings).toEqual([]);
        expect(decision.summary).toContain("Standards: Clean.");
        expect(decision.summary).toContain("Spec: Met.");
    });

    test("a documented-standard violation blocks and keeps its location", () => {
        const decision = combineReviews(
            standardsWith(StandardsFindingKind.Violation),
            cleanSpec,
        );
        expect(decision.verdict).toBe(ReviewVerdict.ChangesRequested);
        expect(decision.findings).toEqual([
            {
                severity: ReviewFindingSeverity.Blocking,
                description:
                    "[standards violation: AGENTS.md: small functions] Too long.",
                file: "src/a.ts",
                line: 3,
            },
        ]);
    });

    test("a smell is reported but never blocks", () => {
        const decision = combineReviews(
            standardsWith(StandardsFindingKind.Smell),
            cleanSpec,
        );
        expect(decision.verdict).toBe(ReviewVerdict.Approved);
        expect(decision.findings).toHaveLength(1);
        expect(decision.findings[0]?.severity).toBe(
            ReviewFindingSeverity.NonBlocking,
        );
    });

    test.each(Object.values(SpecFindingKind))(
        "a %s spec finding blocks",
        (kind) => {
            const decision = combineReviews(cleanStandards, specWith(kind));
            expect(decision.verdict).toBe(ReviewVerdict.ChangesRequested);
            expect(decision.findings).toEqual([
                {
                    severity: ReviewFindingSeverity.Blocking,
                    description: `[spec ${kind}: Story 4] Not as asked.`,
                },
            ]);
        },
    );

    test("a blocking spec finding blocks even beside a standards smell", () => {
        const decision = combineReviews(
            standardsWith(StandardsFindingKind.Smell),
            specWith(SpecFindingKind.Missing),
        );
        expect(decision.verdict).toBe(ReviewVerdict.ChangesRequested);
        expect(decision.findings.map(({ severity }) => severity)).toEqual([
            ReviewFindingSeverity.NonBlocking,
            ReviewFindingSeverity.Blocking,
        ]);
    });
});