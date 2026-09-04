import { describe, expect, test } from "bun:test";

import { MAX_RAW_EVIDENCE } from "../../src/github/pipeline-diagnostics-contracts.ts";
import {
    MIN_EVIDENCE_BUDGET,
    TRUNCATION_MARKER_KEY,
    budgetEvidence,
    budgetRawEvidence,
} from "../../src/github/evidence-budget.ts";
import type { EvidenceBudgetResult } from "../../src/github/evidence-budget.ts";
import { serializeJson } from "../../src/github/pipeline-snapshot.ts";

const emittedLength = (result: EvidenceBudgetResult): number =>
    JSON.stringify(result.value).length;

/** Sum of every truncation marker count carried by a bounded value. */
const markerSum = (value: unknown): number => {
    if (Array.isArray(value))
        return value.reduce((sum, entry) => sum + markerSum(entry), 0);
    if (value !== null && typeof value === "object")
        return Object.entries(value as Record<string, unknown>).reduce(
            (sum, [key, entry]) =>
                key === TRUNCATION_MARKER_KEY
                    ? sum + (typeof entry === "number" ? entry : 0)
                    : sum + markerSum(entry),
            0,
        );
    return 0;
};

describe("evidence budget", () => {
    test("budget counts keys plus structural JSON, not just string values", () => {
        const manyKeys: Record<string, number> = {};
        for (let i = 0; i < 26; i++) manyKeys[String.fromCharCode(97 + i)] = 1;
        const oneString = Object.keys(manyKeys)
            .map((key) => `${key}${manyKeys[key]}`)
            .join("");
        const budget = JSON.stringify(oneString).length;

        expect(JSON.stringify(manyKeys).length).toBeGreaterThan(budget);

        const manyResult = budgetEvidence(manyKeys, budget);
        expect(manyResult.disposition).toBe("truncated");
        expect(manyResult.omitted).toBeGreaterThan(0);
        expect(emittedLength(manyResult)).toBeLessThanOrEqual(budget);

        const stringResult = budgetEvidence(oneString, budget);
        expect(stringResult.disposition).toBe("ok");
        expect(stringResult.omitted).toBe(0);
        expect(stringResult.value).toBe(oneString);
    });

    test("over-budget input yields the explicit truncation marker and count", () => {
        const result = budgetEvidence(
            { alpha: 1, beta: 2, gamma: 3, delta: 4 },
            30,
        );
        expect(result.disposition).toBe("truncated");
        expect(result.omitted).toBe(3);
        expect(result.value).toEqual({ alpha: 1, [TRUNCATION_MARKER_KEY]: 3 });
        expect(emittedLength(result)).toBeLessThanOrEqual(30);
        expect(markerSum(result.value)).toBe(result.omitted);
    });

    test("no unbounded payload is retained alongside the shortened view", () => {
        const longValue = "x".repeat(2_000);
        const payload = { ok: 1, big: longValue };
        const result = budgetEvidence(payload, 60);
        expect(result.disposition).toBe("truncated");
        expect(result.value).not.toBe(payload);
        expect(emittedLength(result)).toBeLessThanOrEqual(60);
        expect(JSON.stringify(result.value)).not.toContain(longValue);
        expect(result.value).toEqual({
            ok: 1,
            big: { [TRUNCATION_MARKER_KEY]: 1 },
        });
    });

    test("truncation never fabricates values and reports accurate counts", () => {
        // A value too big to fit alongside a marker is omitted (with the
        // marker), never replaced by a plausible-looking literal.
        const scalar = budgetEvidence({ a: "y".repeat(500) }, 21);
        expect(scalar.disposition).toBe("truncated");
        expect(scalar.omitted).toBe(1);
        expect(scalar.value).toEqual({ [TRUNCATION_MARKER_KEY]: 1 });
        expect(emittedLength(scalar)).toBeLessThanOrEqual(21);

        // Dropped entries are counted once as whole elements; inner
        // omissions of entries that remain are counted at their own markers.
        const object = budgetEvidence(
            {
                aaaa: "x".repeat(500),
                bbbb: "y".repeat(500),
                cccc: "z".repeat(500),
            },
            60,
        );
        expect(object.disposition).toBe("truncated");
        expect(object.omitted).toBe(3);
        expect(object.value).toEqual({
            aaaa: { [TRUNCATION_MARKER_KEY]: 1 },
            [TRUNCATION_MARKER_KEY]: 2,
        });
        expect(emittedLength(object)).toBeLessThanOrEqual(60);
        expect(markerSum(object.value)).toBe(object.omitted);
    });

    test("nested unknown fields and array elements are counted", () => {
        const payload = {
            nested: {
                list: [1, 2, 3, 4, 5, 6],
                meta: { a: 1, b: 2, c: 3, d: 4 },
            },
        };
        // Nested object keys are counted: the meta marker reports the 4
        // omitted fields while the list keeps every element.
        const nestedMarker = budgetEvidence(payload, 61);
        expect(nestedMarker.disposition).toBe("truncated");
        expect(nestedMarker.omitted).toBe(4);
        expect(nestedMarker.value).toEqual({
            nested: {
                list: [1, 2, 3, 4, 5, 6],
                meta: { [TRUNCATION_MARKER_KEY]: 4 },
            },
        });
        expect(emittedLength(nestedMarker)).toBeLessThanOrEqual(61);
        expect(markerSum(nestedMarker.value)).toBe(nestedMarker.omitted);

        // Array elements are counted: the elements that fit stay and the
        // rest are reported by the marker inside the array.
        const arrayPayload = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
        const arrayResult = budgetEvidence(arrayPayload, 25);
        expect(arrayResult.disposition).toBe("truncated");
        expect(arrayResult.omitted).toBe(11);
        expect(arrayResult.value).toEqual([1, { [TRUNCATION_MARKER_KEY]: 11 }]);
        expect(emittedLength(arrayResult)).toBeLessThanOrEqual(25);
        expect(markerSum(arrayResult.value)).toBe(arrayResult.omitted);

        // The same budget omits more when the payload's values grow.
        const shorter = budgetEvidence(
            { a: "x".repeat(20), meta: { k: 1, l: 2, m: 3, n: 4 } },
            55,
        );
        const longer = budgetEvidence(
            { a: "x".repeat(200), meta: { k: 1, l: 2, m: 3, n: 4 } },
            55,
        );
        expect(shorter.disposition).toBe("truncated");
        expect(longer.disposition).toBe("truncated");
        expect(shorter.omitted).toBe(4);
        expect(longer.omitted).toBe(5);
        expect(longer.omitted).toBeGreaterThan(shorter.omitted);
        expect(emittedLength(longer)).toBeLessThanOrEqual(55);
    });

    test("same input and same budget are deterministic", () => {
        const payload = { b: [1, 2, { c: "x".repeat(300) }], a: { d: 1 } };
        const first = budgetEvidence(payload, 40);
        const second = budgetEvidence(payload, 40);
        expect(second).toEqual(first);
        expect(JSON.stringify(second.value)).toBe(JSON.stringify(first.value));

        budgetEvidence({ z: "y".repeat(500) }, 30);
        const afterOtherCall = budgetEvidence(payload, 40);
        expect(afterOtherCall).toEqual(first);
    });

    test("serializer semantics are reused for edge-case payloads", () => {
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        const payload = {
            plain: "text",
            missing: undefined,
            notANumber: Number.NaN,
            infinite: Number.POSITIVE_INFINITY,
            nothing: null,
            circular,
        };
        const result = budgetEvidence(payload, 10_000);
        expect(result.disposition).toBe("ok");
        expect(result.omitted).toBe(0);
        expect(result.value).toEqual(serializeJson(payload));
        expect(result.value).toEqual({
            plain: "text",
            missing: null,
            notANumber: "NaN",
            infinite: "Infinity",
            nothing: null,
            circular: { self: "[Circular]" },
        });
    });

    test("budgetRawEvidence applies the MAX_RAW_EVIDENCE bound", () => {
        const fits = budgetRawEvidence({ a: 1 });
        expect(fits).toEqual({
            value: { a: 1 },
            disposition: "ok",
            omitted: 0,
        });

        const oversized = { a: "x".repeat(MAX_RAW_EVIDENCE + 100) };
        const truncated = budgetRawEvidence(oversized);
        expect(truncated.disposition).toBe("truncated");
        expect(truncated.omitted).toBeGreaterThan(0);
        expect(truncated.value).toEqual({
            a: { [TRUNCATION_MARKER_KEY]: 1 },
        });
        expect(emittedLength(truncated)).toBeLessThanOrEqual(MAX_RAW_EVIDENCE);
        expect(JSON.stringify(truncated.value)).not.toContain("x".repeat(100));
    });

    test("empty containers respect the budget", () => {
        expect(budgetEvidence({}, MIN_EVIDENCE_BUDGET)).toEqual({
            value: {},
            disposition: "ok",
            omitted: 0,
        });
        expect(budgetEvidence([], MIN_EVIDENCE_BUDGET)).toEqual({
            value: [],
            disposition: "ok",
            omitted: 0,
        });
    });

    test("budgets too small to hold the truncation marker are rejected", () => {
        for (let budget = 1; budget < MIN_EVIDENCE_BUDGET; budget++) {
            expect(() => budgetEvidence({ a: 1 }, budget)).toThrow(RangeError);
            expect(() => budgetEvidence([1, 2, 3], budget)).toThrow(RangeError);
            expect(() => budgetEvidence("x".repeat(500), budget)).toThrow(
                RangeError,
            );
        }
    });

    test("non-positive and non-integer budgets are rejected", () => {
        for (const budget of [
            0,
            -1,
            1.5,
            Number.NaN,
            Number.POSITIVE_INFINITY,
            Number.MAX_SAFE_INTEGER + 1,
        ]) {
            expect(() => budgetEvidence({ a: 1 }, budget)).toThrow(RangeError);
        }
    });
});