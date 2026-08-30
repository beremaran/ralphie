import type { DecompositionLineage } from "../github/decomposition-markdown.ts";
import type { IssueBreakdownDecision } from "./decisions.ts";

type BreakdownChild = IssueBreakdownDecision["issues"][number];

/** Whether a planned child issue would be created or marker-reused. */
export type PlannedChildDisposition = "create" | "reuse";

export type PlannedChild = {
    readonly key: string;
    readonly title: string;
    readonly estimatedComplexity: BreakdownChild["estimatedComplexity"];
    readonly disposition: PlannedChildDisposition;
    /** Present for reused children discovered by their stable marker. */
    readonly issueNumber?: number;
};

export type PlannedDependencyEdge = {
    /** The key of the child that declared the dependency. */
    readonly from: string;
    /** The key of the declared `dependsOn` target. */
    readonly to: string;
    /** True when the target key exists in the same breakdown. */
    readonly resolved: boolean;
};

export type DecompositionOperationCounts = {
    readonly create: number;
    readonly reuse: number;
    readonly attachSubIssues: number;
    readonly dependencies: number;
};

export type DecompositionOperationPlan = {
    readonly lineage: DecompositionLineage;
    readonly children: ReadonlyArray<PlannedChild>;
    readonly dependencyEdges: ReadonlyArray<PlannedDependencyEdge>;
    readonly counts: DecompositionOperationCounts;
    /** Decomposed parents remain open as native tracking issues. */
    readonly parentStaysOpen: true;
};

/**
 * Derive the GitHub operations a decomposition would perform, without
 * mutating anything. Used by dry runs to report the intended native
 * sub-issue hierarchy and dependency edges.
 */
export const planDecompositionOperations = (
    breakdown: IssueBreakdownDecision,
    lineage: DecompositionLineage,
    existingByKey: ReadonlyMap<string, number>,
): DecompositionOperationPlan => {
    const children: ReadonlyArray<PlannedChild> = breakdown.issues.map(
        (child) => {
            const existing = existingByKey.get(child.key);
            return existing === undefined
                ? {
                      key: child.key,
                      title: child.title,
                      estimatedComplexity: child.estimatedComplexity,
                      disposition: "create" as const,
                  }
                : {
                      key: child.key,
                      title: child.title,
                      estimatedComplexity: child.estimatedComplexity,
                      disposition: "reuse" as const,
                      issueNumber: existing,
                  };
        },
    );
    const dependencyEdges: ReadonlyArray<PlannedDependencyEdge> =
        breakdown.issues.flatMap((child) =>
            child.dependsOn.map((to) => ({
                from: child.key,
                to,
                resolved: breakdown.issues.some((target) => target.key === to),
            })),
        );
    const create = children.filter(
        (child) => child.disposition === "create",
    ).length;
    return {
        lineage,
        children,
        dependencyEdges,
        counts: {
            create,
            reuse: children.length - create,
            attachSubIssues: children.length,
            dependencies: dependencyEdges.length,
        },
        parentStaysOpen: true,
    };
};