import { describe, expect, test } from "bun:test";

import type { Octokit } from "octokit";

import { IssueOrder, IssueSort } from "../../src/github/issues.ts";
import {
    loadMaintainabilitySnapshot,
    selectMaintainableIssueNumbers,
} from "../../src/maintain/github-reader.ts";
import {
    createMaintainableIssue,
    createMaintainableThread,
} from "../../src/maintain-issues-snapshot.ts";

const response = (data: unknown, link?: string, status = 200): unknown => ({
    data,
    status,
    headers: link === undefined ? {} : { link },
});

const next =
    '<https://api.github.com/repos/o/r/issues?page=2>; rel="next", <https://api.github.com/repos/o/r/issues?page=2>; rel="last"';

const listIssue = (
    number: number,
    createdAt: string,
    labels: ReadonlyArray<string>,
): Record<string, unknown> => ({
    number,
    node_id: `I_${String(number)}`,
    title: `issue-${String(number)}`,
    html_url: `https://github.com/o/r/issues/${String(number)}`,
    state: "open",
    user: { login: "user", type: "User" },
    labels: labels.map((name) => ({ name })),
    created_at: createdAt,
    updated_at: createdAt,
    comments: number,
});

const detailIssue = (number: number): Record<string, unknown> => ({
    ...listIssue(number, "2026-01-01T00:00:00Z", ["ready"]),
    body: `detail-${String(number)}`,
    author_association: "NONE",
    assignees: [],
    milestone: null,
    locked: false,
});

describe("composed maintenance GitHub reader", () => {
    test("runs one read-only collection pass and round-trips full values", async () => {
        const calls: Array<{
            name: string;
            parameters: Record<string, unknown>;
        }> = [];
        const issues = {
            get: async (parameters: Record<string, unknown>) => {
                calls.push({ name: "get", parameters });
                return response(detailIssue(parameters.issue_number as number));
            },
            listComments: async (parameters: Record<string, unknown>) => {
                calls.push({ name: "comments", parameters });
                return response([
                    {
                        id: parameters.issue_number as number,
                        node_id: "C_1",
                        html_url: "https://github.com/o/r/comment/1",
                        user: null,
                        author_association: "NONE",
                        body: "comment",
                    },
                ]);
            },
            listLabelsForRepo: async (parameters: Record<string, unknown>) => {
                calls.push({ name: "labels", parameters });
                return parameters.page === 1
                    ? response([{ name: "z" }], next)
                    : response([{ name: "a" }]);
            },
            listForRepo: async (parameters: Record<string, unknown>) => {
                calls.push({ name: "issues", parameters });
                return parameters.page === 1
                    ? response(
                          [
                              listIssue(2, "2026-02-01T00:00:00Z", ["ready"]),
                              listIssue(1, "2026-01-01T00:00:00Z", ["other"]),
                          ],
                          next,
                      )
                    : response([
                          listIssue(3, "2026-03-01T00:00:00Z", ["ready"]),
                      ]);
            },
        };
        const client = {
            rest: {
                repos: {
                    get: async (parameters: Record<string, unknown>) => {
                        calls.push({ name: "repository", parameters });
                        return response({
                            full_name: "o/r",
                            default_branch: "main",
                            html_url: "https://github.com/o/r",
                        });
                    },
                },
                issues,
            },
        } as unknown as Octokit;

        const snapshot = await loadMaintainabilitySnapshot(client, "o/r", {
            issueLabels: ["ready"],
            issueSort: IssueSort.Created,
            issueOrder: IssueOrder.Descending,
            maxIssues: 1,
        });

        expect(snapshot.selectedIssueNumbers).toEqual([3]);
        expect(snapshot.selectedIssues[0]?.number).toBe(3);
        expect(snapshot.selectedDetails[0]?.thread.complete).toBe(true);
        expect(snapshot.selectedDetails[0]?.thread.comments).toHaveLength(1);
        expect(snapshot.repository.defaultBranch).toBe("main");
        expect(snapshot.labels.map((label) => label.name)).toEqual(["a", "z"]);
        expect(calls.map((call) => call.name)).toEqual([
            "repository",
            "labels",
            "labels",
            "issues",
            "issues",
            "get",
            "comments",
        ]);
        expect(calls.every((call) => call.name !== "mutation")).toBe(true);

        const selectedIssue = snapshot.selectedIssues[0];
        const selectedDetail = snapshot.selectedDetails[0];
        if (selectedIssue === undefined || selectedDetail === undefined) {
            throw new Error("expected one selected issue detail");
        }
        const roundTrip = createMaintainableIssue(selectedIssue);
        const threadRoundTrip = createMaintainableThread(selectedDetail.thread);
        expect(roundTrip).toEqual(selectedIssue);
        expect(threadRoundTrip).toEqual(selectedDetail.thread);
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(Object.isFrozen(snapshot.selectedIssues)).toBe(true);
    });

    test("selection sorting has deterministic number tie-breaks", () => {
        const values = [
            {
                number: 3,
                isOpen: true,
                labels: [{ name: "x" }],
                createdAt: "",
                updatedAt: "",
                commentCount: 1,
            },
            {
                number: 1,
                isOpen: true,
                labels: [{ name: "x" }],
                createdAt: "",
                updatedAt: "",
                commentCount: 1,
            },
        ] as never;
        expect(
            selectMaintainableIssueNumbers(values, {
                issueSort: IssueSort.Comments,
                issueOrder: IssueOrder.Ascending,
            }),
        ).toEqual([1, 3]);
    });
});