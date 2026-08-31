#!/usr/bin/env bun

import { readFile, writeFile } from "node:fs/promises";

import { RELEASE_TARGETS } from "./create-sha256sums.ts";

export const HOMEBREW_FORMULA_BEGIN_MARKER =
    "  # BEGIN RALPHIE GENERATED RELEASE METADATA";
export const HOMEBREW_FORMULA_END_MARKER =
    "  # END RALPHIE GENERATED RELEASE METADATA";

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
    readonly formulaPath: string;
    readonly metadataPath: string;
    readonly outputPath?: string;
};

type RecordValue = Record<string, unknown>;

const releaseVersionPattern =
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?![\s\S])/;
const sha256Pattern = /^[0-9a-f]{64}(?![\s\S])/;

const expectedAssetName = (target: (typeof RELEASE_TARGETS)[number]): string =>
    `ralphie-${target}`;

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

const validateAssets = (
    value: unknown,
): ReadonlyArray<HomebrewReleaseAsset> => {
    assert(Array.isArray(value), "Release metadata assets must be an array.");
    assert(
        value.length === RELEASE_TARGETS.length,
        `Release metadata must contain exactly ${RELEASE_TARGETS.length} assets.`,
    );

    const names = new Set<string>();
    const assets: HomebrewReleaseAsset[] = [];
    for (const [index, rawAsset] of value.entries()) {
        const asset = asRecord(rawAsset, `Release metadata asset ${index + 1}`);
        const name = asset.name;
        const sha256 = asset.sha256;
        assert(
            typeof name === "string",
            `Release metadata asset ${index + 1} must have a name.`,
        );
        assert(
            !names.has(name),
            `Release metadata contains duplicate asset '${name}'.`,
        );
        names.add(name);
        assert(
            RELEASE_TARGETS.some(
                (target) => name === expectedAssetName(target),
            ),
            `Release metadata contains unexpected asset '${name}'.`,
        );
        assert(
            typeof sha256 === "string" && sha256Pattern.test(sha256),
            `Invalid SHA-256 for asset '${name}'; expected 64 lowercase hexadecimal characters.`,
        );
        assert(
            !/^0+$/.test(sha256),
            `Invalid SHA-256 for asset '${name}'; placeholder values are not allowed.`,
        );
        assets.push({ name, sha256 });
    }

    const expectedNames = RELEASE_TARGETS.map(expectedAssetName);
    assert(
        expectedNames.every((name) => names.has(name)),
        `Release metadata must contain exactly: ${expectedNames.join(", ")}.`,
    );
    return assets;
};

/** Validate the release-metadata.v1 fields used to render the formula. */
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
    return {
        version,
        tag,
        assets: validateAssets(metadata.assets),
    };
};

const assetChecksum = (
    metadata: HomebrewReleaseMetadata,
    target: (typeof RELEASE_TARGETS)[number],
): string => {
    const name = expectedAssetName(target);
    const asset = metadata.assets.find((candidate) => candidate.name === name);
    assert(asset !== undefined, `Release metadata is missing asset '${name}'.`);
    return asset.sha256;
};

const generatedRegion = (metadata: HomebrewReleaseMetadata): string => {
    const checksum = (target: (typeof RELEASE_TARGETS)[number]): string =>
        assetChecksum(metadata, target);

    return [
        HOMEBREW_FORMULA_BEGIN_MARKER,
        `  version "${metadata.version}"`,
        "",
        "  on_macos do",
        "    if Hardware::CPU.arm?",
        `      url "https://github.com/beremaran/ralphie/releases/download/v#{version}/${expectedAssetName("darwin-arm64")}"`,
        `      sha256 "${checksum("darwin-arm64")}"`,
        "    else",
        `      url "https://github.com/beremaran/ralphie/releases/download/v#{version}/${expectedAssetName("darwin-x64")}"`,
        `      sha256 "${checksum("darwin-x64")}"`,
        "    end",
        "  end",
        "",
        "  on_linux do",
        "    if Hardware::CPU.arm?",
        `      url "https://github.com/beremaran/ralphie/releases/download/v#{version}/${expectedAssetName("linux-arm64")}"`,
        `      sha256 "${checksum("linux-arm64")}"`,
        "    else",
        `      url "https://github.com/beremaran/ralphie/releases/download/v#{version}/${expectedAssetName("linux-x64")}"`,
        `      sha256 "${checksum("linux-x64")}"`,
        "    end",
        "  end",
        HOMEBREW_FORMULA_END_MARKER,
    ].join("\n");
};

const markerCount = (formula: string, marker: string): number =>
    formula.split(marker).length - 1;

/** Render metadata into the marked region without touching the rest of a formula. */
export const renderHomebrewFormula = (
    formula: string,
    metadata: unknown,
): string => {
    const parsedMetadata = parseHomebrewReleaseMetadata(metadata);
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
    return `${formula.slice(0, start)}${generatedRegion(parsedMetadata)}${formula.slice(end + HOMEBREW_FORMULA_END_MARKER.length)}`;
};

/** Read explicit release metadata and update only the marked formula region. */
export const generateHomebrewFormula = async ({
    formulaPath,
    metadataPath,
    outputPath,
}: GenerateHomebrewFormulaOptions): Promise<string> => {
    const [formula, metadataText] = await Promise.all([
        readFile(formulaPath, "utf8"),
        readFile(metadataPath, "utf8"),
    ]);
    const rendered = renderHomebrewFormula(
        formula,
        JSON.parse(metadataText) as unknown,
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

const main = async (): Promise<void> => {
    const args = Bun.argv.slice(2);
    if (args.length !== 4 && args.length !== 6) {
        throw new Error(
            "Usage: generate-homebrew-formula.ts --metadata <release-metadata.json> --formula <Formula/ralphie.rb> [--output <path>]",
        );
    }
    await generateHomebrewFormula({
        formulaPath: optionValue(args, "--formula"),
        metadataPath: optionValue(args, "--metadata"),
        outputPath:
            args.length === 6 ? optionValue(args, "--output") : undefined,
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