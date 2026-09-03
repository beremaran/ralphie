import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    HOMEBREW_FORMULA_BEGIN_MARKER,
    HOMEBREW_FORMULA_END_MARKER,
    generateHomebrewFormula,
    renderHomebrewFormula,
} from "../../scripts/generate-homebrew-formula.ts";
import {
    expectedAssetsFromRows,
    parseHomebrewFormula,
} from "../../scripts/validate-homebrew-formula.ts";
import { renderHomebrewTargetRows } from "../../src/targets/standalone-target-renderers.ts";
import { loadStandaloneTargets } from "../../src/targets/standalone-targets.ts";

const canonicalCatalog = await loadStandaloneTargets();

/** A formula with an empty marked region and the real install/test body. */
const REFERENCE_FORMULA = [
    "class Ralphie < Formula",
    '  desc "Turn a GitHub issue queue into reviewed commits with Pi"',
    '  homepage "https://github.com/beremaran/ralphie"',
    '  license "MIT"',
    HOMEBREW_FORMULA_BEGIN_MARKER,
    HOMEBREW_FORMULA_END_MARKER,
    "",
    "  def install",
    '    bin.install Dir["ralphie-*"].first => "ralphie"',
    "  end",
    "",
    "  test do",
    '    system "#{bin}/ralphie", "--version"',
    "  end",
    "end",
    "",
].join("\n");

const REFERENCE_METADATA = {
    version: "0.1.2",
    tag: "v0.1.2",
    assets: [
        {
            name: "ralphie-darwin-arm64",
            sha256: "30be72de92306adb5609a6e8bc2ddb9e9cc29d671e8e0dd87c1921f11aaaf5c5",
        },
        {
            name: "ralphie-darwin-x64",
            sha256: "c08317b2f19011970d7a1579422d9c634cb756eaefafb147704ef8bbf1605ac8",
        },
        {
            name: "ralphie-linux-arm64",
            sha256: "c23f670a69c60c8770bb4958e91ae3007804bab889b55ee8807f2fffd04295f5",
        },
        {
            name: "ralphie-linux-x64",
            sha256: "c0d8b5ff1b24e554121bf879fb68380038ca7fbe27a63fd5857d6a1b27d2b300",
        },
    ],
} as const;

const renderedFormula = (): string =>
    renderHomebrewFormula(
        REFERENCE_FORMULA,
        REFERENCE_METADATA,
        canonicalCatalog,
    );

describe("catalog-driven Homebrew formula generator", () => {
    test("renders the macOS and Linux CPU branches from catalog asset values", () => {
        const rendered = renderedFormula();
        const rows = renderHomebrewTargetRows(canonicalCatalog, "0.1.2");
        const expected = expectedAssetsFromRows(rows);

        expect(rendered).toContain('version "0.1.2"');
        expect(rendered).toContain(HOMEBREW_FORMULA_BEGIN_MARKER);
        expect(rendered).toContain(HOMEBREW_FORMULA_END_MARKER);
        expect(HOMEBREW_FORMULA_BEGIN_MARKER).toContain("DO NOT EDIT");

        for (const asset of expected) {
            const branchLabel = asset.os === "darwin" ? "macos" : asset.os;
            expect(rendered).toContain(`on_${branchLabel} do`);
            expect(
                rendered.indexOf(`on_${branchLabel} do`),
            ).toBeGreaterThanOrEqual(0);
            expect(rendered).toContain(
                `https://github.com/beremaran/ralphie/releases/download/v#{version}/${asset.assetName}`,
            );
            const row = rows.find(
                (candidate) =>
                    candidate.target.releaseAssetName === asset.assetName,
            )?.target;
            expect(row?.arch).toBe(asset.arch);
            expect(row?.os).toBe(asset.os);
        }
    });

    test("generates the arm and x64 branches in the Homebrew DSL order", () => {
        const rendered = renderedFormula();
        const darwin = rendered.slice(
            rendered.indexOf("  on_macos do"),
            rendered.indexOf("  on_linux do"),
        );
        expect(
            darwin.indexOf(
                'url "https://github.com/beremaran/ralphie/releases/download/v#{version}/ralphie-darwin-arm64"',
            ),
        ).toBeLessThan(darwin.indexOf("ralphie-darwin-x64"));
        expect(darwin).toContain("Hardware::CPU.arm?");

        const linux = rendered.slice(rendered.indexOf("  on_linux do"));
        expect(linux.indexOf("ralphie-linux-arm64")).toBeLessThan(
            linux.indexOf("ralphie-linux-x64"),
        );
        expect(linux).toContain("Hardware::CPU.arm?");
    });

    test("keeps the install and test behavior outside the region", () => {
        const rendered = renderedFormula();
        expect(rendered).toContain(
            'bin.install Dir["ralphie-*"].first => "ralphie"',
        );
        expect(rendered).toContain('system "#{bin}/ralphie", "--version"');
        expect(rendered).toContain(
            'desc "Turn a GitHub issue queue into reviewed commits with Pi"',
        );
        expect(rendered).toContain('license "MIT"');
        // Exactly one marker pair.
        expect(rendered.split(HOMEBREW_FORMULA_BEGIN_MARKER).length - 1).toBe(
            1,
        );
        expect(rendered.split(HOMEBREW_FORMULA_END_MARKER).length - 1).toBe(1);
    });

    test("generated URLs use exactly the catalog releaseAssetName values", () => {
        const rendered = renderedFormula();
        const rows = renderHomebrewTargetRows(canonicalCatalog, "0.1.2");
        for (const row of rows) {
            const asset = row.target.releaseAssetName;
            expect(rendered).toContain(
                `https://github.com/beremaran/ralphie/releases/download/v#{version}/${asset}`,
            );
        }
    });

    test("renders deterministically with explicit version input", () => {
        expect(renderedFormula()).toBe(renderedFormula());
        const other = renderHomebrewFormula(
            REFERENCE_FORMULA,
            {
                ...REFERENCE_METADATA,
                version: "2.4.6",
                tag: "v2.4.6",
                assets: [
                    {
                        name: "ralphie-darwin-arm64",
                        sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    },
                    {
                        name: "ralphie-darwin-x64",
                        sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                    },
                    {
                        name: "ralphie-linux-arm64",
                        sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
                    },
                    {
                        name: "ralphie-linux-x64",
                        sha256: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
                    },
                ],
            },
            canonicalCatalog,
        );
        expect(other).toContain('version "2.4.6"');
        expect(other).not.toBe(renderedFormula());
        expect(other).toContain(
            "https://github.com/beremaran/ralphie/releases/download/v#{version}/ralphie-linux-x64",
        );
    });

    test("the rendered formula parses back through the catalog-driven validator", () => {
        const rendered = renderedFormula();
        const rows = renderHomebrewTargetRows(canonicalCatalog, "0.1.2");
        const expected = expectedAssetsFromRows(rows);
        const mappings = parseHomebrewFormula(rendered, "0.1.2", expected);
        expect(mappings.size).toBe(4);
        for (const asset of expected) {
            const mapping = mappings.get(asset.assetName);
            expect(mapping).toBeDefined();
            expect(mapping?.url).toBe(
                `https://github.com/beremaran/ralphie/releases/download/v0.1.2/${asset.assetName}`,
            );
        }
    });

    test("rejects metadata asset names outside the catalog", () => {
        const metadata = {
            ...REFERENCE_METADATA,
            assets: [
                ...REFERENCE_METADATA.assets.slice(0, 3),
                {
                    name: "ralphie-freebsd-arm64",
                    sha256: "1111111111111111111111111111111111111111111111111111111111111111",
                },
            ],
        };
        expect(() =>
            renderHomebrewFormula(
                REFERENCE_FORMULA,
                metadata,
                canonicalCatalog,
            ),
        ).toThrow(/exactly/);
    });

    test("rejects missing, placeholder, or copied checksums in the metadata", () => {
        const withoutOne = {
            version: "0.1.2",
            tag: "v0.1.2",
            assets: REFERENCE_METADATA.assets.slice(0, 3),
        };
        expect(() =>
            renderHomebrewFormula(
                REFERENCE_FORMULA,
                withoutOne,
                canonicalCatalog,
            ),
        ).toThrow(/assets/);

        const placeholder = {
            ...REFERENCE_METADATA,
            assets: [
                ...REFERENCE_METADATA.assets.slice(1),
                {
                    name: "ralphie-darwin-arm64",
                    sha256: "0000000000000000000000000000000000000000000000000000000000000000",
                },
            ],
        };
        expect(() =>
            renderHomebrewFormula(
                REFERENCE_FORMULA,
                placeholder,
                canonicalCatalog,
            ),
        ).toThrow(/placeholder/);

        const duplicated = {
            ...REFERENCE_METADATA,
            assets: [
                {
                    name: "ralphie-darwin-arm64",
                    sha256: REFERENCE_METADATA.assets[0].sha256,
                },
                {
                    name: "ralphie-darwin-x64",
                    sha256: REFERENCE_METADATA.assets[0].sha256,
                },
                ...REFERENCE_METADATA.assets.slice(2),
            ],
        };
        expect(() =>
            renderHomebrewFormula(
                REFERENCE_FORMULA,
                duplicated,
                canonicalCatalog,
            ),
        ).toThrow(/copied/);
    });

    test("rejects malformed versions, mismatched tags, and unmarked formulas", () => {
        expect(() =>
            renderHomebrewFormula(
                REFERENCE_FORMULA,
                { ...REFERENCE_METADATA, version: "0.1" },
                canonicalCatalog,
            ),
        ).toThrow(/version/);
        expect(() =>
            renderHomebrewFormula(
                REFERENCE_FORMULA,
                { ...REFERENCE_METADATA, tag: "v0.1.3" },
                canonicalCatalog,
            ),
        ).toThrow(/tag/);

        const unmarked = "class Ralphie < Formula\nend\n";
        expect(() =>
            renderHomebrewFormula(
                unmarked,
                REFERENCE_METADATA,
                canonicalCatalog,
            ),
        ).toThrow(/marker/);
    });

    test("rejects non-canonical catalogs before rendering any output", () => {
        const edited = canonicalCatalog.map((record) =>
            record.id === "linux-x64"
                ? { ...record, bunCompileTarget: "bun-custom-linux-x64" }
                : record,
        );
        expect(() =>
            renderHomebrewFormula(
                REFERENCE_FORMULA,
                REFERENCE_METADATA,
                edited,
            ),
        ).toThrow();
    });

    test("changing bunCompileTarget cannot change a generated asset name", () => {
        // The generated regions come from releaseAssetName alone; a manifest
        // that changes only bunCompileTarget is rejected before any output,
        // so the formula's download URLs never change. Only a manifest change
        // to releaseAssetName can alter them.
        const edited = canonicalCatalog.map((record) =>
            record.id === "darwin-arm64"
                ? { ...record, bunCompileTarget: "bun-custom-darwin-arm64" }
                : record,
        );
        expect(() =>
            renderHomebrewFormula(
                REFERENCE_FORMULA,
                REFERENCE_METADATA,
                edited,
            ),
        ).toThrow();
        expect(renderedFormula()).toContain(
            "https://github.com/beremaran/ralphie/releases/download/v#{version}/ralphie-darwin-arm64",
        );
    });

    test("generateHomebrewFormula reads the canonical catalog by default", async () => {
        const directory = await mkdtemp(join(tmpdir(), "ralphie-formula-"));
        try {
            const formulaPath = join(directory, "ralphie.rb");
            const outputPath = join(directory, "ralphie-out.rb");
            await writeFile(formulaPath, REFERENCE_FORMULA, "utf8");
            const metadataPath = join(directory, "release-metadata.json");
            await writeFile(
                metadataPath,
                `${JSON.stringify(REFERENCE_METADATA, null, 2)}\n`,
                "utf8",
            );

            const rendered = await generateHomebrewFormula({
                formulaPath,
                metadataPath,
                outputPath,
            });
            expect(rendered).toBe(await readFile(outputPath, "utf8"));
            expect(rendered).toContain(
                "https://github.com/beremaran/ralphie/releases/download/v#{version}/ralphie-darwin-arm64",
            );
            expect(rendered).not.toBe(REFERENCE_FORMULA);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});