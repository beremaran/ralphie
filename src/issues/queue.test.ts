import { describe, expect, test } from "bun:test";

import type { GitHubIssue } from "../github/issues.ts";
import { createIssueQueue } from "./queue.ts";

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
    queue.complete(1);
    expect(queue.next()?.number).toBe(2);
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
  });
});
