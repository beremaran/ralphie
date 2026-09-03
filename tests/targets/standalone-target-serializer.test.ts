import { describe, expect, test } from "bun:test";

import {
    serializeStandaloneTargetMatrix,
    serializeStandaloneTargets,
} from "../../src/targets/standalone-target-serializer.ts";
import { loadStandaloneTargets } from "../../src/targets/standalone-targets.ts";

const canonicalCatalog = await loadStandaloneTargets();

/** Lexicographically sorted key set of a complete canonical target record. */
const EXPECTED_RECORD_KEYS = [
    "arch",
    "binaryFormat",
    "bunCompileTarget",
    "bunVersion",
    "dockerPlatform",
    "id",
    "os",
    "releaseAssetName",
    "runner",
    "targetTriple",
];

describe("standalone target serializers", () => {
    test("sorts catalog and matrix records lexicographically by stable id", () => {
        const expectedIds = [...canonicalCatalog]
            .map((target) => target.id)
            .sort();
        expect(expectedIds).toEqual([
            "darwin-arm64",
            "darwin-x64",
            "linux-arm64",
            "linux-x64",
        ]);

        const catalog = JSON.parse(
            serializeStandaloneTargets(canonicalCatalog),
        ) as Array<{ readonly id: string }>;
        expect(catalog.map((record) => record.id)).toEqual(expectedIds);

        const matrix = JSON.parse(
            serializeStandaloneTargetMatrix(canonicalCatalog),
        ) as { readonly include: Array<{ readonly id: string }> };
        expect(matrix.include.map((record) => record.id)).toEqual(expectedIds);

        // The matrix carries the same complete records as the catalog.
        expect(matrix.include).toEqual(catalog);
    });

    test("sorts object keys lexicographically at every depth", () => {
        const catalog = JSON.parse(
            serializeStandaloneTargets(canonicalCatalog),
        ) as Array<Record<string, unknown>>;

        expect(catalog).toHaveLength(4);
        for (const record of catalog) {
            expect(Object.keys(record)).toEqual(
                [...Object.keys(record)].sort(),
            );
            expect(Object.keys(record)).toEqual(EXPECTED_RECORD_KEYS);
        }

        const matrix = JSON.parse(
            serializeStandaloneTargetMatrix(canonicalCatalog),
        ) as { readonly include: Array<Record<string, unknown>> };
        expect(Object.keys(matrix)).toEqual(["include"]);
        for (const record of matrix.include) {
            expect(Object.keys(record)).toEqual(EXPECTED_RECORD_KEYS);
        }
    });

    test("emits UTF-8 without BOM, LF-only line endings, and one final newline", () => {
        const text = serializeStandaloneTargets(canonicalCatalog);
        const bytes = new TextEncoder().encode(text);

        expect(bytes.length).toBeGreaterThan(0);
        // No UTF-8 BOM prefix (EF BB BF) and no BOM character in the string.
        expect([...bytes.slice(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
        expect(text.startsWith("[")).toBe(true);

        // LF line endings only: no carriage-return bytes anywhere.
        expect([...bytes].includes(0x0d)).toBe(false);
        expect(text).not.toContain("\r");
        expect(text).toContain("\n");

        // Exactly one final newline after the closing bracket.
        expect(text.endsWith("]\n")).toBe(true);
        expect(text.endsWith("\n\n")).toBe(false);
        expect(bytes[bytes.length - 1]).toBe(0x0a);
        expect(bytes[bytes.length - 2]).toBe(0x5d); // ']'

        const matrixText = serializeStandaloneTargetMatrix(canonicalCatalog);
        const matrixBytes = new TextEncoder().encode(matrixText);
        expect([...matrixBytes.slice(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
        expect([...matrixBytes].includes(0x0d)).toBe(false);
        expect(matrixText.endsWith("}\n")).toBe(true);
        expect(matrixText.endsWith("\n\n")).toBe(false);
        expect(matrixBytes[matrixBytes.length - 1]).toBe(0x0a);
    });

    test("is deterministic and repeatable across calls and inputs", () => {
        const first = serializeStandaloneTargets(canonicalCatalog);
        const second = serializeStandaloneTargets(canonicalCatalog);
        expect(second).toBe(first);

        expect(serializeStandaloneTargetMatrix(canonicalCatalog)).toBe(
            serializeStandaloneTargetMatrix(canonicalCatalog),
        );

        // Re-validating the catalog through the canonical parser and
        // serializing that fresh value yields the identical document.
        const reparsed = JSON.parse(first) as unknown;
        expect(serializeStandaloneTargets(reparsed)).toBe(first);
        expect(serializeStandaloneTargetMatrix(reparsed)).toBe(
            serializeStandaloneTargetMatrix(canonicalCatalog),
        );
    });

    test("preserves every catalog field, including null dockerPlatform", () => {
        const records = JSON.parse(
            serializeStandaloneTargets(canonicalCatalog),
        ) as Array<Record<string, unknown>>;

        for (const record of records) {
            expect(Object.keys(record)).toEqual(EXPECTED_RECORD_KEYS);
        }

        const darwinArm64 = records.find(
            (record) => record.id === "darwin-arm64",
        );
        expect(darwinArm64).toBeDefined();
        expect(darwinArm64?.["dockerPlatform"]).toBeNull();
        expect(darwinArm64?.["binaryFormat"]).toBe("Mach-O arm64");
        expect(darwinArm64?.["runner"]).toBe("macos-14");
        expect(darwinArm64?.["bunCompileTarget"]).toBe("bun-darwin-arm64");
        expect(darwinArm64?.["releaseAssetName"]).toBe("ralphie-darwin-arm64");
        expect(darwinArm64?.["bunVersion"]).toBe("1.3.14");
        expect(serializeStandaloneTargets(canonicalCatalog)).toContain(
            '"dockerPlatform": null',
        );

        const linuxX64 = records.find((record) => record.id === "linux-x64");
        expect(linuxX64?.["dockerPlatform"]).toBe("linux/amd64");
        expect(linuxX64?.["runner"]).toBe("ubuntu-24.04");
    });

    test("parses raw unknown input through the canonical API first", () => {
        const raw: unknown = JSON.parse(
            serializeStandaloneTargets(canonicalCatalog),
        );
        expect(serializeStandaloneTargets(raw)).toBe(
            serializeStandaloneTargets(canonicalCatalog),
        );
        expect(serializeStandaloneTargetMatrix(raw)).toBe(
            serializeStandaloneTargetMatrix(canonicalCatalog),
        );
    });

    test("throws before producing any output for malformed or non-canonical manifests", () => {
        const valid = canonicalCatalog.map((record) => ({ ...record }));
        const malformed: Array<unknown> = [
            // Duplicated id / lost record count.
            [...valid, { ...valid[0] }],
            // Wrong canonical order.
            [valid[2], valid[0], valid[1], valid[3]],
            // Unknown field under the strict schema.
            valid.map((record) => ({ ...record, extraField: "x" })),
            // Omitted field — never inferred.
            valid.map((record) =>
                Object.fromEntries(
                    Object.entries(record).filter(([key]) => key !== "runner"),
                ),
            ),
            // Non-canonical field value — never inferred or rewritten.
            valid.map((record) =>
                record.id === "darwin-arm64"
                    ? { ...record, runner: "ubuntu-24.04" }
                    : record,
            ),
            // Non-canonical dockerPlatform.
            valid.map((record) => ({ ...record, dockerPlatform: "wrong" })),
        ];

        for (const input of malformed) {
            expect(() => serializeStandaloneTargets(input)).toThrow();
            expect(() => serializeStandaloneTargetMatrix(input)).toThrow();
        }
    });
});