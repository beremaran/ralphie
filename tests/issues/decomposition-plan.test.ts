import { describe, expect, test } from "bun:test";

import { ImplementationComplexityLevel } from "../../src/issues/decisions.ts";
import { planDecompositionOperations } from "../../src/issues/decomposition-plan.ts";

const lineage = { rootIssueNumber: 42, parentIssueNumber: 42, depth: 1 };

const breakdown = (issues: Array<Record<string, unknown>>) =>
    ({
        rationale: "Split the work.",
        issues,
    }) as never;

describe("decomposition operation plan", () => {
    test("plans creation, native attachments, and dependency edges", () => {
        const plan = planDecompositionOperations(
            breakdown([
                {
                    key: "storage",
                    title: "Migrate storage",
                    estimatedComplexity: ImplementationComplexityLevel.Level2,
                    dependsOn: [],
                },
                {
                    key: "api",
                    title: "Adopt storage API",
                    estimatedComplexity: ImplementationComplexityLevel.Level1,
                    dependsOn: ["storage"],
                },
            ]),
            lineage,
            new Map(),
        );

        expect(plan.lineage).toEqual(lineage);
        expect(plan.parentStaysOpen).toBe(true);
        expect(
            plan.children.map(({ key, disposition }) => ({ key, disposition })),
        ).toEqual([
            { key: "storage", disposition: "create" },
            { key: "api", disposition: "create" },
        ]);
        expect(plan.dependencyEdges).toEqual([
            { from: "api", to: "storage", resolved: true },
        ]);
        expect(plan.counts).toEqual({
            create: 2,
            reuse: 0,
            attachSubIssues: 2,
            dependencies: 1,
        });
    });

    test("marks marker-matched children for reuse and unresolved edges", () => {
        const plan = planDecompositionOperations(
            breakdown([
                {
                    key: "storage",
                    title: "Migrate storage",
                    estimatedComplexity: ImplementationComplexityLevel.Level2,
                    dependsOn: [],
                },
                {
                    key: "api",
                    title: "Adopt storage API",
                    estimatedComplexity: ImplementationComplexityLevel.Level1,
                    dependsOn: ["storage", "external"],
                },
            ]),
            lineage,
            new Map([["storage", 101]]),
        );

        expect(plan.children).toEqual([
            {
                key: "storage",
                title: "Migrate storage",
                estimatedComplexity: ImplementationComplexityLevel.Level2,
                disposition: "reuse",
                issueNumber: 101,
            },
            {
                key: "api",
                title: "Adopt storage API",
                estimatedComplexity: ImplementationComplexityLevel.Level1,
                disposition: "create",
            },
        ]);
        expect(plan.dependencyEdges).toEqual([
            { from: "api", to: "storage", resolved: true },
            { from: "api", to: "external", resolved: false },
        ]);
        expect(plan.counts).toEqual({
            create: 1,
            reuse: 1,
            attachSubIssues: 2,
            dependencies: 2,
        });
    });

    test("plans an empty breakdown without operations", () => {
        const plan = planDecompositionOperations(
            breakdown([]),
            lineage,
            new Map(),
        );
        expect(plan.children).toEqual([]);
        expect(plan.dependencyEdges).toEqual([]);
        expect(plan.counts).toEqual({
            create: 0,
            reuse: 0,
            attachSubIssues: 0,
            dependencies: 0,
        });
    });
});