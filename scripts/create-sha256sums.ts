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

export const RELEASE_TARGETS = [
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
] as const;

type ReleaseTarget = (typeof RELEASE_TARGETS)[number];

type CreateSha256SumsOptions = {
    readonly artifactDirectory: string;
    readonly outputDirectory: string;
    readonly version: string;
};

const releaseVersionPattern =
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

const expectedAssetName = (target: ReleaseTarget): string =>
    `ralphie-${target}`;

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
        await stat(path);
    } catch (error) {
        if (isMissingPathError(error)) return;
        throw error;
    }
    throw new Error(`Duplicate release asset: ${path}`);
};

const copyValidatedAsset = async (
    artifactDirectory: string,
    outputDirectory: string,
    version: string,
    target: ReleaseTarget,
): Promise<string> => {
    const assetName = expectedAssetName(target);
    const artifactPath = join(
        artifactDirectory,
        expectedArtifactName(version, target),
    );
    const entries = await readDirectory(artifactPath);
    if (
        entries.length !== 1 ||
        entries[0]?.name !== assetName ||
        !entries[0]?.isFile()
    ) {
        throw new Error(
            `Release artifact '${artifactPath}' must contain exactly one binary named '${assetName}'.`,
        );
    }

    const sourcePath = join(artifactPath, assetName);
    if ((await stat(sourcePath)).size === 0) {
        throw new Error(`Release asset '${sourcePath}' is empty.`);
    }

    const outputPath = join(outputDirectory, assetName);
    await assertAbsent(outputPath);
    await copyFile(sourcePath, outputPath);
    return outputPath;
};

const sha256 = async (path: string): Promise<string> =>
    createHash("sha256")
        .update(await readFile(path))
        .digest("hex");

export const createSha256Sums = async ({
    artifactDirectory,
    outputDirectory,
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

    await mkdir(outputDirectory, { recursive: true });
    const assetPaths = await Promise.all(
        RELEASE_TARGETS.map((target) =>
            copyValidatedAsset(
                artifactDirectory,
                outputDirectory,
                version,
                target,
            ),
        ),
    );
    const manifestPath = join(outputDirectory, "SHA256SUMS");
    await assertAbsent(manifestPath);
    const manifest = (
        await Promise.all(
            RELEASE_TARGETS.map(async (target, index) => {
                const assetName = expectedAssetName(target);
                return `${await sha256(assetPaths[index] as string)}  ${assetName}`;
            }),
        )
    ).join("\n");
    await writeFile(manifestPath, `${manifest}\n`, "utf8");
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
    if (args.length !== 6) {
        throw new Error(
            "Usage: create-sha256sums.ts --version <version> --artifacts-dir <path> --output-dir <path>",
        );
    }
    await createSha256Sums({
        artifactDirectory: optionValue(args, "--artifacts-dir"),
        outputDirectory: optionValue(args, "--output-dir"),
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