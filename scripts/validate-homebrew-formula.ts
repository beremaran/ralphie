#!/usr/bin/env bun

import { readFile } from "node:fs/promises";

import { RELEASE_TARGETS } from "./create-sha256sums.ts";

export const HOMEBREW_TARGETS = RELEASE_TARGETS;

type HomebrewTarget = (typeof HOMEBREW_TARGETS)[number];

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

const expectedAssetName = (target: HomebrewTarget): string =>
    `ralphie-${target}`;

const expectedUrl = (version: string, target: HomebrewTarget): string =>
    `${releaseBase}/v${version}/${expectedAssetName(target)}`;

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
): ReadonlyArray<HomebrewFormulaMapping> => {
    const urls = [...formula.matchAll(/^\s*url\s+"([^"\r\n]+)"\s*$/gm)];
    const checksums = [...formula.matchAll(/^\s*sha256\s+"([^"\r\n]+)"\s*$/gm)];
    const mappings = [
        ...formula.matchAll(
            /^\s*url\s+"([^"\r\n]+)"\s*\r?\n\s*sha256\s+"([^"\r\n]+)"\s*$/gm,
        ),
    ];

    assert(
        urls.length === HOMEBREW_TARGETS.length,
        `Formula must contain exactly ${HOMEBREW_TARGETS.length} URLs; found ${urls.length}.`,
    );
    assert(
        checksums.length === HOMEBREW_TARGETS.length,
        `Formula must contain exactly ${HOMEBREW_TARGETS.length} SHA-256 values; found ${checksums.length}.`,
    );
    assert(
        mappings.length === HOMEBREW_TARGETS.length,
        `Formula must contain exactly ${HOMEBREW_TARGETS.length} URL/checksum mappings; found ${mappings.length}.`,
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
            HOMEBREW_TARGETS.some(
                (target) => expectedUrl(version, target) === url,
            ),
            `Formula URL does not match a release asset for version ${version}: ${rawUrl}.`,
        );

        return { assetName, url, sha256 };
    });
};

const manifestMappings = (manifest: string): ReadonlyMap<string, string> => {
    const content = manifest.endsWith("\n") ? manifest.slice(0, -1) : manifest;
    const lines = content.split(/\r?\n/);
    const entries = new Map<string, string>();

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
            !entries.has(assetName),
            `SHA256SUMS contains duplicate entry for ${assetName}.`,
        );
        entries.set(assetName, checksum);
    }

    const expectedAssets = HOMEBREW_TARGETS.map(expectedAssetName);
    assert(
        entries.size === expectedAssets.length &&
            expectedAssets.every((assetName) => entries.has(assetName)),
        `SHA256SUMS must contain exactly: ${expectedAssets.join(", ")}.`,
    );
    return entries;
};

export const parseHomebrewFormula = (
    formula: string,
    version: string,
): ReadonlyMap<string, HomebrewFormulaMapping> => {
    assert(
        formulaVersion(formula) === version,
        `Formula version must be ${version}.`,
    );

    const mappings = formulaMappings(formula, version);
    assert(
        new Set(mappings.map((mapping) => mapping.sha256)).size ===
            HOMEBREW_TARGETS.length,
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
        result.size === HOMEBREW_TARGETS.length,
        `Formula must contain one mapping for each release asset; found ${result.size}.`,
    );
    return result;
};

export const validateHomebrewFormulaText = (
    formula: string,
    manifest: string,
    version: string,
): void => {
    const formulaEntries = parseHomebrewFormula(formula, version);
    const manifestEntries = manifestMappings(manifest);

    for (const target of HOMEBREW_TARGETS) {
        const assetName = expectedAssetName(target);
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
    const [formula, manifest] = await Promise.all([
        readFile(formulaPath, "utf8"),
        readFile(manifestPath, "utf8"),
    ]);
    validateHomebrewFormulaText(formula, manifest, version);
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