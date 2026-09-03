import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { checkStandaloneTargetsFile } from "../../scripts/standalone-targets.ts";
import { renderPosixInstallerMapping } from "../../src/targets/standalone-target-renderers.ts";
import { serializeStandaloneJsonDocument } from "../../src/targets/standalone-target-serializer.ts";
import { loadStandaloneTargets } from "../../src/targets/standalone-targets.ts";

const canonicalCatalog = await loadStandaloneTargets();
const mapping = renderPosixInstallerMapping(canonicalCatalog);

/**
 * The installer's resolution protocol, transcribed from scripts/install.sh:
 * case-fold the raw `uname` value, resolve it through the generated alias
 * table, then read the matching record's `releaseAssetName`. The protocol
 * itself is pure data driving; the mapping document is what must satisfy it.
 */
const installerAssetFor = (
    rawOs: string,
    rawArch: string,
): string | undefined => {
    const canonicalOs = mapping.osAliases[rawOs.toLowerCase().trim()];
    const canonicalArch = mapping.archAliases[rawArch.toLowerCase().trim()];
    if (canonicalOs === undefined || canonicalArch === undefined) {
        return undefined;
    }
    const record = mapping.targets.find(
        (target) => target.os === canonicalOs && target.arch === canonicalArch,
    );
    return record?.releaseAssetName;
};

const canonicalRecord = (id: string) => {
    const record = canonicalCatalog.find((target) => target.id === id);
    expect(record).toBeDefined();
    return record as (typeof canonicalCatalog)[number];
};

describe("checked-in POSIX installer mapping", () => {
    test("the checked-in artifact is byte-identical to the rendered document", async () => {
        const artifactPath = resolve(
            import.meta.dir,
            "../../targets/posix-installer-targets.json",
        );
        const outcome = await checkStandaloneTargetsFile({
            format: "posix-mapping",
            filePath: artifactPath,
        });
        expect(outcome).toEqual({ status: "match" });
    });

    test("the generated document is deterministic and re-renderable", () => {
        expect(serializeStandaloneJsonDocument(mapping)).toBe(
            serializeStandaloneJsonDocument(mapping),
        );
        expect(
            serializeStandaloneJsonDocument(
                renderPosixInstallerMapping(canonicalCatalog),
            ),
        ).toBe(serializeStandaloneJsonDocument(mapping));
    });

    test("every canonical target resolves to exactly its releaseAssetName", () => {
        for (const id of [
            "darwin-arm64",
            "darwin-x64",
            "linux-arm64",
            "linux-x64",
        ] as const) {
            const record = canonicalRecord(id);
            expect(installerAssetFor(record.os, record.arch)).toBe(
                record.releaseAssetName,
            );
            expect(record.releaseAssetName).toBe(
                `ralphie-${record.os}-${record.arch}`,
            );
        }
    });

    test("uname aliases normalize into the canonical targets", () => {
        const cases = [
            ["Darwin", "x86_64", "ralphie-darwin-x64"],
            ["macOS", "aarch64", "ralphie-darwin-arm64"],
            ["Linux", "amd64", "ralphie-linux-x64"],
            ["linux", "x86_64", "ralphie-linux-x64"],
            ["DARWIN", "ARM64", "ralphie-darwin-arm64"],
        ] as const;
        for (const [os, arch, asset] of cases) {
            expect(installerAssetFor(os, arch)).toBe(asset);
        }
    });

    test("unsupported combinations fail clearly with no asset", () => {
        const unsupported = [
            ["Windows", "arm64"],
            ["Darwin", "riscv64"],
            ["Linux", "i386"],
            ["plan9", "x86_64"],
            ["darwin", "mips64"],
            ["", "arm64"],
            ["darwin", ""],
        ] as const;
        for (const [os, arch] of unsupported) {
            expect(installerAssetFor(os, arch)).toBeUndefined();
        }
    });

    test("asset names are the manifest's releaseAssetName, never reconstructed", () => {
        for (const record of mapping.targets) {
            expect(record.releaseAssetName).toBe(
                canonicalRecord(record.id).releaseAssetName,
            );
        }
        // The mapping carries every catalog field untouched.
        for (const record of mapping.targets) {
            const expected = canonicalRecord(record.id);
            expect(record).toEqual(expected);
            expect(record.bunCompileTarget).toBe(expected.bunCompileTarget);
            expect(record.dockerPlatform).toBe(expected.dockerPlatform);
        }
    });

    test("changing bunCompileTarget cannot change an asset name", () => {
        // The consumer mapping resolves downloads from `releaseAssetName`
        // alone; the compiler-target field never feeds the asset name. A
        // manifest that edits bunCompileTarget without editing the record's
        // own releaseAssetName field is rejected before any output exists, so
        // the generated mapping's asset names are unchanged.
        const edited: unknown = canonicalCatalog.map((record) =>
            record.id === "linux-x64"
                ? { ...record, bunCompileTarget: "bun-custom-linux-x64" }
                : record,
        );
        expect(() => renderPosixInstallerMapping(edited)).toThrow();

        // Asset names in the mapping are byte-for-byte the manifest's
        // releaseAssetName field for every record.
        for (const record of mapping.targets) {
            expect(record.releaseAssetName).toBe(
                canonicalRecord(record.id).releaseAssetName,
            );
        }
    });

    test("the mapping JSON is parseable by the installer's line-shaped reader", () => {
        // The installer reads known-shape indented JSON with awk; the
        // artifact must keep the four-space alias rows and six-space record
        // fields the reader pattern-matches on.
        const text = serializeStandaloneJsonDocument(mapping);
        for (const aliasEntry of [
            '"darwin": "darwin"',
            '"macos": "darwin"',
            '"aarch64": "arm64"',
            '"amd64": "x64"',
            '"releaseAssetName": "ralphie-darwin-arm64"',
        ]) {
            expect(text).toContain(aliasEntry);
        }
        // Alias entries are the only 4-space-indented key/value rows; record
        // fields are 6-space-indented and never collide with alias keys.
        for (const line of text.split("\n")) {
            if (!line.startsWith('    "')) continue;
            expect(line).toMatch(/^    "[^"]+": "[^"]*",?$/);
        }
    });
});