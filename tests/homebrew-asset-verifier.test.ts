import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
    RELEASE_TARGETS,
    verifyHomebrewAssets,
} from "../scripts/verify-homebrew-assets.ts";

const repository = "owner/repository";
const tag = "v1.2.3";
const version = "1.2.3";
const apiBaseUrl = "https://api.example.test";
const releaseApiUrl = `${apiBaseUrl}/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`;

type FixtureOptions = {
    readonly binaryChanges?: ReadonlyMap<string, string>;
    readonly duplicate?: boolean;
    readonly releaseTag?: string;
    readonly prerelease?: boolean;
    readonly omitted?: ReadonlySet<string>;
    readonly sidecarName?: string;
    readonly sidecarText?: string;
};

const binaryFor = (name: string): string => `binary bytes for ${name}`;

const digestFor = (bytes: string): string =>
    createHash("sha256").update(bytes).digest("hex");

type FetchImplementation = (
    input: string | URL | Request,
    init?: RequestInit,
) => Promise<Response>;

const fixtureFetch = (
    options: FixtureOptions = {},
): { readonly fetchImpl: FetchImplementation; readonly calls: string[] } => {
    const calls: string[] = [];
    const binaryChanges = options.binaryChanges ?? new Map();
    const bodies = new Map<string, string>();
    const assets = RELEASE_TARGETS.flatMap((target) => {
        const name = `ralphie-${target}`;
        const binary = binaryChanges.get(name) ?? binaryFor(name);
        const sidecarName = options.sidecarName ?? name;
        bodies.set(name, binary);
        bodies.set(
            `${name}.sha256`,
            options.sidecarText ??
                `${digestFor(binaryFor(name))}  ${sidecarName}\n`,
        );
        return [name, `${name}.sha256`];
    }).filter((name) => !options.omitted?.has(name));
    if (options.duplicate) assets.push(assets[0] as string);
    const fetchImpl: FetchImplementation = async (input) => {
        const url = String(input);
        calls.push(url);
        if (url === releaseApiUrl) {
            return new Response(
                JSON.stringify({
                    tag_name: options.releaseTag ?? tag,
                    draft: false,
                    prerelease: options.prerelease ?? false,
                    assets: assets.map((name) => ({
                        name,
                        browser_download_url: `https://github.com/${repository}/releases/download/${tag}/${name}`,
                    })),
                }),
                { headers: { "Content-Type": "application/json" } },
            );
        }
        const name = url.slice(url.lastIndexOf("/") + 1);
        const body = bodies.get(name);
        return body === undefined
            ? new Response("not found", { status: 404 })
            : new Response(body);
    };
    return { calls, fetchImpl };
};

const verifyFixture = async (options: FixtureOptions = {}) => {
    const root = await mkdtemp(join(tmpdir(), "ralphie-homebrew-assets-test-"));
    const outputPath = join(root, "manifest.json");
    try {
        const fixture = fixtureFetch(options);
        const manifest = await verifyHomebrewAssets({
            apiBaseUrl,
            fetchImpl: fixture.fetchImpl,
            outputPath,
            repository,
            tag,
            version,
        });
        return { fixture, manifest, outputPath };
    } catch (error) {
        await rm(root, { recursive: true, force: true });
        throw error;
    }
};

describe("Homebrew release asset verifier", () => {
    test("creates a stable manifest only after verifying all four binaries", async () => {
        const { fixture, manifest, outputPath } = await verifyFixture();
        try {
            expect(fixture.calls[0]).toBe(releaseApiUrl);
            expect(fixture.calls).toHaveLength(9);
            expect(manifest).toEqual({
                schema: "ralphie.homebrew-asset-manifest.v1",
                tag,
                version,
                assets: RELEASE_TARGETS.map((target) => {
                    const name = `ralphie-${target}`;
                    return {
                        target,
                        name,
                        url: `https://github.com/${repository}/releases/download/${tag}/${name}`,
                        sha256: digestFor(binaryFor(name)),
                    };
                }),
            });
            expect(await readFile(outputPath, "utf8")).toBe(
                `${JSON.stringify(manifest, null, 2)}\n`,
            );
        } finally {
            await rm(outputPath.slice(0, outputPath.lastIndexOf("/")), {
                recursive: true,
                force: true,
            });
        }
    });

    test("uses the exact tag endpoint and rejects a wrong release tag", async () => {
        const root = await mkdtemp(
            join(tmpdir(), "ralphie-homebrew-assets-test-"),
        );
        try {
            const fixture = fixtureFetch({ releaseTag: "v1.2.4" });
            await expect(
                verifyHomebrewAssets({
                    apiBaseUrl,
                    fetchImpl: fixture.fetchImpl,
                    outputPath: join(root, "manifest.json"),
                    repository,
                    tag,
                    version,
                }),
            ).rejects.toThrow("exact tag");
            expect(fixture.calls).toEqual([releaseApiUrl]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("rejects prereleases and invalid expected tags before asset downloads", async () => {
        const root = await mkdtemp(
            join(tmpdir(), "ralphie-homebrew-assets-test-"),
        );
        try {
            const prerelease = fixtureFetch({ prerelease: true });
            await expect(
                verifyHomebrewAssets({
                    apiBaseUrl,
                    fetchImpl: prerelease.fetchImpl,
                    outputPath: join(root, "prerelease.json"),
                    repository,
                    tag,
                    version,
                }),
            ).rejects.toThrow("draft or prerelease");
            expect(prerelease.calls).toHaveLength(1);

            const invalid = fixtureFetch();
            await expect(
                verifyHomebrewAssets({
                    apiBaseUrl,
                    fetchImpl: invalid.fetchImpl,
                    outputPath: join(root, "invalid.json"),
                    repository,
                    tag: "v1.2.3-rc.1",
                    version: "1.2.3-rc.1",
                }),
            ).rejects.toThrow("no prerelease");
            expect(invalid.calls).toHaveLength(0);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("rejects missing or substituted required assets", async () => {
        const root = await mkdtemp(
            join(tmpdir(), "ralphie-homebrew-assets-test-"),
        );
        try {
            const fixture = fixtureFetch({
                omitted: new Set(["ralphie-linux-x64"]),
            });
            await expect(
                verifyHomebrewAssets({
                    apiBaseUrl,
                    fetchImpl: fixture.fetchImpl,
                    outputPath: join(root, "manifest.json"),
                    repository,
                    tag,
                    version,
                }),
            ).rejects.toThrow("missing asset 'ralphie-linux-x64'");
            expect(fixture.calls).toHaveLength(1);

            const duplicate = fixtureFetch({ duplicate: true });
            await expect(
                verifyHomebrewAssets({
                    apiBaseUrl,
                    fetchImpl: duplicate.fetchImpl,
                    outputPath: join(root, "duplicate.json"),
                    repository,
                    tag,
                    version,
                }),
            ).rejects.toThrow("duplicate asset");
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("rejects malformed sidecars and sidecars naming another asset", async () => {
        const root = await mkdtemp(
            join(tmpdir(), "ralphie-homebrew-assets-test-"),
        );
        try {
            const fixture = fixtureFetch({ sidecarName: "ralphie-other" });
            await expect(
                verifyHomebrewAssets({
                    apiBaseUrl,
                    fetchImpl: fixture.fetchImpl,
                    outputPath: join(root, "manifest.json"),
                    repository,
                    tag,
                    version,
                }),
            ).rejects.toThrow("malformed or names a different asset");

            const malformed = fixtureFetch({ sidecarText: "not a checksum\n" });
            await expect(
                verifyHomebrewAssets({
                    apiBaseUrl,
                    fetchImpl: malformed.fetchImpl,
                    outputPath: join(root, "malformed.json"),
                    repository,
                    tag,
                    version,
                }),
            ).rejects.toThrow("malformed or names a different asset");
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("rejects a content hash mismatch", async () => {
        const root = await mkdtemp(
            join(tmpdir(), "ralphie-homebrew-assets-test-"),
        );
        try {
            const fixture = fixtureFetch({
                binaryChanges: new Map([
                    ["ralphie-linux-x64", "tampered binary bytes"],
                ]),
            });
            await expect(
                verifyHomebrewAssets({
                    apiBaseUrl,
                    fetchImpl: fixture.fetchImpl,
                    outputPath: join(root, "manifest.json"),
                    repository,
                    tag,
                    version,
                }),
            ).rejects.toThrow("does not match its sidecar checksum");
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});