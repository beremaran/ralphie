#!/usr/bin/env bun

import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { RELEASE_TARGETS } from "./create-sha256sums.ts";

export { RELEASE_TARGETS };

export type HomebrewAssetTarget = (typeof RELEASE_TARGETS)[number];

export type HomebrewAssetManifestEntry = {
    readonly target: HomebrewAssetTarget;
    readonly name: string;
    readonly url: string;
    readonly sha256: string;
};

export type HomebrewAssetManifest = {
    readonly schema: "ralphie.homebrew-asset-manifest.v1";
    readonly tag: string;
    readonly version: string;
    readonly assets: ReadonlyArray<HomebrewAssetManifestEntry>;
};

type FetchImplementation = (
    input: string | URL | Request,
    init?: RequestInit,
) => Promise<Response>;

type VerifyHomebrewAssetsOptions = {
    readonly apiBaseUrl?: string;
    readonly fetchImpl?: FetchImplementation;
    readonly outputPath: string;
    readonly repository: string;
    readonly tag: string;
    readonly token?: string;
    readonly version: string;
};

type JsonRecord = Record<string, unknown>;

type ReleaseAsset = {
    readonly name: string;
    readonly url: string;
};

const releaseTagPattern =
    /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const fail = (message: string): never => {
    throw new Error(`Homebrew asset verification: ${message}`);
};

const isRecord = (value: unknown): value is JsonRecord =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const recordFrom = (value: unknown, label: string): JsonRecord =>
    isRecord(value) ? value : fail(`${label} must be a JSON object.`);

const stringFrom = (record: JsonRecord, key: string, label: string): string => {
    const value = record[key];
    if (typeof value !== "string" || value.length === 0) {
        return fail(`${label} must contain a non-empty '${key}'.`);
    }
    return value;
};

const expectedAssetName = (target: HomebrewAssetTarget): string =>
    `ralphie-${target}`;

const expectedDownloadUrl = (
    repository: string,
    tag: string,
    name: string,
): string =>
    `https://github.com/${repository}/releases/download/${tag}/${name}`;

const assertExpectedTagAndVersion = (tag: string, version: string): void => {
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
            `release tag '${tag}' does not match expected version '${version}'.`,
        );
    }
};

const releaseAssetsFrom = (
    value: unknown,
    repository: string,
    tag: string,
): Map<string, ReleaseAsset> => {
    const release = recordFrom(value, "GitHub release");
    const releaseTag = stringFrom(release, "tag_name", "GitHub release");
    if (releaseTag !== tag) {
        return fail(
            `GitHub returned release tag '${releaseTag}', expected exact tag '${tag}'.`,
        );
    }
    if (release.draft !== false || release.prerelease !== false) {
        return fail("the exact release is a draft or prerelease.");
    }

    const rawAssets = release.assets;
    if (!Array.isArray(rawAssets))
        return fail("GitHub release has no assets list.");
    const assets = new Map<string, ReleaseAsset>();
    for (const [index, rawAsset] of rawAssets.entries()) {
        const asset = recordFrom(rawAsset, `GitHub release asset ${index + 1}`);
        const name = stringFrom(
            asset,
            "name",
            `GitHub release asset ${index + 1}`,
        );
        if (assets.has(name)) {
            return fail(`GitHub release contains duplicate asset '${name}'.`);
        }
        const url = stringFrom(
            asset,
            "browser_download_url",
            `asset '${name}'`,
        );
        if (url !== expectedDownloadUrl(repository, tag, name)) {
            return fail(
                `asset '${name}' does not point to the exact release download URL.`,
            );
        }
        assets.set(name, { name, url });
    }
    return assets;
};

const fetchJson = async (
    url: string,
    token: string | undefined,
    fetchImpl: FetchImplementation,
): Promise<unknown> => {
    const headers = new Headers({
        Accept: "application/vnd.github+json",
        "User-Agent": "ralphie-homebrew-asset-verifier",
    });
    if (token !== undefined) headers.set("Authorization", `Bearer ${token}`);
    const response = await fetchImpl(url, { headers, redirect: "error" });
    if (!response.ok)
        return fail(`GitHub release lookup returned HTTP ${response.status}.`);
    try {
        return (await response.json()) as unknown;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fail(`GitHub release lookup returned invalid JSON: ${message}`);
    }
};

const download = async (
    asset: ReleaseAsset,
    token: string | undefined,
    fetchImpl: FetchImplementation,
): Promise<Uint8Array> => {
    const headers = new Headers({
        Accept: "application/octet-stream",
        "User-Agent": "ralphie-homebrew-asset-verifier",
    });
    if (token !== undefined) headers.set("Authorization", `Bearer ${token}`);
    const response = await fetchImpl(asset.url, {
        headers,
        redirect: "follow",
    });
    if (!response.ok)
        return fail(`asset '${asset.name}' returned HTTP ${response.status}.`);
    return new Uint8Array(await response.arrayBuffer());
};

const sidecarDigest = (bytes: Uint8Array, assetName: string): string => {
    let text: string;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        return fail(`sidecar '${assetName}.sha256' is not valid UTF-8.`);
    }
    const match = text.match(/^([0-9a-f]{64}) {2}([^\s\r\n]+)\n?$/);
    if (match === null || match[2] !== assetName) {
        return fail(
            `sidecar '${assetName}.sha256' is malformed or names a different asset.`,
        );
    }
    return match[1] as string;
};

const verifyDownloadedAssets = async (
    assets: Map<string, ReleaseAsset>,
    token: string | undefined,
    fetchImpl: FetchImplementation,
): Promise<ReadonlyArray<HomebrewAssetManifestEntry>> => {
    const required = RELEASE_TARGETS.map((target) => ({
        target,
        name: expectedAssetName(target),
    }));
    for (const { name } of required) {
        if (!assets.has(name))
            return fail(`GitHub release is missing asset '${name}'.`);
        if (!assets.has(`${name}.sha256`)) {
            return fail(`GitHub release is missing asset '${name}.sha256'.`);
        }
    }

    const downloaded = await Promise.all(
        required.flatMap(({ name }) => [
            download(assets.get(name) as ReleaseAsset, token, fetchImpl),
            download(
                assets.get(`${name}.sha256`) as ReleaseAsset,
                token,
                fetchImpl,
            ),
        ]),
    );
    const entries: HomebrewAssetManifestEntry[] = [];
    for (const [index, { target, name }] of required.entries()) {
        const binary = downloaded[index * 2] as Uint8Array;
        const sidecar = downloaded[index * 2 + 1] as Uint8Array;
        if (binary.byteLength === 0) return fail(`asset '${name}' is empty.`);
        const digest = createHash("sha256").update(binary).digest("hex");
        if (sidecarDigest(sidecar, name) !== digest) {
            return fail(`asset '${name}' does not match its sidecar checksum.`);
        }
        entries.push({
            target,
            name,
            url: assets.get(name)?.url as string,
            sha256: digest,
        });
    }
    return entries.sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
};

const writeManifest = async (
    outputPath: string,
    manifest: HomebrewAssetManifest,
): Promise<void> => {
    await mkdir(dirname(outputPath), { recursive: true });
    const temporaryPath = join(
        dirname(outputPath),
        `.${basename(outputPath)}.${randomUUID()}.tmp`,
    );
    try {
        await writeFile(
            temporaryPath,
            `${JSON.stringify(manifest, null, 2)}\n`,
            {
                encoding: "utf8",
                flag: "wx",
            },
        );
        await rename(temporaryPath, outputPath);
    } finally {
        await rm(temporaryPath, { force: true });
    }
};

export const verifyHomebrewAssets = async ({
    apiBaseUrl = process.env.GITHUB_API_URL ?? "https://api.github.com",
    fetchImpl = fetch,
    outputPath,
    repository,
    tag,
    token,
    version,
}: VerifyHomebrewAssetsOptions): Promise<HomebrewAssetManifest> => {
    await rm(outputPath, { force: true });
    assertExpectedTagAndVersion(tag, version);
    if (!repositoryPattern.test(repository)) {
        return fail(
            `invalid repository '${repository}'; expected owner/repository.`,
        );
    }
    const apiRoot = apiBaseUrl.replace(/\/+$/, "");
    const releaseUrl = `${apiRoot}/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`;
    const releaseAssets = releaseAssetsFrom(
        await fetchJson(releaseUrl, token, fetchImpl),
        repository,
        tag,
    );
    const assets = await verifyDownloadedAssets(
        releaseAssets,
        token,
        fetchImpl,
    );
    const manifest: HomebrewAssetManifest = {
        schema: "ralphie.homebrew-asset-manifest.v1",
        tag,
        version,
        assets,
    };
    await writeManifest(outputPath, manifest);
    return manifest;
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
            "Usage: verify-homebrew-assets.ts --tag <v<major>.<minor>.<patch>> --version <version> --output <manifest.json> [--repository <owner/repository>] (or set GITHUB_REPOSITORY)",
        );
        return;
    }
    await verifyHomebrewAssets({
        outputPath: optionValue(args, "--output"),
        repository:
            optionalOptionValue(args, "--repository") ??
            process.env.GITHUB_REPOSITORY ??
            "",
        tag: optionValue(args, "--tag"),
        token: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
        version: optionValue(args, "--version"),
    });
};

if (import.meta.main) {
    try {
        await main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}