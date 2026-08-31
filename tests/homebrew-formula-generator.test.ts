import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import {
    HOMEBREW_FORMULA_BEGIN_MARKER,
    HOMEBREW_FORMULA_END_MARKER,
    parseHomebrewReleaseMetadata,
    renderHomebrewFormula,
} from "../scripts/generate-homebrew-formula.ts";

const formulaPath = resolve(import.meta.dir, "../Formula/ralphie.rb");
const version = "0.1.2";
const checksums = {
    "darwin-arm64":
        "30be72de92306adb5609a6e8bc2ddb9e9cc29d671e8e0dd87c1921f11aaaf5c5",
    "darwin-x64":
        "c08317b2f19011970d7a1579422d9c634cb756eaefafb147704ef8bbf1605ac8",
    "linux-arm64":
        "c23f670a69c60c8770bb4958e91ae3007804bab889b55ee8807f2fffd04295f5",
    "linux-x64":
        "c0d8b5ff1b24e554121bf879fb68380038ca7fbe27a63fd5857d6a1b27d2b300",
} as const;

const metadata = {
    version,
    tag: `v${version}`,
    assets: Object.entries(checksums).map(([target, sha256]) => ({
        name: `ralphie-${target}`,
        sha256,
    })),
};

const readFormula = (): Promise<string> => readFile(formulaPath, "utf8");

describe("Homebrew formula generator", () => {
    test("renders exact URLs and checksums for every platform selection", async () => {
        const rendered = renderHomebrewFormula(await readFormula(), metadata);

        for (const [target, sha256] of Object.entries(checksums)) {
            expect(rendered).toContain(
                `url "https://github.com/beremaran/ralphie/releases/download/v#{version}/ralphie-${target}"`,
            );
            expect(rendered).toContain(`sha256 "${sha256}"`);
        }
        expect(rendered).toContain(`version "${version}"`);
    });

    test("preserves the formula sections outside the generated region", async () => {
        const formula = await readFormula();
        const start = formula.indexOf(HOMEBREW_FORMULA_BEGIN_MARKER);
        const end = formula.indexOf(HOMEBREW_FORMULA_END_MARKER);
        const rendered = renderHomebrewFormula(formula, metadata);

        expect(rendered.slice(0, start)).toBe(formula.slice(0, start));
        const renderedEnd = rendered.indexOf(HOMEBREW_FORMULA_END_MARKER);
        expect(
            rendered.slice(renderedEnd + HOMEBREW_FORMULA_END_MARKER.length),
        ).toBe(formula.slice(end + HOMEBREW_FORMULA_END_MARKER.length));
        expect(rendered).toContain(
            'bin.install Dir["ralphie-*"].first => "ralphie"',
        );
        expect(rendered).toContain('system "#{bin}/ralphie", "--version"');
    });

    test("is deterministic and stable when rendered repeatedly", async () => {
        const formula = await readFormula();
        const first = renderHomebrewFormula(formula, metadata);
        const second = renderHomebrewFormula(formula, metadata);
        const third = renderHomebrewFormula(first, metadata);

        expect(second).toBe(first);
        expect(third).toBe(first);
    });

    test("rejects invalid versions, tags, and prereleases", () => {
        expect(() =>
            parseHomebrewReleaseMetadata({
                ...metadata,
                version: "0.1.2-beta",
            }),
        ).toThrow("Invalid release version");
        expect(() =>
            parseHomebrewReleaseMetadata({ ...metadata, tag: "v0.1.3" }),
        ).toThrow("does not match version");
    });

    test("rejects missing, duplicate, and malformed assets", () => {
        const firstAsset = metadata.assets[0]!;
        const missing = metadata.assets.slice(0, -1);
        const duplicate = [
            firstAsset,
            ...metadata.assets.slice(1, -1),
            firstAsset,
        ];

        expect(() =>
            parseHomebrewReleaseMetadata({ ...metadata, assets: missing }),
        ).toThrow("exactly 4 assets");
        expect(() =>
            parseHomebrewReleaseMetadata({ ...metadata, assets: duplicate }),
        ).toThrow("duplicate asset");
        expect(() =>
            parseHomebrewReleaseMetadata({
                ...metadata,
                assets: metadata.assets.map((asset, index) =>
                    index === 0 ? { ...asset, sha256: "A".repeat(64) } : asset,
                ),
            }),
        ).toThrow("64 lowercase hexadecimal");
    });

    test("fails closed when formula markers are not a single ordered pair", async () => {
        const formula = await readFormula();

        expect(() =>
            renderHomebrewFormula(
                formula.replace(HOMEBREW_FORMULA_BEGIN_MARKER, ""),
                metadata,
            ),
        ).toThrow("exactly one");
        expect(() =>
            renderHomebrewFormula(
                formula.replace(
                    HOMEBREW_FORMULA_END_MARKER,
                    `${HOMEBREW_FORMULA_END_MARKER}\n${HOMEBREW_FORMULA_END_MARKER}`,
                ),
                metadata,
            ),
        ).toThrow("exactly one");
        expect(() =>
            renderHomebrewFormula(
                formula
                    .replace(
                        HOMEBREW_FORMULA_BEGIN_MARKER,
                        "MARKER_PLACEHOLDER",
                    )
                    .replace(
                        HOMEBREW_FORMULA_END_MARKER,
                        HOMEBREW_FORMULA_BEGIN_MARKER,
                    )
                    .replace("MARKER_PLACEHOLDER", HOMEBREW_FORMULA_END_MARKER),
                metadata,
            ),
        ).toThrow("out of order");
    });
});