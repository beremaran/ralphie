import { describe, expect, test } from "bun:test";

import {
    ImplementationComplexityLevel,
    type IssueBreakdownDecision,
} from "../../src/issues/decisions.ts";
import type { GitHubIssue } from "../../src/github/issues.ts";
import {
    DEFAULT_MAX_DECOMPOSITION_DEPTH,
    RALPHIE_DECOMPOSITION_MARKER,
    isDecomposedParent,
    nextDecompositionLineage,
    parseDecompositionMarker,
    parseGeneratedIssueDependencies,
    renderChildIssueBody,
    renderDecomposedOriginalBody,
} from "../../src/github/decomposition-markdown.ts";

const original: GitHubIssue = {
    number: 10,
    title: "Large migration",
    url: "https://github.com/owner/repo/issues/10",
    body: "Keep this original context.",
    labels: [],
};

const breakdown: IssueBreakdownDecision = {
    rationale: "Split storage from API work.",
    issues: [
        {
            key: "storage",
            title: "Migrate storage",
            body: "Implement storage migration.",
            estimatedComplexity: ImplementationComplexityLevel.Level3,
            dependsOn: [],
        },
        {
            key: "api",
            title: "Migrate API",
            body: "Implement API migration.",
            estimatedComplexity: ImplementationComplexityLevel.Level2,
            dependsOn: ["storage"],
        },
    ],
};

const lineage = {
    rootIssueNumber: 10,
    parentIssueNumber: 10,
    depth: 1,
};
const issueNumbers = {
    storage: 11,
    api: 12,
};
const decompositionMarkerForDepth = (depth: number): string =>
    `<!-- ralphie:decomposition root=10 parent=9 key="generated" depth=${depth} -->`;

describe("decomposition Markdown", () => {
    test("keeps the stable marker and dependencies without redundant lineage lists", () => {
        const body = renderChildIssueBody({
            child: breakdown.issues[1]!,
            lineage,
            issueNumbers,
        });

        expect(body).toContain(RALPHIE_DECOMPOSITION_MARKER);
        expect(body).toContain("root=10 parent=10");
        expect(body).toContain("## Dependencies\n\n- #11 (storage)");
        expect(body).not.toContain("## Decomposition lineage");
        expect(body).not.toContain("## Related child issues");
        expect(body).not.toContain("- Parent: #10");
    });

    test("rewrites the original while preserving its content and complete stack", () => {
        const body = renderDecomposedOriginalBody({
            original,
            breakdown,
            issueNumbers,
            lineage,
        });

        expect(body).toContain("- #11 — Migrate storage");
        expect(body).toContain("- #12 — Migrate API (depends on #11)");
        expect(body).toContain("Keep this original context.");
        expect(body).toContain("Split storage from API work.");
        expect(
            renderDecomposedOriginalBody({
                original: {
                    ...original,
                    body,
                },
                breakdown,
                issueNumbers,
                lineage,
            }),
        ).toBe(body);
    });

    test("rejects decomposition beyond the maximum depth", () => {
        const generated = {
            ...original,
            body: decompositionMarkerForDepth(DEFAULT_MAX_DECOMPOSITION_DEPTH),
        };
        expect(() => nextDecompositionLineage(generated)).toThrow(
            "exceeds the configured maximum",
        );
        expect(nextDecompositionLineage(generated, 4).depth).toBe(4);
    });

    test("increments lineage when a generated child requires decomposition", () => {
        const generated = {
            ...original,
            number: 12,
            body: renderChildIssueBody({
                child: breakdown.issues[1]!,
                lineage,
                issueNumbers,
            }),
        };

        expect(nextDecompositionLineage(generated)).toEqual({
            rootIssueNumber: 10,
            parentIssueNumber: 12,
            depth: 2,
        });
    });

    test("parses dependency issue numbers only from generated child issues", () => {
        const body = renderChildIssueBody({
            child: breakdown.issues[1]!,
            lineage,
            issueNumbers,
        });
        expect(
            parseGeneratedIssueDependencies({
                ...original,
                body,
            }),
        ).toEqual([11]);
        expect(parseGeneratedIssueDependencies(original)).toEqual([]);
    });

    test("parses the stable marker and detects decomposed parents", () => {
        const childBody = renderChildIssueBody({
            child: breakdown.issues[1]!,
            lineage,
            issueNumbers,
        });
        expect(parseDecompositionMarker(childBody)).toEqual({
            rootIssueNumber: 10,
            parentIssueNumber: 10,
            key: "api",
            depth: 1,
        });
        expect(parseDecompositionMarker(original.body)).toBeUndefined();
        expect(parseDecompositionMarker(null)).toBeUndefined();

        const parent = {
            ...original,
            body: renderDecomposedOriginalBody({
                original,
                breakdown,
                issueNumbers,
                lineage,
            }),
        };
        expect(isDecomposedParent(parent)).toBe(true);
        expect(isDecomposedParent(original)).toBe(false);
        expect(isDecomposedParent({ ...original, body: null })).toBe(false);
    });
});