#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
    copyFile,
    mkdir,
    readdir,
    readFile,
    stat,
    writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { RELEASE_TARGETS } from "./create-sha256sums.ts";

export { RELEASE_TARGETS };

const releaseVersionPattern =
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const commitShaPattern = /^[0-9a-f]{40}$/;

type ReleaseAsset = {
    readonly name: string;
    readonly sha256: string;
};

type CreateReleaseMetadataOptions = {
    readonly artifactDirectory: string;
    readonly commitSha: string;
    readonly outputDirectory: string;
    readonly tag: string;
    readonly version: string;
};

const expectedAssetName = (target: (typeof RELEASE_TARGETS)[number]): string =>
    `ralphie-${target}`;

const expectedChecksumName = (
    target: (typeof RELEASE_TARGETS)[number],
): string => `${expectedAssetName(target)}.sha256`;

const expectedArtifactName = (
    version: string,
    target: (typeof RELEASE_TARGETS)[number],
): string => `ralphie-${version}-${target}`;

const isMissingPathError = (error: unknown): boolean =>
    error instanceof Error && "code" in error && error.code === "ENOENT";

const readDirectory = async (path: string) => {
    try {
        return await readdir(path, { withFileTypes: true });
    } catch (error) {
        if (isMissingPathError(error)) return [];
        throw error;
    }
};

const assertVersionAndTag = (version: string, tag: string): void => {
    if (!releaseVersionPattern.test(version)) {
        throw new Error(`Invalid release version '${version}'.`);
    }
    if (tag !== `v${version}`) {
        throw new Error(
            `Release tag '${tag}' does not match version '${version}'.`,
        );
    }
};

const assertExpectedNames = (
    actualNames: ReadonlyArray<string>,
    expectedNames: ReadonlyArray<string>,
    description: string,
): void => {
    const actual = [...actualNames].sort();
    const expected = [...expectedNames].sort();
    if (
        actual.length !== expected.length ||
        actual.some((name, index) => name !== expected[index])
    ) {
        throw new Error(
            `${description} must be exactly: ${expected.join(", ")}; found: ${actual.join(", ") || "none"}.`,
        );
    }
};

const sha256 = async (path: string): Promise<string> =>
    createHash("sha256")
        .update(await readFile(path))
        .digest("hex");

const verifyArtifact = async (
    artifactDirectory: string,
    version: string,
    target: (typeof RELEASE_TARGETS)[number],
): Promise<ReleaseAsset> => {
    const assetName = expectedAssetName(target);
    const checksumName = expectedChecksumName(target);
    const artifactPath = join(
        artifactDirectory,
        expectedArtifactName(version, target),
    );
    const entries = await readDirectory(artifactPath);
    assertExpectedNames(
        entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
        [assetName, checksumName],
        `Release artifact '${artifactPath}' files`,
    );
    if (entries.some((entry) => !entry.isFile())) {
        throw new Error(
            `Release artifact '${artifactPath}' contains a non-file entry.`,
        );
    }

    const assetPath = join(artifactPath, assetName);
    if ((await stat(assetPath)).size === 0) {
        throw new Error(`Release asset '${assetPath}' is empty.`);
    }
    const digest = await sha256(assetPath);
    const checksum = (
        await readFile(join(artifactPath, checksumName), "utf8")
    ).trim();
    if (checksum !== `${digest}  ${assetName}`) {
        throw new Error(
            `Release asset checksum for '${assetPath}' does not match its contents.`,
        );
    }
    return { name: assetName, sha256: digest };
};

const assertEmptyOutputDirectory = async (path: string): Promise<void> => {
    const entries = await readDirectory(path);
    if (entries.length > 0) {
        throw new Error(
            `Release metadata output directory '${path}' is not empty.`,
        );
    }
    await mkdir(path, { recursive: true });
};

export const createReleaseMetadata = async ({
    artifactDirectory,
    commitSha,
    outputDirectory,
    tag,
    version,
}: CreateReleaseMetadataOptions): Promise<string> => {
    assertVersionAndTag(version, tag);
    if (!commitShaPattern.test(commitSha)) {
        throw new Error(
            "Release commit SHA must be a 40-character lowercase SHA-1.",
        );
    }

    const artifactEntries = await readDirectory(artifactDirectory);
    if (artifactEntries.some((entry) => !entry.isDirectory())) {
        throw new Error(
            `Release artifact directory '${artifactDirectory}' contains a non-artifact entry.`,
        );
    }
    assertExpectedNames(
        artifactEntries.map((entry) => entry.name),
        RELEASE_TARGETS.map((target) => expectedArtifactName(version, target)),
        "Release artifacts",
    );

    const assets = (
        await Promise.all(
            RELEASE_TARGETS.map((target) =>
                verifyArtifact(artifactDirectory, version, target),
            ),
        )
    ).sort((left, right) => left.name.localeCompare(right.name));

    await assertEmptyOutputDirectory(outputDirectory);
    for (const target of RELEASE_TARGETS) {
        const assetName = expectedAssetName(target);
        const artifactPath = join(
            artifactDirectory,
            expectedArtifactName(version, target),
        );
        await copyFile(
            join(artifactPath, assetName),
            join(outputDirectory, assetName),
        );
        await copyFile(
            join(artifactPath, expectedChecksumName(target)),
            join(outputDirectory, expectedChecksumName(target)),
        );
    }

    const sums = `${assets.map((asset) => `${asset.sha256}  ${asset.name}`).join("\n")}\n`;
    await writeFile(join(outputDirectory, "SHA256SUMS"), sums, "utf8");

    const manifest = {
        schema: "ralphie.release-metadata.v1",
        tag,
        version,
        commit: commitSha,
        assets,
    };
    const manifestPath = join(outputDirectory, "release-metadata.json");
    await writeFile(
        manifestPath,
        `${JSON.stringify(manifest, null, 2)}\n`,
        "utf8",
    );
    return manifestPath;
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
    if (args.length !== 10) {
        throw new Error(
            "Usage: create-release-metadata.ts --version <version> --tag <tag> --commit-sha <sha> --artifacts-dir <path> --output-dir <path>",
        );
    }
    await createReleaseMetadata({
        artifactDirectory: optionValue(args, "--artifacts-dir"),
        commitSha: optionValue(args, "--commit-sha"),
        outputDirectory: optionValue(args, "--output-dir"),
        tag: optionValue(args, "--tag"),
        version: optionValue(args, "--version"),
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