import { describe, expect, test } from "bun:test";
import type { Octokit } from "octokit";

import {
    makePipelineSnapshotCollectorService,
    type PipelineSnapshotRequest,
} from "../../src/github/pipeline-snapshot-collector.ts";

const sha = "a".repeat(40);
const request: PipelineSnapshotRequest = {
    repository: "owner/repository",
    branch: "main",
    commitSha: sha,
};

type Page = Readonly<Record<string, unknown>>;

type FakeInput = {
    readonly checks: ReadonlyArray<Page>;
    readonly suites: ReadonlyArray<Page>;
    readonly statuses: ReadonlyArray<Page>;
    readonly workflows: ReadonlyArray<Page>;
    readonly failures?: ReadonlyArray<
        "checks" | "suites" | "statuses" | "workflows"
    >;
};

const fakeClient = (input: FakeInput) => {
    const requests: Array<{
        readonly source: string;
        readonly parameters: Record<string, unknown>;
    }> = [];
    const endpoint =
        (
            source: "checks" | "suites" | "statuses" | "workflows",
            pages: ReadonlyArray<Page>,
        ) =>
        async (parameters: Record<string, unknown>) => {
            requests.push({ source, parameters });
            if (input.failures?.includes(source))
                throw new Error(`${source} unavailable`);
            const page = pages[Number(parameters.page) - 1];
            return page === undefined
                ? { data: undefined }
                : { data: { ...page, total_count: pages.length * 100 } };
        };
    const client = {
        rest: {
            checks: {
                listForRef: endpoint("checks", input.checks),
                listSuitesForRef: endpoint("suites", input.suites),
            },
            repos: {
                listCommitStatusesForRef: endpoint("statuses", input.statuses),
            },
            actions: {
                listWorkflowRunsForRepo: endpoint("workflows", input.workflows),
            },
        },
    } as unknown as Octokit;
    return { client, requests };
};

const scoped = (extra: Record<string, unknown> = {}) => ({
    head_sha: sha,
    head_branch: "main",
    status: "completed",
    conclusion: "success",
    ...extra,
});

describe("pipeline snapshot collector", () => {
    test("collects every envelope source, paginates, and correlates Actions metadata", async () => {
        const { client, requests } = fakeClient({
            checks: [
                {
                    total_count: 2,
                    check_runs: [
                        scoped({
                            id: 11,
                            name: "build",
                            app: { slug: "provider-a" },
                            check_suite: {
                                id: 101,
                                head_sha: sha,
                                head_branch: "main",
                                workflow_run: {
                                    id: 501,
                                    run_attempt: 1,
                                    workflow_id: 7,
                                    run_number: 10,
                                },
                            },
                            conclusion: "failure",
                        }),
                    ],
                },
                {
                    total_count: 2,
                    check_runs: [
                        scoped({
                            id: 12,
                            name: "build",
                            app: { slug: "provider-b" },
                            check_suite: {
                                id: 102,
                                head_sha: sha,
                                head_branch: "main",
                                workflow_run: {
                                    id: 502,
                                    run_attempt: 2,
                                    workflow_id: 8,
                                    run_number: 20,
                                },
                            },
                        }),
                    ],
                },
            ],
            suites: [
                {
                    total_count: 2,
                    check_suites: [scoped({ id: 201, name: "suite-first" })],
                },
                {
                    total_count: 2,
                    check_suites: [scoped({ id: 202, name: "suite-later" })],
                },
            ],
            statuses: [
                {
                    total_count: 2,
                    sha,
                    statuses: [
                        {
                            context: "legacy-first",
                            branch: "main",
                            state: "success",
                        },
                    ],
                },
                {
                    total_count: 2,
                    sha,
                    statuses: [
                        {
                            context: "legacy-later",
                            branch: "main",
                            state: "success",
                        },
                    ],
                },
            ],
            workflows: [
                {
                    total_count: 2,
                    workflow_runs: [
                        scoped({
                            id: 701,
                            name: "workflow-first",
                            workflow_id: 9,
                            run_number: 30,
                        }),
                    ],
                },
                {
                    total_count: 2,
                    workflow_runs: [
                        scoped({
                            id: 702,
                            name: "workflow-later",
                            workflow_id: 9,
                            run_number: 31,
                        }),
                        scoped({
                            id: 703,
                            name: "wrong-sha",
                            head_sha: "b".repeat(40),
                        }),
                        scoped({
                            id: 704,
                            name: "wrong-branch",
                            head_branch: "release",
                        }),
                    ],
                },
            ],
        });

        const snapshot = await makePipelineSnapshotCollectorService().collect(
            client,
            request,
        );
        const bySource = (source: string) =>
            requests.filter((entry) => entry.source === source);

        expect(bySource("checks")).toHaveLength(2);
        expect(bySource("suites")).toHaveLength(2);
        expect(bySource("statuses")).toHaveLength(2);
        expect(bySource("workflows")).toHaveLength(2);
        expect(bySource("checks")[0]?.parameters).toMatchObject({
            owner: "owner",
            repo: "repository",
            ref: sha,
            filter: "all",
            per_page: 100,
        });
        expect(bySource("workflows")[0]?.parameters).toMatchObject({
            branch: "main",
            head_sha: sha,
            per_page: 100,
        });

        expect(snapshot.items.map(({ name }) => name)).toContain("suite-later");
        expect(snapshot.items.map(({ name }) => name)).toContain(
            "legacy-later",
        );
        expect(snapshot.items.map(({ name }) => name)).not.toContain(
            "wrong-sha",
        );
        expect(snapshot.items.map(({ name }) => name)).not.toContain(
            "wrong-branch",
        );
        const legacy = snapshot.items.find(
            ({ name }) => name === "legacy-later",
        );
        expect(legacy?.diagnostic.rawValues.sha).toBe(sha);
        expect(legacy?.diagnostic.rawValues.context).toBe("legacy-later");
        const workflow = snapshot.items.find(
            ({ name }) => name === "workflow-later",
        );
        expect(workflow?.diagnostic.runId).toBe(702);
        expect(workflow?.diagnostic.workflowId).toBe(9);
        expect(workflow?.diagnostic.runNumber).toBe(31);
        const selectedCheck = snapshot.items.find(
            ({ provider, name }) =>
                provider === "provider-b" && name === "build",
        );
        expect(selectedCheck?.diagnostic.runId).toBe(502);
        expect(selectedCheck?.diagnostic.runAttempt).toBe(2);
        expect(selectedCheck?.diagnostic.workflowId).toBe(8);
        expect(selectedCheck?.diagnostic.runNumber).toBe(20);
        expect(selectedCheck?.diagnostic.suiteId).toBe(102);
        expect(selectedCheck?.diagnostic.checkRunId).toBe(12);
    });

    test("fails closed for a malformed commit-status response", async () => {
        const { client } = fakeClient({
            checks: [
                { check_runs: [scoped({ name: "check" })] },
                { check_runs: [] },
            ],
            suites: [
                { check_suites: [scoped({ name: "suite" })] },
                { check_suites: [] },
            ],
            statuses: [{ statuses: "malformed" }, { statuses: [] }],
            workflows: [
                { workflow_runs: [scoped({ name: "workflow" })] },
                { workflow_runs: [] },
            ],
        });

        const snapshot = await makePipelineSnapshotCollectorService().collect(
            client,
            request,
        );

        expect(snapshot.sourceErrors).toContainEqual({
            source: "statuses",
            message: "statuses response did not contain statuses.",
            rawValues: {
                name: "Error",
                message: "statuses response did not contain statuses.",
            },
        });
        expect(snapshot.items.map(({ name }) => name)).toEqual([
            "check",
            "suite",
            "workflow",
        ]);
        expect(snapshot.greenCandidate).toBe(false);
    });

    test("retains successful sources and serializable errors when a source fails", async () => {
        const { client } = fakeClient({
            checks: [],
            suites: [{ total_count: 0, check_suites: [] }],
            statuses: [
                {
                    total_count: 1,
                    sha,
                    statuses: [
                        { context: "legacy", branch: "main", state: "success" },
                    ],
                },
            ],
            workflows: [],
            failures: ["checks", "workflows"],
        });

        const snapshot = await makePipelineSnapshotCollectorService().read(
            client,
            "owner/repository",
            "main",
            sha,
        );

        expect(snapshot.items.some(({ name }) => name === "legacy")).toBe(true);
        expect(snapshot.sourceErrors.map(({ source }) => source)).toEqual([
            "checks",
            "workflow-runs",
        ]);
        expect(snapshot.sourceErrors[0]?.rawValues).toEqual({
            name: "Error",
            message: "checks unavailable",
        });
        expect(snapshot.greenCandidate).toBe(false);
    });
});