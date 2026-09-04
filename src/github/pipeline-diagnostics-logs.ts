/**
 * Bounded GitHub Actions job-log excerpt retriever.
 *
 * This module retrieves bounded text excerpts from the GitHub Actions
 * job-log API (`GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs`,
 * resolved through the Octokit endpoint behind the documented "download job
 * logs for a workflow run" operation) for the typed job records produced by
 * the workflow-run collector (#402). Every request goes through an injected
 * transport: the job-log API call through the shared request seam, and the
 * signed blob the API redirects to through the injected `fetch` seam. No
 * general-purpose URL scraping ever happens, and no URL found in job metadata
 * is dereferenced: the only URL fetched is the `Location` header returned by
 * the job-log API for the exact `job_id` being examined (the documented
 * redirect to the signed blob), and a transport guard rejects any host
 * outside the GitHub allowlist with "unavailable" before a fetch.
 *
 * Byte budgets are enforced by a bounded reader: `MAX_EXCERPT_BYTES` per
 * excerpt and `MAX_TOTAL_BYTES` across all excerpts of one run (shared,
 * exported constants from the contracts module so the artifact step can
 * re-validate). The reader stops retaining bytes once its granted budget is
 * exhausted, so neither budget can be exceeded. Bodies are sanitized through
 * `sanitizeDiagnosticExcerpt` (terminal control sequences only; all supplied
 * values pass through verbatim per the GH-180 unredacted output contract)
 * before they enter the typed record.
 *
 * Every excerpt record carries an explicit disposition
 * (`ok | truncated | unavailable | malformed | rate-limited`) and retrieval
 * never fails silently: budget cuts are "truncated" with the byte counts
 * read/available, malformed redirect envelopes or bodies are "malformed",
 * non-2xx responses (403 rate-limit included) and transport failures are
 * "rate-limited" or "unavailable", and a failure record is always emitted.
 */
import type { Octokit } from "octokit";

import { classifyDiagnosticError } from "./pipeline-diagnostics-errors.ts";
import type { DiagnosticFailureDisposition } from "./pipeline-diagnostics-errors.ts";
import {
    MAX_EXCERPT_BYTES,
    MAX_TOTAL_BYTES,
    type DiagnosticError,
    type DiagnosticRecordDisposition,
    type JobContext,
    type JsonObject,
} from "./pipeline-diagnostics-contracts.ts";
import type {
    PipelineIdentifier,
    PipelineSnapshotRequest,
} from "./pipeline-diagnostics-contracts.ts";
import type { Endpoint } from "./pipeline-diagnostics-pagination.ts";
import { sanitizeDiagnosticExcerpt } from "./pipeline-diagnostics-sanitize.ts";
import type { PipelineSnapshotRequestExecutor } from "./pipeline-snapshot-collector.ts";
import { parseRepositorySlug } from "./repository.ts";

/** Source label carried by job-log dispositions and errors. */
export const WORKFLOW_RUN_LOGS_SOURCE = "github.workflow-run.logs" as const;

/**
 * Hosts permitted for the signed log blob URL returned by the job-log API.
 * The documented redirect targets GitHub-owned blob hosts; the transport
 * guard rejects anything else with "unavailable" before any fetch happens.
 * Each entry permits the exact host and any of its subdomains.
 */
export const GITHUB_LOG_HOST_ALLOWLIST: ReadonlyArray<string> = [
    "github.com",
    "actions.githubusercontent.com",
];

/** One bounded, sanitized log excerpt attached to a job identity. */
export type JobLogExcerptRecord = JsonObject & {
    readonly jobId: PipelineIdentifier;
    readonly runId: PipelineIdentifier;
    readonly runAttempt: PipelineIdentifier;
    readonly disposition: DiagnosticRecordDisposition;
    /** Sanitized, budget-bounded excerpt text; empty when nothing was read. */
    readonly excerpt: string;
    /** UTF-8 bytes of the sanitized body retained in `excerpt`. */
    readonly fetchedBytes: number;
    /** UTF-8 bytes available in the sanitized body; omitted when never read. */
    readonly availableBytes?: number;
};

/**
 * A typed job record (#402) that the log retriever can attach an excerpt to.
 * The attempt is required: the workflow-run collector only emits job records
 * whose run attempt is established, so retrieval never guesses a "latest"
 * attempt.
 */
export type JobLogExcerptJob = JobContext & {
    readonly runAttempt: PipelineIdentifier;
};

/** Input to the bounded job-log excerpt retriever. */
export type JobLogExcerptsInput = {
    readonly request: PipelineSnapshotRequest;
    /** Typed job records (#402) whose excerpts are retrieved, in order. */
    readonly jobs: ReadonlyArray<JobLogExcerptJob>;
    /** Optional caller cancellation signal for every transport boundary. */
    readonly signal?: AbortSignal;
};

/**
 * Injected transport for one signed log blob URL. Returns the delivered body:
 * a plain string, or an object carrying a string under `body` or `data`.
 * Thrown failures are classified through `classifyDiagnosticError`
 * (rate-limit metadata and 5xx statuses included). This seam replaces a
 * general-purpose scraper: the retriever only ever calls it with the
 * `Location` URL returned by the job-log API for the examined job.
 */
export type JobLogFetcher = (
    url: string,
    signal?: AbortSignal,
) => Promise<unknown>;

/** Bounded-read result for one sanitized log body. */
export type BoundedLogRead = {
    /** Sanitized text retained within the budget. */
    readonly excerpt: string;
    /** UTF-8 bytes of the sanitized body captured in `excerpt`. */
    readonly fetchedBytes: number;
    /** UTF-8 bytes of the whole sanitized body delivered by the transport. */
    readonly availableBytes: number;
    /** True when the body exceeded the granted budget. */
    readonly truncated: boolean;
};

/** Injectable dependencies and test-only tighter bounds. */
export type JobLogExcerptsDependencies = {
    /** Explicit `actions.downloadJobLogsForWorkflowRun` endpoint. */
    readonly endpoint?: Endpoint;
    /** Octokit client used only to discover the allowlisted jobs-log endpoint. */
    readonly client?: Octokit;
    /** Request executor used for the job-log API call. */
    readonly request?: PipelineSnapshotRequestExecutor;
    /** Injected transport for the signed blob URL returned by the endpoint. */
    readonly fetch?: JobLogFetcher;
    /** Per-excerpt byte budget; never allowed to exceed MAX_EXCERPT_BYTES. */
    readonly maxExcerptBytes?: number;
    /** Total byte budget; never allowed to exceed MAX_TOTAL_BYTES. */
    readonly maxTotalBytes?: number;
    /** Hosts permitted for the signed blob; defaults to the GitHub allowlist. */
    readonly allowedHosts?: ReadonlyArray<string>;
};

/** Result of one bounded job-log excerpt retrieval for one run. */
export type JobLogExcerptsResult = JsonObject & {
    readonly request: PipelineSnapshotRequest;
    readonly source: string;
    readonly records: ReadonlyArray<JobLogExcerptRecord>;
    /** True when any excerpt was truncated or a budget stopped retrieval. */
    readonly truncated: boolean;
    /** Parallel errors array; every error carries its disposition. */
    readonly errors: ReadonlyArray<DiagnosticError>;
};

/** Service shape matching the repository's explicit read-only services. */
export type JobLogExcerptsService = {
    readonly collect: (
        input: JobLogExcerptsInput,
    ) => Promise<JobLogExcerptsResult>;
    readonly read: (
        input: JobLogExcerptsInput,
    ) => Promise<JobLogExcerptsResult>;
};

type JobOutcome = {
    readonly disposition: DiagnosticRecordDisposition;
    readonly excerpt: string;
    readonly fetchedBytes: number;
    readonly availableBytes?: number;
    readonly error?: DiagnosticError;
};

type ResolveOutcome =
    | { readonly kind: "url"; readonly url: URL }
    | { readonly kind: "outcome"; readonly outcome: JobOutcome };

type PreparedTransport = {
    readonly owner: string;
    readonly repo: string;
    readonly endpoint: unknown;
    readonly endpointCallable: boolean;
    readonly request: PipelineSnapshotRequestExecutor;
    readonly requestCallable: boolean;
    readonly fetch: JobLogFetcher | undefined;
    readonly fetchCallable: boolean;
    readonly maxExcerpt: number;
    readonly maxTotal: number;
    readonly allowedHosts: ReadonlyArray<string>;
};

type CollectionState = {
    readonly records: JobLogExcerptRecord[];
    readonly errors: DiagnosticError[];
    retainedBytes: number;
    truncated: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const requestDirectly: PipelineSnapshotRequestExecutor = async (
    endpoint,
    parameters,
    signal,
) =>
    (endpoint as Endpoint)({
        ...parameters,
        ...(signal === undefined ? {} : { request: { signal } }),
    });

const byteLength = (text: string): number =>
    new TextEncoder().encode(text).length;

/**
 * Bound one sanitized log body to `budget` UTF-8 bytes. Code points are
 * atomic: a code point is retained only when it fits whole, so a truncated
 * excerpt never ends mid-character and never exceeds the budget. The reader
 * stops as soon as the budget is consumed, so retained work is bounded by
 * the budget rather than by the delivered body.
 */
export const readBoundedLogBody = (
    body: string,
    budget: number,
): BoundedLogRead => {
    const availableBytes = byteLength(body);
    if (availableBytes <= budget)
        return {
            excerpt: body,
            fetchedBytes: availableBytes,
            availableBytes,
            truncated: false,
        };
    let excerpt = "";
    let captured = 0;
    for (const codePoint of body) {
        const unit = new TextEncoder().encode(codePoint);
        if (captured + unit.length > budget) break;
        excerpt += codePoint;
        captured += unit.length;
        if (captured >= budget) break;
    }
    return {
        excerpt,
        fetchedBytes: captured,
        availableBytes,
        truncated: true,
    };
};

const locationHeader = (response: unknown): string | undefined => {
    if (!isRecord(response)) return undefined;
    const headers = response.headers;
    if (headers === undefined || headers === null) return undefined;
    const location =
        typeof (headers as { get?: unknown }).get === "function"
            ? (headers as { get: (name: string) => unknown }).get("location")
            : isRecord(headers)
              ? Object.entries(headers).find(
                    ([key]) => key.toLowerCase() === "location",
                )?.[1]
              : undefined;
    return typeof location === "string" && location.trim().length > 0
        ? location.trim()
        : undefined;
};

const responseStatus = (response: unknown): number | undefined => {
    if (!isRecord(response)) return undefined;
    const status = response.status;
    return typeof status === "number" && Number.isFinite(status)
        ? status
        : undefined;
};

const responseBody = (response: unknown): string | undefined => {
    if (typeof response === "string") return response;
    if (!isRecord(response)) return undefined;
    const raw = response.body ?? response.data;
    return typeof raw === "string" ? raw : undefined;
};

/** The GitHub allowlist permits the exact host and any of its subdomains. */
export const isGithubLogHostAllowed = (
    hostname: string,
    allowedHosts: ReadonlyArray<string> = GITHUB_LOG_HOST_ALLOWLIST,
): boolean => {
    const host = hostname.trim().toLowerCase();
    if (host.length === 0) return false;
    return allowedHosts.some((allowed) => {
        const suffix = allowed.trim().toLowerCase();
        return host === suffix || host.endsWith(`.${suffix}`);
    });
};

const diagnosticError = (
    message: string,
    evidence: unknown,
    disposition: DiagnosticFailureDisposition,
): DiagnosticError =>
    classifyDiagnosticError({
        source: WORKFLOW_RUN_LOGS_SOURCE,
        message,
        evidence,
        disposition,
    });

const transportError = (
    message: string,
    evidence: unknown,
    cause: unknown,
): DiagnosticError =>
    classifyDiagnosticError({
        source: WORKFLOW_RUN_LOGS_SOURCE,
        message,
        evidence,
        cause,
    });

const truncatedError = (
    job: JobLogExcerptJob,
    message: string,
    fetchedBytes: number,
    availableBytes: number | undefined,
): DiagnosticError =>
    diagnosticError(
        message,
        {
            jobId: job.jobId,
            runId: job.runId,
            runAttempt: job.runAttempt,
            fetchedBytes,
            ...(availableBytes === undefined ? {} : { availableBytes }),
        },
        "truncated",
    );

/**
 * Failure-closed outcome for a pinned disposition (malformed redirect
 * envelopes, unusable URLs, guard rejections, non-callable seams): the
 * classified disposition is pinned by the caller and never "ok".
 */
const pinnedOutcome = (
    job: JobLogExcerptJob,
    message: string,
    evidence: unknown,
    disposition: DiagnosticFailureDisposition,
): JobOutcome => ({
    disposition,
    excerpt: "",
    fetchedBytes: 0,
    error: diagnosticError(message, evidence, disposition),
});

/**
 * Failure-closed outcome for a transport failure: the cause is introspected
 * so an Octokit 403 rate-limit (or any error carrying rate-limit metadata)
 * is "rate-limited" and a 5xx server error is "unavailable"; anything else
 * is reported "unavailable", never "ok".
 */
const transportOutcome = (
    job: JobLogExcerptJob,
    message: string,
    evidence: unknown,
    cause: unknown,
): JobOutcome => {
    const error = transportError(message, evidence, cause);
    return {
        disposition:
            error.disposition === "rate-limited"
                ? "rate-limited"
                : "unavailable",
        excerpt: "",
        fetchedBytes: 0,
        error,
    };
};

const recordFor = (
    job: JobLogExcerptJob,
    outcome: JobOutcome,
): JobLogExcerptRecord => ({
    jobId: job.jobId,
    runId: job.runId,
    runAttempt: job.runAttempt,
    disposition: outcome.disposition,
    excerpt: outcome.excerpt,
    fetchedBytes: outcome.fetchedBytes,
    ...(outcome.availableBytes === undefined
        ? {}
        : { availableBytes: outcome.availableBytes }),
});

const appendOutcome = (
    state: CollectionState,
    job: JobLogExcerptJob,
    outcome: JobOutcome,
): void => {
    state.records.push(recordFor(job, outcome));
    if (outcome.error !== undefined) state.errors.push(outcome.error);
    if (outcome.disposition === "truncated") state.truncated = true;
};

const endpointFor = (dependencies: JobLogExcerptsDependencies): unknown => {
    if (dependencies.endpoint !== undefined) return dependencies.endpoint;
    const actions =
        dependencies.client === undefined
            ? undefined
            : (
                  dependencies.client as unknown as {
                      readonly rest?: {
                          readonly actions?: {
                              readonly downloadJobLogsForWorkflowRun?: unknown;
                          };
                      };
                  }
              ).rest?.actions;
    return actions?.downloadJobLogsForWorkflowRun ?? undefined;
};

const resolveLocation = async (
    job: JobLogExcerptJob,
    transport: PreparedTransport,
    signal?: AbortSignal,
): Promise<ResolveOutcome> => {
    if (!transport.endpointCallable)
        return {
            kind: "outcome",
            outcome: pinnedOutcome(
                job,
                "job-log endpoint is not callable.",
                { jobId: job.jobId },
                "unavailable",
            ),
        };
    if (!transport.requestCallable)
        return {
            kind: "outcome",
            outcome: pinnedOutcome(
                job,
                "job-log request executor is not callable.",
                { jobId: job.jobId },
                "unavailable",
            ),
        };
    let response: unknown;
    try {
        response = await transport.request(
            transport.endpoint as Endpoint,
            { owner: transport.owner, repo: transport.repo, job_id: job.jobId },
            signal,
        );
    } catch (cause) {
        if (signal?.aborted === true) throw cause;
        return {
            kind: "outcome",
            outcome: transportOutcome(
                job,
                "job-log request failed.",
                { jobId: job.jobId },
                cause,
            ),
        };
    }
    const status = responseStatus(response);
    if (status !== undefined && (status < 200 || status >= 400))
        return {
            kind: "outcome",
            outcome: transportOutcome(
                job,
                `job-log endpoint responded with a non-success status ${String(status)}.`,
                { jobId: job.jobId, status },
                response,
            ),
        };
    const location = locationHeader(response);
    if (location === undefined)
        return {
            kind: "outcome",
            outcome: pinnedOutcome(
                job,
                "job-log response did not include the documented Location redirect.",
                { jobId: job.jobId },
                "malformed",
            ),
        };
    let parsed: URL;
    try {
        parsed = new URL(location);
    } catch {
        return {
            kind: "outcome",
            outcome: pinnedOutcome(
                job,
                "job-log Location header is not a usable URL.",
                { jobId: job.jobId, location },
                "malformed",
            ),
        };
    }
    if (parsed.protocol !== "https:")
        return {
            kind: "outcome",
            outcome: pinnedOutcome(
                job,
                "job-log Location header is not an https URL.",
                { jobId: job.jobId, location },
                "malformed",
            ),
        };
    return { kind: "url", url: parsed };
};

const fetchJobOutcome = async (
    job: JobLogExcerptJob,
    granted: number,
    transport: PreparedTransport,
    signal?: AbortSignal,
): Promise<JobOutcome> => {
    const resolved = await resolveLocation(job, transport, signal);
    if (resolved.kind === "outcome") return resolved.outcome;
    const url = resolved.url;
    if (!isGithubLogHostAllowed(url.hostname, transport.allowedHosts))
        return pinnedOutcome(
            job,
            "Signed job-log URL host is outside the GitHub allowlist and was never fetched.",
            { jobId: job.jobId, host: url.hostname },
            "unavailable",
        );
    if (!transport.fetchCallable)
        return pinnedOutcome(
            job,
            "job-log transport is not callable.",
            { jobId: job.jobId },
            "unavailable",
        );
    let delivered: unknown;
    try {
        delivered = await transport.fetch!(url.toString(), signal);
    } catch (cause) {
        if (signal?.aborted === true) throw cause;
        return transportOutcome(
            job,
            "job-log body fetch failed.",
            { jobId: job.jobId },
            cause,
        );
    }
    const status = responseStatus(delivered);
    if (status !== undefined && (status < 200 || status >= 300))
        return transportOutcome(
            job,
            `job-log body responded with a non-success status ${String(status)}.`,
            { jobId: job.jobId, status },
            delivered,
        );
    const body = responseBody(delivered);
    if (body === undefined)
        return pinnedOutcome(
            job,
            "job-log body is not readable text.",
            { jobId: job.jobId },
            "malformed",
        );
    const read = readBoundedLogBody(sanitizeDiagnosticExcerpt(body), granted);
    return {
        disposition: read.truncated ? "truncated" : "ok",
        excerpt: read.excerpt,
        fetchedBytes: read.fetchedBytes,
        availableBytes: read.availableBytes,
        ...(read.truncated
            ? {
                  error: truncatedError(
                      job,
                      `Job ${String(job.jobId)} log excerpt was truncated to ${String(read.fetchedBytes)} of ${String(read.availableBytes)} budgeted bytes.`,
                      read.fetchedBytes,
                      read.availableBytes,
                  ),
              }
            : {}),
    };
};

const collectJob = async (
    state: CollectionState,
    job: JobLogExcerptJob,
    transport: PreparedTransport,
    signal?: AbortSignal,
): Promise<void> => {
    signal?.throwIfAborted();
    const remaining = transport.maxTotal - state.retainedBytes;
    if (remaining <= 0) {
        appendOutcome(state, job, {
            disposition: "truncated",
            excerpt: "",
            fetchedBytes: 0,
            error: truncatedError(
                job,
                `Job ${String(job.jobId)} log excerpt was not read: the ${String(transport.maxTotal)}-byte total budget is exhausted.`,
                0,
                undefined,
            ),
        });
        return;
    }
    const outcome = await fetchJobOutcome(
        job,
        Math.min(transport.maxExcerpt, remaining),
        transport,
        signal,
    );
    state.retainedBytes += outcome.fetchedBytes;
    appendOutcome(state, job, outcome);
};

const boundedLimit = (value: number | undefined, maximum: number): number => {
    if (value === undefined) return maximum;
    if (!Number.isSafeInteger(value) || value <= 0)
        throw new RangeError(
            `diagnostics limit must be a positive safe integer; received ${String(value)}.`,
        );
    return Math.min(value, maximum);
};

const collectWithDependencies = async (
    input: JobLogExcerptsInput,
    dependencies: JobLogExcerptsDependencies,
): Promise<JobLogExcerptsResult> => {
    input.signal?.throwIfAborted();
    const { owner, name: repo } = parseRepositorySlug(input.request.repository);
    const endpoint = endpointFor(dependencies);
    const request = dependencies.request ?? requestDirectly;
    const fetch = dependencies.fetch;
    const transport: PreparedTransport = {
        owner,
        repo,
        endpoint,
        endpointCallable: typeof endpoint === "function",
        request,
        requestCallable: typeof request === "function",
        fetch,
        fetchCallable: typeof fetch === "function",
        maxExcerpt: boundedLimit(
            dependencies.maxExcerptBytes,
            MAX_EXCERPT_BYTES,
        ),
        maxTotal: boundedLimit(dependencies.maxTotalBytes, MAX_TOTAL_BYTES),
        allowedHosts: dependencies.allowedHosts ?? GITHUB_LOG_HOST_ALLOWLIST,
    };
    const state: CollectionState = {
        records: [],
        errors: [],
        retainedBytes: 0,
        truncated: false,
    };
    for (const job of input.jobs) {
        input.signal?.throwIfAborted();
        await collectJob(state, job, transport, input.signal);
    }
    return {
        request: input.request,
        source: WORKFLOW_RUN_LOGS_SOURCE,
        records: state.records,
        truncated: state.truncated,
        errors: state.errors,
    } as unknown as JobLogExcerptsResult;
};

/**
 * Retrieve bounded, sanitized job-log excerpts for the given typed job
 * records, enforcing the per-excerpt and per-run byte budgets through the
 * injected transport.
 */
export const collectJobLogExcerpts = (
    input: JobLogExcerptsInput,
    dependencies: JobLogExcerptsDependencies = {},
): Promise<JobLogExcerptsResult> =>
    collectWithDependencies(input, dependencies);

/** Alias emphasizing that the retriever returns bounded excerpts per job. */
export const collectJobLogExcerptsForJobs = collectJobLogExcerpts;

/** Factory for the job-log excerpt read service. */
export const makePipelineDiagnosticsLogsService = (
    dependencies: JobLogExcerptsDependencies = {},
): JobLogExcerptsService => {
    const collect = (input: JobLogExcerptsInput) =>
        collectWithDependencies(input, dependencies);
    return { collect, read: collect };
};

/** Compatibility alias naming the retriever rather than the service. */
export const makeJobLogExcerptRetriever = makePipelineDiagnosticsLogsService;