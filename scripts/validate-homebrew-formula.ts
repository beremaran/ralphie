#!/usr/bin/env bun

import { readFile } from "node:fs/promises";

import {
    renderHomebrewTargetRows,
    type HomebrewTargetRow,
} from "../src/targets/standalone-target-renderers.ts";
import { loadStandaloneTargets } from "../src/targets/standalone-targets.ts";
import { homebrewPlatformLabel } from "./generate-homebrew-formula.ts";

/** A catalog-derived Homebrew release asset and its formula branch. */
export type HomebrewExpectedAsset = {
    readonly assetName: string;
    readonly os: "darwin" | "linux";
    readonly arch: "arm64" | "x64";
};

export type HomebrewFormulaMapping = {
    readonly assetName: string;
    readonly url: string;
    readonly sha256: string;
};

type ValidateHomebrewFormulaOptions = {
    readonly formulaPath: string;
    readonly manifestPath: string;
    readonly version: string;
};

const releaseBase = "https://github.com/beremaran/ralphie/releases/download";
const sha256Pattern = /^[0-9a-f]{64}$/;

/** The expected assets come from catalog rows, never from a rebuilt name. */
export const expectedAssetsFromRows = (
    rows: ReadonlyArray<HomebrewTargetRow>,
): ReadonlyArray<HomebrewExpectedAsset> =>
    rows.map((row) => ({
        assetName: row.target.releaseAssetName,
        os: row.target.os,
        arch: row.target.arch,
    }));

const expectedUrl = (version: string, assetName: string): string =>
    `${releaseBase}/v${version}/${assetName}`;

const expectedFormulaUrl = (assetName: string): string =>
    `${releaseBase}/v#{version}/${assetName}`;

const escapeRegExp = (value: string): string =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type TargetBranch = {
    readonly platform: string;
    readonly armAsset: string;
    readonly x64Asset: string;
};

/** One arm/x64 branch per platform, derived from the catalog rows. */
const targetBranches = (
    expected: ReadonlyArray<HomebrewExpectedAsset>,
): ReadonlyArray<TargetBranch> => {
    const platforms = [...new Set(expected.map((asset) => asset.os))].sort();
    return platforms.map((platform) => {
        const arm = expected.find(
            (asset) => asset.os === platform && asset.arch === "arm64",
        );
        const x64 = expected.find(
            (asset) => asset.os === platform && asset.arch === "x64",
        );
        if (arm === undefined || x64 === undefined) {
            throw new Error(
                `Catalog must contain both arm64 and x64 targets for '${platform}'.`,
            );
        }
        return {
            platform: homebrewPlatformLabel(platform),
            armAsset: arm.assetName,
            x64Asset: x64.assetName,
        };
    });
};

function assert(condition: boolean, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

const formulaVersion = (formula: string): string => {
    const matches = [...formula.matchAll(/^\s*version\s+"([^"\r\n]+)"\s*$/gm)];
    assert(matches.length === 1, "Formula must declare exactly one version.");
    return matches[0]?.[1] as string;
};

const formulaMappings = (
    formula: string,
    version: string,
    expected: ReadonlyArray<HomebrewExpectedAsset>,
): ReadonlyArray<HomebrewFormulaMapping> => {
    const expectedNames = expected.map((asset) => asset.assetName);
    const urls = [...formula.matchAll(/^\s*url\s+"([^"\r\n]+)"\s*$/gm)];
    const checksums = [...formula.matchAll(/^\s*sha256\s+"([^"\r\n]+)"\s*$/gm)];
    const mappings = [
        ...formula.matchAll(
            /^\s*url\s+"([^"\r\n]+)"\s*\r?\n\s*sha256\s+"([^"\r\n]+)"\s*$/gm,
        ),
    ];

    assert(
        urls.length === expectedNames.length,
        `Formula must contain exactly ${expectedNames.length} URLs; found ${urls.length}.`,
    );
    assert(
        checksums.length === expectedNames.length,
        `Formula must contain exactly ${expectedNames.length} SHA-256 values; found ${checksums.length}.`,
    );
    assert(
        mappings.length === expectedNames.length,
        `Formula must contain exactly ${expectedNames.length} URL/checksum mappings; found ${mappings.length}.`,
    );

    return mappings.map((mapping) => {
        const rawUrl = mapping[1] as string;
        const sha256 = mapping[2] as string;
        const url = rawUrl.replaceAll("#{version}", version);
        const assetName = url.slice(url.lastIndexOf("/") + 1);

        assert(
            sha256Pattern.test(sha256) && !/^0+$/.test(sha256),
            `Invalid SHA-256 value for ${assetName}: ${sha256}.`,
        );
        assert(
            expectedNames.some((name) => expectedUrl(version, name) === url),
            `Formula URL does not match a release asset for version ${version}: ${rawUrl}.`,
        );

        return { assetName, url, sha256 };
    });
};

const targetMappingPattern = (
    assetName: string,
    mappings: ReadonlyMap<string, HomebrewFormulaMapping>,
): string => {
    const mapping = mappings.get(assetName);
    assert(mapping !== undefined, `Missing formula mapping for ${assetName}.`);
    return [
        `[ \\t]*url[ \\t]+"${escapeRegExp(expectedFormulaUrl(assetName))}"[ \\t]*`,
        `\\r?\\n[ \\t]*sha256[ \\t]+"${escapeRegExp(mapping.sha256)}"[ \\t]*`,
    ].join("");
};

const targetBranchPattern = (
    branch: TargetBranch,
    mappings: ReadonlyMap<string, HomebrewFormulaMapping>,
): RegExp =>
    new RegExp(
        [
            `^[ \\t]*on_${branch.platform}[ \\t]+do[ \\t]*\\r?\\n`,
            `[ \\t]*if[ \\t]+Hardware::CPU\\.arm\\?[ \\t]*\\r?\\n`,
            targetMappingPattern(branch.armAsset, mappings),
            `[ \\t]*\\r?\\n[ \\t]*else[ \\t]*\\r?\\n`,
            targetMappingPattern(branch.x64Asset, mappings),
            `[ \\t]*\\r?\\n[ \\t]*end[ \\t]*\\r?\\n`,
            `[ \\t]*end[ \\t]*(?:\\r?\\n|$)`,
        ].join(""),
        "m",
    );

const validateTargetPlacement = (
    formula: string,
    expected: ReadonlyArray<HomebrewExpectedAsset>,
    mappings: ReadonlyMap<string, HomebrewFormulaMapping>,
): void => {
    for (const branch of targetBranches(expected)) {
        assert(
            targetBranchPattern(branch, mappings).test(formula),
            `Formula must map ${branch.armAsset} to the arm branch and ${branch.x64Asset} to the x64 branch under on_${branch.platform}.`,
        );
    }
};

const manifestMappings = (
    manifest: string,
    expectedNames: ReadonlyArray<string>,
): ReadonlyMap<string, string> => {
    const content = manifest.endsWith("\n") ? manifest.slice(0, -1) : manifest;
    const lines = content.split(/\r?\n/);
    const entries = new Map<string, string>();
    const checksums = new Set<string>();

    assert(content.length > 0, "SHA256SUMS must not be empty.");
    for (const line of lines) {
        const match = line.match(/^([0-9a-f]{64}) {2}(\S+)$/);
        assert(
            match !== null,
            `Invalid SHA256SUMS line: ${line || "<empty>"}.`,
        );
        const checksum = match[1] as string;
        const assetName = match[2] as string;
        assert(
            !/^0+$/.test(checksum),
            `SHA256SUMS contains a placeholder checksum for ${assetName}.`,
        );
        assert(
            !entries.has(assetName),
            `SHA256SUMS contains duplicate entry for ${assetName}.`,
        );
        assert(
            !checksums.has(checksum),
            `SHA256SUMS contains a checksum copied between assets: ${checksum}.`,
        );
        entries.set(assetName, checksum);
        checksums.add(checksum);
    }

    assert(
        entries.size === expectedNames.length &&
            expectedNames.every((assetName) => entries.has(assetName)),
        `SHA256SUMS must contain exactly: ${expectedNames.join(", ")}.`,
    );
    return entries;
};

export const parseHomebrewFormula = (
    formula: string,
    version: string,
    expected: ReadonlyArray<HomebrewExpectedAsset>,
): ReadonlyMap<string, HomebrewFormulaMapping> => {
    const expectedNames = expected.map((asset) => asset.assetName);
    assert(
        formulaVersion(formula) === version,
        `Formula version must be ${version}.`,
    );

    const mappings = formulaMappings(formula, version, expected);
    assert(
        new Set(mappings.map((mapping) => mapping.sha256)).size ===
            expectedNames.length,
        "Formula must contain a distinct SHA-256 value for each release asset.",
    );
    const result = new Map<string, HomebrewFormulaMapping>();
    for (const mapping of mappings) {
        assert(
            !result.has(mapping.assetName),
            `Formula contains duplicate release asset ${mapping.assetName}.`,
        );
        result.set(mapping.assetName, mapping);
    }
    assert(
        result.size === expectedNames.length,
        `Formula must contain one mapping for each release asset; found ${result.size}.`,
    );
    validateTargetPlacement(formula, expected, result);
    return result;
};

export const validateHomebrewFormulaText = (
    formula: string,
    manifest: string,
    version: string,
    expected: ReadonlyArray<HomebrewExpectedAsset>,
): void => {
    const formulaEntries = parseHomebrewFormula(formula, version, expected);
    const manifestEntries = manifestMappings(
        manifest,
        expected.map((asset) => asset.assetName),
    );

    for (const asset of expected) {
        const assetName = asset.assetName;
        const formulaEntry = formulaEntries.get(assetName);
        const manifestChecksum = manifestEntries.get(assetName);
        assert(
            formulaEntry !== undefined && manifestChecksum !== undefined,
            `Missing SHA-256 mapping for ${assetName}.`,
        );
        assert(
            formulaEntry.sha256 === manifestChecksum,
            `Checksum mismatch for ${assetName}: formula has ${formulaEntry.sha256}, manifest has ${manifestChecksum}.`,
        );
    }
};

export const validateHomebrewFormula = async ({
    formulaPath,
    manifestPath,
    version,
}: ValidateHomebrewFormulaOptions): Promise<void> => {
    const [formula, manifest, catalog] = await Promise.all([
        readFile(formulaPath, "utf8"),
        readFile(manifestPath, "utf8"),
        loadStandaloneTargets(),
    ]);
    const expected = expectedAssetsFromRows(
        renderHomebrewTargetRows(catalog, version),
    );
    validateHomebrewFormulaText(formula, manifest, version, expected);
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
    await validateHomebrewFormula({
        formulaPath: optionValue(args, "--formula"),
        manifestPath: optionValue(args, "--manifest"),
        version: optionValue(args, "--version"),
    });
    console.log("Homebrew formula matches SHA256SUMS.");
};

if (import.meta.main) {
    try {
        await main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    }
}