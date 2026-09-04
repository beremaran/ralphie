/**
 * Failure-closed transport primitives for the maintenance GitHub reader.
 *
 * This module deliberately knows nothing about maintenance policy. It only
 * turns an injected, read-only Octokit endpoint into a bounded sequence of
 * JSON records. Every transport, status, envelope, and pagination failure is
 * represented by `MaintainGitHubReaderDiagnosticError`; callers may classify
 * record-level HTTP failures separately, but must never turn this error into a
 * typed record skip.
 */
import { RalphieError } from "../../shared/error.ts";
import { rateLimitFromUnknown } from "../../github/rate-limit.ts";

export const MAINTAIN_READER_DEFAULT_PAGE_SIZE = 100;
export const MAINTAIN_READER_MAX_PAGES = 10_000;

type RecordLike = Record<string, unknown>;

const isRecord = (value: unknown): value is RecordLike =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const hasOwn = (value: object, key: string): boolean =>
    Object.prototype.hasOwnProperty.call(value, key);

const causeMessage = (cause: unknown): string => {
    if (cause instanceof Error && cause.message.trim().length > 0)
        return cause.message;
    if (typeof cause === "string" && cause.trim().length > 0) return cause;
    if (cause === undefined) return "unknown transport failure";
    try {
        return String(cause);
    } catch {
        return "unknown transport failure";
    }
};

const statusFrom = (value: unknown): number | undefined => {
    if (!isRecord(value)) return undefined;
    const responseStatus = isRecord(value.response)
        ? value.response.status
        : undefined;
    const status = responseStatus ?? value.status;
    return typeof status === "number" && Number.isFinite(status)
        ? status
        : undefined;
};

/**
 * A diagnostic identifies the exact read operation that failed. The original
 * cause is also installed as `Error.cause` by `RalphieError`, so callers can
 * inspect the Octokit response envelope and its headers without reparsing the
 * diagnostic message.
 */
export class MaintainGitHubReaderDiagnosticError extends RalphieError {
    override readonly _tag = "MaintainGitHubReaderDiagnosticError" as const;
    readonly repository: string;
    readonly endpoint: string;
    readonly page: number | undefined;

    constructor(input: {
        readonly repository: string;
        readonly endpoint: string;
        readonly page?: number;
        readonly message: string;
        readonly cause?: unknown;
    }) {
        const location = `${input.repository} ${input.endpoint}${input.page === undefined ? "" : ` page ${String(input.page)}`}`;
        super({
            message: `Maintenance GitHub reader failed for ${location}: ${input.message}`,
            ...(input.cause === undefined ? {} : { cause: input.cause }),
        });
        this.name = "MaintainGitHubReaderDiagnosticError";
        this.repository = input.repository;
        this.endpoint = input.endpoint;
        this.page = input.page;
    }
}

export type MaintainReaderDiagnosticError = MaintainGitHubReaderDiagnosticError;

const errorFor = (input: {
    readonly repository: string;
    readonly endpoint: string;
    readonly page?: number;
    readonly message: string;
    readonly cause?: unknown;
}): MaintainGitHubReaderDiagnosticError =>
    new MaintainGitHubReaderDiagnosticError(input);

const headersFor = (value: unknown): unknown => {
    if (!isRecord(value)) return undefined;
    if (value.headers !== undefined) return value.headers;
    if (isRecord(value.response)) return value.response.headers;
    return undefined;
};

const headerValue = (headers: unknown, name: string): unknown => {
    if (headers === null || headers === undefined) return undefined;
    if (typeof (headers as { get?: unknown }).get === "function") {
        return (headers as { get: (key: string) => unknown }).get(name);
    }
    if (!isRecord(headers)) return undefined;
    const key = Object.keys(headers).find(
        (candidate) => candidate.toLowerCase() === name.toLowerCase(),
    );
    return key === undefined ? undefined : headers[key];
};

const headerStatus = (value: unknown): number | undefined => {
    const status = statusFrom(value);
    return status;
};

/**
 * Detect only the HTTP shapes that mean the shared GitHub rate-limit budget
 * is exhausted. Other retry metadata remains useful diagnostic context but is
 * intentionally not treated as proof of a rate-limit response here.
 */
export const isMaintainReaderRateLimited = (value: unknown): boolean => {
    const status = headerStatus(value);
    if (status === 429) return true;
    if (status !== 403) return false;
    const headers = headersFor(value);
    const remaining = headerValue(headers, "x-ratelimit-remaining");
    return (
        remaining === 0 ||
        (typeof remaining === "string" && remaining.trim() === "0")
    );
};

export const isRateLimited = isMaintainReaderRateLimited;
export const maintainReaderRateLimitFromUnknown = rateLimitFromUnknown;

const abortError = (message: string): Error => {
    const error = new Error(message);
    error.name = "AbortError";
    return error;
};

/** Rethrow the caller's abort reason at every phase/page boundary. */
export const throwIfAborted = (
    signal: AbortSignal | undefined,
    message = "Maintenance GitHub reader was aborted.",
): void => {
    if (signal?.aborted !== true) return;
    throw signal.reason === undefined ? abortError(message) : signal.reason;
};

export const throwIfMaintainReaderAborted = throwIfAborted;

export type MaintainReaderEndpoint = (
    parameters: Record<string, unknown>,
) => Promise<unknown>;

export type MaintainReaderRequest = (
    endpoint: MaintainReaderEndpoint,
    parameters: Record<string, unknown>,
    signal?: AbortSignal,
) => Promise<unknown>;

const requestDirectly: MaintainReaderRequest = async (
    endpoint,
    parameters,
    signal,
) =>
    endpoint({
        ...parameters,
        ...(signal === undefined ? {} : { request: { signal } }),
    });

export type PaginatedMaintainReaderGetOptions<T = unknown> = {
    /** owner/name, retained in every diagnostic. */
    readonly repository: string;
    /** Human-readable REST endpoint or phase name. */
    readonly endpoint: string;
    /** Injected Octokit REST method. It is the only callable transport. */
    readonly requestEndpoint: MaintainReaderEndpoint;
    /** Fixed query/path parameters; page and per_page are supplied by helper. */
    readonly parameters?: Readonly<Record<string, unknown>>;
    /** The array key inside the response data, or undefined for a bare array. */
    readonly responseKey?: string;
    readonly perPage?: number;
    readonly maxPages?: number;
    readonly signal?: AbortSignal;
    /** Optional request seam used by tests and by clients with shared transport. */
    readonly request?: MaintainReaderRequest;
    /** Pure record mapper. Mapping failures become diagnostics. */
    readonly map?: (value: unknown, page: number) => T;
    /**
     * Optional observation hook invoked once after each validated page. The
     * hook receives metadata only; it cannot request another page or mutate
     * the transport operation.
     */
    readonly onPage?: (page: MaintainReaderPageInfo) => void;
};

export type PaginatedMaintainReaderGetResult<T> = ReadonlyArray<T>;

export type MaintainReaderPageInfo = {
    readonly page: number;
    readonly itemCount: number;
    readonly totalCount: number | undefined;
    readonly hasNext: boolean;
};

const positiveInteger = (
    value: number | undefined,
    fallback: number,
    name: string,
): number => {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved <= 0) {
        throw new RangeError(`${name} must be a positive integer.`);
    }
    return resolved;
};

const responseData = (response: unknown): unknown => {
    if (!isRecord(response) || !hasOwn(response, "data")) return undefined;
    return response.data;
};

const responseHeaders = (response: unknown): unknown =>
    isRecord(response) ? response.headers : undefined;

const nextLinkFor = (
    response: unknown,
    input: {
        readonly repository: string;
        readonly endpoint: string;
        readonly page: number;
    },
): boolean | undefined => {
    const headers = responseHeaders(response);
    if (headers === undefined || headers === null) return undefined;
    const raw = headerValue(headers, "link");
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== "string") {
        throw errorFor({
            ...input,
            message: "Link header was not a string.",
            cause: raw,
        });
    }
    const link = raw.trim();
    if (link.length === 0) return false;
    // GitHub's Link header is treated as untrusted metadata. We inspect only
    // its relation token and never parse or dereference the advertised URL.
    const relationTokens = [...link.matchAll(/rel\s*=\s*["']([^"']+)["']/gi)];
    if (relationTokens.length === 0) {
        throw errorFor({
            ...input,
            message: "Link header did not contain a quoted relation.",
            cause: raw,
        });
    }
    return relationTokens.some((match) =>
        (match[1] ?? "")
            .split(/\s+/u)
            .some((relation) => relation.toLowerCase() === "next"),
    );
};

const totalCountFor = (data: unknown): number | undefined => {
    if (!isRecord(data)) return undefined;
    const value = data.total_count;
    return typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= 0
        ? value
        : undefined;
};

const pageItems = (options: {
    readonly response: unknown;
    readonly responseKey: string | undefined;
    readonly repository: string;
    readonly endpoint: string;
    readonly page: number;
}): {
    readonly items: ReadonlyArray<unknown>;
    readonly totalCount?: number;
} => {
    const data = responseData(options.response);
    if (data === undefined) {
        throw errorFor({
            repository: options.repository,
            endpoint: options.endpoint,
            page: options.page,
            message: "response did not contain a JSON data envelope.",
            cause: options.response,
        });
    }
    if (options.responseKey === undefined) {
        if (!Array.isArray(data)) {
            throw errorFor({
                repository: options.repository,
                endpoint: options.endpoint,
                page: options.page,
                message: "response data was not an array.",
                cause: data,
            });
        }
        const totalCount = totalCountFor(options.response);
        return {
            items: data,
            ...(totalCount === undefined ? {} : { totalCount }),
        };
    }
    if (!isRecord(data) || !Array.isArray(data[options.responseKey])) {
        throw errorFor({
            repository: options.repository,
            endpoint: options.endpoint,
            page: options.page,
            message: `response data did not contain the ${options.responseKey} array.`,
            cause: data,
        });
    }
    const totalCount = totalCountFor(data);
    return {
        items: data[options.responseKey] as ReadonlyArray<unknown>,
        ...(totalCount === undefined ? {} : { totalCount }),
    };
};

const statusFailure = (response: unknown): number | undefined => {
    const status = statusFrom(response);
    return status !== undefined && status >= 400 ? status : undefined;
};

type PreparedMaintainReaderGet<T> = {
    readonly perPage: number;
    readonly maxPages: number;
    readonly request: MaintainReaderRequest;
    readonly options: PaginatedMaintainReaderGetOptions<T>;
};

const prepareGet = <T>(
    options: PaginatedMaintainReaderGetOptions<T>,
): PreparedMaintainReaderGet<T> => {
    const perPage = positiveInteger(
        options.perPage,
        MAINTAIN_READER_DEFAULT_PAGE_SIZE,
        "perPage",
    );
    const maxPages = positiveInteger(
        options.maxPages,
        MAINTAIN_READER_MAX_PAGES,
        "maxPages",
    );
    if (typeof options.requestEndpoint !== "function") {
        throw errorFor({
            repository: options.repository,
            endpoint: options.endpoint,
            message: "endpoint is not callable.",
        });
    }
    const request = options.request ?? requestDirectly;
    if (typeof request !== "function") {
        throw errorFor({
            repository: options.repository,
            endpoint: options.endpoint,
            message: "request executor is not callable.",
        });
    }
    return { perPage, maxPages, request, options };
};

const requestMaintainReaderPage = async <T>(
    prepared: PreparedMaintainReaderGet<T>,
    page: number,
): Promise<unknown> => {
    const { options } = prepared;
    try {
        return await prepared.request(
            options.requestEndpoint,
            {
                ...(options.parameters ?? {}),
                page,
                per_page: prepared.perPage,
            },
            options.signal,
        );
    } catch (cause) {
        if (options.signal?.aborted === true) throw cause;
        if (cause instanceof MaintainGitHubReaderDiagnosticError) throw cause;
        throw errorFor({
            repository: options.repository,
            endpoint: options.endpoint,
            page,
            message: causeMessage(cause),
            cause,
        });
    }
};

const mapMaintainReaderPage = <T>(
    prepared: PreparedMaintainReaderGet<T>,
    response: unknown,
    page: number,
): {
    readonly count: number;
    readonly totalCount?: number;
    readonly records: ReadonlyArray<T>;
} => {
    const { options } = prepared;
    const decoded = pageItems({
        response,
        responseKey: options.responseKey,
        repository: options.repository,
        endpoint: options.endpoint,
        page,
    });
    const records: T[] = [];
    for (const item of decoded.items) {
        try {
            records.push(
                options.map === undefined
                    ? (item as T)
                    : options.map(item, page),
            );
        } catch (cause) {
            if (options.signal?.aborted === true) throw cause;
            if (cause instanceof MaintainGitHubReaderDiagnosticError)
                throw cause;
            throw errorFor({
                repository: options.repository,
                endpoint: options.endpoint,
                page,
                message: `record mapping failed: ${causeMessage(cause)}`,
                cause,
            });
        }
    }
    return {
        count: decoded.items.length,
        ...(decoded.totalCount === undefined
            ? {}
            : { totalCount: decoded.totalCount }),
        records,
    };
};

const hasMaintainReaderNextPage = <T>(
    prepared: PreparedMaintainReaderGet<T>,
    response: unknown,
    page: number,
    count: number,
    totalCount: number | undefined,
): boolean => {
    const { options, perPage } = prepared;
    const next = nextLinkFor(response, {
        repository: options.repository,
        endpoint: options.endpoint,
        page,
    });
    const expectedByCount =
        totalCount !== undefined && page * perPage < totalCount;
    if (next !== true && expectedByCount) {
        throw errorFor({
            repository: options.repository,
            endpoint: options.endpoint,
            page,
            message: "pagination ended before its total_count was collected.",
            cause: response,
        });
    }
    if (next === true && count === 0) {
        throw errorFor({
            repository: options.repository,
            endpoint: options.endpoint,
            page,
            message: "Link header advertised a next page after an empty page.",
            cause: response,
        });
    }
    return next === true;
};

/**
 * Fetch every page of one REST collection. The helper always uses GET through
 * the endpoint supplied by the caller, carries the caller's signal in the
 * Octokit `request` option, and returns no partial success: any failure throws
 * a diagnostic after preserving the failed response as its cause.
 */
export const paginateMaintainReaderGet = async <T = unknown>(
    options: PaginatedMaintainReaderGetOptions<T>,
): Promise<PaginatedMaintainReaderGetResult<T>> => {
    const prepared = prepareGet(options);
    const records: T[] = [];
    for (let page = 1; page <= prepared.maxPages; page += 1) {
        throwIfAborted(options.signal);
        const response = await requestMaintainReaderPage(prepared, page);
        throwIfAborted(options.signal);
        const status = statusFailure(response);
        if (status !== undefined) {
            throw errorFor({
                repository: options.repository,
                endpoint: options.endpoint,
                page,
                message: `GitHub returned HTTP ${String(status)}${isMaintainReaderRateLimited(response) ? " (rate limited)" : ""}.`,
                cause: response,
            });
        }
        const mapped = mapMaintainReaderPage(prepared, response, page);
        records.push(...mapped.records);
        const hasNext = hasMaintainReaderNextPage(
            prepared,
            response,
            page,
            mapped.count,
            mapped.totalCount,
        );
        options.onPage?.({
            page,
            itemCount: mapped.count,
            totalCount: mapped.totalCount,
            hasNext,
        });
        if (!hasNext) {
            return Object.freeze(records);
        }
    }
    throw errorFor({
        repository: options.repository,
        endpoint: options.endpoint,
        page: prepared.maxPages,
        message: `pagination exceeded the safety limit of ${String(prepared.maxPages)} pages.`,
    });
};

export const paginateMaintainabilityGet = paginateMaintainReaderGet;
export const paginateMaintenanceGet = paginateMaintainReaderGet;
export const collectMaintainReaderPages = paginateMaintainReaderGet;