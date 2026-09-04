/**
 * Bounded JSON evidence for diagnostics records.
 *
 * `budgetEvidence` renders a payload as the shortest JSON representation that
 * fits a character budget that covers the COMPLETE emitted text: object keys,
 * structural punctuation, nested fields, array elements, and raw scalar
 * values. The consumer receives only the bounded form; the original payload
 * is never retained alongside it. Truncated output always carries the
 * `TRUNCATION_MARKER_KEY` marker whose value is the number of elements
 * omitted at that site, and the result reports a "truncated" disposition
 * with the total omitted count, so callers can map it onto
 * `DiagnosticRecordDisposition` ("truncated") without parsing the marker.
 *
 * The representation never fabricates a stand-in value and never drops
 * entries without a marker: a value or entry that cannot fit alongside its
 * marker is omitted entirely and counted at the nearest enclosing truncation
 * marker. Budgets smaller than `MIN_EVIDENCE_BUDGET` (the length of the
 * smallest marker) are rejected with a RangeError because no bounded form
 * could carry the required marker and count.
 */
import {
    MAX_RAW_EVIDENCE,
    validateDiagnosticsLimit,
} from "./pipeline-diagnostics-contracts.ts";
import { serializeJson } from "./pipeline-snapshot.ts";
import type { JsonObject, JsonValue } from "./pipeline-snapshot.ts";

/**
 * Marker key emitted at every truncation site. Its value is the number of
 * elements (object keys or array elements) omitted at that site.
 */
export const TRUNCATION_MARKER_KEY = "__truncated__";

/** Smallest budget that can carry a truncation marker with its count. */
export const MIN_EVIDENCE_BUDGET = `{"${TRUNCATION_MARKER_KEY}":1}`.length;

export type EvidenceBudgetDisposition = "ok" | "truncated";

export type EvidenceBudgetResult = {
    /** The bounded representation; always fits the budget when emitted. */
    readonly value: JsonValue;
    /** "truncated" when any content was omitted; "ok" otherwise. */
    readonly disposition: EvidenceBudgetDisposition;
    /**
     * Total number of omitted elements (object keys and array elements)
     * across every truncation site. Zero when the payload fits, and always
     * equal to the sum of the marker counts carried by the emitted value.
     */
    readonly omitted: number;
};

type Emitted = {
    readonly text: string;
    readonly omitted: number;
};

type Entry = { readonly prefix: string; readonly value: JsonValue };

type EmitFit = {
    readonly text: string;
    readonly cost: number;
    readonly omitted: number;
};

const markerObject = (omitted: number): string =>
    `{"${TRUNCATION_MARKER_KEY}":${String(omitted)}}`;

/**
 * Bound one scalar value. Returns the scalar text when it fits, otherwise
 * the marker object (which counts the omitted scalar as one element).
 * Returns undefined when even the marker cannot fit, signalling the caller
 * to omit the whole entry at the next enclosing marker rather than
 * fabricating a placeholder.
 */
const emitScalar = (
    value: string | number | boolean | null,
    budget: number,
): Emitted | undefined => {
    const text = JSON.stringify(value);
    if (text.length <= budget) return { text, omitted: 0 };
    const marker = markerObject(1);
    if (marker.length <= budget) return { text: marker, omitted: 1 };
    return undefined;
};

const emitJsonValue = (
    value: JsonValue,
    budget: number,
): Emitted | undefined => {
    if (value === null || typeof value !== "object")
        return emitScalar(value, budget);
    if (Array.isArray(value)) return emitArray(value, budget);
    return emitObject(value as JsonObject, budget);
};

const emitObject = (value: JsonObject, budget: number): Emitted | undefined => {
    const entries: Entry[] = Object.keys(value).map((key) => ({
        prefix: `${JSON.stringify(key)}:`,
        value: value[key]!,
    }));
    return emitEntries(
        entries,
        "{",
        "}",
        (omitted) =>
            `${JSON.stringify(TRUNCATION_MARKER_KEY)}:${String(omitted)}`,
        budget,
    );
};

const emitArray = (
    value: ReadonlyArray<JsonValue>,
    budget: number,
): Emitted | undefined =>
    emitEntries(
        value.map((entry) => ({ prefix: "", value: entry })),
        "[",
        "]",
        (omitted) => markerObject(omitted),
        budget,
    );

/**
 * Fit one entry (its key prefix and value together) into `available`
 * characters, either in full or by bounding the value's own representation.
 */
const entryBounded = (
    entry: Entry,
    separator: string,
    close: string,
    available: number,
): EmitFit | undefined => {
    const full = JSON.stringify(entry.value);
    const fullCost = separator.length + entry.prefix.length + full.length;
    if (fullCost + close.length <= available)
        return { text: `${entry.prefix}${full}`, cost: fullCost, omitted: 0 };
    const remaining =
        available - separator.length - entry.prefix.length - close.length;
    if (remaining <= 0) return undefined;
    const shrunk = emitJsonValue(entry.value, remaining);
    if (shrunk === undefined) return undefined;
    const shrunkCost =
        separator.length + entry.prefix.length + shrunk.text.length;
    if (shrunkCost + close.length > available) return undefined;
    return {
        text: `${entry.prefix}${shrunk.text}`,
        cost: shrunkCost,
        omitted: shrunk.omitted,
    };
};

/**
 * Replace the entries from `index` on (plus trailing emitted entries only
 * when the marker needs the room) with the marker entry. The marker value is
 * always the number of entries absent from the final text, and the reported
 * count is the sum of the marker counts inside the entries that remain plus
 * the entries that are absent entirely. An entry dropped wholesale is never
 * also charged for the inner omissions it carried, so the reported count
 * always equals the sum of the markers in the emitted text.
 */
const elide = (
    entries: ReadonlyArray<Entry>,
    index: number,
    emitted: ReadonlyArray<Emitted>,
    open: string,
    close: string,
    markerFor: (omitted: number) => string,
    budget: number,
): Emitted | undefined => {
    for (let keep = emitted.length; keep >= 0; keep--) {
        const dropped = entries.length - index + (emitted.length - keep);
        const kept = emitted.slice(0, keep);
        const body = kept.map((entry) => entry.text).join(",");
        const sep = keep === 0 ? "" : ",";
        const text = `${open}${body}${sep}${markerFor(dropped)}${close}`;
        if (text.length <= budget)
            return {
                text,
                omitted:
                    kept.reduce((sum, entry) => sum + entry.omitted, 0) +
                    dropped,
            };
    }
    const markerOnly = `${open}${markerFor(entries.length)}${close}`;
    if (markerOnly.length <= budget)
        return { text: markerOnly, omitted: entries.length };
    return undefined;
};

/**
 * Emit `entries` as one JSON container whose text never exceeds `budget`.
 * Entries are emitted in order while they fit; the first entry that cannot
 * fit is replaced by the marker entry (dropping earlier entries backwards
 * only when the marker needs the room), and everything after it is omitted.
 */
const emitEntries = (
    entries: ReadonlyArray<Entry>,
    open: string,
    close: string,
    markerFor: (omitted: number) => string,
    budget: number,
): Emitted | undefined => {
    if (entries.length === 0) return { text: `${open}${close}`, omitted: 0 };
    const emitted: Emitted[] = [];
    let used = open.length;
    for (const [index, entry] of entries.entries()) {
        const separator = emitted.length === 0 ? "" : ",";
        const fit = entryBounded(entry, separator, close, budget - used);
        if (fit !== undefined) {
            emitted.push({ text: fit.text, omitted: fit.omitted });
            used += fit.cost;
            continue;
        }
        return elide(entries, index, emitted, open, close, markerFor, budget);
    }
    return {
        text: `${open}${emitted.map((entry) => entry.text).join(",")}${close}`,
        omitted: emitted.reduce((sum, entry) => sum + entry.omitted, 0),
    };
};

/**
 * Render `payload` as a JSON representation bounded to `budget` characters
 * of the complete emitted text (keys, punctuation, nesting, and scalars).
 * The result is deterministic: identical input and budget always produce
 * identical output, and a truncated output never retains the original
 * payload alongside it. Budgets below `MIN_EVIDENCE_BUDGET`, and budgets too
 * small to hold the marker (with its count) for a given payload, are
 * rejected with a RangeError.
 */
export const budgetEvidence = (
    payload: unknown,
    budget: number,
): EvidenceBudgetResult => {
    validateDiagnosticsLimit("evidence budget", budget);
    if (budget < MIN_EVIDENCE_BUDGET)
        throw new RangeError(
            `evidence budget must be at least ${String(MIN_EVIDENCE_BUDGET)} to carry the truncation marker; received ${String(budget)}.`,
        );
    const normalized = serializeJson(payload);
    if (JSON.stringify(normalized).length <= budget)
        return { value: normalized, disposition: "ok", omitted: 0 };
    const emitted = emitJsonValue(normalized, budget);
    if (emitted === undefined)
        throw new RangeError(
            `evidence budget ${String(budget)} is too small to hold the truncation marker for this payload.`,
        );
    return {
        value: JSON.parse(emitted.text) as JsonValue,
        disposition: "truncated",
        omitted: emitted.omitted,
    };
};

/**
 * Convenience applying `MAX_RAW_EVIDENCE` as the budget. When the evidence
 * exceeds the bound the result reports a "truncated" disposition with the
 * truncation count, ready to map onto the contracts' "truncated" record
 * disposition.
 */
export const budgetRawEvidence = (payload: unknown): EvidenceBudgetResult =>
    budgetEvidence(payload, MAX_RAW_EVIDENCE);