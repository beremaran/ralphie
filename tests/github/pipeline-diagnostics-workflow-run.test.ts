import { describe, expect, test } from "bun:test";

import {
    MAX_JOBS_PER_RUN,
    MAX_RAW_EVIDENCE,
    MAX_STEPS_PER_JOB,
    type PipelineDiagnostic,
    type PipelineSnapshotRequest,
} from "../../src/github/pipeline-diagnostics-contracts.ts";
import {
    collectWorkflowRunDiagnostics,
    makeWorkflowRunDiagnosticsService,
    WORKFLOW_RUN_JOBS_SOURCE,
} from "../../src/github/pipeline-diagnostics-workflow-run.ts";

const request: PipelineSnapshotRequest = {
    repository: "owner/repository",
    branch: "main",
    commitSha: "A".repeat(40),
};

const workflowDiagnostic = (
    overrides: Partial<PipelineDiagnostic> = {},
): PipelineDiagnostic => ({
    source: "workflow-run",
    disposition: "selected",
    provider: "github.workflow-run",
    name: "CI",
    runId: 900,
    runAttempt: 1,
    workflowId: 77,
    rawState: { status: "completed", conclusion: "failure" },
    rawValues: {
        kind: "workflow-run",
        name: "CI",
        id: 900,
        run_attempt: 1,
        workflow_id: 77,
        head_sha: request.commitSha,
    },
    errors: [],
    ...overrides,
});

const job = (
    id: number,
    overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
    id,
    run_id: 900,
    run_attempt: 1,
    head_sha: request.commitSha.toLowerCase(),
    name: `job-${String(id)}`,
    status: "completed",
    conclusion: "failure",
    steps: [
        {
            name: "Build",
            number: 1,
            conclusion: "failure",
            started_at: "2026-09-04T00:00:00Z",
            completed_at: "2026-09-04T00:01:00Z",
            unknown_step_field: { preserved: true },
        },
    ],
    ...overrides,
});

const jobsResponse = (
    jobs: ReadonlyArray<Record<string, unknown>>,
    totalCount = jobs.length,
): unknown => ({ data: { total_count: totalCount, jobs } });

const collect = (
    diagnostics: ReadonlyArray<PipelineDiagnostic>,
    endpoint: (parameters: Record<string, unknown>) => Promise<unknown>,
    options: Record<string, unknown> = {},
) =>
    collectWorkflowRunDiagnostics(
        { request, diagnostics },
        { endpoint, ...(options as object) },
    );

describe("workflow-run pipeline diagnostics", () => {
    test("collects jobs and steps with request identity and diagnostic metadata", async () => {
        const calls: Array<Record<string, unknown>> = [];
        const result = await collect(
            [workflowDiagnostic()],
            async (parameters) => {
                calls.push(parameters);
                return jobsResponse([job(1)]);
            },
        );

        expect(calls).toEqual([
            {
                owner: "owner",
                repo: "repository",
                run_id: 900,
                filter: "all",
                per_page: 100,
                page: 1,
            },
        ]);
        expect(result.errors).toEqual([]);
        expect(result.truncated).toBe(false);
        expect(result.records.map(({ kind }) => kind)).toEqual([
            "run",
            "job",
            "step",
        ]);
        expect(result.records[0]).toMatchObject({
            kind: "run",
            disposition: "ok",
            value: {
                provider: "github.workflow-run",
                commitSha: request.commitSha,
                runId: 900,
                runAttempt: 1,
                workflowId: 77,
                diagnostic: workflowDiagnostic(),
            },
        });
        expect(result.records[1]).toMatchObject({
            kind: "job",
            disposition: "ok",
            value: {
                id: 1,
                name: "job-1",
                provider: "github.workflow-run",
                runId: 900,
                runAttempt: 1,
                rawState: { status: "completed", conclusion: "failure" },
                steps: [
                    {
                        name: "Build",
                        number: 1,
                        unknown_step_field: { preserved: true },
                    },
                ],
                diagnostic: workflowDiagnostic(),
            },
        });
        expect(result.records[2]).toMatchObject({
            kind: "step",
            disposition: "ok",
            value: {
                name: "Build",
                number: 1,
                conclusion: "failure",
                startedAt: "2026-09-04T00:00:00Z",
                completedAt: "2026-09-04T00:01:00Z",
                unknown_step_field: { preserved: true },
                diagnostic: workflowDiagnostic(),
            },
        });
    });

    test("filters by source before requesting and never follows payload URLs", async () => {
        const calls: Array<Record<string, unknown>> = [];
        const endpoint = async (parameters: Record<string, unknown>) => {
            calls.push(parameters);
            return jobsResponse([
                job(1, {
                    url: "https://third-party.invalid/job",
                    html_url: "https://third-party.invalid/html",
                    details_url: "https://third-party.invalid/details",
                    steps: [
                        {
                            name: "URL-shaped metadata",
                            number: 1,
                            url: "https://third-party.invalid/step",
                        },
                    ],
                }),
            ]);
        };
        const checkRun = workflowDiagnostic({
            source: "check-run",
            checkRunId: 900,
            rawState: { conclusion: "failure" },
        });
        const result = await collect(
            [checkRun, workflowDiagnostic()],
            endpoint,
        );

        expect(calls).toHaveLength(1);
        expect(calls[0]?.run_id).toBe(900);
        expect(JSON.stringify(result)).toContain("third-party.invalid");
    });

    test("deduplicates only identical full identities, not reruns sharing a run ID", async () => {
        const calls: Array<Record<string, unknown>> = [];
        const first = workflowDiagnostic();
        const duplicate = workflowDiagnostic({
            rawValues: { ...first.rawValues, duplicate_marker: true },
        });
        const rerun = workflowDiagnostic({
            runAttempt: 2,
            rawState: { status: "completed", conclusion: "failure" },
            rawValues: {
                ...first.rawValues,
                run_attempt: 2,
                duplicate_marker: "rerun",
            },
        });
        const endpoint = async (parameters: Record<string, unknown>) => {
            calls.push(parameters);
            return jobsResponse([
                job(calls.length, {
                    run_attempt: calls.length,
                    steps: [],
                }),
            ]);
        };
        const result = await collect([first, duplicate, rerun], endpoint);

        expect(calls).toHaveLength(2);
        expect(
            result.records.filter(({ kind }) => kind === "run"),
        ).toHaveLength(2);
        expect(
            result.records
                .filter((record) => record.kind === "run")
                .map((record) => record.value.runAttempt),
        ).toEqual([1, 2]);
        expect(result.errors).toEqual([]);
    });

    test("paginates through multiple pages and reports a hard page cap", async () => {
        const calls: Array<Record<string, unknown>> = [];
        const result = await collect(
            [workflowDiagnostic()],
            async (parameters) => {
                calls.push(parameters);
                const page = parameters.page;
                return jobsResponse([job(Number(page))], 3);
            },
            { perPage: 1 },
        );

        expect(calls).toHaveLength(3);
        expect(
            result.records.filter(({ kind }) => kind === "job"),
        ).toHaveLength(3);

        const capped = await collect(
            [workflowDiagnostic()],
            async (parameters) => {
                calls.push(parameters);
                return jobsResponse([job(Number(parameters.page))], 100);
            },
            { perPage: 1, maxPages: 2 },
        );
        expect(capped.truncated).toBe(true);
        expect(
            capped.errors.some(
                ({ disposition }) => disposition === "truncated",
            ),
        ).toBe(true);
        expect(
            capped.records.filter(({ kind }) => kind === "job"),
        ).toHaveLength(2);
    });

    test("enforces job and step bounds before retaining the job payload", async () => {
        const overLimitSteps = Array.from(
            { length: MAX_STEPS_PER_JOB + 2 },
            (_, index) => ({
                name: `step-${String(index + 1)}`,
                number: index + 1,
                conclusion: "failure",
            }),
        );
        const overLimitJobs = Array.from(
            { length: MAX_JOBS_PER_RUN + 1 },
            (_, index) =>
                job(index + 1, { steps: index === 0 ? overLimitSteps : [] }),
        );
        const result = await collect([workflowDiagnostic()], async () =>
            jobsResponse(overLimitJobs),
        );
        const jobRecords = result.records.filter(
            (record) => record.kind === "job",
        );
        const first = jobRecords[0];
        expect(jobRecords).toHaveLength(MAX_JOBS_PER_RUN);
        expect(
            first?.kind === "job" ? first.value.steps : undefined,
        ).toHaveLength(MAX_STEPS_PER_JOB);
        expect(result.truncated).toBe(true);
        expect(
            JSON.stringify(first?.kind === "job" ? first.value : undefined),
        ).not.toContain(`step-${String(MAX_STEPS_PER_JOB + 1)}`);
        expect(
            result.errors.filter(
                ({ disposition }) => disposition === "truncated",
            ),
        ).toHaveLength(2);
    });

    test("bounds verbose raw job evidence while retaining its identity and unknown fields", async () => {
        const result = await collect([workflowDiagnostic()], async () =>
            jobsResponse([
                job(1, {
                    unknown_large_field: "x".repeat(MAX_RAW_EVIDENCE * 2),
                    unknown_small_field: { retained: true },
                }),
            ]),
        );
        const jobRecord = result.records.find(
            (record) => record.kind === "job",
        );
        expect(jobRecord?.kind).toBe("job");
        if (jobRecord?.kind !== "job") return;
        expect(jobRecord.value.jobId).toBe(1);
        expect(jobRecord.value.rawValues).toEqual(
            expect.objectContaining({
                unknown_small_field: { retained: true },
            }),
        );
        expect(
            JSON.stringify(jobRecord.value.rawValues).length,
        ).toBeLessThanOrEqual(MAX_RAW_EVIDENCE);
        expect(JSON.stringify(jobRecord.value.rawValues)).not.toContain(
            "x".repeat(64),
        );
    });

    test("keeps malformed jobs and missing step identities visible", async () => {
        const result = await collect([workflowDiagnostic()], async () =>
            jobsResponse([
                job(1, {
                    steps: [
                        { name: "missing number", conclusion: "failure" },
                        { name: "valid", step_number: 2 },
                    ],
                }),
                { run_id: 900, run_attempt: 1, head_sha: request.commitSha },
            ]),
        );

        expect(
            result.records.filter(({ kind }) => kind === "job"),
        ).toHaveLength(1);
        expect(
            result.records.filter(({ kind }) => kind === "step"),
        ).toHaveLength(1);
        expect(result.errors).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    source: WORKFLOW_RUN_JOBS_SOURCE,
                    disposition: "malformed",
                }),
            ]),
        );
        expect(result.records.find(({ kind }) => kind === "run")).toMatchObject(
            {
                disposition: "malformed",
            },
        );
    });

    test("filters wrong-attempt and wrong-SHA jobs instead of attaching them", async () => {
        const result = await collect([workflowDiagnostic()], async () =>
            jobsResponse([
                job(1, { run_attempt: 2 }),
                job(2, { head_sha: `${request.commitSha.slice(0, 39)}0` }),
                job(3),
            ]),
        );
        const jobs = result.records.filter((record) => record.kind === "job");
        expect(jobs).toHaveLength(1);
        expect(jobs[0]?.kind === "job" ? jobs[0].value.jobId : undefined).toBe(
            3,
        );
        expect(result.errors).toHaveLength(2);
        expect(
            result.errors.every(
                ({ disposition }) => disposition === "malformed",
            ),
        ).toBe(true);
    });

    test("requires an attempt and does not request an unsafe latest-attempt lookup", async () => {
        let calls = 0;
        const result = await collect(
            [workflowDiagnostic({ runAttempt: undefined })],
            async () => {
                calls += 1;
                return jobsResponse([job(1)]);
            },
        );
        expect(calls).toBe(0);
        expect(result.records).toEqual([]);
        expect(result.errors[0]).toMatchObject({
            disposition: "malformed",
            message: expect.stringContaining("run attempt"),
        });
    });

    test("classifies unavailable, rate-limited, and server failures with bounded raw errors", async () => {
        const transportError = (
            status: number,
            headers?: Record<string, string>,
        ) =>
            Object.assign(new Error(`status ${String(status)}`), {
                status,
                response: {
                    status,
                    headers,
                    data: { message: "bounded response" },
                },
            });
        const cases = [
            ["unavailable", () => Promise.reject(new Error("offline"))],
            [
                "rate-limited",
                () =>
                    Promise.reject(
                        transportError(403, {
                            "x-ratelimit-remaining": "0",
                            "x-ratelimit-reset": "1700000000",
                        }),
                    ),
            ],
            ["unavailable", () => Promise.reject(transportError(503))],
        ] as const;
        for (const [disposition, endpoint] of cases) {
            const result = await collect([workflowDiagnostic()], endpoint);
            expect(result.errors[0]?.disposition).toBe(disposition);
            expect(result.errors[0]?.source).toBe(WORKFLOW_RUN_JOBS_SOURCE);
            expect(
                JSON.stringify(result.errors[0]?.rawValues).length,
            ).toBeLessThanOrEqual(MAX_RAW_EVIDENCE);
        }
    });

    test("malformed empty envelopes are not successful empty collections", async () => {
        const result = await collect([workflowDiagnostic()], async () => ({
            data: [],
        }));
        expect(
            result.records.filter(({ kind }) => kind === "job"),
        ).toHaveLength(0);
        expect(result.errors[0]).toMatchObject({
            source: WORKFLOW_RUN_JOBS_SOURCE,
            disposition: "malformed",
        });
        expect(result.records.find(({ kind }) => kind === "run")).toMatchObject(
            {
                disposition: "malformed",
            },
        );
    });

    test("supports collection through Octokit endpoint discovery", async () => {
        const endpoint = async () => jobsResponse([job(1)]);
        const client = {
            rest: { actions: { listJobsForWorkflowRun: endpoint } },
        } as unknown as import("octokit").Octokit;
        const service = makeWorkflowRunDiagnosticsService({ client });
        const result = await service.collect({
            request,
            diagnostics: [workflowDiagnostic()],
        });
        expect(
            result.records.filter(({ kind }) => kind === "job"),
        ).toHaveLength(1);
    });
});