import { describe, expect, test } from "bun:test";

import { TRUNCATION_MARKER_KEY } from "../../src/github/evidence-budget.ts";
import {
    MAX_CHECK_OUTPUT_CHARS,
    MAX_RAW_EVIDENCE,
    type PipelineDiagnostic,
    type PipelineSnapshotRequest,
} from "../../src/github/pipeline-diagnostics-contracts.ts";
import {
    CHECK_RUN_ANNOTATIONS_SOURCE,
    CHECK_RUN_DIAGNOSTIC_SOURCE,
    CHECK_RUN_GET_SOURCE,
    collectCheckRunDiagnostics,
    makeCheckRunDiagnosticsService,
    type CollectedCheckContext,
} from "../../src/github/pipeline-diagnostics-checks.ts";

const request: PipelineSnapshotRequest = {
    repository: "owner/repository",
    branch: "main",
    commitSha: "A".repeat(40),
};

const checkRunDiagnostic = (
    overrides: Partial<PipelineDiagnostic> = {},
): PipelineDiagnostic => ({
    source: "check-run",
    disposition: "selected",
    provider: "github.check-run",
    name: "unit tests",
    checkRunId: 900,
    runId: 918273,
    runAttempt: 2,
    workflowId: 445566,
    jobId: 112233,
    rawState: { status: "completed", conclusion: "failure" },
    rawValues: {
        kind: "check-run",
        id: 900,
        name: "unit tests",
        head_sha: request.commitSha,
        run_id: 918273,
        run_attempt: 2,
        job_id: 112233,
    },
    errors: [],
    ...overrides,
});

const checkResponse = (overrides: Record<string, unknown> = {}): unknown => ({
    data: {
        id: 900,
        head_sha: request.commitSha.toLowerCase(),
        status: "completed",
        conclusion: "failure",
        name: "unit tests",
        started_at: "2026-09-04T00:00:00Z",
        completed_at: "2026-09-04T00:02:00Z",
        url: "https://third-party.invalid/check/900",
        html_url: "https://third-party.invalid/check/html",
        details_url: "https://third-party.invalid/check/details",
        output: {
            title: "unit tests failed",
            summary: "2 tests failed",
            text: "line one\nline two",
            annotations_url: "https://third-party.invalid/annotations",
            unknown_output_field: { preserved: true },
        },
        unknown_check_field: { preserved: true },
        ...overrides,
    },
});

const annotationsPage = (
    annotations: ReadonlyArray<Record<string, unknown>>,
): unknown => ({ data: annotations });

const annotation = (index: number): Record<string, unknown> => ({
    path: "src/main.ts",
    start_line: index,
    start_column: 2,
    end_line: index,
    end_column: 8,
    level: "failure",
    message: `assertion failed ${String(index)}`,
    unknown_annotation_field: { retained: true },
});

const collect = (
    diagnostics: ReadonlyArray<PipelineDiagnostic>,
    getCheck: (parameters: Record<string, unknown>) => Promise<unknown>,
    listAnnotations:
        | ((parameters: Record<string, unknown>) => Promise<unknown>)
        | undefined,
    options: Record<string, unknown> = {},
) =>
    collectCheckRunDiagnostics(
        { request, diagnostics },
        {
            getCheck,
            ...(listAnnotations === undefined ? {} : { listAnnotations }),
            ...(options as object),
        },
    );

const checkValue = (
    records: Awaited<ReturnType<typeof collectCheckRunDiagnostics>>["records"],
): CollectedCheckContext | undefined => {
    const record = records.find((record) => record.kind === "check-run");
    return record?.kind === "check-run"
        ? (record.value as unknown as CollectedCheckContext)
        : undefined;
};

const transportError = (status: number, headers?: Record<string, string>) =>
    Object.assign(new Error(`status ${String(status)}`), {
        status,
        response: {
            status,
            ...(headers === undefined ? {} : { headers }),
            data: { message: "bounded response" },
        },
    });

describe("failing check-run pipeline diagnostics", () => {
    test("collects output and annotations with request and diagnostic identity", async () => {
        const getCalls: Array<Record<string, unknown>> = [];
        const annotationCalls: Array<Record<string, unknown>> = [];
        const result = await collect(
            [checkRunDiagnostic()],
            async (parameters) => {
                getCalls.push(parameters);
                return checkResponse();
            },
            async (parameters) => {
                annotationCalls.push(parameters);
                return annotationsPage([annotation(1), annotation(2)]);
            },
        );

        expect(getCalls).toEqual([
            { owner: "owner", repo: "repository", check_run_id: 900 },
        ]);
        expect(annotationCalls).toEqual([
            {
                owner: "owner",
                repo: "repository",
                check_run_id: 900,
                per_page: 100,
                page: 1,
            },
        ]);
        expect(result.errors).toEqual([]);
        expect(result.truncated).toBe(false);
        expect(result.source).toBe(CHECK_RUN_DIAGNOSTIC_SOURCE);
        expect(result.records.map(({ kind }) => kind)).toEqual([
            "check-run",
            "annotation",
            "annotation",
        ]);

        const value = checkValue(result.records);
        expect(value).toMatchObject({
            provider: "github.check-run",
            commitSha: request.commitSha,
            checkRunId: 900,
            name: "unit tests",
            runId: 918273,
            runAttempt: 2,
            workflowId: 445566,
            jobId: 112233,
            rawState: { status: "completed", conclusion: "failure" },
            diagnostic: checkRunDiagnostic(),
            annotationsTruncated: false,
            output: {
                title: "unit tests failed",
                summary: "2 tests failed",
                text: "line one\nline two",
                annotations_url: "https://third-party.invalid/annotations",
                unknown_output_field: { preserved: true },
            },
            unknown_check_field: { preserved: true },
            url: "https://third-party.invalid/check/900",
        });
        expect(value?.annotations).toHaveLength(2);
        expect(value?.rawValues).toEqual(
            expect.objectContaining({
                checkRunId: 900,
                provider: "github.check-run",
            }),
        );
        expect(JSON.stringify(value?.rawValues).length).toBeLessThanOrEqual(
            MAX_RAW_EVIDENCE,
        );

        const annotations = result.records.filter(
            (record) => record.kind === "annotation",
        );
        expect(annotations[0]).toMatchObject({
            kind: "annotation",
            disposition: "ok",
            value: {
                path: "src/main.ts",
                message: "assertion failed 1",
                startLine: 1,
                startColumn: 2,
                endLine: 1,
                endColumn: 8,
                level: "failure",
                unknown_annotation_field: { retained: true },
            },
        });
        expect(result.records[0]).toMatchObject({
            kind: "check-run",
            disposition: "ok",
        });
    });

    test("selects only failing check-run diagnostics and keeps run/job fields as check metadata", async () => {
        const getCalls: Array<Record<string, unknown>> = [];
        const annotationCalls: Array<Record<string, unknown>> = [];
        const workflowRun = {
            source: "workflow-run",
            disposition: "selected",
            provider: "github.workflow-run",
            name: "CI",
            runId: 900,
            runAttempt: 1,
            rawState: { status: "completed", conclusion: "failure" },
            rawValues: {
                kind: "workflow-run",
                id: 900,
                run_attempt: 1,
                head_sha: request.commitSha,
            },
            errors: [],
        } as unknown as PipelineDiagnostic;
        const passingCheck = checkRunDiagnostic({
            name: "lint",
            rawState: { status: "completed", conclusion: "success" },
            rawValues: { kind: "check-run", id: 901, name: "lint" },
        });
        const missingId = checkRunDiagnostic({ checkRunId: undefined });
        const target = checkRunDiagnostic();

        const result = await collect(
            [workflowRun, passingCheck, missingId, target],
            async (parameters) => {
                getCalls.push(parameters);
                return checkResponse();
            },
            async (parameters) => {
                annotationCalls.push(parameters);
                return annotationsPage([]);
            },
        );

        expect(
            result.records.filter(({ kind }) => kind === "check-run"),
        ).toHaveLength(1);
        expect(getCalls).toHaveLength(1);
        expect(annotationCalls).toHaveLength(1);
        for (const call of [...getCalls, ...annotationCalls]) {
            expect(call).not.toHaveProperty("run_id");
            expect(call).not.toHaveProperty("job_id");
            expect(call).not.toHaveProperty("run_attempt");
        }
        expect(result.errors[0]).toMatchObject({
            source: CHECK_RUN_GET_SOURCE,
            disposition: "malformed",
            message: expect.stringContaining("check-run ID"),
        });
        const value = checkValue(result.records);
        expect(value?.jobId).toBe(112233);
        expect(value?.runId).toBe(918273);
        expect(value?.runAttempt).toBe(2);
    });

    test("never issues a request to a URL found in any payload", async () => {
        const calls: Array<Record<string, unknown>> = [];
        const result = await collect(
            [checkRunDiagnostic()],
            async (parameters) => {
                calls.push(parameters);
                return checkResponse({
                    annotations: [{ path: "inline.ts", message: "inline" }],
                });
            },
            async (parameters) => {
                calls.push(parameters);
                return annotationsPage([annotation(1)]);
            },
        );

        expect(calls).toHaveLength(2);
        const serialized = JSON.stringify(calls);
        expect(serialized).not.toContain("http");
        expect(serialized).not.toContain("third-party");
        const value = checkValue(result.records);
        expect(value?.annotations).toHaveLength(1);
        expect(value?.annotations[0]).toMatchObject({
            path: "src/main.ts",
            message: "assertion failed 1",
        });
        expect(JSON.stringify(value)).toContain("third-party.invalid");
    });

    test("a thin but valid check response never empties the diagnostic raw state", async () => {
        const result = await collect(
            [checkRunDiagnostic()],
            async () => ({
                data: {
                    id: 900,
                    head_sha: request.commitSha.toLowerCase(),
                },
            }),
            async () => annotationsPage([]),
        );
        const value = checkValue(result.records);
        expect(value?.rawState).toEqual({
            status: "completed",
            conclusion: "failure",
        });
        expect(JSON.stringify(value?.rawValues)).not.toBe("{}");
        expect(result.records[0]).toMatchObject({ disposition: "ok" });
    });

    test("captures output summary and text and enforces the aggregate output budget", async () => {
        const manyKeys: Record<string, string> = {};
        for (let i = 0; i < 150; i++)
            manyKeys[`key-${String(i).padStart(3, "0")}`] = "v".repeat(20);
        const bounded = await collect(
            [checkRunDiagnostic()],
            async () => checkResponse({ output: manyKeys }),
            async () => annotationsPage([]),
            { maxOutputChars: 512 },
        );
        const boundedValue = checkValue(bounded.records);
        expect(boundedValue?.output).toEqual(
            expect.objectContaining({
                [TRUNCATION_MARKER_KEY]: expect.any(Number),
            }),
        );
        expect(JSON.stringify(boundedValue?.output).length).toBeLessThanOrEqual(
            512,
        );
        expect(bounded.truncated).toBe(true);
        expect(bounded.records[0]).toMatchObject({ disposition: "truncated" });
        expect(
            bounded.errors.some(
                ({ disposition }) => disposition === "truncated",
            ),
        ).toBe(true);

        const summary = "s".repeat(MAX_CHECK_OUTPUT_CHARS * 2);
        const overBudget = await collect(
            [checkRunDiagnostic()],
            async () => checkResponse({ output: { summary, text: "tail" } }),
            async () => annotationsPage([]),
        );
        expect(overBudget.truncated).toBe(true);
        const overValue = checkValue(overBudget.records);
        expect(JSON.stringify(overValue?.output)).not.toContain("s".repeat(64));
        expect(
            bounded.errors.every(
                ({ source }) => source === CHECK_RUN_GET_SOURCE,
            ),
        ).toBe(true);
    });

    test("non-object output is malformed and cannot bypass the budget unchanged", async () => {
        const nonObject = "x".repeat(MAX_CHECK_OUTPUT_CHARS * 2);
        const result = await collect(
            [checkRunDiagnostic()],
            async () => checkResponse({ output: nonObject }),
            async () => annotationsPage([]),
        );
        const value = checkValue(result.records);
        expect(value?.output).toEqual({ [TRUNCATION_MARKER_KEY]: 1 });
        expect(JSON.stringify(value)).not.toContain("x".repeat(64));
        expect(result.truncated).toBe(true);
        expect(result.records[0]).toMatchObject({ disposition: "truncated" });
        expect(
            result.errors.some(
                ({ disposition }) => disposition === "malformed",
            ),
        ).toBe(true);
        expect(
            result.errors.some(
                ({ disposition }) => disposition === "truncated",
            ),
        ).toBe(true);

        const smallNonObject = await collect(
            [checkRunDiagnostic()],
            async () => checkResponse({ output: "oops" }),
            async () => annotationsPage([]),
        );
        expect(smallNonObject.records[0]).toMatchObject({
            disposition: "malformed",
        });
        expect(smallNonObject.errors[0]?.source).toBe(CHECK_RUN_GET_SOURCE);
        expect(smallNonObject.errors[0]?.disposition).toBe("malformed");
    });

    test("paginates annotations and enforces the annotation count bound", async () => {
        const calls: Array<Record<string, unknown>> = [];
        const many = Array.from({ length: 5 }, (_, index) =>
            annotation(index + 1),
        );
        const result = await collect(
            [checkRunDiagnostic()],
            async () => checkResponse(),
            async (parameters) => {
                calls.push(parameters);
                const page = Number(parameters.page);
                return annotationsPage(many.slice((page - 1) * 2, page * 2));
            },
            { perPage: 2, maxAnnotations: 3 },
        );
        expect(calls).toHaveLength(2);
        expect(calls.map((call) => call.page)).toEqual([1, 2]);
        expect(
            result.records.filter(({ kind }) => kind === "annotation"),
        ).toHaveLength(3);
        expect(result.truncated).toBe(true);
        expect(result.records[0]).toMatchObject({ disposition: "truncated" });
        expect(
            result.errors.some(
                ({ disposition }) => disposition === "truncated",
            ),
        ).toBe(true);
        expect(checkValue(result.records)?.annotations).toHaveLength(3);
    });

    test("missing check IDs fail closed without any request", async () => {
        const calls: Array<Record<string, unknown>> = [];
        const result = await collect(
            [checkRunDiagnostic({ checkRunId: undefined })],
            async (parameters) => {
                calls.push(parameters);
                return checkResponse();
            },
            undefined,
        );
        expect(calls).toHaveLength(0);
        expect(result.records).toEqual([]);
        expect(result.errors[0]).toMatchObject({
            source: CHECK_RUN_GET_SOURCE,
            disposition: "malformed",
            message: expect.stringContaining("check-run ID"),
        });
    });

    test("ID-only and wrong-envelope check responses are malformed without replacing raw state", async () => {
        const cases: ReadonlyArray<Record<string, unknown>> = [
            { data: { id: 900 } },
            { data: { check_run_id: 900 } },
            { data: [] },
            { data: { jobs: [] } },
            { data: { id: 999, head_sha: request.commitSha } },
            { data: { id: 900, head_sha: "b".repeat(40) } },
        ];
        for (const response of cases) {
            const result = await collect(
                [checkRunDiagnostic()],
                async () => response,
                async () => annotationsPage([annotation(1)]),
            );
            expect(result.records[0]).toMatchObject({
                kind: "check-run",
                disposition: "malformed",
            });
            expect(
                result.errors.some(
                    ({ source, disposition }) =>
                        source === CHECK_RUN_GET_SOURCE &&
                        disposition === "malformed",
                ),
            ).toBe(true);
            const value = checkValue(result.records);
            expect(value?.checkRunId).toBe(900);
            expect(value?.rawState).toEqual({
                status: "completed",
                conclusion: "failure",
            });
            expect(JSON.stringify(value?.rawValues)).not.toBe("{}");
            expect(value?.annotations).toHaveLength(1);
        }
    });

    test("partial endpoint failure retains the other bounded evidence", async () => {
        const getFails = await collect(
            [checkRunDiagnostic()],
            async () => Promise.reject(new Error("offline")),
            async () => annotationsPage([annotation(1), annotation(2)]),
        );
        expect(getFails.records[0]).toMatchObject({
            kind: "check-run",
            disposition: "unavailable",
        });
        expect(
            getFails.records[0]?.kind === "check-run"
                ? getFails.records[0].value.annotations
                : undefined,
        ).toHaveLength(2);
        expect(getFails.errors[0]).toMatchObject({
            source: CHECK_RUN_GET_SOURCE,
            disposition: "unavailable",
        });

        const annotationsFail = await collect(
            [checkRunDiagnostic()],
            async () => checkResponse(),
            async () =>
                Promise.reject(
                    transportError(403, {
                        "x-ratelimit-remaining": "0",
                        "x-ratelimit-reset": "1700000000",
                    }),
                ),
        );
        expect(annotationsFail.records[0]).toMatchObject({
            kind: "check-run",
            disposition: "rate-limited",
        });
        const value = checkValue(annotationsFail.records);
        expect(value?.output).toMatchObject({ summary: "2 tests failed" });
        expect(value?.annotations).toHaveLength(0);
        expect(
            annotationsFail.errors.some(
                ({ source, disposition }) =>
                    source === CHECK_RUN_ANNOTATIONS_SOURCE &&
                    disposition === "rate-limited",
            ),
        ).toBe(true);

        const annotationsMissing = await collect(
            [checkRunDiagnostic()],
            async () => checkResponse(),
            undefined,
        );
        expect(annotationsMissing.records[0]).toMatchObject({
            kind: "check-run",
            disposition: "unavailable",
        });
        expect(checkValue(annotationsMissing.records)?.output).toMatchObject({
            text: "line one\nline two",
        });
        expect(annotationsMissing.errors[0]).toMatchObject({
            source: CHECK_RUN_ANNOTATIONS_SOURCE,
            disposition: "unavailable",
        });
    });

    test("missing endpoints surface explicit unavailable errors for every check", async () => {
        const result = await collectCheckRunDiagnostics(
            { request, diagnostics: [checkRunDiagnostic()] },
            {},
        );
        expect(result.records[0]).toMatchObject({
            kind: "check-run",
            disposition: "unavailable",
        });
        expect(result.errors).toHaveLength(2);
        expect(result.errors.map(({ source }) => source)).toEqual([
            CHECK_RUN_GET_SOURCE,
            CHECK_RUN_ANNOTATIONS_SOURCE,
        ]);
        expect(
            result.errors.every(
                ({ disposition }) => disposition === "unavailable",
            ),
        ).toBe(true);
    });

    test("classifies rate-limit, 5xx, and generic failures with bounded raw errors", async () => {
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
        for (const [disposition, getCheck] of cases) {
            const result = await collect(
                [checkRunDiagnostic()],
                getCheck,
                async () => annotationsPage([]),
            );
            expect(result.errors[0]?.disposition).toBe(disposition);
            expect(result.errors[0]?.source).toBe(CHECK_RUN_GET_SOURCE);
            expect(
                JSON.stringify(result.errors[0]?.rawValues).length,
            ).toBeLessThanOrEqual(MAX_RAW_EVIDENCE);
            if (disposition === "rate-limited")
                expect(result.errors[0]?.rateLimit).toBeDefined();
        }
    });

    test("supports the explicit read service and Octokit endpoint discovery", async () => {
        const getCheck = async () => checkResponse();
        const listAnnotations = async () => annotationsPage([annotation(1)]);
        const client = {
            rest: { checks: { get: getCheck, listAnnotations } },
        } as unknown as import("octokit").Octokit;
        const service = makeCheckRunDiagnosticsService({ client });
        const result = await service.read({
            request,
            diagnostics: [checkRunDiagnostic()],
        });
        expect(result.records[0]).toMatchObject({ kind: "check-run" });
        expect(
            result.records.filter(({ kind }) => kind === "annotation"),
        ).toHaveLength(1);
    });
});