/**
 * Envelope-validating, transport-injected pagination helpers for the GitHub
 * Actions pipeline diagnostics collector (runs -> jobs -> steps -> check
 * runs -> annotations).
 *
 * Every helper receives an explicit Octokit endpoint function (and
 * optionally a request executor shaped like `PipelineSnapshotRequestExecutor`)
 * and ALL requests go through it: no helper constructs, fetches, or follows
 * a URL. Link headers are bounded untrusted metadata read only as a boolean
 * "is there a next page" signal; their URLs are never parsed or dereferenced
 * (failure-closed transport). Every request carries the helper's page size
 * as `per_page`, so the served page size and the next-page heuristic always
 * agree and collection never silently stops on a partial page.
 *
 * Each call validates the response envelope against the expected shape, so a
 * wrong or absent expected key (e.g. `{ data: [] }` for jobs instead of
 * `{ jobs: [...] }`) is reported as malformed, never as an empty success.
 * Collection is bounded by the hard page cap `MAX_PAGINATION_PAGES` and the
 * endpoint's item bound; when a cap or bound is reached, collection stops and
 * returns the collected prefix plus an explicit "truncated" result with its
 * count. Partial evidence is never thrown away, and every collected record is
 * bounded through the shared evidence budget (`budgetRawEvidence`), so no
 * record exceeds `MAX_RAW_EVIDENCE`. A missing or non-callable endpoint
 * surfaces an "unavailable" result instead of crashing the collection, and a
 * result never looks complete when any page failed.
 */
import { budgetRawEvidence } from "./evidence-budget.ts";
import {
    MAX_CHECK_ANNOTATIONS,
    MAX_JOBS_PER_RUN,
    MAX_PAGINATION_PAGES,
    MAX_STEPS_PER_JOB,
    validateDiagnosticsLimit,
} from "./pipeline-diagnostics-contracts.ts";
import type { JsonValue } from "./pipeline-snapshot.ts";
import type { PipelineSnapshotRequestExecutor } from "./pipeline-snapshot-collector.ts";

const DEFAULT_PAGE_SIZE = 100;

/** Injectable transport: a callable Octokit endpoint function. */
export type Endpoint = (
    parameters: Record<string, unknown>,
) => Promise<unknown>;

/**
 * Expected response envelope for one endpoint. `array` matches bare arrays
 * (check annotations); `object` matches `{ [key]: [...] }` envelopes (jobs,
 * steps, check runs). Responses wrapped one level in `data` (the Octokit
 * response shape) are unwrapped before validation, so `{ data: [] }` is never
 * accepted where `{ [key]: [...] }` is expected.
 */
export type Envelope =
    | { readonly kind: "array" }
    | { readonly kind: "object"; readonly key: string };

/** Expected envelope for jobs on a run: `{ jobs: [...] }`. */
export const JOBS_ENVELOPE: Envelope = { kind: "object", key: "jobs" };

/** Expected envelope for steps on a job: `{ steps: [...] }`. */
export const STEPS_ENVELOPE: Envelope = { kind: "object", key: "steps" };

/** Expected envelope for check runs: `{ check_runs: [...] }`. */
export const CHECK_RUNS_ENVELOPE: Envelope = {
    kind: "object",
    key: "check_runs",
};

/** Expected envelope for check annotations: a bare array. */
export const ANNOTATIONS_ENVELOPE: Envelope = { kind: "array" };

/** Options for one bounded pagination collection from one endpoint. */
export type PaginationOptions = {
    /** Diagnostic label carried by the result and error messages. */
    readonly source: string;
    /** Injectable transport; every request goes through this function. */
    readonly endpoint: Endpoint;
    /** Expected response envelope; a wrong or absent expected key is malformed. */
    readonly envelope: Envelope;
    /**
     * Fixed request parameters. The helper adds `page` and injects
     * `per_page: perPage` on every request, so the served page size always
     * matches the next-page heuristic. A caller-supplied `per_page` is used
     * only to default `perPage` when the option is omitted (see `perPage`).
     */
    readonly parameters: Record<string, unknown>;
    /**
     * Page size guaranteed on every request via the injected `per_page`.
     * Defaults to `parameters.per_page` when present and valid, else 100.
     * Drives the full-page and `total_count` next-page heuristics.
     */
    readonly perPage?: number;
    /** Hard page cap; defaults to MAX_PAGINATION_PAGES. */
    readonly maxPages?: number;
    /** Item bound; when reached, collection stops with a truncated result. */
    readonly maxItems: number;
    /** Optional request executor; defaults to calling the endpoint directly. */
    readonly request?: PipelineSnapshotRequestExecutor;
};

/**
 * Endpoint options for the per-endpoint helpers: `envelope` and `maxItems`
 * are supplied by the helper (with the contract's item bounds as defaults).
 */
export type EndpointPaginationOptions = Omit<
    PaginationOptions,
    "envelope" | "maxItems"
> & { readonly maxItems?: number };

export type PaginationDisposition =
    | "ok"
    | "malformed"
    | "unavailable"
    | "truncated";

/** Explicit truncation result carried when a cap or bound stopped collection. */
export type PaginationTruncation = {
    readonly disposition: "truncated";
    /**
     * The number of items collected when collection stopped (the collected
     * prefix's length). The prefix itself is never discarded.
     */
    readonly count: number;
};

/** Failure detail carried when an envelope or the transport failed. */
export type PaginationError = {
    readonly source: string;
    readonly message: string;
    readonly disposition: "malformed" | "unavailable";
};

/**
 * Result of one bounded pagination collection. Records are normalized and
 * evidence-budgeted. The overall disposition is never "ok" when any page
 * failed or a cap or bound stopped collection (failure-closed): reaching the
 * item bound or page cap always yields "truncated", even when the collected
 * prefix happens to cover the whole set.
 */
export type PaginationResult = {
    readonly source: string;
    /** Bounded evidence records; the collected prefix on truncation or abort. */
    readonly records: ReadonlyArray<JsonValue>;
    /** Overall outcome; "ok" only when every page was collected in full. */
    readonly disposition: PaginationDisposition;
    /** Present exactly when the page cap or an item bound stopped collection. */
    readonly truncation?: PaginationTruncation;
    /** Present when the collection aborted (malformed envelope or unavailable endpoint). */
    readonly error?: PaginationError;
};

const hasOwn = (value: object, key: string): boolean =>
    Object.prototype.hasOwnProperty.call(value, key);

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

/** Octokit responses wrap the payload as `data`; unwrap exactly one level. */
const unwrapData = (value: unknown): unknown =>
    isRecord(value) && hasOwn(value, "data") ? value.data : value;

const errorMessage = (cause: unknown): string =>
    cause instanceof Error ? cause.message : String(cause);

/**
 * Detect a `rel="next"` link header as a boolean only. The header is bounded
 * untrusted metadata: its URL is never extracted, parsed, or dereferenced.
 */
const nextLinkPresent = (response: unknown): boolean | undefined => {
    if (!isRecord(response)) return undefined;
    const headers = response.headers;
    if (headers === undefined || headers === null) return undefined;
    const link =
        typeof (headers as { get?: unknown }).get === "function"
            ? (headers as { get: (name: string) => unknown }).get("link")
            : isRecord(headers)
              ? Object.entries(headers).find(
                    ([key]) => key.toLowerCase() === "link",
                )?.[1]
              : undefined;
    return typeof link === "string"
        ? /rel=["']next["']/i.test(link)
        : undefined;
};

const totalCountFor = (
    envelope: Record<string, unknown>,
): number | undefined => {
    const value = envelope.total_count;
    return typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= 0
        ? value
        : undefined;
};

type DecodedPage =
    | {
          readonly kind: "page";
          readonly items: ReadonlyArray<unknown>;
          readonly totalCount?: number;
      }
    | { readonly kind: "malformed"; readonly message: string };

const decodePage = (
    response: unknown,
    envelope: Envelope,
    source: string,
): DecodedPage => {
    const unwrapped = unwrapData(response);
    if (envelope.kind === "array") {
        if (!Array.isArray(unwrapped))
            return {
                kind: "malformed",
                message: `${source} response was not an annotation array.`,
            };
        return { kind: "page", items: unwrapped };
    }
    if (!isRecord(unwrapped)) {
        return {
            kind: "malformed",
            message: `${source} response did not contain the expected ${envelope.key} array.`,
        };
    }
    const values = unwrapped[envelope.key];
    if (!Array.isArray(values))
        return {
            kind: "malformed",
            message: `${source} response did not contain the expected ${envelope.key} array.`,
        };
    const totalCount = totalCountFor(unwrapped);
    return {
        kind: "page",
        items: values,
        ...(totalCount === undefined ? {} : { totalCount }),
    };
};

const hasNextPage = (
    page: number,
    perPage: number,
    decoded: {
        readonly items: ReadonlyArray<unknown>;
        readonly totalCount?: number;
    },
    response: unknown,
): boolean => {
    const nextLink = nextLinkPresent(response);
    if (nextLink !== undefined) return nextLink;
    if (decoded.totalCount !== undefined)
        return page * perPage < decoded.totalCount;
    return decoded.items.length === perPage;
};

type RequestOutcome =
    | { readonly kind: "response"; readonly response: unknown }
    | { readonly kind: "failed"; readonly message: string };

const requestPage = async (
    request: PipelineSnapshotRequestExecutor,
    endpoint: Endpoint,
    parameters: Record<string, unknown>,
    page: number,
    perPage: number,
): Promise<RequestOutcome> => {
    try {
        return {
            kind: "response",
            response: await request(
                endpoint,
                { ...parameters, page, per_page: perPage },
                undefined,
            ),
        };
    } catch (cause) {
        return { kind: "failed", message: errorMessage(cause) };
    }
};

const requestDirectly: PipelineSnapshotRequestExecutor = async (
    endpoint,
    parameters,
) => endpoint(parameters);

const budgetedRecord = (value: unknown): JsonValue =>
    budgetRawEvidence(value).value;

const okResult = (
    source: string,
    records: ReadonlyArray<JsonValue>,
): PaginationResult => ({ source, records, disposition: "ok" });

const truncatedResult = (
    source: string,
    records: ReadonlyArray<JsonValue>,
): PaginationResult => ({
    source,
    records,
    disposition: "truncated",
    truncation: { disposition: "truncated", count: records.length },
});

const failureResult = (
    source: string,
    records: ReadonlyArray<JsonValue>,
    disposition: "malformed" | "unavailable",
    message: string,
): PaginationResult => ({
    source,
    records,
    disposition,
    error: { source, message, disposition },
});

type PreparedPagination = {
    readonly source: string;
    readonly endpoint: Endpoint;
    readonly envelope: Envelope;
    readonly parameters: Record<string, unknown>;
    readonly request: PipelineSnapshotRequestExecutor;
    readonly perPage: number;
    readonly maxPages: number;
    readonly maxItems: number;
};

type CollectionOutcome =
    | { readonly kind: "completed"; readonly records: ReadonlyArray<JsonValue> }
    | { readonly kind: "truncated"; readonly records: ReadonlyArray<JsonValue> }
    | { readonly kind: "aborted"; readonly result: PaginationResult };

type PreparedResult =
    | { readonly kind: "ready"; readonly pagination: PreparedPagination }
    | { readonly kind: "unavailable"; readonly result: PaginationResult };

/**
 * Resolve the page size the helper guarantees on every request. An explicit
 * `perPage` option wins; otherwise a positive integer `parameters.per_page`
 * is honored so the count heuristic matches a caller that fixes the page
 * size; otherwise the default page size (100) applies.
 */
const resolvePerPage = (options: PaginationOptions): number => {
    const { source, parameters } = options;
    if (options.perPage !== undefined) {
        validateDiagnosticsLimit(`${source} perPage`, options.perPage);
        return options.perPage;
    }
    const parameterPerPage = parameters.per_page;
    if (
        typeof parameterPerPage === "number" &&
        Number.isSafeInteger(parameterPerPage) &&
        parameterPerPage > 0
    ) {
        validateDiagnosticsLimit(`${source} per_page`, parameterPerPage);
        return parameterPerPage;
    }
    return DEFAULT_PAGE_SIZE;
};

/**
 * Resolve options into a bounded collection run. Invalid limits are programmer
 * errors and throw a RangeError; a missing or non-callable endpoint is a
 * runtime failure surfaced as an "unavailable" result.
 */
const preparePagination = (options: PaginationOptions): PreparedResult => {
    const { source, endpoint, envelope, parameters } = options;
    const perPage = resolvePerPage(options);
    const maxPages = options.maxPages ?? MAX_PAGINATION_PAGES;
    validateDiagnosticsLimit(`${source} maxPages`, maxPages);
    validateDiagnosticsLimit(`${source} maxItems`, options.maxItems);
    if (typeof endpoint !== "function") {
        return {
            kind: "unavailable",
            result: failureResult(
                source,
                [],
                "unavailable",
                `${source} endpoint is not callable.`,
            ),
        };
    }
    if (
        options.request !== undefined &&
        typeof options.request !== "function"
    ) {
        return {
            kind: "unavailable",
            result: failureResult(
                source,
                [],
                "unavailable",
                `${source} request executor is not callable.`,
            ),
        };
    }
    return {
        kind: "ready",
        pagination: {
            source,
            endpoint,
            envelope,
            parameters,
            request: options.request ?? requestDirectly,
            perPage,
            maxPages,
            maxItems: options.maxItems,
        },
    };
};

const collectPages = async (
    prepared: PreparedPagination,
): Promise<CollectionOutcome> => {
    const {
        source,
        endpoint,
        envelope,
        parameters,
        request,
        perPage,
        maxPages,
        maxItems,
    } = prepared;
    const collected: JsonValue[] = [];
    for (let page = 1; page <= maxPages; page += 1) {
        const outcome = await requestPage(
            request,
            endpoint,
            parameters,
            page,
            perPage,
        );
        if (outcome.kind === "failed")
            return {
                kind: "aborted",
                result: failureResult(
                    source,
                    collected,
                    "unavailable",
                    outcome.message,
                ),
            };
        const decoded = decodePage(outcome.response, envelope, source);
        if (decoded.kind === "malformed")
            return {
                kind: "aborted",
                result: failureResult(
                    source,
                    collected,
                    "malformed",
                    decoded.message,
                ),
            };
        const room = maxItems - collected.length;
        if (decoded.items.length > room) {
            collected.push(...decoded.items.slice(0, room).map(budgetedRecord));
            return { kind: "truncated", records: collected };
        }
        collected.push(...decoded.items.map(budgetedRecord));
        // Reaching the item bound always stops with a truncated result,
        // even when the just-collected page happens to cover the whole set.
        if (collected.length >= maxItems)
            return { kind: "truncated", records: collected };
        if (!hasNextPage(page, perPage, decoded, outcome.response))
            return { kind: "completed", records: collected };
    }
    return { kind: "truncated", records: collected };
};

/**
 * Collect one paginated endpoint into bounded evidence records. Requests go
 * exclusively through `options.endpoint` (via `options.request` when given);
 * `page` and `per_page` are the only parameters the helper adds. The
 * collection stops, never looping past `maxPages`, when the envelope is
 * malformed, the page cap or item bound is reached, or the transport fails,
 * and the collected prefix is always returned with the explicit outcome.
 */
export async function collectPaginationPages(
    options: PaginationOptions,
): Promise<PaginationResult> {
    const prepared = preparePagination(options);
    if (prepared.kind === "unavailable") return prepared.result;
    const { source } = prepared.pagination;
    const outcome = await collectPages(prepared.pagination);
    if (outcome.kind === "aborted") return outcome.result;
    if (outcome.kind === "truncated")
        return truncatedResult(source, outcome.records);
    return okResult(source, outcome.records);
}

/** Collect jobs on a run; bounded by MAX_JOBS_PER_RUN. */
export const paginateJobs = (
    options: EndpointPaginationOptions,
): Promise<PaginationResult> =>
    collectPaginationPages({
        ...options,
        envelope: JOBS_ENVELOPE,
        maxItems: options.maxItems ?? MAX_JOBS_PER_RUN,
    });

/** Collect steps on a job; bounded by MAX_STEPS_PER_JOB. */
export const paginateSteps = (
    options: EndpointPaginationOptions,
): Promise<PaginationResult> =>
    collectPaginationPages({
        ...options,
        envelope: STEPS_ENVELOPE,
        maxItems: options.maxItems ?? MAX_STEPS_PER_JOB,
    });

/**
 * Collect check runs; the check-run count has no contract bound, so the
 * caller must supply the item bound explicitly.
 */
export const paginateCheckRuns = (
    options: EndpointPaginationOptions & { readonly maxItems: number },
): Promise<PaginationResult> =>
    collectPaginationPages({
        ...options,
        envelope: CHECK_RUNS_ENVELOPE,
        maxItems: options.maxItems,
    });

/** Collect check annotations; bounded by MAX_CHECK_ANNOTATIONS. */
export const paginateAnnotations = (
    options: EndpointPaginationOptions,
): Promise<PaginationResult> =>
    collectPaginationPages({
        ...options,
        envelope: ANNOTATIONS_ENVELOPE,
        maxItems: options.maxItems ?? MAX_CHECK_ANNOTATIONS,
    });