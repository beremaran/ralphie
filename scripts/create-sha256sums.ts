#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
    copyFile,
    lstat,
    mkdir,
    readdir,
    readFile,
    stat,
    writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

export const RELEASE_TARGETS = [
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
] as const;

export type ReleaseTarget = (typeof RELEASE_TARGETS)[number];

export const releaseAssetName = (target: ReleaseTarget): string =>
    `ralphie-${target}`;

export const RELEASE_ASSET_NAMES: ReadonlyArray<string> =
    RELEASE_TARGETS.map(releaseAssetName);

type CreateSha256SumsOptions = {
    readonly artifactDirectory: string;
    readonly outputDirectory: string;
    readonly requireChecksums?: boolean;
    readonly version: string;
};

const releaseVersionPattern =
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

const expectedAssetName = releaseAssetName;

const expectedChecksumName = (target: ReleaseTarget): string =>
    `${releaseAssetName(target)}.sha256`;

const expectedArtifactName = (version: string, target: ReleaseTarget): string =>
    `ralphie-${version}-${target}`;

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

const assertReleaseVersion = (version: string): void => {
    if (!releaseVersionPattern.test(version)) {
        throw new Error(
            `Invalid release version '${version}'; expected <major>.<minor>.<patch>.`,
        );
    }
};

const assertExpectedArtifactSet = (
    artifactNames: ReadonlyArray<string>,
    version: string,
): void => {
    const expectedNames = RELEASE_TARGETS.map((target) =>
        expectedArtifactName(version, target),
    ).sort();
    const actualNames = [...artifactNames].sort();
    if (
        actualNames.length !== expectedNames.length ||
        actualNames.some((name, index) => name !== expectedNames[index])
    ) {
        throw new Error(
            `Release artifacts must be exactly: ${expectedNames.join(", ")}; found: ${actualNames.join(", ") || "none"}.`,
        );
    }
};

const assertAbsent = async (path: string): Promise<void> => {
    try {
        await lstat(path);
    } catch (error) {
        if (isMissingPathError(error)) return;
        throw error;
    }
    throw new Error(`Duplicate release asset: ${path}`);
};

type ValidatedAsset = {
    readonly assetName: string;
    readonly sourcePath: string;
};

const validateArtifact = async (
    artifactDirectory: string,
    version: string,
    target: ReleaseTarget,
    requireChecksums: boolean,
): Promise<ValidatedAsset> => {
    const assetName = expectedAssetName(target);
    const checksumName = expectedChecksumName(target);
    const artifactPath = join(
        artifactDirectory,
        expectedArtifactName(version, target),
    );
    const entries = await readDirectory(artifactPath);
    const hasExpectedFiles =
        entries.length === 2 &&
        entries.every(
            (entry) =>
                entry.isFile() &&
                (entry.name === assetName || entry.name === checksumName),
        );
    const hasOnlyBinary =
        entries.length === 1 &&
        entries[0]?.name === assetName &&
        entries[0]?.isFile() === true;
    if (
        (!hasExpectedFiles && !hasOnlyBinary) ||
        (requireChecksums && !hasExpectedFiles)
    ) {
        throw new Error(
            `Release artifact '${artifactPath}' must contain exactly one binary named '${assetName}' and its checksum.`,
        );
    }

    const sourcePath = join(artifactPath, assetName);
    const sourceStat = await stat(sourcePath);
    if (sourceStat.size === 0) {
        throw new Error(`Release asset '${sourcePath}' is empty.`);
    }

    if (hasExpectedFiles) {
        const checksum = (
            await readFile(join(artifactPath, checksumName), "utf8")
        ).trim();
        const expectedDigest = await sha256(sourcePath);
        const expectedRecord = `${expectedDigest}  ${assetName}`;
        if (checksum !== expectedRecord) {
            throw new Error(
                `Release asset checksum for '${sourcePath}' does not match its contents.`,
            );
        }
    }

    return { assetName, sourcePath };
};

const assertOutputDirectoryReady = async (
    artifactDirectory: string,
    artifactEntries: ReadonlyArray<{ readonly name: string }>,
    outputDirectory: string,
): Promise<void> => {
    const outputEntries = await readDirectory(outputDirectory);
    const sameDirectory =
        resolve(artifactDirectory) === resolve(outputDirectory);
    const allowedEntries = sameDirectory
        ? new Set(artifactEntries.map((entry) => entry.name))
        : new Set<string>();
    const generatedEntries = new Set([...RELEASE_ASSET_NAMES, "SHA256SUMS"]);
    const staleEntries = outputEntries
        .filter(
            (entry) =>
                !allowedEntries.has(entry.name) &&
                !generatedEntries.has(entry.name),
        )
        .map((entry) => entry.name);
    if (staleEntries.length > 0) {
        throw new Error(
            `Release output directory '${outputDirectory}' contains stale or unexpected entries: ${staleEntries.join(", ")}.`,
        );
    }

    for (const assetName of RELEASE_ASSET_NAMES) {
        await assertAbsent(join(outputDirectory, assetName));
    }
    await assertAbsent(join(outputDirectory, "SHA256SUMS"));
};

const sha256 = async (path: string): Promise<string> =>
    createHash("sha256")
        .update(await readFile(path))
        .digest("hex");

export const createSha256Sums = async ({
    artifactDirectory,
    outputDirectory,
    requireChecksums = false,
    version,
}: CreateSha256SumsOptions): Promise<string> => {
    assertReleaseVersion(version);

    const artifactEntries = await readDirectory(artifactDirectory);
    if (artifactEntries.some((entry) => !entry.isDirectory())) {
        throw new Error(
            `Release artifact directory '${artifactDirectory}' contains a non-artifact entry.`,
        );
    }
    assertExpectedArtifactSet(
        artifactEntries.map((entry) => entry.name),
        version,
    );

    const validatedAssets = await Promise.all(
        RELEASE_TARGETS.map((target) =>
            validateArtifact(
                artifactDirectory,
                version,
                target,
                requireChecksums,
            ),
        ),
    );

    await mkdir(outputDirectory, { recursive: true });
    await assertOutputDirectoryReady(
        artifactDirectory,
        artifactEntries,
        outputDirectory,
    );

    const assetPaths = await Promise.all(
        validatedAssets.map(async ({ assetName, sourcePath }) => {
            const outputPath = join(outputDirectory, assetName);
            await copyFile(sourcePath, outputPath, fsConstants.COPYFILE_EXCL);
            return outputPath;
        }),
    );
    const manifestPath = join(outputDirectory, "SHA256SUMS");
    const manifest = (
        await Promise.all(
            RELEASE_TARGETS.map(async (target, index) => {
                const assetName = expectedAssetName(target);
                return `${await sha256(assetPaths[index] as string)}  ${assetName}`;
            }),
        )
    ).join("\n");
    await writeFile(manifestPath, `${manifest}\n`, {
        encoding: "utf8",
        flag: "wx",
    });
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
    const requireChecksums = args.includes("--require-checksums");
    if (args.length !== (requireChecksums ? 7 : 6)) {
        throw new Error(
            "Usage: create-sha256sums.ts --version <version> --artifacts-dir <path> --output-dir <path> [--require-checksums]",
        );
    }
    await createSha256Sums({
        artifactDirectory: optionValue(args, "--artifacts-dir"),
        outputDirectory: optionValue(args, "--output-dir"),
        requireChecksums,
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