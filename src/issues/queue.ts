import type { GitHubIssue } from "../github/issues.ts";
import { parseGeneratedIssueDependencies } from "../github/decomposition-markdown.ts";

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
  readonly refresh: (issues: ReadonlyArray<QueuedIssue>) => number;
  readonly pendingCount: () => number;
  readonly processedCount: () => number;
  readonly state: () => IssueQueueState;
};

export const createIssueQueue = (
  initialIssues: ReadonlyArray<QueuedIssue>,
  maxIssues?: number,
): IssueQueue => {
  const pending: QueuedIssue[] = [];
  const known = new Set<number>();
  const completed = new Set<number>();
  let processed = 0;

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
      if (maxIssues !== undefined && processed >= maxIssues) return undefined;

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
  };
};

/** Preserve GitHub ordering while attaching dependencies that are still open. */
export const toQueuedIssues = (
  issues: ReadonlyArray<GitHubIssue>,
): ReadonlyArray<QueuedIssue> => {
  const openIssueNumbers = new Set(issues.map(({ number }) => number));
  return issues.map((issue) => ({
    issue,
    dependsOn: parseGeneratedIssueDependencies(issue).filter((number) =>
      openIssueNumbers.has(number),
    ),
  }));
};
