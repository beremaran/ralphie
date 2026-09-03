import { describe, expect, test } from "bun:test";

import {
    InvalidHomebrewVersionError,
    renderDocumentationTargets,
    renderHomebrewTargetRows,
    renderPosixInstallerTarget,
} from "../../src/targets/standalone-target-renderers.ts";
import { UnsupportedTargetSelectorError } from "../../src/targets/standalone-target-query.ts";
import { serializeStandaloneTargets } from "../../src/targets/standalone-target-serializer.ts";
import {
    loadStandaloneTargets,
    type StandaloneTarget,
} from "../../src/targets/standalone-targets.ts";

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

const recordById = (
    records: ReadonlyArray<{ readonly id: string }>,
    id: string,
) => {
    const record = records.find((candidate) => candidate.id === id);
    expect(record).toBeDefined();
    return record as { readonly id: string };
};

const canonicalRecord = (id: string) => {
    const record = canonicalCatalog.find((target) => target.id === id);
    expect(record).toBeDefined();
    return record as (typeof canonicalCatalog)[number];
};

describe("standalone target consumer renderers", () => {
    test("posix installer mapping returns the full record for a canonical pair", () => {
        const target = renderPosixInstallerTarget(
            canonicalCatalog,
            "darwin",
            "arm64",
        );
        expect(target).toEqual(canonicalRecord("darwin-arm64"));
        expect(target.releaseAssetName).toBe("ralphie-darwin-arm64");
        expect(target.bunCompileTarget).toBe("bun-darwin-arm64");
        expect(target.targetTriple).toBe("aarch64-apple-darwin");
        expect(target.runner).toBe("macos-14");
        expect(target.binaryFormat).toBe("Mach-O arm64");
        expect(target.bunVersion).toBe("1.3.14");
        expect(target.dockerPlatform).toBeNull();
    });

    test("posix installer mapping normalizes os/arch aliases through the query API", () => {
        const cases = [
            { os: "Darwin", arch: "x86_64", id: "darwin-x64" },
            { os: "macOS", arch: "aarch64", id: "darwin-arm64" },
            { os: "Linux", arch: "amd64", id: "linux-x64" },
            { os: "  linux ", arch: " ARM64 ", id: "linux-arm64" },
        ] as const;
        for (const { os, arch, id } of cases) {
            expect(
                renderPosixInstallerTarget(canonicalCatalog, os, arch),
            ).toEqual(canonicalRecord(id));
            expect(
                renderPosixInstallerTarget(canonicalCatalog, os, arch)
                    .releaseAssetName,
            ).toBe(canonicalRecord(id).releaseAssetName);
        }
    });

    test("posix installer mapping rejects unsupported pairs with typed errors", () => {
        expect(() =>
            renderPosixInstallerTarget(canonicalCatalog, "windows", "arm64"),
        ).toThrow(UnsupportedTargetSelectorError);
        expect(() =>
            renderPosixInstallerTarget(canonicalCatalog, "darwin", "riscv64"),
        ).toThrow(UnsupportedTargetSelectorError);
    });

    test("homebrew mapping emits rows sorted by stable id", () => {
        const rows = renderHomebrewTargetRows(canonicalCatalog, "0.1.2");
        expect(rows.map((row) => row.target.id)).toEqual([
            "darwin-arm64",
            "darwin-x64",
            "linux-arm64",
            "linux-x64",
        ]);
    });

    test("homebrew rows contain the full target record and versioned download URL", () => {
        const rows = renderHomebrewTargetRows(canonicalCatalog, "0.1.2");
        for (const row of rows) {
            expect(Object.keys(row.target).sort()).toEqual(
                EXPECTED_RECORD_KEYS,
            );
            expect(row.target).toEqual(canonicalRecord(row.target.id));
            expect(row.version).toBe("0.1.2");
            expect(row.downloadUrl).toBe(
                `https://github.com/beremaran/ralphie/releases/download/v0.1.2/${row.target.releaseAssetName}`,
            );
        }

        const linuxArm64 = recordById(
            rows.map((row) => row.target),
            "linux-arm64",
        );
        expect(linuxArm64).toEqual(canonicalRecord("linux-arm64"));
        expect(
            rows.find((row) => row.target.id === "linux-arm64")?.target
                .bunCompileTarget,
        ).toBe("bun-linux-arm64");
    });

    test("homebrew download URL always comes from the record's releaseAssetName", () => {
        const rows = renderHomebrewTargetRows(canonicalCatalog, "2.4.6");
        for (const row of rows) {
            expect(row.downloadUrl).toBe(
                `https://github.com/beremaran/ralphie/releases/download/v2.4.6/${row.target.releaseAssetName}`,
            );
            expect(row.target.releaseAssetName).toBe(
                canonicalRecord(row.target.id).releaseAssetName,
            );
        }
    });

    test("homebrew version is an explicit validated input, not a constant", () => {
        const first = renderHomebrewTargetRows(canonicalCatalog, "1.2.3");
        const second = renderHomebrewTargetRows(canonicalCatalog, "9.8.7");
        expect(first[0]?.downloadUrl).toBe(
            "https://github.com/beremaran/ralphie/releases/download/v1.2.3/ralphie-darwin-arm64",
        );
        expect(second[0]?.downloadUrl).toBe(
            "https://github.com/beremaran/ralphie/releases/download/v9.8.7/ralphie-darwin-arm64",
        );
        expect(first[0]?.downloadUrl).not.toBe(second[0]?.downloadUrl);

        const invalidVersions = [
            "",
            "latest",
            "v1.2.3",
            "1.2",
            "1.2.3.4",
            "01.2.3",
            "1.02.3",
            "1.2.03",
            "1.2.3-rc.1",
            "1.2.3+build.7",
            " 1.2.3",
        ];
        for (const version of invalidVersions) {
            expect(() =>
                renderHomebrewTargetRows(canonicalCatalog, version),
            ).toThrow(InvalidHomebrewVersionError);
        }
    });

    test("documentation mapping emits the complete sorted catalog with all fields", () => {
        const catalog = renderDocumentationTargets(canonicalCatalog);
        expect(catalog).toHaveLength(4);
        expect(catalog.map((record) => record.id)).toEqual([
            "darwin-arm64",
            "darwin-x64",
            "linux-arm64",
            "linux-x64",
        ]);
        for (const record of catalog) {
            expect(Object.keys(record).sort()).toEqual(EXPECTED_RECORD_KEYS);
            expect(record).toEqual(canonicalRecord(record.id));
        }
        expect(catalog).toEqual(canonicalCatalog);
    });

    test("documentation mapping matches the serializer document's records", () => {
        const catalog = renderDocumentationTargets(canonicalCatalog);
        const serialized = JSON.parse(
            serializeStandaloneTargets(canonicalCatalog),
        ) as unknown as ReadonlyArray<StandaloneTarget>;
        expect(catalog).toEqual(serialized);
    });

    test("all renderers are deterministic and freeze their output arrays", () => {
        expect(renderDocumentationTargets(canonicalCatalog)).toEqual(
            renderDocumentationTargets(canonicalCatalog),
        );
        expect(renderHomebrewTargetRows(canonicalCatalog, "0.1.2")).toEqual(
            renderHomebrewTargetRows(canonicalCatalog, "0.1.2"),
        );
        expect(
            renderHomebrewTargetRows(canonicalCatalog, "0.1.2")[0]?.target,
        ).toEqual(canonicalRecord("darwin-arm64"));

        const catalog = renderDocumentationTargets(canonicalCatalog);
        const rows = renderHomebrewTargetRows(canonicalCatalog, "0.1.2");
        expect(Object.isFrozen(catalog)).toBe(true);
        expect(Object.isFrozen(rows)).toBe(true);
        for (const record of catalog)
            expect(Object.isFrozen(record)).toBe(true);
        for (const row of rows) expect(Object.isFrozen(row.target)).toBe(true);
    });

    test("renderers validate raw unknown input through the canonical API first", () => {
        const raw: unknown = JSON.parse(
            serializeStandaloneTargets(canonicalCatalog),
        );
        expect(renderDocumentationTargets(raw)).toEqual(
            renderDocumentationTargets(canonicalCatalog),
        );
        expect(renderHomebrewTargetRows(raw, "0.1.2")).toEqual(
            renderHomebrewTargetRows(canonicalCatalog, "0.1.2"),
        );
        expect(renderPosixInstallerTarget(raw, "linux", "arm64")).toEqual(
            canonicalRecord("linux-arm64"),
        );
    });

    test("renderers throw before any output for malformed or non-canonical manifests", () => {
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
            expect(() => renderDocumentationTargets(input)).toThrow();
            expect(() => renderHomebrewTargetRows(input, "0.1.2")).toThrow();
            expect(() =>
                renderPosixInstallerTarget(input, "darwin", "arm64"),
            ).toThrow();
        }
    });
});