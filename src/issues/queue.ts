import type { GitHubIssue } from "../github/issues.ts";
import {
    isDecomposedParent,
    parseGeneratedIssueDependencies,
} from "../github/decomposition-markdown.ts";

export type QueuedIssue = {
    readonly issue: GitHubIssue;
    readonly dependsOn?: ReadonlyArray<number>;
};

export enum IssueQueueState {
    Ready = "ready",
    DependencyBlocked = "dependency-blocked",
    BudgetExhausted = "budget-exhausted",
    Exhausted = "exhausted",
}

export type IssueQueue = {
    readonly next: () => GitHubIssue | undefined;
    readonly complete: (issueNumber: number) => void;
    readonly skip: (issueNumber: number) => void;
    readonly refresh: (issues: ReadonlyArray<QueuedIssue>) => number;
    readonly pendingCount: () => number;
    readonly processedCount: () => number;
    readonly state: () => IssueQueueState;
    readonly snapshot: () => {
        readonly pending: ReadonlyArray<QueuedIssue>;
        readonly completedIssueNumbers: ReadonlyArray<number>;
        readonly processedCount: number;
    };
};

export const createIssueQueue = (
    initialIssues: ReadonlyArray<QueuedIssue>,
    maxIssues?: number,
    resume?: {
        readonly completedIssueNumbers: ReadonlyArray<number>;
        readonly processedCount: number;
    },
): IssueQueue => {
    const pending: QueuedIssue[] = [];
    const known = new Set<number>();
    const completed = new Set<number>();
    let processed = resume?.processedCount ?? 0;

    for (const issueNumber of resume?.completedIssueNumbers ?? []) {
        known.add(issueNumber);
        completed.add(issueNumber);
    }

    const refresh = (issues: ReadonlyArray<QueuedIssue>): number => {
        let added = 0;
        for (const issue of issues) {
            if (!known.has(issue.issue.number)) {
                known.add(issue.issue.number);
                pending.push(issue);
                added += 1;
            }
        }
        return added;
    };

    refresh(initialIssues);

    return {
        next: () => {
            if (maxIssues !== undefined && processed >= maxIssues)
                return undefined;

            const readyIndex = pending.findIndex((candidate) =>
                (candidate.dependsOn ?? []).every((dependency) =>
                    completed.has(dependency),
                ),
            );
            if (readyIndex === -1) return undefined;

            const [ready] = pending.splice(readyIndex, 1);
            if (!ready) return undefined;
            processed += 1;
            return ready.issue;
        },
        complete: (issueNumber) => {
            known.add(issueNumber);
            completed.add(issueNumber);
        },
        skip: (issueNumber) => {
            processed = Math.max(0, processed - 1);
            known.add(issueNumber);
            completed.add(issueNumber);
        },
        refresh,
        pendingCount: () => pending.length,
        processedCount: () => processed,
        state: () => {
            if (maxIssues !== undefined && processed >= maxIssues) {
                return IssueQueueState.BudgetExhausted;
            }
            if (pending.length === 0) return IssueQueueState.Exhausted;
            return pending.some((candidate) =>
                (candidate.dependsOn ?? []).every((dependency) =>
                    completed.has(dependency),
                ),
            )
                ? IssueQueueState.Ready
                : IssueQueueState.DependencyBlocked;
        },
        snapshot: () => ({
            pending: pending.map((entry) => ({
                issue: {
                    ...entry.issue,
                    labels: [...entry.issue.labels],
                    ...(entry.issue.comments === undefined
                        ? {}
                        : {
                              comments: entry.issue.comments.map((comment) => ({
                                  ...comment,
                              })),
                          }),
                },
                dependsOn: [...(entry.dependsOn ?? [])],
            })),
            completedIssueNumbers: [...completed],
            processedCount: processed,
        }),
    };
};

/**
 * Preserve GitHub ordering while attaching dependencies that are still open.
 * Decomposed parents are tracking issues kept open for native sub-issue
 * progress and are never queued for execution; only their children are.
 */
export const toQueuedIssues = (
    issues: ReadonlyArray<GitHubIssue>,
): ReadonlyArray<QueuedIssue> => {
    const openIssueNumbers = new Set(issues.map(({ number }) => number));
    const openDescendants = new Map<number, number[]>();
    for (const issue of issues) {
        const lineage =
            /<!--\s*ralphie:decomposition\b[^>]*\broot=(\d+)\b[^>]*\bparent=(\d+)\b/i.exec(
                issue.body ?? "",
            );
        if (lineage?.[1] === undefined || lineage[2] === undefined) continue;
        for (const ancestor of new Set([
            Number(lineage[1]),
            Number(lineage[2]),
        ])) {
            const descendants = openDescendants.get(ancestor) ?? [];
            descendants.push(issue.number);
            openDescendants.set(ancestor, descendants);
        }
    }

    const expandOpenDependency = (dependency: number): number[] => {
        if (openIssueNumbers.has(dependency)) return [dependency];
        return [...(openDescendants.get(dependency) ?? [])];
    };

    return issues
        .filter((issue) => !isDecomposedParent(issue))
        .map((issue) => ({
            issue,
            dependsOn: [
                ...new Set(
                    parseGeneratedIssueDependencies(issue).flatMap(
                        expandOpenDependency,
                    ),
                ),
            ],
        }));
};