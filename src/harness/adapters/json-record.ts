/** A parsed JSON object. */
export type JsonRecord = Readonly<Record<string, unknown>>;

export const asRecord = (value: unknown): JsonRecord | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as JsonRecord)
        : undefined;

export const asString = (value: unknown): string | undefined =>
    typeof value === "string" ? value : undefined;

/** A finite number, or undefined for anything else. */
export const asNumber = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** A finite number, or 0 for anything else (token and cost counters). */
export const asNumberOrZero = (value: unknown): number => asNumber(value) ?? 0;

/**
 * Parse one stream line into an object. Lines are split on `\n` only by the
 * process port, so U+2028 and U+2029 inside strings survive and `JSON.parse`
 * accepts them. Anything that is not a JSON object yields undefined.
 */
export const parseLine = (line: string): JsonRecord | undefined => {
    if (!line.trim().startsWith("{")) return undefined;
    try {
        return asRecord(JSON.parse(line));
    } catch {
        return undefined;
    }
};