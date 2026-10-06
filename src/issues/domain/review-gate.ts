import { z } from "zod";

import {
    ReviewFindingSeverity,
    ReviewVerdict,
    type ReviewDecision,
} from "./decisions.ts";

/**
 * The two-axis review gate. The standards reviewer reports where the candidate
 * commits break the repository's documented standards (hard violations) and
 * which baseline code smells it spots (judgement calls). The spec reviewer
 * reports where the commits miss, only partly meet, get wrong, or go beyond
 * the issue's contract. Ralphie, not the reviewers, turns the findings into a
 * verdict: see `combineReviews`.
 */
export enum StandardsFindingKind {
    Violation = "violation",
    Smell = "smell",
}

export enum SpecFindingKind {
    Missing = "missing",
    Partial = "partial",
    Wrong = "wrong",
    ScopeCreep = "scope_creep",
}

const location = {
    file: z.string().min(1).optional(),
    line: z.number().int().positive().optional(),
};

export const standardsReviewSchema = z
    .object({
        summary: z.string().min(1),
        findings: z.array(
            z
                .object({
                    kind: z.enum(StandardsFindingKind),
                    /** The documented rule (file and rule) or the smell name. */
                    standard: z.string().min(1),
                    description: z.string().min(1),
                    ...location,
                })
                .strict(),
        ),
    })
    .strict();

export const specReviewSchema = z
    .object({
        summary: z.string().min(1),
        findings: z.array(
            z
                .object({
                    kind: z.enum(SpecFindingKind),
                    /** The spec line the finding is about. */
                    requirement: z.string().min(1),
                    description: z.string().min(1),
                    ...location,
                })
                .strict(),
        ),
    })
    .strict();

export type StandardsReview = z.infer<typeof standardsReviewSchema>;
export type SpecReview = z.infer<typeof specReviewSchema>;

type Located = { readonly file?: string; readonly line?: number };

const locationOf = (finding: Located): Located => ({
    ...(finding.file === undefined ? {} : { file: finding.file }),
    ...(finding.line === undefined ? {} : { line: finding.line }),
});

/**
 * Block on any hard documented-standard violation and on every spec finding
 * (missing, partial, wrong, scope creep). Smells never block. The result
 * keeps the single-decision shape the review loop and recovery artifacts use.
 */
export const combineReviews = (
    standards: StandardsReview,
    spec: SpecReview,
): ReviewDecision => {
    const findings: ReviewDecision["findings"] = [
        ...standards.findings.map((finding) => ({
            severity:
                finding.kind === StandardsFindingKind.Violation
                    ? ReviewFindingSeverity.Blocking
                    : ReviewFindingSeverity.NonBlocking,
            description: `[standards ${finding.kind}: ${finding.standard}] ${finding.description}`,
            ...locationOf(finding),
        })),
        ...spec.findings.map((finding) => ({
            severity: ReviewFindingSeverity.Blocking,
            description: `[spec ${finding.kind}: ${finding.requirement}] ${finding.description}`,
            ...locationOf(finding),
        })),
    ];
    const blocking = findings.some(
        (finding) => finding.severity === ReviewFindingSeverity.Blocking,
    );
    return {
        verdict: blocking
            ? ReviewVerdict.ChangesRequested
            : ReviewVerdict.Approved,
        summary: `Standards: ${standards.summary} Spec: ${spec.summary}`,
        findings,
    };
};