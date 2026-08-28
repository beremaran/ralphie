import { describe, expect, test } from "bun:test";

import type { GitHubIssue } from "../../src/github/issues.ts";
import {
    createIssueQueue,
    IssueQueueState,
    toQueuedIssues,
} from "../../src/issues/queue.ts";
import { renderChildIssueBody } from "../../src/github/decomposition-markdown.ts";
import { ImplementationComplexityLevel } from "../../src/issues/decisions.ts";

const issue = (number: number): GitHubIssue => ({
    number,
    title: `Issue ${number}`,
    url: `issue/${number}`,
    body: null,
    labels: [],
});

describe("refreshable issue queue", () => {
    test("adds newly discovered issues without duplicating existing work", () => {
        const queue = createIssueQueue([
            {
                issue: issue(1),
            },
        ]);

        expect(queue.next()?.number).toBe(1);
        queue.complete(1);
        expect(
            queue.refresh([
                {
                    issue: issue(1),
                },
                {
                    issue: issue(2),
                },
                {
                    issue: issue(3),
                },
            ]),
        ).toBe(2);
        expect(queue.next()?.number).toBe(2);
        expect(queue.next()?.number).toBe(3);
    });

    test("does not release an issue before its dependencies complete", () => {
        const queue = createIssueQueue([
            {
                issue: issue(2),
                dependsOn: [1],
            },
            {
                issue: issue(1),
            },
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
        const queue = createIssueQueue(
            [
                {
                    issue: issue(1),
                },
            ],
            2,
        );

        expect(queue.next()?.number).toBe(1);
        queue.complete(1);
        queue.refresh([
            {
                issue: issue(2),
            },
            {
                issue: issue(3),
            },
        ]);
        expect(queue.next()?.number).toBe(2);
        expect(queue.next()).toBeUndefined();
        expect(queue.pendingCount()).toBe(1);
        expect(queue.processedCount()).toBe(2);
        expect(queue.state()).toBe(IssueQueueState.BudgetExhausted);
    });

    test("preserves refresh order through multiple child generations", () => {
        const queue = createIssueQueue([
            {
                issue: issue(1),
            },
        ]);

        expect(queue.next()?.number).toBe(1);
        queue.complete(1);
        queue.refresh([
            {
                issue: issue(2),
            },
            {
                issue: issue(3),
                dependsOn: [2],
            },
        ]);
        expect(queue.next()?.number).toBe(2);
        queue.complete(2);
        queue.refresh([
            {
                issue: issue(2),
            },
            {
                issue: issue(3),
                dependsOn: [2],
            },
            {
                issue: issue(4),
                dependsOn: [3],
            },
        ]);
        expect(queue.next()?.number).toBe(3);
        queue.complete(3);
        expect(queue.next()?.number).toBe(4);
    });

    test("translates generated dependency keys into open GitHub issue dependencies", () => {
        const dependency = issue(11);
        const child = {
            ...issue(12),
            body: renderChildIssueBody({
                child: {
                    key: "api",
                    title: "API",
                    body: "Update API.",
                    estimatedComplexity: ImplementationComplexityLevel.Level2,
                    dependsOn: ["storage"],
                },
                lineage: {
                    rootIssueNumber: 10,
                    parentIssueNumber: 10,
                    depth: 1,
                },
                issueNumbers: {
                    storage: 11,
                    api: 12,
                },
            }),
        };

        expect(toQueuedIssues([dependency, child])).toEqual([
            {
                issue: dependency,
                dependsOn: [],
            },
            {
                issue: child,
                dependsOn: [11],
            },
        ]);
        expect(toQueuedIssues([child])).toEqual([
            {
                issue: child,
                dependsOn: [],
            },
        ]);
    });

    test("expands a closed decomposed dependency to its open children", () => {
        const child = {
            ...issue(160),
            body: '<!-- ralphie:decomposition root=7 parent=36 key="service" depth=2 -->',
        };
        const dependent = {
            ...issue(37),
            body: '<!-- ralphie:decomposition root=7 parent=35 key="consumer" depth=2 -->\n\n## Dependencies\n\n- #36 (notification)',
        };

        expect(toQueuedIssues([dependent, child])).toEqual([
            { issue: dependent, dependsOn: [160] },
            { issue: child, dependsOn: [] },
        ]);
    });

    test("restores processing budget and completed dependencies from a snapshot", () => {
        const queue = createIssueQueue(
            [
                {
                    issue: issue(2),
                    dependsOn: [1],
                },
                {
                    issue: issue(3),
                },
            ],
            3,
            {
                completedIssueNumbers: [1],
                processedCount: 1,
            },
        );

        expect(queue.next()?.number).toBe(2);
        queue.complete(2);
        expect(queue.snapshot()).toEqual({
            pending: [
                {
                    issue: issue(3),
                    dependsOn: [],
                },
            ],
            completedIssueNumbers: [1, 2],
            processedCount: 2,
        });
    });
});