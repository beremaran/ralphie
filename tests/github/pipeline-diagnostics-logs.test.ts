import { describe, expect, test } from "bun:test";

import {
    MAX_EXCERPT_BYTES,
    MAX_TOTAL_BYTES,
    type PipelineSnapshotRequest,
} from "../../src/github/pipeline-diagnostics-contracts.ts";
import {
    collectJobLogExcerpts,
    isGithubLogHostAllowed,
    makePipelineDiagnosticsLogsService,
    readBoundedLogBody,
    WORKFLOW_RUN_LOGS_SOURCE,
    type JobLogExcerptJob,
} from "../../src/github/pipeline-diagnostics-logs.ts";

const request: PipelineSnapshotRequest = {
    repository: "owner/repository",
    branch: "main",
    commitSha: "A".repeat(40),
};

const signedUrl =
    "https://pipelines.actions.githubusercontent.com/ab1f3/apis/pipelines/1/jobs/19/signedlogcontent?urlExpires=2026-09-04T00%3A00%3A00Z&urlSignature=abc";

const jobContext = (
    jobId: number,
    overrides: Record<string, unknown> = {},
): JobLogExcerptJob => ({
    provider: "github.workflow-run",
    runId: 900,
    runAttempt: 1,
    jobId,
    rawState: { status: "completed", conclusion: "failure" },
    ...overrides,
});

const redirectResponse = (location: string | undefined): unknown => ({
    status: 302,
    headers: location === undefined ? {} : { Location: location },
});

const collect = (
    jobs: ReadonlyArray<JobLogExcerptJob>,
    endpoint: (parameters: Record<string, unknown>) => Promise<unknown>,
    fetch?: (url: string) => Promise<unknown>,
    options: Record<string, unknown> = {},
) =>
    collectJobLogExcerpts(
        { request, jobs },
        {
            endpoint,
            ...(fetch === undefined ? {} : { fetch }),
            ...(options as object),
        },
    );

const transportError = (status: number, headers?: Record<string, string>) =>
    Object.assign(new Error(`status ${String(status)}`), {
        status,
        response: {
            status,
            ...(headers === undefined ? {} : { headers }),
            data: { message: "bounded response" },
        },
    });

describe("bounded job-log excerpt retrieval", () => {
    test("retrieves a byte-budgeted excerpt with identity linkage and accounting", async () => {
        const resolveCalls: Array<Record<string, unknown>> = [];
        const fetchCalls: string[] = [];
        const result = await collect(
            [jobContext(19, { name: "build" }), jobContext(21)],
            async (parameters) => {
                resolveCalls.push(parameters);
                return redirectResponse(signedUrl);
            },
            async (url) => {
                fetchCalls.push(url);
                return "line one\nline two\n";
            },
        );

        expect(resolveCalls).toEqual([
            { owner: "owner", repo: "repository", job_id: 19 },
            { owner: "owner", repo: "repository", job_id: 21 },
        ]);
        expect(fetchCalls).toEqual([signedUrl, signedUrl]);
        expect(result.errors).toEqual([]);
        expect(result.truncated).toBe(false);
        expect(result.source).toBe(WORKFLOW_RUN_LOGS_SOURCE);
        expect(result.records).toHaveLength(2);
        expect(result.records[0]).toMatchObject({
            jobId: 19,
            runId: 900,
            runAttempt: 1,
            disposition: "ok",
            excerpt: "line one\nline two\n",
            fetchedBytes: 18,
            availableBytes: 18,
        });
        expect(result.records[1]).toMatchObject({
            jobId: 21,
            disposition: "ok",
        });
    });

    test("truncates a per-excerpt body at the byte budget boundary", async () => {
        const byteBody = (length: number) => "x".repeat(length);
        const exact = await collect(
            [jobContext(1)],
            async () => redirectResponse(signedUrl),
            async () => byteBody(MAX_EXCERPT_BYTES),
            { maxExcerptBytes: MAX_EXCERPT_BYTES },
        );
        expect(exact.records[0]).toMatchObject({
            disposition: "ok",
            fetchedBytes: MAX_EXCERPT_BYTES,
            availableBytes: MAX_EXCERPT_BYTES,
        });
        expect(exact.truncated).toBe(false);

        const over = await collect(
            [jobContext(2)],
            async () => redirectResponse(signedUrl),
            async () => byteBody(MAX_EXCERPT_BYTES + 1),
            { maxExcerptBytes: MAX_EXCERPT_BYTES },
        );
        expect(over.records[0]).toMatchObject({
            disposition: "truncated",
            fetchedBytes: MAX_EXCERPT_BYTES,
            availableBytes: MAX_EXCERPT_BYTES + 1,
        });
        expect(over.truncated).toBe(true);
        expect(over.errors[0]).toMatchObject({
            source: WORKFLOW_RUN_LOGS_SOURCE,
            disposition: "truncated",
        });
    });

    test("never splits a code point or exceeds the budget at the boundary", () => {
        const read = readBoundedLogBody("a".repeat(62) + "🙂", 64);
        expect(read.fetchedBytes).toBe(62);
        expect(read.availableBytes).toBe(66);
        expect(read.truncated).toBe(true);
        expect(read.excerpt).toBe("a".repeat(62));

        const fits = readBoundedLogBody("a".repeat(62) + "🙂", 66);
        expect(fits.truncated).toBe(false);
        expect(fits.fetchedBytes).toBe(66);
    });

    test("enforces the total byte budget across several jobs", async () => {
        const fetchCalls: string[] = [];
        const result = await collect(
            [jobContext(1), jobContext(2), jobContext(3)],
            async () => redirectResponse(signedUrl),
            async (url) => {
                fetchCalls.push(url);
                return "y".repeat(100);
            },
            { maxExcerptBytes: 100, maxTotalBytes: 150 },
        );

        expect(result.records.map(({ disposition }) => disposition)).toEqual([
            "ok",
            "truncated",
            "truncated",
        ]);
        expect(result.records[0]).toMatchObject({
            jobId: 1,
            fetchedBytes: 100,
            availableBytes: 100,
        });
        expect(result.records[1]).toMatchObject({
            jobId: 2,
            disposition: "truncated",
            fetchedBytes: 50,
            availableBytes: 100,
            excerpt: "y".repeat(50),
        });
        // The total budget was exhausted, so the third job was never read.
        expect(result.records[2]).toMatchObject({
            jobId: 3,
            disposition: "truncated",
            fetchedBytes: 0,
        });
        expect(result.records[2]).not.toHaveProperty("availableBytes");
        expect(fetchCalls).toHaveLength(2);
        expect(
            result.records.reduce(
                (sum, record) => sum + record.fetchedBytes,
                0,
            ),
        ).toBeLessThanOrEqual(150);
        expect(result.truncated).toBe(true);
        expect(
            result.errors.filter(
                ({ disposition }) => disposition === "truncated",
            ),
        ).toHaveLength(2);
    });

    test("maps endpoint and body transport failures to unavailable", async () => {
        const network = await collect(
            [jobContext(1)],
            async () => Promise.reject(new Error("connection reset")),
            async () => "unreachable",
        );
        expect(network.records[0]?.disposition).toBe("unavailable");
        expect(network.errors[0]).toMatchObject({
            source: WORKFLOW_RUN_LOGS_SOURCE,
            disposition: "unavailable",
        });
        expect(network.records[0]?.fetchedBytes).toBe(0);

        const server = await collect(
            [jobContext(2)],
            async () => Promise.reject(transportError(503)),
            async () => "unreachable",
        );
        expect(server.records[0]?.disposition).toBe("unavailable");

        const non2xxBody = await collect(
            [jobContext(3)],
            async () => redirectResponse(signedUrl),
            async () => ({ status: 500, body: "oops" }),
        );
        expect(non2xxBody.records[0]?.disposition).toBe("unavailable");
    });

    test("classifies 403 rate-limit responses as rate-limited with metadata", async () => {
        const fromEndpoint = await collect(
            [jobContext(1)],
            async () =>
                Promise.reject(
                    transportError(403, {
                        "x-ratelimit-remaining": "0",
                        "x-ratelimit-reset": "1700000000",
                    }),
                ),
            async () => "unreachable",
        );
        expect(fromEndpoint.records[0]?.disposition).toBe("rate-limited");
        expect(fromEndpoint.errors[0]).toMatchObject({
            source: WORKFLOW_RUN_LOGS_SOURCE,
            disposition: "rate-limited",
        });
        expect(fromEndpoint.errors[0]?.rateLimit).toEqual({
            resetAtMs: 1_700_000_000_000,
            remaining: 0,
        });

        const fromBody = await collect(
            [jobContext(2)],
            async () => redirectResponse(signedUrl),
            async () =>
                Promise.reject(
                    transportError(403, {
                        "x-ratelimit-remaining": "0",
                        "retry-after": "30",
                    }),
                ),
        );
        expect(fromBody.records[0]?.disposition).toBe("rate-limited");
        expect(fromBody.errors[0]?.rateLimit).toEqual({
            retryAfterMs: 30_000,
            remaining: 0,
        });
    });

    test("classifies a returned non-2xx endpoint envelope as rate-limited or unavailable", async () => {
        const rateLimited = await collect(
            [jobContext(1)],
            async () => ({
                status: 403,
                headers: { "x-ratelimit-remaining": "0" },
            }),
            async () => "unreachable",
        );
        expect(rateLimited.records[0]?.disposition).toBe("rate-limited");
        expect(rateLimited.errors[0]).toMatchObject({
            source: WORKFLOW_RUN_LOGS_SOURCE,
            disposition: "rate-limited",
        });
        expect(rateLimited.errors[0]?.rateLimit).toEqual({ remaining: 0 });
        expect(rateLimited.records[0]?.fetchedBytes).toBe(0);

        const unavailable = await collect(
            [jobContext(2)],
            async () => ({ status: 503, body: "server error" }),
            async () => "unreachable",
        );
        expect(unavailable.records[0]?.disposition).toBe("unavailable");
        expect(unavailable.errors[0]).toMatchObject({
            source: WORKFLOW_RUN_LOGS_SOURCE,
            disposition: "unavailable",
        });
        expect(unavailable.records[0]?.fetchedBytes).toBe(0);
    });

    test("marks unreadable and missing bodies malformed", async () => {
        const missingBody = await collect(
            [jobContext(1)],
            async () => redirectResponse(signedUrl),
            async () => ({ status: 200 }),
        );
        expect(missingBody.records[0]?.disposition).toBe("malformed");
        expect(missingBody.errors[0]).toMatchObject({
            disposition: "malformed",
            source: WORKFLOW_RUN_LOGS_SOURCE,
        });

        const nonTextBody = await collect(
            [jobContext(2)],
            async () => redirectResponse(signedUrl),
            async () => ({ status: 200, body: 12345 }),
        );
        expect(nonTextBody.records[0]?.disposition).toBe("malformed");
    });

    test("marks a missing or unusable Location redirect malformed", async () => {
        const missing = await collect(
            [jobContext(1)],
            async () => redirectResponse(undefined),
            async () => "irrelevant",
        );
        expect(missing.records[0]?.disposition).toBe("malformed");
        expect(missing.records[0]?.fetchedBytes).toBe(0);

        const unusable = await collect(
            [jobContext(2)],
            async () => redirectResponse("not a url"),
            async () => "irrelevant",
        );
        expect(unusable.records[0]?.disposition).toBe("malformed");

        const plainHttp = await collect(
            [jobContext(3)],
            async () => redirectResponse("http://github.com/logs"),
            async () => "irrelevant",
        );
        expect(plainHttp.records[0]?.disposition).toBe("malformed");
    });

    test("rejects signed blob hosts outside the GitHub allowlist without fetching", async () => {
        const fetchCalls: string[] = [];
        const guarded = await collect(
            [jobContext(1)],
            async () =>
                redirectResponse("https://third-party.invalid/signed/log"),
            async (url) => {
                fetchCalls.push(url);
                return "never delivered";
            },
        );
        expect(guarded.records[0]?.disposition).toBe("unavailable");
        expect(fetchCalls).toEqual([]);
        expect(guarded.errors[0]).toMatchObject({
            disposition: "unavailable",
        });
        expect(
            isGithubLogHostAllowed("pipelines.actions.githubusercontent.com"),
        ).toBe(true);
        expect(isGithubLogHostAllowed("third-party.invalid")).toBe(false);
        expect(isGithubLogHostAllowed("api.github.com")).toBe(true);
    });

    test("never fetches URLs found in job metadata", async () => {
        const resolveCalls: Array<Record<string, unknown>> = [];
        const fetchCalls: string[] = [];
        const metadataUrls = [
            "https://third-party.invalid/job/19",
            "https://third-party.invalid/html",
            "https://api.github.com/repos/owner/repository/actions/jobs/19/logs",
        ];
        const result = await collect(
            [
                jobContext(19, {
                    url: metadataUrls[0],
                    html_url: metadataUrls[1],
                    logs_url: metadataUrls[2],
                }),
            ],
            async (parameters) => {
                resolveCalls.push(parameters);
                return redirectResponse(signedUrl);
            },
            async (url) => {
                fetchCalls.push(url);
                return "log text";
            },
        );

        expect(resolveCalls).toHaveLength(1);
        expect(fetchCalls).toEqual([signedUrl]);
        for (const metadataUrl of metadataUrls)
            expect(fetchCalls).not.toContain(metadataUrl);
        expect(result.records[0]).toMatchObject({
            jobId: 19,
            disposition: "ok",
            excerpt: "log text",
        });
    });

    test("sanitizes terminal controls while preserving credentials verbatim", async () => {
        const body = [
            `\u001b[31mERROR\u001b[0m github_pat_111122223333444455556666`,
            `ghp_aaaaaaaaaaaaaaaaaaaa gho_bbbbbbbbbb ghu_cccccccccc`,
            `ghs_dddddddddd ghr_eeeeeeeeee`,
            "Authorization: Bearer abcdef0123456789",
            "MY_ENV_SECRET=supersecret-value-42",
            `\u001b]8;;https://example.invalid\u0007link\u001b]8;;\u0007 \u0007`,
            "line\u0008 with bell \u0007 and \u001b[1mbold\u001b[0m text",
        ].join("\n");
        const result = await collect(
            [jobContext(1)],
            async () => redirectResponse(signedUrl),
            async () => body,
        );

        const excerpt = result.records[0]?.excerpt ?? "";
        expect(excerpt).not.toContain("\u001b");
        expect(excerpt).not.toContain("\u0007");
        expect(excerpt).not.toContain("\u0008");
        expect(excerpt).not.toContain("]8;;");
        expect(excerpt).toContain("github_pat_111122223333444455556666");
        expect(excerpt).toContain("ghp_aaaaaaaaaaaaaaaaaaaa");
        expect(excerpt).toContain("gho_bbbbbbbbbb");
        expect(excerpt).toContain("ghu_cccccccccc");
        expect(excerpt).toContain("ghs_dddddddddd");
        expect(excerpt).toContain("ghr_eeeeeeeeee");
        expect(excerpt).toContain("Bearer abcdef0123456789");
        expect(excerpt).toContain("MY_ENV_SECRET=supersecret-value-42");
        expect(excerpt).toContain("ERROR");
        expect(result.records[0]?.disposition).toBe("ok");
    });

    test("reports a missing transport as unavailable per job without crashing", async () => {
        const result = await collectJobLogExcerpts(
            { request, jobs: [jobContext(1)] },
            {
                endpoint: async () => redirectResponse(signedUrl),
                ...({} as object),
            },
        );
        expect(result.records).toHaveLength(1);
        expect(result.records[0]).toMatchObject({
            disposition: "unavailable",
            fetchedBytes: 0,
        });
        expect(result.errors[0]).toMatchObject({
            disposition: "unavailable",
            message: expect.stringContaining("transport"),
        });
    });

    test("reports a missing endpoint as unavailable per job", async () => {
        const result = await collectJobLogExcerpts(
            { request, jobs: [jobContext(1)] },
            {},
        );
        expect(result.records[0]).toMatchObject({
            disposition: "unavailable",
        });
        expect(result.errors[0]).toMatchObject({
            disposition: "unavailable",
            message: expect.stringContaining("endpoint"),
        });
    });

    test("supports the explicit read service and Octokit endpoint discovery", async () => {
        const endpoint = async () => redirectResponse(signedUrl);
        const client = {
            rest: { actions: { downloadJobLogsForWorkflowRun: endpoint } },
        } as unknown as import("octokit").Octokit;
        const service = makePipelineDiagnosticsLogsService({
            client,
            fetch: async () => "discovered",
        });
        const result = await service.read({
            request,
            jobs: [jobContext(7)],
        });
        expect(result.records[0]).toMatchObject({
            jobId: 7,
            disposition: "ok",
            excerpt: "discovered",
        });
    });
});