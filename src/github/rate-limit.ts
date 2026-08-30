/** Small, transport-independent helpers for GitHub retry metadata. */

export type RateLimitMetadata = {
    /** Absolute rate-limit window reset time in Unix epoch milliseconds. */
    readonly resetAtMs?: number;
    /** Retry-After delay in milliseconds. */
    readonly retryAfterMs?: number;
    /** Raw Retry-After header, when parsing is deferred to an observer clock. */
    readonly retryAfter?: string | number;
    /** Raw reset metadata, when parsing is deferred to an observer clock. */
    readonly resetAt?: string | number;
    /** Optional response headers from a transport error. */
    readonly headers?: Readonly<Record<string, unknown>>;
    /** Remaining calls in the current rate-limit window. */
    readonly remaining?: number;
};

type RecordLike = Record<string, unknown>;

const isRecord = (value: unknown): value is RecordLike =>
    typeof value === "object" && value !== null;

const finiteNonNegative = (value: number): number | undefined =>
    Number.isFinite(value) && value >= 0 ? value : undefined;

const textFor = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim().length > 0
        ? value.trim()
        : undefined;

const headerFromGetter = (
    headers: unknown,
    names: ReadonlyArray<string>,
): unknown => {
    if (typeof (headers as { get?: unknown }).get !== "function")
        return undefined;
    const getter = headers as { get: (key: string) => unknown };
    for (const name of names) {
        const value = getter.get(name);
        if (value !== null && value !== undefined) return value;
    }
    return undefined;
};

const headerFromRecord = (
    headers: unknown,
    names: ReadonlyArray<string>,
): unknown => {
    if (!isRecord(headers)) return undefined;
    const keys = Object.keys(headers);
    const key = names
        .flatMap((name) =>
            keys.filter((candidate) => candidate.toLowerCase() === name),
        )
        .at(0);
    return key === undefined ? undefined : headers[key];
};

const headerValue = (
    headers: unknown,
    names: ReadonlyArray<string>,
): unknown =>
    headers === undefined || headers === null
        ? undefined
        : (headerFromGetter(headers, names) ??
          headerFromRecord(headers, names));

/** Parse an RFC Retry-After value using the supplied observation clock. */
export const parseRetryAfter = (
    value: unknown,
    nowMs: number = Date.now(),
): number | undefined => {
    if (typeof value === "number") return finiteNonNegative(value * 1_000);
    const text = textFor(value);
    if (text === undefined) return undefined;
    if (/^\d+(?:\.\d+)?$/.test(text))
        return finiteNonNegative(Number(text) * 1_000);
    const date = Date.parse(text);
    if (Number.isNaN(date)) return undefined;
    return finiteNonNegative(date - nowMs);
};

const resetTime = (value: unknown): number | undefined => {
    if (typeof value === "number") {
        if (!Number.isFinite(value) || value < 0) return undefined;
        return value > 1_000_000_000_000 ? value : value * 1_000;
    }
    const text = textFor(value);
    if (text === undefined) return undefined;
    if (/^\d+(?:\.\d+)?$/.test(text)) return resetTime(Number(text));
    const date = Date.parse(text);
    return Number.isNaN(date) ? undefined : date;
};

const remainingCalls = (value: unknown): number | undefined => {
    const number =
        typeof value === "number" ? value : Number(textFor(value) ?? "NaN");
    return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
};

const metadataFromHeaders = (
    headers: unknown,
    nowMs: number,
): RateLimitMetadata | undefined => {
    const retryAfterHeader = headerValue(headers, ["retry-after"]);
    const resetHeader = headerValue(headers, [
        "x-ratelimit-reset",
        "x-rate-limit-reset",
    ]);
    const remainingHeader = headerValue(headers, [
        "x-ratelimit-remaining",
        "x-rate-limit-remaining",
    ]);
    const retryAfter =
        retryAfterHeader === undefined
            ? undefined
            : parseRetryAfter(retryAfterHeader, nowMs);
    const resetAt =
        resetHeader === undefined ? undefined : resetTime(resetHeader);
    const remaining =
        remainingHeader === undefined
            ? undefined
            : remainingCalls(remainingHeader);
    if (
        retryAfter === undefined &&
        resetAt === undefined &&
        remaining === undefined
    )
        return undefined;
    return {
        ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }),
        ...(resetAt === undefined ? {} : { resetAtMs: resetAt }),
        ...(remaining === undefined ? {} : { remaining }),
    };
};

const directMetadata = (
    value: RecordLike,
    nowMs: number,
): RateLimitMetadata => {
    const retryAfterMs = finiteNonNegative(
        typeof value.retryAfterMs === "number"
            ? value.retryAfterMs
            : typeof value.retry_after_ms === "number"
              ? value.retry_after_ms
              : Number.NaN,
    );
    const rawRetryAfter = value.retryAfter ?? value.retry_after;
    const retryAfter =
        rawRetryAfter === undefined
            ? retryAfterMs
            : parseRetryAfter(rawRetryAfter, nowMs);
    const rawResetAt = value.resetAt ?? value.reset_at;
    const resetAtMs =
        rawResetAt === undefined
            ? finiteNonNegative(
                  typeof value.resetAtMs === "number"
                      ? value.resetAtMs
                      : Number.NaN,
              )
            : resetTime(rawResetAt);
    const remaining = remainingCalls(value.remaining);
    return {
        ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }),
        ...(resetAtMs === undefined ? {} : { resetAtMs }),
        ...(remaining === undefined ? {} : { remaining }),
    };
};

const metadataFromRecord = (
    value: RecordLike,
    nowMs: number,
): RateLimitMetadata | undefined => {
    const nested = value.rateLimit ?? value.rate_limit;
    const nestedMetadata = isRecord(nested)
        ? metadataFromRecord(nested, nowMs)
        : undefined;
    const combined = {
        ...(nestedMetadata ?? {}),
        ...(metadataFromHeaders(value.headers, nowMs) ?? {}),
        ...directMetadata(value, nowMs),
    };
    return Object.keys(combined).length === 0 ? undefined : combined;
};

/** Extract usable retry metadata from an Octokit error or response-shaped value. */
export const rateLimitFromUnknown = (
    value: unknown,
    nowMs: number = Date.now(),
): RateLimitMetadata | undefined => {
    if (!isRecord(value)) return undefined;
    const direct = metadataFromRecord(value, nowMs);
    const response = isRecord(value.response)
        ? metadataFromRecord(value.response, nowMs)
        : undefined;
    const cause = isRecord(value.cause)
        ? rateLimitFromUnknown(value.cause, nowMs)
        : undefined;
    const combined = {
        ...(cause ?? {}),
        ...(response ?? {}),
        ...(direct ?? {}),
    };
    return Object.keys(combined).length === 0 ? undefined : combined;
};

export const rateLimitFromHeaders = (
    headers: unknown,
    nowMs: number = Date.now(),
): RateLimitMetadata | undefined => metadataFromHeaders(headers, nowMs);