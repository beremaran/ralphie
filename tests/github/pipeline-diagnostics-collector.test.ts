import { describe, expect, test } from "bun:test";

import {
    CHECK_RUN_ANNOTATIONS_SOURCE,
    CHECK_RUN_GET_SOURCE,
} from "../../src/github/pipeline-diagnostics-checks.ts";
import {
    MAX_CHECK_OUTPUT_CHARS,
    MAX_JOBS_PER_RUN,
    MAX_RAW_EVIDENCE,
    type PipelineDiagnostic,
    type PipelineSnapshot,
    type PipelineSnapshotRequest,
} from "../../src/github/pipeline-diagnostics-contracts.ts";
import {
    PIPELINE_DIAGNOSTICS_COLLECTOR_SOURCE,
    collectPipelineDiagnostics,
    makePipelineDiagnosticsService,
} from "../../src/github/pipeline-diagnostics-collector.ts";
import { WORKFLOW_RUN_JOBS_SOURCE } from "../../src/github/pipeline-diagnostics-workflow-run.ts";

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
    runId: 100,
    runAttempt: 1,
    workflowId: 10,
    rawState: { status: "completed", conclusion: "failure" },
    rawValues: {
        kind: "workflow-run",
        id: 100,
        run_attempt: 1,
        workflow_id: 10,
        head_sha: request.commitSha,
    },
    errors: [],
    ...overrides,
});

const checkDiagnostic = (
    overrides: Partial<PipelineDiagnostic> = {},
): PipelineDiagnostic => ({
    source: "check-run",
    disposition: "selected",
    provider: "github.check-run",
    name: "unit tests",
    checkRunId: 200,
    runId: 100,
    runAttempt: 1,
    workflowId: 10,
    jobId: 300,
    rawState: { status: "completed", conclusion: "failure" },
    rawValues: {
        kind: "check-run",
        id: 200,
        head_sha: request.commitSha,
        run_id: 100,
        run_attempt: 1,
        job_id: 300,
    },
    errors: [],
    ...overrides,
});

const snapshotFor = (
    diagnostics: ReadonlyArray<PipelineDiagnostic>,
): PipelineSnapshot =>
    ({
        ...request,
        state: diagnostics.length === 0 ? "empty" : "non-empty",
        items: [],
        sourceErrors: [],
        completenessErrors: [],
        diagnostics,
        reason: "failure",
        greenCandidate: false,
        fingerprint: "snapshot-fingerprint",
    }) as PipelineSnapshot;

const observationFor = (
    snapshot: PipelineSnapshot,
): {
    readonly kind: "failed";
    readonly observedSha: string;
    readonly reason: "failing";
    readonly snapshot: PipelineSnapshot;
    readonly elapsedMs: number;
    readonly polls: number;
} => ({
    kind: "failed",
    observedSha: request.commitSha.toLowerCase(),
    reason: "failing",
    snapshot,
    elapsedMs: 10,
    polls: 1,
});

const jobFor = (
    runId: number,
    runAttempt: number,
    id: number,
    extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
    id,
    run_id: runId,
    run_attempt: runAttempt,
    head_sha: request.commitSha.toLowerCase(),
    name: `job-${String(id)}`,
    status: "completed",
    conclusion: "failure",
    steps: [{ name: "test", number: 1, conclusion: "failure" }],
    ...extra,
});

const jobResponse = (
    jobs: ReadonlyArray<Record<string, unknown>>,
    totalCount = jobs.length,
): unknown => ({ data: { total_count: totalCount, jobs } });

const checkResponse = (
    checkRunId: number,
    extra: Record<string, unknown> = {},
): unknown => ({
    data: {
        id: checkRunId,
        head_sha: request.commitSha.toLowerCase(),
        name: `check-${String(checkRunId)}`,
        status: "completed",
        conclusion: "failure",
        output: { summary: "failure", text: "details" },
        ...extra,
    },
});

const annotationsResponse = (
    annotations: ReadonlyArray<Record<string, unknown>> = [],
): unknown => ({ data: annotations });

describe("composed pipeline diagnostics collector", () => {
    test("routes sources before deduplication and never follows third-party URLs", async () => {
        const calls: Array<{
            readonly endpoint: string;
            readonly parameters: Record<string, unknown>;
        }> = [];
        const workflow = workflowDiagnostic();
        const check = checkDiagnostic();
        const client = {
            rest: {
                actions: {
                    listJobsForWorkflowRun: async (
                        parameters: Record<string, unknown>,
                    ) => {
                        calls.push({ endpoint: "jobs", parameters });
                        return jobResponse([
                            jobFor(100, 1, 301, {
                                url: "https://third-party.invalid/job",
                                html_url: "https://third-party.invalid/html",
                                details_url:
                                    "https://third-party.invalid/details",
                            }),
                        ]);
                    },
                },
                checks: {
                    get: async (parameters: Record<string, unknown>) => {
                        calls.push({ endpoint: "get", parameters });
                        return checkResponse(200, {
                            url: "https://third-party.invalid/check",
                            details_url: "https://third-party.invalid/details",
                        });
                    },
                    listAnnotations: async (
                        parameters: Record<string, unknown>,
                    ) => {
                        calls.push({ endpoint: "annotations", parameters });
                        return annotationsResponse([
                            {
                                path: "src/test.ts",
                                message: "failure",
                                url: "https://third-party.invalid/annotation",
                            },
                        ]);
                    },
                },
            },
        } as unknown as import("octokit").Octokit;
        const result = await collectPipelineDiagnostics(
            {
                request,
                observation: observationFor(snapshotFor([workflow, check])),
            },
            { client },
        );

        expect(calls.map(({ endpoint }) => endpoint)).toEqual([
            "jobs",
            "get",
            "annotations",
        ]);
        expect(calls.map(({ parameters }) => parameters)).toEqual([
            expect.objectContaining({ run_id: 100 }),
            expect.objectContaining({ check_run_id: 200 }),
            expect.objectContaining({ check_run_id: 200 }),
        ]);
        expect(result.source).toBe(PIPELINE_DIAGNOSTICS_COLLECTOR_SOURCE);
        expect(result.errors).toEqual([]);
        expect(result.records.map(({ kind }) => kind)).toEqual([
            "run",
            "job",
            "step",
            "check-run",
            "annotation",
        ]);
        expect(result.records[4]).toMatchObject({
            kind: "annotation",
            value: {
                provider: "github.check-run",
                commitSha: request.commitSha,
                checkRunId: 200,
                runId: 100,
                runAttempt: 1,
                jobId: 300,
            },
        });
        expect(JSON.stringify(calls)).not.toContain("third-party.invalid");
        expect(JSON.stringify(result)).toContain("third-party.invalid");
    });

    test("uses diagnostic order for output even when check diagnostics carry run identity", async () => {
        const firstCheck = checkDiagnostic({ checkRunId: 201, jobId: 301 });
        const workflow = workflowDiagnostic();
        const calls: string[] = [];
        const result = await collectPipelineDiagnostics(
            {
                request,
                diagnostics: [firstCheck, workflow],
            },
            {
                checks: {
                    getCheck: async () => {
                        calls.push("get");
                        return checkResponse(201);
                    },
                    listAnnotations: async () => {
                        calls.push("annotations");
                        return annotationsResponse();
                    },
                },
                jobs: {
                    endpoint: async () => {
                        calls.push("jobs");
                        return jobResponse([jobFor(100, 1, 301)]);
                    },
                },
            },
        );

        expect(calls).toEqual(["jobs", "get", "annotations"]);
        expect(result.records.map(({ kind }) => kind)).toEqual([
            "check-run",
            "run",
            "job",
            "step",
        ]);
        expect(
            result.records.find(({ kind }) => kind === "check-run"),
        ).toMatchObject({
            value: {
                checkRunId: 201,
                runId: 100,
                runAttempt: 1,
                jobId: 301,
            },
        });
    });

    test("keeps check-run contexts separate across attempts and preserves diagnostic metadata", async () => {
        const first = checkDiagnostic({ runAttempt: 1, jobId: 301 });
        const second = checkDiagnostic({ runAttempt: 2, jobId: 302 });
        const calls: number[] = [];
        const result = await collectPipelineDiagnostics(
            { request, diagnostics: [first, second] },
            {
                checks: {
                    getCheck: async (parameters) => {
                        calls.push(Number(parameters.check_run_id));
                        return checkResponse(200);
                    },
                    listAnnotations: async () => annotationsResponse(),
                },
            },
        );

        expect(calls).toEqual([200, 200]);
        const checks = result.records.filter(
            ({ kind }) => kind === "check-run",
        );
        expect(checks).toHaveLength(2);
        expect(
            checks.map((record) =>
                record.kind === "check-run"
                    ? record.value.runAttempt
                    : undefined,
            ),
        ).toEqual([1, 2]);
        expect(
            checks.map((record) =>
                record.kind === "check-run" ? record.value.jobId : undefined,
            ),
        ).toEqual([301, 302]);
    });

    test("propagates bounds and keeps raw evidence bounded at the aggregate boundary", async () => {
        const result = await collectPipelineDiagnostics(
            {
                request,
                diagnostics: [workflowDiagnostic(), checkDiagnostic()],
            },
            {
                jobs: {
                    endpoint: async () =>
                        jobResponse(
                            Array.from(
                                { length: MAX_JOBS_PER_RUN + 1 },
                                (_, index) =>
                                    jobFor(100, 1, index + 1, {
                                        unknown_large_field: "x".repeat(
                                            MAX_RAW_EVIDENCE * 2,
                                        ),
                                    }),
                            ),
                        ),
                },
                checks: {
                    getCheck: async () =>
                        checkResponse(200, {
                            output: {
                                summary: "s".repeat(MAX_CHECK_OUTPUT_CHARS * 2),
                            },
                        }),
                    listAnnotations: async () => annotationsResponse(),
                },
            },
        );

        expect(result.truncated).toBe(true);
        expect(
            result.errors.some(
                ({ disposition }) => disposition === "truncated",
            ),
        ).toBe(true);
        const jobs = result.records.filter(({ kind }) => kind === "job");
        expect(jobs).toHaveLength(MAX_JOBS_PER_RUN);
        for (const record of result.records) {
            if (record.kind === "job")
                expect(
                    JSON.stringify(record.value.rawValues).length,
                ).toBeLessThanOrEqual(MAX_RAW_EVIDENCE);
        }
        const check = result.records.find(({ kind }) => kind === "check-run");
        expect(check?.kind).toBe("check-run");
        if (check?.kind === "check-run")
            expect(JSON.stringify(check.value.output)).not.toContain(
                "s".repeat(64),
            );
    });

    test("returns malformed instead of successful empty output when snapshot or diagnostics are absent", async () => {
        let calls = 0;
        const result = await collectPipelineDiagnostics(
            { request },
            {
                jobs: {
                    endpoint: async () => {
                        calls += 1;
                        return jobResponse([]);
                    },
                },
            },
        );

        expect(calls).toBe(0);
        expect(result.records).toEqual([]);
        expect(result.errors).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    source: PIPELINE_DIAGNOSTICS_COLLECTOR_SOURCE,
                    disposition: "malformed",
                }),
            ]),
        );
    });

    test("sorts shared-source errors with identity and canonical bounded evidence", async () => {
        const first = workflowDiagnostic({ runId: 100, runAttempt: 1 });
        const second = workflowDiagnostic({
            runId: 101,
            runAttempt: 1,
            rawValues: {
                kind: "workflow-run",
                id: 101,
                run_attempt: 1,
                head_sha: request.commitSha,
            },
        });
        const run = await collectPipelineDiagnostics(
            { request, diagnostics: [second, first] },
            {
                jobs: {
                    endpoint: async () => Promise.reject(new Error("offline")),
                },
            },
        );
        const errors = run.errors.filter(
            ({ source }) => source === WORKFLOW_RUN_JOBS_SOURCE,
        );
        expect(errors).toHaveLength(2);
        expect(errors.map((error) => error.rawValues)).toEqual(
            [...errors]
                .sort((left, right) =>
                    JSON.stringify(left.rawValues).localeCompare(
                        JSON.stringify(right.rawValues),
                    ),
                )
                .map((error) => error.rawValues),
        );
    });

    test("retains each child disposition without failing open", async () => {
        const malformedResult = await collectPipelineDiagnostics(
            { request, diagnostics: [checkDiagnostic()] },
            {
                checks: {
                    getCheck: async () => ({ data: [] }),
                    listAnnotations: async () => annotationsResponse(),
                },
            },
        );
        expect(malformedResult.errors).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    source: CHECK_RUN_GET_SOURCE,
                    disposition: "malformed",
                }),
            ]),
        );
        expect(malformedResult.records[0]).toMatchObject({
            kind: "check-run",
            disposition: "malformed",
        });

        const rateLimitedResult = await collectPipelineDiagnostics(
            { request, diagnostics: [checkDiagnostic()] },
            {
                checks: {
                    getCheck: async () =>
                        Promise.reject(
                            Object.assign(new Error("rate limited"), {
                                status: 403,
                                response: {
                                    status: 403,
                                    headers: { "x-ratelimit-remaining": "0" },
                                },
                            }),
                        ),
                    listAnnotations: async () => annotationsResponse(),
                },
            },
        );
        expect(rateLimitedResult.errors).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    source: CHECK_RUN_GET_SOURCE,
                    disposition: "rate-limited",
                }),
            ]),
        );

        const unavailableResult = await collectPipelineDiagnostics(
            { request, diagnostics: [workflowDiagnostic()] },
            { jobs: {} },
        );
        expect(unavailableResult.errors).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    source: WORKFLOW_RUN_JOBS_SOURCE,
                    disposition: "unavailable",
                }),
            ]),
        );

        const truncatedResult = await collectPipelineDiagnostics(
            { request, diagnostics: [checkDiagnostic()] },
            {
                checks: {
                    getCheck: async () => checkResponse(200),
                    listAnnotations: async () =>
                        annotationsResponse([
                            { path: "a", message: "one" },
                            { path: "b", message: "two" },
                        ]),
                    maxAnnotations: 1,
                },
            },
        );
        expect(truncatedResult.errors).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    source: CHECK_RUN_ANNOTATIONS_SOURCE,
                    disposition: "truncated",
                }),
            ]),
        );
        expect(truncatedResult.truncated).toBe(true);
    });

    test("exposes the explicit read service", async () => {
        const service = makePipelineDiagnosticsService({
            checks: {
                getCheck: async () => checkResponse(200),
                listAnnotations: async () => annotationsResponse(),
            },
        });
        const result = await service.read({
            request,
            diagnostics: [checkDiagnostic()],
        });
        expect(result.records[0]).toMatchObject({
            kind: "check-run",
            disposition: "ok",
        });
    });
});