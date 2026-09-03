#!/usr/bin/env bun

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
    renderHomebrewTargetRows,
    type HomebrewTargetRow,
} from "../src/targets/standalone-target-renderers.ts";

export const HOMEBREW_FORMULA_BEGIN_MARKER =
    "  # BEGIN RALPHIE GENERATED RELEASE METADATA - DO NOT EDIT";
export const HOMEBREW_FORMULA_END_MARKER =
    "  # END RALPHIE GENERATED RELEASE METADATA - DO NOT EDIT";

export type HomebrewReleaseAsset = {
    readonly name: string;
    readonly sha256: string;
};

export type HomebrewReleaseMetadata = {
    readonly version: string;
    readonly tag: string;
    readonly assets: ReadonlyArray<HomebrewReleaseAsset>;
};

type GenerateHomebrewFormulaOptions = {
    readonly catalogPath?: string;
    readonly formulaPath: string;
    readonly metadataPath: string;
    readonly outputPath?: string;
};

type RecordValue = Record<string, unknown>;

const releaseVersionPattern =
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?![\s\S])/;
const sha256Pattern = /^[0-9a-f]{64}(?![\s\S])/;

function assert(condition: boolean, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

const asRecord = (value: unknown, description: string): RecordValue => {
    assert(
        typeof value === "object" && value !== null && !Array.isArray(value),
        `${description} must be an object.`,
    );
    return value as RecordValue;
};

const validateVersionAndTag = (version: unknown, tag: unknown): void => {
    assert(
        typeof version === "string" && releaseVersionPattern.test(version),
        `Invalid release version '${String(version)}'; expected <major>.<minor>.<patch>.`,
    );
    assert(
        typeof tag === "string" && tag === `v${version}`,
        `Release tag '${String(tag)}' does not match version '${String(version)}'.`,
    );
};

/**
 * Structurally validate the release-metadata fields used to render the
 * formula: version/tag grammar and per-asset name and SHA-256 shape, with
 * duplicate names and copied or placeholder checksums rejected. The exact
 * asset set is checked against the catalog's release assets by
 * `assertExactReleaseAssets`.
 */
export const parseHomebrewReleaseMetadata = (
    value: unknown,
): HomebrewReleaseMetadata => {
    const metadata = asRecord(value, "Release metadata");
    const version = metadata.version;
    const tag = metadata.tag;
    validateVersionAndTag(version, tag);
    assert(
        typeof version === "string" && typeof tag === "string",
        "Release metadata version and tag must be strings.",
    );

    const rawAssets = metadata.assets;
    assert(
        Array.isArray(rawAssets),
        "Release metadata assets must be an array.",
    );
    const names = new Set<string>();
    const checksums = new Set<string>();
    const assets: HomebrewReleaseAsset[] = [];
    for (const [index, rawAsset] of rawAssets.entries()) {
        const asset = asRecord(rawAsset, `Release metadata asset ${index + 1}`);
        const name = asset.name;
        const sha256 = asset.sha256;
        assert(
            typeof name === "string" && name.length > 0,
            `Release metadata asset ${index + 1} must have a name.`,
        );
        assert(
            !names.has(name),
            `Release metadata contains duplicate asset '${name}'.`,
        );
        names.add(name);
        assert(
            typeof sha256 === "string" && sha256Pattern.test(sha256),
            `Invalid SHA-256 for asset '${name}'; expected 64 lowercase hexadecimal characters.`,
        );
        assert(
            !/^0+$/.test(sha256),
            `Invalid SHA-256 for asset '${name}'; placeholder values are not allowed.`,
        );
        assert(
            !checksums.has(sha256),
            `Release metadata contains a checksum copied between assets: '${sha256}'.`,
        );
        checksums.add(sha256);
        assets.push({ name, sha256 });
    }

    return { version, tag, assets };
};

/**
 * Require the release metadata assets to be exactly the catalog's release
 * assets: same count, same asset names, nothing missing, nothing extra. The
 * expected names come from each catalog row's `releaseAssetName`, never from
 * a rebuilt `ralphie-<os>-<arch>` shape.
 */
export const assertExactReleaseAssets = (
    assets: ReadonlyArray<HomebrewReleaseAsset>,
    rows: ReadonlyArray<HomebrewTargetRow>,
): void => {
    const expectedNames = rows.map((row) => row.target.releaseAssetName);
    assert(
        assets.length === expectedNames.length,
        `Release metadata must contain exactly ${expectedNames.length} assets.`,
    );
    const names = new Set(assets.map((asset) => asset.name));
    assert(
        expectedNames.every((name) => names.has(name)),
        `Release metadata must contain exactly: ${expectedNames.join(", ")}.`,
    );
};

const assetChecksum = (
    metadata: HomebrewReleaseMetadata,
    assetName: string,
): string => {
    const asset = metadata.assets.find(
        (candidate) => candidate.name === assetName,
    );
    assert(
        asset !== undefined,
        `Release metadata is missing asset '${assetName}'.`,
    );
    return asset.sha256;
};

/** The Homebrew platform DSL label for a canonical catalog `os` value. */
export const homebrewPlatformLabel = (os: "darwin" | "linux"): string =>
    os === "darwin" ? "macos" : "linux";

/** The two CPU branches of one Homebrew platform, from catalog records. */
const platformRegion = (
    metadata: HomebrewReleaseMetadata,
    rows: ReadonlyArray<HomebrewTargetRow>,
    platform: "darwin" | "linux",
): readonly string[] => {
    const armRow = rows.find(
        (row) => row.target.os === platform && row.target.arch === "arm64",
    );
    const x64Row = rows.find(
        (row) => row.target.os === platform && row.target.arch === "x64",
    );
    assert(
        armRow !== undefined && x64Row !== undefined,
        `Catalog must contain arm64 and x64 targets for '${platform}'.`,
    );
    const armAsset = armRow.target.releaseAssetName;
    const x64Asset = x64Row.target.releaseAssetName;
    return [
        `  on_${homebrewPlatformLabel(platform)} do`,
        "    if Hardware::CPU.arm?",
        `      url "https://github.com/beremaran/ralphie/releases/download/v#{version}/${armAsset}"`,
        `      sha256 "${assetChecksum(metadata, armAsset)}"`,
        "    else",
        `      url "https://github.com/beremaran/ralphie/releases/download/v#{version}/${x64Asset}"`,
        `      sha256 "${assetChecksum(metadata, x64Asset)}"`,
        "    end",
        "  end",
    ];
};

const generatedRegion = (
    metadata: HomebrewReleaseMetadata,
    rows: ReadonlyArray<HomebrewTargetRow>,
): string =>
    [
        HOMEBREW_FORMULA_BEGIN_MARKER,
        `  version "${metadata.version}"`,
        "",
        ...platformRegion(metadata, rows, "darwin"),
        "",
        ...platformRegion(metadata, rows, "linux"),
        HOMEBREW_FORMULA_END_MARKER,
    ].join("\n");

const markerCount = (formula: string, marker: string): number =>
    formula.split(marker).length - 1;

/**
 * Render the catalog-derived release metadata into the marked region without
 * touching the rest of a formula. The macOS/Linux CPU branches are generated
 * from the catalog's release asset values (each platform's arm64/x64 rows),
 * so no independent list of the four release assets exists here.
 */
export const renderHomebrewFormula = (
    formula: string,
    metadataValue: unknown,
    catalogValue: unknown,
): string => {
    const parsedMetadata = parseHomebrewReleaseMetadata(metadataValue);
    const rows = renderHomebrewTargetRows(catalogValue, parsedMetadata.version);
    assertExactReleaseAssets(parsedMetadata.assets, rows);

    assert(
        markerCount(formula, HOMEBREW_FORMULA_BEGIN_MARKER) === 1,
        `Formula must contain exactly one '${HOMEBREW_FORMULA_BEGIN_MARKER}' marker.`,
    );
    assert(
        markerCount(formula, HOMEBREW_FORMULA_END_MARKER) === 1,
        `Formula must contain exactly one '${HOMEBREW_FORMULA_END_MARKER}' marker.`,
    );

    const start = formula.indexOf(HOMEBREW_FORMULA_BEGIN_MARKER);
    const end = formula.indexOf(HOMEBREW_FORMULA_END_MARKER);
    assert(
        start >= 0 && end > start,
        "Formula generated-region markers are out of order.",
    );
    return `${formula.slice(0, start)}${generatedRegion(parsedMetadata, rows)}${formula.slice(end + HOMEBREW_FORMULA_END_MARKER.length)}`;
};

/** The canonical standalone target catalog next to the scripts directory. */
const canonicalCatalogPath = (): string =>
    resolve(import.meta.dir, "../targets/standalone-targets.json");

/**
 * Read explicit release metadata (and the canonical catalog unless
 * `--catalog` overrides it) and update only the marked formula region.
 */
export const generateHomebrewFormula = async ({
    catalogPath,
    formulaPath,
    metadataPath,
    outputPath,
}: GenerateHomebrewFormulaOptions): Promise<string> => {
    const [formula, metadataText, catalogText] = await Promise.all([
        readFile(formulaPath, "utf8"),
        readFile(metadataPath, "utf8"),
        readFile(catalogPath ?? canonicalCatalogPath(), "utf8"),
    ]);
    const rendered = renderHomebrewFormula(
        formula,
        JSON.parse(metadataText) as unknown,
        JSON.parse(catalogText) as unknown,
    );
    await writeFile(outputPath ?? formulaPath, rendered, "utf8");
    return rendered;
};

const optionValue = (args: ReadonlyArray<string>, option: string): string => {
    const index = args.indexOf(option);
    const value = args[index + 1];
    if (index === -1 || value === undefined || value.startsWith("--")) {
        throw new Error(`${option} requires a value.`);
    }
    return value;
};

const optionalOptionValue = (
    args: ReadonlyArray<string>,
    option: string,
): string | undefined => {
    const index = args.indexOf(option);
    if (index === -1) return undefined;
    return optionValue(args, option);
};

const main = async (): Promise<void> => {
    const args = Bun.argv.slice(2);
    if (args.length % 2 !== 0) {
        throw new Error(
            "Options must be supplied as --option value pairs: generate-homebrew-formula.ts --metadata <release-metadata.json> --formula <Formula/ralphie.rb> [--catalog <targets/standalone-targets.json>] [--output <path>]",
        );
    }
    const known = new Set(["--metadata", "--formula", "--catalog", "--output"]);
    for (let index = 0; index < args.length; index += 2) {
        const option = args[index] as string;
        if (!known.has(option)) {
            throw new Error(`Unknown option '${option}'.`);
        }
        if (
            args[index + 1] === undefined ||
            args[index + 1]?.startsWith("--")
        ) {
            throw new Error(`${option} requires a value.`);
        }
    }
    if (!args.includes("--metadata") || !args.includes("--formula")) {
        throw new Error("--metadata and --formula are required.");
    }
    await generateHomebrewFormula({
        formulaPath: optionValue(args, "--formula"),
        metadataPath: optionValue(args, "--metadata"),
        catalogPath: optionalOptionValue(args, "--catalog"),
        outputPath: optionalOptionValue(args, "--output"),
    });
};

if (import.meta.main) {
    try {
        await main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    }
}