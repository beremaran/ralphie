import { describe, expect, test } from "bun:test";

import { TRUNCATION_MARKER_KEY } from "../../src/github/evidence-budget.ts";
import {
    MAX_CHECK_ANNOTATIONS,
    MAX_JOBS_PER_RUN,
    MAX_STEPS_PER_JOB,
} from "../../src/github/pipeline-diagnostics-contracts.ts";
import {
    ANNOTATIONS_ENVELOPE,
    JOBS_ENVELOPE,
    collectPaginationPages,
    paginateAnnotations,
    paginateCheckRuns,
    paginateJobs,
    paginateSteps,
} from "../../src/github/pipeline-diagnostics-pagination.ts";
import type {
    Endpoint,
    PaginationResult,
} from "../../src/github/pipeline-diagnostics-pagination.ts";
import type { PipelineSnapshotRequestExecutor } from "../../src/github/pipeline-snapshot-collector.ts";

const NEXT_URL = "https://api.github.com/repos/o/r/actions/runs/9/jobs";

const nextLink = (page: number): string =>
    `<${NEXT_URL}?page=${String(page + 1)}>; rel="next", <${NEXT_URL}?page=2>; rel="last"`;

const responseWith = (payload: unknown, link?: string): unknown => ({
    data: payload,
    headers: link === undefined ? {} : { link },
    status: 200,
    url: NEXT_URL,
});

const job = (id: number): unknown => ({
    id,
    name: `job-${String(id)}`,
    status: "completed",
    conclusion: "failure",
});

const step = (number: number): unknown => ({
    number,
    name: `step-${String(number)}`,
    conclusion: "failure",
});

const annotation = (index: number): unknown => ({
    path: "src/main.ts",
    start_line: index,
    message: `annotation-${String(index)}`,
});

const jobsPage = (
    ids: ReadonlyArray<number>,
    link?: string,
    totalCount?: number,
): unknown =>
    responseWith(
        {
            total_count: totalCount ?? ids.length,
            jobs: ids.map(job),
        },
        link,
    );

describe("pipeline diagnostics pagination", () => {
    test("envelope validation: a correct jobs envelope passes", async () => {
        const result = await paginateJobs({
            source: "github.jobs",
            endpoint: async () => jobsPage([1, 2, 3]),
            parameters: { owner: "o", repo: "r", run_id: 9 },
        });
        expect(result.disposition).toBe("ok");
        expect(result.records).toHaveLength(3);
        expect(result.records[0]).toEqual({
            id: 1,
            name: "job-1",
            status: "completed",
            conclusion: "failure",
        });
        expect(result.truncation).toBeUndefined();
        expect(result.error).toBeUndefined();
    });

    test("envelope validation: { data: [] } is malformed for jobs, valid for annotations", async () => {
        const jobs = await paginateJobs({
            source: "github.jobs",
            endpoint: async () => ({ data: [] }),
            parameters: { owner: "o", repo: "r", run_id: 9 },
        });
        expect(jobs.disposition).toBe("malformed");
        expect(jobs.records).toEqual([]);
        expect(jobs.error).toEqual({
            source: "github.jobs",
            disposition: "malformed",
            message:
                "github.jobs response did not contain the expected jobs array.",
        });

        const annotations = await paginateAnnotations({
            source: "github.annotations",
            endpoint: async () => ({ data: [] }),
            parameters: { owner: "o", repo: "r", check_run_id: 9 },
        });
        expect(annotations.disposition).toBe("ok");
        expect(annotations.records).toEqual([]);
        expect(annotations.error).toBeUndefined();
    });

    test("envelope validation: an absent or wrong-typed expected key is malformed", async () => {
        for (const payload of [{}, { jobs: "not-an-array" }, { steps: [] }]) {
            const result = await paginateJobs({
                source: "github.jobs",
                endpoint: async () => responseWith(payload),
                parameters: { owner: "o", repo: "r", run_id: 9 },
            });
            expect(result.disposition).toBe("malformed");
            expect(result.records).toEqual([]);
            expect(result.error?.disposition).toBe("malformed");
        }
    });

    test("envelope validation: annotations accept bare arrays and data-wrapped arrays", async () => {
        const bare = await paginateAnnotations({
            source: "github.annotations",
            endpoint: async () => [annotation(1), annotation(2)],
            parameters: { owner: "o", repo: "r", check_run_id: 9 },
        });
        expect(bare.disposition).toBe("ok");
        expect(bare.records).toHaveLength(2);

        const wrapped = await paginateAnnotations({
            source: "github.annotations",
            endpoint: async () => responseWith([annotation(3)]),
            parameters: { owner: "o", repo: "r", check_run_id: 9 },
        });
        expect(wrapped.disposition).toBe("ok");
        expect(wrapped.records).toHaveLength(1);
    });

    test("page cap: collected prefix plus explicit truncation result, never past the cap", async () => {
        const calls: Array<Record<string, unknown>> = [];
        const endpoint = async (
            parameters: Record<string, unknown>,
        ): Promise<unknown> => {
            calls.push(parameters);
            const page = parameters.page as number;
            return jobsPage(
                [page * 3, page * 3 + 1, page * 3 + 2],
                undefined,
                999,
            );
        };
        const result = await paginateJobs({
            source: "github.jobs",
            endpoint,
            parameters: { owner: "o", repo: "r", run_id: 9 },
            maxPages: 2,
        });

        expect(calls).toHaveLength(2);
        expect(calls[0]).toEqual({
            owner: "o",
            repo: "r",
            run_id: 9,
            page: 1,
            per_page: 100,
        });
        expect(calls[1]).toEqual({
            owner: "o",
            repo: "r",
            run_id: 9,
            page: 2,
            per_page: 100,
        });
        expect(result.disposition).toBe("truncated");
        expect(result.records).toHaveLength(6);
        expect(result.records[0]).toMatchObject({ id: 3 });
        expect(result.records[5]).toMatchObject({ id: 8 });
        expect(result.truncation).toEqual({
            disposition: "truncated",
            count: 6,
        });
        expect(result.error).toBeUndefined();
    });

    test("no link headers: per_page in parameters drives the page size to a full collection", async () => {
        const calls: Array<Record<string, unknown>> = [];
        const endpoint = async (
            parameters: Record<string, unknown>,
        ): Promise<unknown> => {
            calls.push(parameters);
            const page = parameters.page as number;
            if (page === 1)
                return responseWith({
                    total_count: 5,
                    jobs: [job(1), job(2)],
                });
            if (page === 2)
                return responseWith({
                    total_count: 5,
                    jobs: [job(3), job(4)],
                });
            return responseWith({ total_count: 5, jobs: [job(5)] });
        };
        const result = await paginateJobs({
            source: "github.jobs",
            endpoint,
            parameters: { owner: "o", repo: "r", run_id: 9, per_page: 2 },
        });
        // Without the per_page-aware heuristic this would stop after two
        // records (page 1) and report "ok" on a partial collection.
        expect(result.disposition).toBe("ok");
        expect(result.records).toHaveLength(5);
        expect(calls).toHaveLength(3);
        expect(calls[0]).toEqual({
            owner: "o",
            repo: "r",
            run_id: 9,
            per_page: 2,
            page: 1,
        });
        expect(calls[1]).toEqual({
            owner: "o",
            repo: "r",
            run_id: 9,
            per_page: 2,
            page: 2,
        });
        expect(calls[2]).toEqual({
            owner: "o",
            repo: "r",
            run_id: 9,
            per_page: 2,
            page: 3,
        });
    });

    test("page cap: a full-page heuristic triggers pagination until the next page is empty", async () => {
        const responses = [
            { data: { total_count: 4, jobs: [job(1), job(2)] } },
            { data: { total_count: 4, jobs: [job(3), job(4)] } },
            { data: { total_count: 4, jobs: [] } },
        ];
        const result = await collectPaginationPages({
            source: "github.jobs",
            endpoint: async () => responses.shift(),
            envelope: JOBS_ENVELOPE,
            parameters: { owner: "o", repo: "r", run_id: 9, per_page: 2 },
            perPage: 2,
            maxItems: MAX_JOBS_PER_RUN,
        });
        expect(result.disposition).toBe("ok");
        expect(result.records).toHaveLength(4);
    });

    test("item bound: MAX_JOBS_PER_RUN keeps the prefix and drops the rest", async () => {
        const ids = Array.from({ length: 25 }, (_, index) => index + 1);
        const result = await paginateJobs({
            source: "github.jobs",
            endpoint: async () => jobsPage(ids),
            parameters: { owner: "o", repo: "r", run_id: 9 },
        });
        expect(result.disposition).toBe("truncated");
        expect(result.records).toHaveLength(MAX_JOBS_PER_RUN);
        expect(result.records[0]).toMatchObject({ id: 1 });
        expect(result.records[MAX_JOBS_PER_RUN - 1]).toMatchObject({
            id: MAX_JOBS_PER_RUN,
        });
        expect(
            result.records.some(
                (record) => (record as { id?: number }).id === 21,
            ),
        ).toBe(false);
        expect(result.truncation).toEqual({
            disposition: "truncated",
            count: MAX_JOBS_PER_RUN,
        });
    });

    test("item bound: MAX_STEPS_PER_JOB stops at 40 of 50 steps", async () => {
        const steps = Array.from({ length: 50 }, (_, index) => step(index + 1));
        const result = await paginateSteps({
            source: "github.steps",
            endpoint: async () => responseWith({ steps, total_count: 50 }),
            parameters: { owner: "o", repo: "r", run_id: 9, job_id: 7 },
        });
        expect(result.disposition).toBe("truncated");
        expect(result.records).toHaveLength(MAX_STEPS_PER_JOB);
        expect(result.truncation?.count).toBe(MAX_STEPS_PER_JOB);
    });

    test("item bound: MAX_CHECK_ANNOTATIONS stops at 100 of 150 annotations", async () => {
        const annotations = Array.from({ length: 150 }, (_, index) =>
            annotation(index + 1),
        );
        const result = await paginateAnnotations({
            source: "github.annotations",
            endpoint: async () => annotations,
            parameters: { owner: "o", repo: "r", check_run_id: 9 },
        });
        expect(result.disposition).toBe("truncated");
        expect(result.records).toHaveLength(MAX_CHECK_ANNOTATIONS);
        expect(result.truncation?.count).toBe(MAX_CHECK_ANNOTATIONS);
    });

    test("item bound met exactly: no request is made past the bound", async () => {
        const ids = Array.from({ length: 20 }, (_, index) => index + 1);
        let calls = 0;
        const result = await paginateJobs({
            source: "github.jobs",
            endpoint: async () => {
                calls += 1;
                return jobsPage(ids, nextLink(1));
            },
            parameters: { owner: "o", repo: "r", run_id: 9 },
        });
        expect(calls).toBe(1);
        expect(result.disposition).toBe("truncated");
        expect(result.records).toHaveLength(MAX_JOBS_PER_RUN);
        expect(result.truncation).toEqual({
            disposition: "truncated",
            count: MAX_JOBS_PER_RUN,
        });
    });

    test("missing endpoint yields unavailable without crashing", async () => {
        const result = await paginateJobs({
            source: "github.jobs",
            endpoint: undefined as unknown as Endpoint,
            parameters: { owner: "o", repo: "r", run_id: 9 },
        });
        expect(result.disposition).toBe("unavailable");
        expect(result.records).toEqual([]);
        expect(result.error).toEqual({
            source: "github.jobs",
            message: "github.jobs endpoint is not callable.",
            disposition: "unavailable",
        });
        expect(result.truncation).toBeUndefined();
    });

    test("non-callable endpoint yields unavailable", async () => {
        const result = await paginateJobs({
            source: "github.jobs",
            endpoint: "not-a-function" as unknown as Endpoint,
            parameters: { owner: "o", repo: "r", run_id: 9 },
        });
        expect(result.disposition).toBe("unavailable");
        expect(result.error?.disposition).toBe("unavailable");
    });

    test("a non-callable request executor yields unavailable", async () => {
        const result = await paginateJobs({
            source: "github.jobs",
            endpoint: async () => jobsPage([1, 2]),
            parameters: { owner: "o", repo: "r", run_id: 9 },
            request:
                "not-a-function" as unknown as PipelineSnapshotRequestExecutor,
        });
        expect(result.disposition).toBe("unavailable");
        expect(result.records).toEqual([]);
        expect(result.error).toEqual({
            source: "github.jobs",
            message: "github.jobs request executor is not callable.",
            disposition: "unavailable",
        });
    });

    test("a failing transport yields unavailable and keeps the collected prefix", async () => {
        const result = await paginateJobs({
            source: "github.jobs",
            endpoint: async (parameters) => {
                if (parameters.page === 2) throw new Error("rate limited");
                return jobsPage([1], nextLink(1));
            },
            parameters: { owner: "o", repo: "r", run_id: 9 },
        });
        expect(result.disposition).toBe("unavailable");
        expect(result.records).toHaveLength(1);
        expect(result.records[0]).toMatchObject({ id: 1 });
        expect(result.error).toEqual({
            source: "github.jobs",
            message: "rate limited",
            disposition: "unavailable",
        });
    });

    test("a malformed later page keeps the collected prefix", async () => {
        const calls: Array<Record<string, unknown>> = [];
        const result = await paginateJobs({
            source: "github.jobs",
            endpoint: async (parameters) => {
                calls.push(parameters);
                return parameters.page === 1
                    ? jobsPage([1, 2, 3], nextLink(1))
                    : { data: [] };
            },
            parameters: { owner: "o", repo: "r", run_id: 9 },
        });
        expect(calls).toHaveLength(2);
        expect(result.disposition).toBe("malformed");
        expect(result.records).toHaveLength(3);
        expect(result.error?.disposition).toBe("malformed");
    });

    test("transport injection: a spy endpoint records calls and nothing else is fetched", async () => {
        const calls: Array<Record<string, unknown>> = [];
        const parameters = {
            owner: "octo",
            repo: "pipeline",
            run_id: 123,
            per_page: 2,
        };
        const endpoint = async (
            requestParameters: Record<string, unknown>,
        ): Promise<unknown> => {
            calls.push(requestParameters);
            const page = requestParameters.page as number;
            if (page === 3)
                return responseWith({
                    total_count: 5,
                    jobs: [job(5)],
                });
            return jobsPage(page === 1 ? [1, 2] : [3, 4], nextLink(page));
        };
        const result = await paginateJobs({
            source: "github.jobs",
            endpoint,
            parameters,
            perPage: 2,
        });

        expect(result.disposition).toBe("ok");
        expect(result.records).toHaveLength(5);
        expect(calls).toHaveLength(3);
        expect(calls[0]).toEqual({ ...parameters, page: 1 });
        expect(calls[1]).toEqual({ ...parameters, page: 2 });
        expect(calls[2]).toEqual({ ...parameters, page: 3 });
        for (const call of calls) {
            expect(Object.keys(call).sort()).toEqual([
                "owner",
                "page",
                "per_page",
                "repo",
                "run_id",
            ]);
            expect(JSON.stringify(call)).not.toContain(NEXT_URL);
            expect(JSON.stringify(call)).not.toContain("link");
        }
        // Link-header URLs are bounded metadata: they never reach the
        // endpoint call parameters or the collected records.
        expect(JSON.stringify(result.records)).not.toContain(NEXT_URL);
        for (const record of result.records)
            expect(JSON.stringify(record)).not.toContain("href");
    });

    test("transport injection: a request executor carries every request", async () => {
        const executed: Array<unknown> = [];
        const request: PipelineSnapshotRequestExecutor = async (
            endpoint,
            requestParameters,
        ) => {
            executed.push(requestParameters);
            return endpoint(requestParameters);
        };
        const result = await paginateJobs({
            source: "github.jobs",
            endpoint: async () => jobsPage([1, 2]),
            parameters: { owner: "o", repo: "r", run_id: 9 },
            request,
        });
        expect(result.disposition).toBe("ok");
        expect(executed).toHaveLength(1);
        expect(executed[0]).toEqual({
            owner: "o",
            repo: "r",
            run_id: 9,
            page: 1,
            per_page: 100,
        });
    });

    test("check runs helper requires an explicit item bound and stops at it", async () => {
        const result = await paginateCheckRuns({
            source: "github.check-runs",
            endpoint: async () =>
                responseWith({ check_runs: [job(1), job(2)] }),
            parameters: { owner: "o", repo: "r", ref: "a".repeat(40) },
            maxItems: 2,
        });
        expect(result.disposition).toBe("truncated");
        expect(result.records).toHaveLength(2);
        expect(result.truncation).toEqual({
            disposition: "truncated",
            count: 2,
        });
    });

    test("records over the evidence budget are bounded, never dropped whole", async () => {
        const verboseJob = {
            id: 1,
            name: "build",
            log: "x".repeat(MAX_JOBS_PER_RUN * 10_000),
        };
        const result = await paginateJobs({
            source: "github.jobs",
            endpoint: async () => responseWith({ jobs: [verboseJob] }),
            parameters: { owner: "o", repo: "r", run_id: 9 },
        });
        expect(result.disposition).toBe("ok");
        expect(result.records).toHaveLength(1);
        const record = result.records[0] as { log?: unknown };
        const log = record.log as { [TRUNCATION_MARKER_KEY]?: number };
        expect(typeof log[TRUNCATION_MARKER_KEY]).toBe("number");
        expect(log[TRUNCATION_MARKER_KEY]).toBeGreaterThan(0);
        expect(JSON.stringify(result.records).length).toBeLessThan(50_000);
    });
});