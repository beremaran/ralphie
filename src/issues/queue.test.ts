import { describe, expect, test } from "bun:test";

import type { GitHubIssue } from "../github/issues.ts";
import { createIssueQueue, IssueQueueState } from "./queue.ts";

const issue = (number: number): GitHubIssue => ({
  number,
  title: `Issue ${number}`,
  url: `issue/${number}`,
  body: null,
  labels: [],
});

describe("refreshable issue queue", () => {
  test("adds newly discovered issues without duplicating existing work", () => {
    const queue = createIssueQueue([{ issue: issue(1) }]);

    expect(queue.next()?.number).toBe(1);
    queue.complete(1);
    expect(
      queue.refresh([{ issue: issue(1) }, { issue: issue(2) }, { issue: issue(3) }]),
    ).toBe(2);
    expect(queue.next()?.number).toBe(2);
    expect(queue.next()?.number).toBe(3);
  });

  test("does not release an issue before its dependencies complete", () => {
    const queue = createIssueQueue([
      { issue: issue(2), dependsOn: [1] },
      { issue: issue(1) },
    ]);

    expect(queue.next()?.number).toBe(1);
    expect(queue.next()).toBeUndefined();
    expect(queue.state()).toBe(IssueQueueState.DependencyBlocked);
    queue.complete(1);
    expect(queue.state()).toBe(IssueQueueState.Ready);
    expect(queue.next()?.number).toBe(2);
    expect(queue.state()).toBe(IssueQueueState.Exhausted);
  });

  test("applies the processing budget to refreshed issues", () => {
    const queue = createIssueQueue([{ issue: issue(1) }], 2);

    expect(queue.next()?.number).toBe(1);
    queue.complete(1);
    queue.refresh([{ issue: issue(2) }, { issue: issue(3) }]);
    expect(queue.next()?.number).toBe(2);
    expect(queue.next()).toBeUndefined();
    expect(queue.pendingCount()).toBe(1);
    expect(queue.processedCount()).toBe(2);
    expect(queue.state()).toBe(IssueQueueState.BudgetExhausted);
  });

  test("preserves refresh order through multiple child generations", () => {
    const queue = createIssueQueue([{ issue: issue(1) }]);

    expect(queue.next()?.number).toBe(1);
    queue.complete(1);
    queue.refresh([
      { issue: issue(2) },
      { issue: issue(3), dependsOn: [2] },
    ]);
    expect(queue.next()?.number).toBe(2);
    queue.complete(2);
    queue.refresh([
      { issue: issue(2) },
      { issue: issue(3), dependsOn: [2] },
      { issue: issue(4), dependsOn: [3] },
    ]);
    expect(queue.next()?.number).toBe(3);
    queue.complete(3);
    expect(queue.next()?.number).toBe(4);
  });
});
