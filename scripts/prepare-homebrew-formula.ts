#!/usr/bin/env bun

/**
 * Fail-closed Homebrew formula change guard (executable seam).
 *
 * This preparation step consumes the manifest written by the exact-tag
 * verifier (`scripts/verify-homebrew-assets.ts`,
 * `ralphie.homebrew-asset-manifest.v1`) together with the validated release
 * tag/version and the tap formula path, renders the candidate formula into a
 * temporary output using the existing generator
 * (`scripts/generate-homebrew-formula.ts`), and only then applies the change
 * to a target-branch checkout.
 *
 * It never queries GitHub, never selects `latest`, and never uses `git
 * reset`, `git clean`, a destructive checkout, or a force operation. The
 * target-branch checkout is inspected read-only; any unrelated worktree
 * change, a formula edit outside the generated region, malformed or unmarked
 * formula content, an unexpected manifest, or a tag/version mismatch rejects
 * the whole update before anything is written.
 *
 * The result is an explicit `changed`/`unchanged` outcome so callers can skip
 * a commit when the desired metadata is already present.
 */

import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
    generateHomebrewFormula,
    HOMEBREW_FORMULA_BEGIN_MARKER,
    HOMEBREW_FORMULA_END_MARKER,
} from "./generate-homebrew-formula.ts";
import {
    RELEASE_TARGETS,
    type HomebrewAssetManifest,
    type HomebrewAssetManifestEntry,
    type HomebrewAssetTarget,
} from "./verify-homebrew-assets.ts";

export const HOMEBREW_ASSET_MANIFEST_SCHEMA =
    "ralphie.homebrew-asset-manifest.v1";

const releaseTagPattern =
    /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const gitHubUrlPrefix = "https://github.com/";

type PrepareHomebrewFormulaOptions = {
    readonly checkoutPath?: string;
    readonly formulaPath: string;
    readonly manifestPath: string;
    readonly tag: string;
    readonly version: string;
};

export type HomebrewFormulaChangeResult = {
    readonly changed: boolean;
    readonly formulaPath: string;
    readonly result: "changed" | "unchanged";
    readonly tag: string;
    readonly version: string;
};

type MarkerSpan = {
    readonly end: number;
    readonly start: number;
};

type JsonRecord = Record<string, unknown>;

const fail = (message: string): never => {
    throw new Error(`Homebrew formula change guard: ${message}`);
};

const isRecord = (value: unknown): value is JsonRecord =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const stringFrom = (record: JsonRecord, key: string, label: string): string => {
    const value = record[key];
    if (typeof value !== "string" || value.length === 0) {
        return fail(`${label} must contain a non-empty '${key}'.`);
    }
    return value;
};

const expectedAssetName = (target: HomebrewAssetTarget): string =>
    `ralphie-${target}`;

const defaultCheckoutPath = (formulaPath: string): string =>
    dirname(dirname(resolve(formulaPath)));

const assertTagAndVersion = (tag: string, version: string): void => {
    if (!releaseTagPattern.test(tag)) {
        return fail(
            `invalid release tag '${tag}'; expected v<major>.<minor>.<patch> with no prerelease or build suffix.`,
        );
    }
    if (!versionPattern.test(version)) {
        return fail(
            `invalid release version '${version}'; expected <major>.<minor>.<patch> with no prerelease or build suffix.`,
        );
    }
    if (tag !== `v${version}`) {
        return fail(
            `release tag '${tag}' does not match the validated version '${version}'.`,
        );
    }
};

const markerCount = (content: string, marker: string): number =>
    content.split(marker).length - 1;

/** Require exactly one ordered BEGIN/END generated-region marker pair. */
const formulaMarkerSpan = (
    content: string,
    label = "Formula content",
): MarkerSpan => {
    const beginCount = markerCount(content, HOMEBREW_FORMULA_BEGIN_MARKER);
    const endCount = markerCount(content, HOMEBREW_FORMULA_END_MARKER);
    if (beginCount !== 1 || endCount !== 1) {
        return fail(
            `${label} must be marked with exactly one '${HOMEBREW_FORMULA_BEGIN_MARKER}' and one '${HOMEBREW_FORMULA_END_MARKER}' marker; found ${beginCount} begin and ${endCount} end markers.`,
        );
    }
    const start = content.indexOf(HOMEBREW_FORMULA_BEGIN_MARKER);
    const end = content.indexOf(HOMEBREW_FORMULA_END_MARKER);
    if (end <= start) {
        return fail(`${label} generated-region markers are out of order.`);
    }
    return { end: end + HOMEBREW_FORMULA_END_MARKER.length, start };
};

const assertOutsideRegionIdentity = (
    original: string,
    candidate: string,
    failureMessage: string,
): void => {
    const originalSpan = formulaMarkerSpan(original);
    const candidateSpan = formulaMarkerSpan(candidate);
    const before = original.slice(0, originalSpan.start);
    const after = original.slice(originalSpan.end);
    if (
        before !== candidate.slice(0, candidateSpan.start) ||
        after !== candidate.slice(candidateSpan.end)
    ) {
        return fail(failureMessage);
    }
};

const manifestEntryFrom = (
    rawEntry: unknown,
    index: number,
    tag: string,
): HomebrewAssetManifestEntry => {
    const label = `manifest asset ${index + 1}`;
    if (!isRecord(rawEntry)) return fail(`${label} is not a JSON object.`);
    const name = stringFrom(rawEntry, "name", label);
    if (!RELEASE_TARGETS.some((target) => name === expectedAssetName(target))) {
        return fail(`manifest contains unexpected asset '${name}'.`);
    }
    const target = stringFrom(rawEntry, "target", label);
    if (!RELEASE_TARGETS.some((candidate) => candidate === target)) {
        return fail(
            `manifest asset '${name}' has an unknown target '${target}'.`,
        );
    }
    const url = stringFrom(rawEntry, "url", label);
    if (
        !url.startsWith(gitHubUrlPrefix) ||
        !url.endsWith(`/releases/download/${tag}/${name}`)
    ) {
        return fail(
            `manifest asset '${name}' does not point at the exact release download URL for tag '${tag}'.`,
        );
    }
    const sha256 = stringFrom(rawEntry, "sha256", label);
    if (!sha256Pattern.test(sha256) || /^0+$/.test(sha256)) {
        return fail(`manifest asset '${name}' has an invalid SHA-256.`);
    }
    return { target: target as HomebrewAssetTarget, name, url, sha256 };
};

const manifestEntriesFrom = (
    rawAssets: unknown,
    tag: string,
): HomebrewAssetManifestEntry[] => {
    if (!Array.isArray(rawAssets)) {
        return fail("manifest has no assets list.");
    }
    if (rawAssets.length !== RELEASE_TARGETS.length) {
        return fail(
            `manifest must contain exactly ${RELEASE_TARGETS.length} assets; found ${rawAssets.length}.`,
        );
    }

    const entries: HomebrewAssetManifestEntry[] = [];
    const names = new Set<string>();
    const checksums = new Set<string>();
    for (const [index, rawEntry] of rawAssets.entries()) {
        const entry = manifestEntryFrom(rawEntry, index, tag);
        if (names.has(entry.name)) {
            return fail(`manifest contains duplicate asset '${entry.name}'.`);
        }
        if (checksums.has(entry.sha256)) {
            return fail(
                "manifest contains the same SHA-256 for multiple assets.",
            );
        }
        names.add(entry.name);
        checksums.add(entry.sha256);
        entries.push(entry);
    }
    return entries;
};

const readJsonManifest = async (manifestPath: string): Promise<unknown> => {
    let text: string;
    try {
        text = await readFile(manifestPath, "utf8");
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fail(`could not read manifest '${manifestPath}': ${message}`);
    }
    try {
        return JSON.parse(text) as unknown;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fail(`manifest '${manifestPath}' is not valid JSON: ${message}`);
    }
};

const loadManifest = async (
    manifestPath: string,
    tag: string,
    version: string,
): Promise<HomebrewAssetManifest> => {
    const value = await readJsonManifest(manifestPath);
    if (!isRecord(value)) return fail("manifest must be a JSON object.");
    if (value.schema !== HOMEBREW_ASSET_MANIFEST_SCHEMA) {
        return fail(
            `unexpected manifest schema '${String(value.schema)}'; expected '${HOMEBREW_ASSET_MANIFEST_SCHEMA}'.`,
        );
    }
    if (value.tag !== tag) {
        return fail(
            `manifest tag '${String(value.tag)}' does not match the validated release tag '${tag}'.`,
        );
    }
    if (value.version !== version) {
        return fail(
            `manifest version '${String(value.version)}' does not match the validated release version '${version}'.`,
        );
    }
    const manifest: HomebrewAssetManifest = {
        schema: HOMEBREW_ASSET_MANIFEST_SCHEMA,
        tag,
        version,
        assets: manifestEntriesFrom(value.assets, tag),
    };
    for (const expected of RELEASE_TARGETS) {
        const name = expectedAssetName(expected);
        if (!manifest.assets.some((asset) => asset.name === name)) {
            return fail(`manifest is missing asset '${name}'.`);
        }
    }
    return manifest;
};

/** Render the exact manifest through the generator into a temporary output. */
const generateCandidateToTemporaryOutput = async (
    formulaPath: string,
    manifest: HomebrewAssetManifest,
): Promise<string> => {
    const directory = await mkdtemp(
        join(tmpdir(), "ralphie-homebrew-formula-guard-"),
    );
    try {
        const metadataPath = join(directory, "release-metadata.json");
        const candidatePath = join(directory, "ralphie.rb");
        await writeFile(
            metadataPath,
            `${JSON.stringify(
                {
                    version: manifest.version,
                    tag: manifest.tag,
                    assets: manifest.assets.map((asset) => ({
                        name: asset.name,
                        sha256: asset.sha256,
                    })),
                },
                null,
                2,
            )}\n`,
            "utf8",
        );
        await generateHomebrewFormula({
            formulaPath,
            metadataPath,
            outputPath: candidatePath,
        });
        return await readFile(candidatePath, "utf8");
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
};

const runGit = (
    checkoutPath: string,
    args: ReadonlyArray<string>,
    failureMessage: string,
): string => {
    const result = Bun.spawnSync(["git", "-C", checkoutPath, ...args], {
        stderr: "pipe",
        stdout: "pipe",
    });
    if (result.exitCode !== 0) {
        const detail = result.stderr.toString().trim();
        return fail(`${failureMessage}${detail ? `: ${detail}` : ""}`);
    }
    return result.stdout.toString();
};

/** Committed formula text; read-only and never a destructive operation. */
const headFormulaText = (
    checkoutPath: string,
    relativeFormulaPath: string,
): string => {
    const result = Bun.spawnSync(
        ["git", "-C", checkoutPath, "show", `HEAD:${relativeFormulaPath}`],
        { stderr: "pipe", stdout: "pipe" },
    );
    if (result.exitCode !== 0) {
        return fail(
            `Formula/ralphie.rb is not tracked at HEAD in the target-branch checkout '${checkoutPath}'.`,
        );
    }
    return result.stdout.toString();
};

/** Paths with any staged, unstaged, or untracked change in the checkout. */
const changedPaths = (checkoutPath: string): ReadonlyArray<string> => {
    const output = runGit(
        checkoutPath,
        ["status", "--porcelain=v1", "-z"],
        "failed to read the target-branch checkout status",
    );
    const paths: string[] = [];
    for (const token of output.split("\0")) {
        if (token.length >= 3 && token[2] === " ") {
            paths.push(token.slice(3));
        }
    }
    return paths;
};

/**
 * Deterministically prepare the Homebrew formula update from the verified
 * exact-tag manifest. Returns the explicit `changed`/`unchanged` outcome and
 * writes only `Formula/ralphie.rb`, and only when the guard is satisfied.
 */
export const prepareHomebrewFormula = async ({
    checkoutPath,
    formulaPath,
    manifestPath,
    tag,
    version,
}: PrepareHomebrewFormulaOptions): Promise<HomebrewFormulaChangeResult> => {
    const checkoutRoot = resolve(
        checkoutPath ?? defaultCheckoutPath(formulaPath),
    );
    const absoluteFormulaPath = resolve(formulaPath);
    const relativeFormulaPath = relative(checkoutRoot, absoluteFormulaPath);
    if (
        relativeFormulaPath.startsWith("..") ||
        isAbsolute(relativeFormulaPath)
    ) {
        return fail(
            `formula path '${absoluteFormulaPath}' is outside the target-branch checkout '${checkoutRoot}'.`,
        );
    }

    assertTagAndVersion(tag, version);
    const manifest = await loadManifest(manifestPath, tag, version);
    const formula = await readFile(absoluteFormulaPath, "utf8");
    formulaMarkerSpan(formula, relativeFormulaPath);

    const candidate = await generateCandidateToTemporaryOutput(
        absoluteFormulaPath,
        manifest,
    );
    assertOutsideRegionIdentity(
        formula,
        candidate,
        `${relativeFormulaPath} differs from the generated candidate outside the generated region; refusing to apply.`,
    );

    const headFormula = headFormulaText(checkoutRoot, relativeFormulaPath);
    assertOutsideRegionIdentity(
        headFormula,
        formula,
        `${relativeFormulaPath} has uncommitted changes outside the generated region; refusing to apply.`,
    );

    const unrelatedChanges = changedPaths(checkoutRoot).filter(
        (path) => path !== relativeFormulaPath,
    );
    if (unrelatedChanges.length > 0) {
        return fail(
            `target-branch checkout '${checkoutRoot}' is not clean: changed path '${unrelatedChanges[0]}' is not '${relativeFormulaPath}'.`,
        );
    }

    if (formula === candidate) {
        return {
            changed: false,
            formulaPath: absoluteFormulaPath,
            result: "unchanged",
            tag,
            version,
        };
    }

    await writeFile(absoluteFormulaPath, candidate, "utf8");
    const applied = await readFile(absoluteFormulaPath, "utf8");
    if (applied !== candidate) {
        return fail(
            `the formula written to '${absoluteFormulaPath}' does not match the generated candidate; refusing to report a change.`,
        );
    }
    return {
        changed: true,
        formulaPath: absoluteFormulaPath,
        result: "changed",
        tag,
        version,
    };
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
    if (args.includes("--help") || args.includes("-h")) {
        console.log(
            "Usage: prepare-homebrew-formula.ts --manifest <homebrew-asset-manifest.json> --tag <v<major>.<minor>.<patch>> --version <version> --formula <Formula/ralphie.rb> [--checkout <target-branch-checkout>]",
        );
        return;
    }
    const result = await prepareHomebrewFormula({
        formulaPath: optionValue(args, "--formula"),
        manifestPath: optionValue(args, "--manifest"),
        tag: optionValue(args, "--tag"),
        version: optionValue(args, "--version"),
        checkoutPath: optionalOptionValue(args, "--checkout"),
    });
    const line = `homebrew_formula_result=${result.result}`;
    const outputPath = process.env.GITHUB_OUTPUT;
    if (outputPath === undefined || outputPath === "") {
        console.log(line);
        return;
    }
    await appendFile(outputPath, `${line}\n`);
};

if (import.meta.main) {
    try {
        await main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}