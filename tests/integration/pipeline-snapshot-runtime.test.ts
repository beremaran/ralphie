import { describe, expect, test } from "bun:test";
import type { Octokit } from "octokit";

import type { PipelineSnapshotRequest } from "../../src/github/pipeline-snapshot.ts";
import { makeProgressRecorder } from "../../src/progress/progress.ts";
import { makeLiveRuntime } from "../../src/runtime.ts";

const sha = "a".repeat(40);
const request: PipelineSnapshotRequest = {
    repository: "owner/repository",
    branch: "main",
    commitSha: sha,
};

type Source = "checks" | "suites" | "statuses" | "workflows";
type FakeResponse = Readonly<Record<string, unknown>>;

type FakeOctokitInput = {
    readonly checks: FakeResponse;
    readonly suites: FakeResponse;
    readonly statuses: FakeResponse;
    readonly workflows: FakeResponse;
    readonly failures?: ReadonlySet<Source>;
};

const fakeAuthenticatedOctokit = (
    input: FakeOctokitInput,
    requests: Array<{
        readonly source: Source;
        readonly parameters: Record<string, unknown>;
    }>,
): Octokit => {
    const endpoint =
        (source: Source, data: FakeResponse) =>
        async (parameters: Record<string, unknown>) => {
            requests.push({ source, parameters });
            if (input.failures?.has(source))
                throw new Error(`${source} unavailable`);
            return { data };
        };
    return {
        auth: "already-authenticated-token",
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
};

const workflowRun = (
    id: number,
    attempt: number,
    createdAt: string,
    conclusion: string,
) => ({
    id,
    run_attempt: attempt,
    workflow_id: 7,
    run_number: id,
    created_at: createdAt,
    status: "completed",
    conclusion,
});

const checkRun = (
    id: number,
    provider: string,
    run: ReturnType<typeof workflowRun>,
) => ({
    id,
    name: "build",
    app: { slug: provider },
    status: run.status,
    conclusion: run.conclusion,
    check_suite: {
        id: id + 1000,
        head_sha: sha,
        head_branch: "main",
        workflow_run: run,
    },
});

const completeResponses = (): FakeOctokitInput => ({
    checks: {
        check_runs: [
            checkRun(
                101,
                "provider-a",
                workflowRun(501, 1, "2024-01-01T00:00:00Z", "failure"),
            ),
            checkRun(
                102,
                "provider-a",
                workflowRun(502, 1, "2024-02-01T00:00:00Z", "failure"),
            ),
            checkRun(
                103,
                "provider-a",
                workflowRun(502, 2, "2024-02-01T00:00:00Z", "success"),
            ),
            checkRun(
                104,
                "provider-b",
                workflowRun(503, 1, "2024-02-03T00:00:00Z", "success"),
            ),
            {
                id: 105,
                name: "lint",
                app: { slug: "provider-a" },
                head_sha: sha,
                head_branch: "main",
                status: "completed",
                conclusion: "success",
            },
        ],
    },
    suites: {
        check_suites: [
            {
                id: 201,
                name: "suite",
                head_sha: sha,
                head_branch: "main",
                status: "completed",
                conclusion: "success",
            },
        ],
    },
    statuses: {
        sha,
        branch: "main",
        statuses: [
            {
                context: "legacy",
                state: "success",
            },
        ],
    },
    workflows: {
        workflow_runs: [
            {
                id: 502,
                name: "deploy",
                head_sha: sha,
                head_branch: "main",
                status: "completed",
                conclusion: "success",
                workflow_id: 7,
                run_number: 502,
                run_attempt: 2,
            },
        ],
    },
});

const responsesWithChecks = (
    checkRuns: ReadonlyArray<unknown>,
): FakeOctokitInput => ({
    checks: { check_runs: checkRuns },
    suites: { check_suites: [] },
    statuses: { sha, branch: "main", statuses: [] },
    workflows: { workflow_runs: [] },
});

const stateCheck = (
    name: string,
    status: string,
    conclusion: string | null,
) => ({
    ...checkRun(
        901,
        "provider-state",
        workflowRun(901, 1, "2024-03-01T00:00:00Z", "success"),
    ),
    name,
    status,
    conclusion,
});

const makeRuntime = () =>
    makeLiveRuntime({
        codex: {
            start: async () => {
                throw new Error("Codex must not start for a snapshot read");
            },
        },
        progress: makeProgressRecorder([]),
    });

const collectFromFake = async (input: FakeOctokitInput) => {
    const requests: Array<{
        readonly source: Source;
        readonly parameters: Record<string, unknown>;
    }> = [];
    const snapshot = await makeRuntime().pipelineSnapshot.collect(
        fakeAuthenticatedOctokit(input, requests),
        request,
    );
    return { snapshot, requests };
};

describe("pipeline snapshot runtime acceptance", () => {
    test("collects all visible sources through the runtime service", async () => {
        const runtime = makeRuntime();
        const requests: Array<{
            readonly source: Source;
            readonly parameters: Record<string, unknown>;
        }> = [];
        const client = fakeAuthenticatedOctokit(completeResponses(), requests);

        const snapshot = await runtime.pipelineSnapshot.collect(
            client,
            request,
        );

        expect(() => JSON.stringify(snapshot)).not.toThrow();
        expect(snapshot.state).toBe("non-empty");
        expect(snapshot.sourceErrors).toEqual([]);
        expect(snapshot.completenessErrors).toEqual([]);
        expect(snapshot.greenCandidate).toBe(true);
        expect(snapshot.reason).toBe("success");
        expect(
            new Set(
                snapshot.items.map(
                    ({ provider, name }) => `${provider}:${name}`,
                ),
            ).size,
        ).toBe(snapshot.items.length);
        expect(snapshot.items.map(({ name }) => name)).toEqual(
            expect.arrayContaining([
                "build",
                "lint",
                "suite",
                "legacy",
                "deploy",
            ]),
        );
        expect(
            snapshot.items.filter(({ name }) => name === "build"),
        ).toHaveLength(2);

        const selected = snapshot.items.find(
            ({ provider, name }) =>
                provider === "provider-a" && name === "build",
        );
        expect(selected?.status).toBe("passing");
        expect(selected?.diagnostic.runId).toBe(502);
        expect(selected?.diagnostic.runAttempt).toBe(2);
        expect(selected?.diagnostic.checkRunId).toBe(103);
        expect(selected?.diagnostic.suiteId).toBe(1103);
        expect(selected?.diagnostic.workflowId).toBe(7);
        expect(selected?.diagnostic.runNumber).toBe(502);
        expect(selected?.diagnostic.checkRunId).not.toBe(101);
        expect(selected?.diagnostic.checkRunId).not.toBe(102);

        const workflow = snapshot.items.find(({ name }) => name === "deploy");
        expect(workflow?.diagnostic.runId).toBe(502);
        expect(workflow?.diagnostic.workflowId).toBe(7);
        expect(workflow?.diagnostic.runNumber).toBe(502);
        expect(workflow?.status).toBe("passing");
        expect(requests.map(({ source }) => source)).toEqual(
            expect.arrayContaining([
                "checks",
                "suites",
                "statuses",
                "workflows",
            ]),
        );
        expect(
            requests.find(({ source }) => source === "checks")?.parameters,
        ).toMatchObject({
            owner: "owner",
            repo: "repository",
            ref: sha,
            filter: "all",
            per_page: 100,
        });
    });

    test("retains raw unknown observations and fails closed on partial collection", async () => {
        const runtime = makeRuntime();
        const requests: Array<{
            readonly source: Source;
            readonly parameters: Record<string, unknown>;
        }> = [];
        const responses = completeResponses();
        const client = fakeAuthenticatedOctokit(
            {
                ...responses,
                checks: {
                    ...responses.checks,
                    check_runs: [
                        ...(responses.checks
                            .check_runs as ReadonlyArray<unknown>),
                        { unknown_payload: { provider: "future-ci" } },
                    ],
                },
                failures: new Set<Source>(["workflows"]),
            },
            requests,
        );

        const snapshot = await runtime.pipelineSnapshot.read(client, request);

        expect(snapshot.sourceErrors).toContainEqual(
            expect.objectContaining({
                source: "workflow-runs",
                message: "workflows unavailable",
            }),
        );
        expect(snapshot.diagnostics).toContainEqual(
            expect.objectContaining({
                source: "unknown",
                disposition: "incomplete",
                rawValues: expect.objectContaining({
                    unknown_payload: { provider: "future-ci" },
                }),
            }),
        );
        expect(snapshot.greenCandidate).toBe(false);
        expect(snapshot.reason).toBe("error");
        expect(snapshot.items.map(({ name }) => name)).toContain("legacy");
    });

    test("marks an empty complete collection explicitly non-green", async () => {
        const { snapshot, requests } = await collectFromFake(
            responsesWithChecks([]),
        );

        expect(requests).toHaveLength(4);
        expect(snapshot.state).toBe("empty");
        expect(snapshot.items).toEqual([]);
        expect(snapshot.sourceErrors).toEqual([]);
        expect(snapshot.completenessErrors).toEqual([]);
        expect(snapshot.greenCandidate).toBe(false);
        expect(snapshot.reason).toBe("no-checks");
    });

    test("fails closed independently for pending, failing, and cancelled checks", async () => {
        for (const state of [
            {
                name: "pending-check",
                status: "queued",
                conclusion: null,
                expected: "pending",
            },
            {
                name: "failing-check",
                status: "completed",
                conclusion: "failure",
                expected: "failing",
            },
            {
                name: "cancelled-check",
                status: "completed",
                conclusion: "cancelled",
                expected: "cancelled",
            },
        ] as const) {
            const { snapshot } = await collectFromFake(
                responsesWithChecks([
                    stateCheck(state.name, state.status, state.conclusion),
                ]),
            );
            const item = snapshot.items.find(({ name }) => name === state.name);

            expect(snapshot.sourceErrors).toEqual([]);
            expect(snapshot.completenessErrors).toEqual([]);
            expect(item?.status).toBe(state.expected);
            expect(snapshot.greenCandidate).toBe(false);
        }
    });

    test("fails closed for complete collection with unknown or malformed observations", async () => {
        const responses = completeResponses();
        const checkRuns = responses.checks.check_runs as ReadonlyArray<unknown>;
        const { snapshot } = await collectFromFake({
            ...responses,
            checks: {
                ...responses.checks,
                check_runs: [
                    ...checkRuns,
                    { unknown_payload: { provider: "future-ci" } },
                    {
                        id: 106,
                        name: "malformed-state",
                        app: { slug: "provider-c" },
                        head_sha: sha,
                        head_branch: "main",
                        status: "completed",
                        conclusion: "future",
                    },
                ],
            },
        });

        expect(snapshot.sourceErrors).toEqual([]);
        expect(snapshot.completenessErrors).toContain(
            "Observation has an unknown kind or no stable name.",
        );
        expect(snapshot.diagnostics).toContainEqual(
            expect.objectContaining({
                source: "unknown",
                disposition: "incomplete",
                rawValues: expect.objectContaining({
                    unknown_payload: { provider: "future-ci" },
                }),
            }),
        );
        expect(
            snapshot.items.find(({ name }) => name === "malformed-state")
                ?.status,
        ).toBe("unknown");
        expect(snapshot.greenCandidate).toBe(false);
    });

    test("requires complete collection before accepting all passing or acceptable items", async () => {
        const complete = await collectFromFake(completeResponses());
        expect(complete.snapshot.sourceErrors).toEqual([]);
        expect(complete.snapshot.completenessErrors).toEqual([]);
        expect(complete.snapshot.items.length).toBeGreaterThan(0);
        expect(
            complete.snapshot.items.every(
                ({ status }) => status === "passing" || status === "acceptable",
            ),
        ).toBe(true);
        expect(complete.snapshot.greenCandidate).toBe(true);

        const incomplete = await collectFromFake({
            ...completeResponses(),
            failures: new Set<Source>(["workflows"]),
        });
        expect(incomplete.snapshot.items.length).toBeGreaterThan(0);
        expect(
            incomplete.snapshot.items.every(
                ({ status }) => status === "passing" || status === "acceptable",
            ),
        ).toBe(true);
        expect(incomplete.snapshot.sourceErrors).toContainEqual(
            expect.objectContaining({ source: "workflow-runs" }),
        );
        expect(incomplete.snapshot.greenCandidate).toBe(false);
    });
});