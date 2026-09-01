#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
    chmod,
    copyFile,
    lstat,
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { RELEASE_PAYLOAD_PATHS } from "../src/release/artifact-contract.ts";

const PACKAGE_NAME = "@beremaran/ralphie";
const PACKAGE_ENTRY = "dist/ralphie.js";
const INSTALLER_PATH = RELEASE_PAYLOAD_PATHS.installer;
// Match the SemVer grammar accepted by the npm publication job, including
// prerelease and build metadata while rejecting leading-zero numeric identifiers.
const VERSION_PATTERN =
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*)|([0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))(\.((0|[1-9][0-9]*)|([0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)))*)?(\+([0-9A-Za-z-]+)(\.[0-9A-Za-z-]+)*)?$(?![\s\S])/;
const REVISION_PATTERN = /^[0-9a-f]{40}$(?![\s\S])/;

export type StageReleasePackageOptions = {
    readonly outputDirectory: string;
    readonly sourceDirectory?: string;
    readonly sourceRevision: string;
    readonly version: string;
};

export type StagedReleasePackage = {
    readonly installerPath: string;
    readonly installerSha256: string;
    readonly packagePath: string;
    readonly packageSha256: string;
    readonly sourceRevision: string;
    readonly version: string;
};

type JsonRecord = Record<string, unknown>;

type PackageLayout = {
    readonly packagePath: string;
    readonly installerPath: string;
};

const fail = (message: string): never => {
    throw new Error(`Release package staging: ${message}`);
};

const isRecord = (value: unknown): value is JsonRecord =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const readJson = async (path: string, label: string): Promise<JsonRecord> => {
    let value: unknown;
    try {
        value = JSON.parse(await readFile(path, "utf8")) as unknown;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fail(`could not read ${label}: ${message}`);
    }
    if (!isRecord(value)) return fail(`${label} must be a JSON object.`);
    return value;
};

const run = (
    command: string,
    args: ReadonlyArray<string>,
    cwd: string,
    label: string,
): string => {
    const result = Bun.spawnSync([command, ...args], {
        cwd,
        stderr: "pipe",
        stdout: "pipe",
    });
    const stdout = result.stdout?.toString() ?? "";
    const stderr = result.stderr?.toString() ?? "";
    if (result.exitCode !== 0) {
        return fail(
            `${label} failed with exit code ${result.exitCode}.\nstdout:\n${stdout || "(empty)"}\nstderr:\n${stderr || "(empty)"}`,
        );
    }
    return stdout;
};

const assertVersionAndRevision = (
    version: string,
    sourceRevision: string,
): void => {
    if (!VERSION_PATTERN.test(version)) {
        fail(`version '${version}' is not a canonical SemVer version.`);
    }
    if (!REVISION_PATTERN.test(sourceRevision)) {
        fail(
            `source revision '${sourceRevision}' is not a lowercase commit SHA.`,
        );
    }
};

const gitHead = (sourceDirectory: string): string =>
    run(
        "git",
        ["-C", sourceDirectory, "rev-parse", "--verify", "HEAD^{commit}"],
        sourceDirectory,
        "source revision lookup",
    ).trim();

const assertValidatedSource = (
    sourceDirectory: string,
    sourceRevision: string,
): void => {
    const actualRevision = gitHead(sourceDirectory);
    if (actualRevision !== sourceRevision) {
        fail(
            `source revision mismatch: checkout is ${actualRevision}, but validated revision is ${sourceRevision}.`,
        );
    }
};

const packageFiles = (manifest: JsonRecord): ReadonlyArray<string> => {
    const files = manifest.files;
    if (
        !Array.isArray(files) ||
        files.some((file) => typeof file !== "string")
    ) {
        return fail("package.json files must be an explicit string allowlist.");
    }
    const entries = ["package.json", ...files];
    if (
        entries.some(
            (entry) =>
                entry.length === 0 ||
                entry.endsWith("/") ||
                entry.includes("*") ||
                entry.includes("\\") ||
                entry.startsWith("/"),
        )
    ) {
        return fail("package.json files contains a non-canonical entry.");
    }
    const unique = [...new Set(entries)];
    if (unique.length !== entries.length) {
        return fail("package.json files contains duplicate entries.");
    }
    return unique;
};

const normalizedArchivePath = (entry: string): string => {
    let path = entry.replace(/^\.\//, "");
    if (path.startsWith("package/")) path = path.slice("package/".length);
    return path.endsWith("/") ? path.slice(0, -1) : path;
};

const archiveFiles = (
    packagePath: string,
    root: string,
): ReadonlyArray<string> =>
    run("tar", ["-tzf", packagePath], root, "npm tarball inspection")
        .split(/\r?\n/)
        .filter((entry) => entry.length > 0 && !entry.endsWith("/"))
        .map(normalizedArchivePath);

const assertExactEntries = (
    actualEntries: ReadonlyArray<string>,
    expectedEntries: ReadonlyArray<string>,
    label: string,
): void => {
    const actual = [...actualEntries].sort();
    const expected = [...expectedEntries].sort();
    if (
        actual.length !== expected.length ||
        actual.some((entry, index) => entry !== expected[index])
    ) {
        fail(
            `${label} must contain exactly ${expected.join(", ")}; found ${actual.join(", ") || "none"}.`,
        );
    }
};

const packageManifestFrom = async (
    packageRoot: string,
): Promise<JsonRecord> => {
    const manifestPath = join(packageRoot, "package.json");
    const manifest = await readJson(manifestPath, "packed package.json");
    if (manifest.name !== PACKAGE_NAME) {
        fail(
            `packed package name is ${JSON.stringify(manifest.name)}; expected ${PACKAGE_NAME}.`,
        );
    }
    return manifest;
};

const assertPackageIdentity = (manifest: JsonRecord, version: string): void => {
    if (manifest.version !== version) {
        fail(
            `packed package version is ${JSON.stringify(manifest.version)}; expected ${version}.`,
        );
    }
    const bin = manifest.bin;
    const binEntry =
        isRecord(bin) && typeof bin.ralphie === "string"
            ? bin.ralphie
            : undefined;
    if (binEntry !== `./${PACKAGE_ENTRY}`) {
        fail(`packed package bin must resolve to ./${PACKAGE_ENTRY}.`);
    }
    if (
        manifest.main !== `./${PACKAGE_ENTRY}` ||
        manifest.module !== `./${PACKAGE_ENTRY}` ||
        !isRecord(manifest.exports) ||
        manifest.exports["."] !== `./${PACKAGE_ENTRY}`
    ) {
        fail(
            `packed package main and module must resolve to ./${PACKAGE_ENTRY}.`,
        );
    }
};

const versionJsonFrom = async (packageRoot: string): Promise<JsonRecord> => {
    const executable = join(packageRoot, PACKAGE_ENTRY);
    try {
        const entry = await lstat(executable);
        if (!entry.isFile())
            return fail(`packed package entry ${PACKAGE_ENTRY} is not a file.`);
    } catch {
        return fail(`packed package is missing ${PACKAGE_ENTRY}.`);
    }
    const output = run(
        process.execPath,
        [executable, "--version", "--output", "json"],
        packageRoot,
        "packed package metadata check",
    );
    let value: unknown;
    try {
        value = JSON.parse(output.trim()) as unknown;
    } catch {
        return fail("packed executable did not produce JSON metadata.");
    }
    if (!isRecord(value))
        return fail("packed executable metadata is not an object.");
    return value;
};

const assertEmbeddedMetadata = (
    metadata: JsonRecord,
    version: string,
    sourceRevision: string,
): void => {
    if (metadata.version !== version || metadata.commitSha !== sourceRevision) {
        fail(
            `packed executable metadata must be version ${version} and commit ${sourceRevision}; found ${JSON.stringify(metadata)}.`,
        );
    }
};

const installerReferences = (): ReadonlyArray<string> => [
    `RELEASE_BASE="https://github.com/beremaran/ralphie/releases/download/$RELEASE_TAG"`,
    `CHECKSUMS_URL="$RELEASE_BASE/SHA256SUMS"`,
    `BUNDLE_URL="$RELEASE_BASE/SHA256SUMS.sigstore.json"`,
    `COMMIT_URL="https://api.github.com/repos/beremaran/ralphie/commits/$RELEASE_TAG"`,
    `CERT_IDENTITY="https://github.com/beremaran/ralphie/.github/workflows/release.yml@refs/tags/$RELEASE_TAG"`,
    `EXPECTED_VERSION=\${RELEASE_TAG#v}`,
];

const assertInstaller = async (
    sourceDirectory: string,
    installerPath: string,
): Promise<void> => {
    const sourceInstaller = join(sourceDirectory, INSTALLER_PATH);
    const [sourceEntry, stagedEntry, sourceBytes, stagedBytes] =
        await Promise.all([
            lstat(sourceInstaller),
            lstat(installerPath),
            readFile(sourceInstaller),
            readFile(installerPath),
        ]);
    if (!sourceEntry.isFile() || !stagedEntry.isFile()) {
        fail("staged installer and source installer must be regular files.");
    }
    if (!sourceBytes.equals(stagedBytes)) {
        fail(
            "staged installer is not byte-for-byte identical to scripts/install.sh.",
        );
    }
    const installer = stagedBytes.toString("utf8");
    for (const reference of installerReferences()) {
        if (!installer.includes(reference)) {
            fail(`staged installer is missing release reference ${reference}.`);
        }
    }
    for (const reference of [
        'ASSET="ralphie-${OS}-${ARCH}"',
        'RELEASE_URL="$RELEASE_BASE/$ASSET"',
    ]) {
        if (!installer.includes(reference)) {
            fail(
                `staged installer must select the host asset with ${reference}.`,
            );
        }
    }
};

const extractAndValidatePackage = async (
    packagePath: string,
    expectedFiles: ReadonlyArray<string>,
    version: string,
    sourceRevision: string,
): Promise<void> => {
    const extraction = await mkdtemp(
        join(tmpdir(), "ralphie-release-package-"),
    );
    try {
        run(
            "tar",
            ["-xzf", packagePath, "-C", extraction],
            extraction,
            "npm tarball extraction",
        );
        const packageRoot = join(extraction, "package");
        assertExactEntries(
            await archiveFiles(packagePath, extraction),
            expectedFiles,
            "npm tarball",
        );
        const manifest = await packageManifestFrom(packageRoot);
        assertPackageIdentity(manifest, version);
        const metadata = await versionJsonFrom(packageRoot);
        assertEmbeddedMetadata(metadata, version, sourceRevision);
        for (const file of expectedFiles) {
            const entry = await lstat(join(packageRoot, file));
            if (!entry.isFile())
                fail(`npm tarball entry ${file} is not a regular file.`);
            if (file === PACKAGE_ENTRY && (entry.mode & 0o777) !== 0o755) {
                fail(
                    `npm tarball entry ${file} must be executable (mode 755).`,
                );
            }
        }
    } finally {
        await rm(extraction, { force: true, recursive: true });
    }
};

const packagePathFor = (outputDirectory: string, version: string): string =>
    join(outputDirectory, RELEASE_PAYLOAD_PATHS.npmTarball(version));

const layoutFrom = (
    outputDirectory: string,
    version: string,
): PackageLayout => ({
    packagePath: packagePathFor(outputDirectory, version),
    installerPath: join(outputDirectory, INSTALLER_PATH),
});

const assertOutputEntries = async (
    outputDirectory: string,
    version: string,
): Promise<void> => {
    const entries = await readdir(outputDirectory, { withFileTypes: true });
    assertExactEntries(
        entries.map((entry) => entry.name),
        [`beremaran-ralphie-${version}.tgz`, "scripts"],
        "package staging root entries",
    );
    const tarball = entries.find(
        (entry) => entry.name === `beremaran-ralphie-${version}.tgz`,
    );
    if (tarball === undefined || !tarball.isFile()) {
        fail("package staging is missing its tarball.");
    }
    const scripts = entries.find((entry) => entry.name === "scripts");
    if (scripts === undefined || !scripts.isDirectory()) {
        fail("package staging is missing the scripts directory.");
    }
    const scriptEntries = await readdir(join(outputDirectory, "scripts"), {
        withFileTypes: true,
    });
    assertExactEntries(
        scriptEntries.map((entry) => entry.name),
        ["install.sh"],
        "package staging installer files",
    );
    const installer = scriptEntries[0];
    if (installer === undefined || !installer.isFile()) {
        fail("package staging installer must be a regular file.");
    }
};

export const validateStagedReleasePackage = async ({
    outputDirectory,
    sourceDirectory = resolve(import.meta.dir, ".."),
    sourceRevision,
    version,
}: StageReleasePackageOptions): Promise<StagedReleasePackage> => {
    assertVersionAndRevision(version, sourceRevision);
    const sourceManifest = await readJson(
        join(sourceDirectory, "package.json"),
        "source package.json",
    );
    if (sourceManifest.name !== PACKAGE_NAME) {
        fail(`source package name must be ${PACKAGE_NAME}.`);
    }
    if (sourceManifest.version !== version) {
        fail(
            `source package version is ${JSON.stringify(sourceManifest.version)}; expected ${version}.`,
        );
    }
    const layout = layoutFrom(outputDirectory, version);
    await assertOutputEntries(outputDirectory, version);
    await assertInstaller(sourceDirectory, layout.installerPath);
    const expectedFiles = packageFiles(sourceManifest);
    await extractAndValidatePackage(
        layout.packagePath,
        expectedFiles,
        version,
        sourceRevision,
    );
    const packageSha256 = createHash("sha256")
        .update(await readFile(layout.packagePath))
        .digest("hex");
    const installerSha256 = createHash("sha256")
        .update(await readFile(layout.installerPath))
        .digest("hex");
    return {
        installerPath: layout.installerPath,
        installerSha256,
        packagePath: layout.packagePath,
        packageSha256,
        sourceRevision,
        version,
    };
};

const prepareOutputDirectory = async (
    outputDirectory: string,
): Promise<void> => {
    await mkdir(outputDirectory, { recursive: true });
    if ((await readdir(outputDirectory)).length > 0) {
        fail(
            `output directory '${outputDirectory}' must be empty before staging.`,
        );
    }
};

const packageBuild = (
    sourceDirectory: string,
    version: string,
    sourceRevision: string,
): void => {
    run(
        process.execPath,
        [
            "run",
            "scripts/build.ts",
            "--package",
            "--version",
            version,
            "--commit-sha",
            sourceRevision,
        ],
        sourceDirectory,
        "validated package build",
    );
};

const packPackage = async (
    sourceDirectory: string,
    outputDirectory: string,
    version: string,
): Promise<void> => {
    const packDirectory = await mkdtemp(join(tmpdir(), "ralphie-npm-pack-"));
    try {
        const output = run(
            "npm",
            [
                "pack",
                "--ignore-scripts",
                "--json",
                "--pack-destination",
                packDirectory,
            ],
            sourceDirectory,
            "npm package staging",
        );
        const records = JSON.parse(output) as ReadonlyArray<JsonRecord>;
        const record = records[0];
        if (!isRecord(record))
            return fail("npm pack returned no package record.");
        if (record.name !== PACKAGE_NAME || record.version !== version) {
            return fail(
                `npm pack returned ${JSON.stringify(record.name)}@${JSON.stringify(record.version)}; expected ${PACKAGE_NAME}@${version}.`,
            );
        }
        const filename = `beremaran-ralphie-${version}.tgz`;
        if (record.filename !== filename) {
            return fail(
                `npm pack returned unexpected filename ${JSON.stringify(record.filename)}.`,
            );
        }
        await copyFile(
            join(packDirectory, filename),
            packagePathFor(outputDirectory, version),
        );
    } finally {
        await rm(packDirectory, { force: true, recursive: true });
    }
};

const stage = async (
    options: StageReleasePackageOptions,
): Promise<StagedReleasePackage> => {
    const sourceDirectory = resolve(
        options.sourceDirectory ?? resolve(import.meta.dir, ".."),
    );
    const outputDirectory = resolve(options.outputDirectory);
    assertVersionAndRevision(options.version, options.sourceRevision);
    assertValidatedSource(sourceDirectory, options.sourceRevision);
    await prepareOutputDirectory(outputDirectory);
    const sourceInstaller = join(sourceDirectory, INSTALLER_PATH);
    const installerStat = await lstat(sourceInstaller);
    if (!installerStat.isFile())
        fail("scripts/install.sh must be a regular file.");
    const sourceManifest = await readJson(
        join(sourceDirectory, "package.json"),
        "source package.json",
    );
    if (sourceManifest.version !== options.version) {
        fail(
            `source package version is ${JSON.stringify(sourceManifest.version)}; expected ${options.version}.`,
        );
    }
    packageBuild(sourceDirectory, options.version, options.sourceRevision);
    await packPackage(sourceDirectory, outputDirectory, options.version);
    await mkdir(join(outputDirectory, "scripts"));
    await copyFile(sourceInstaller, join(outputDirectory, INSTALLER_PATH));
    await chmod(join(outputDirectory, INSTALLER_PATH), 0o755);
    return validateStagedReleasePackage({
        ...options,
        outputDirectory,
        sourceDirectory,
    });
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
    if (args.length !== 6 && args.length !== 8) {
        throw new Error(
            "Usage: stage-release-package.ts --version <version> --commit-sha <sha> --output-dir <path> [--source-dir <path>]",
        );
    }
    const sourceDirectory = args.includes("--source-dir")
        ? optionValue(args, "--source-dir")
        : undefined;
    const result = await stageReleasePackage({
        outputDirectory: optionValue(args, "--output-dir"),
        sourceDirectory,
        sourceRevision: optionValue(args, "--commit-sha"),
        version: optionValue(args, "--version"),
    });
    console.log(
        `Staged ${PACKAGE_NAME}@${result.version} from ${result.sourceRevision} at ${result.packagePath}.`,
    );
};

export const stageReleasePackage = stage;

if (import.meta.main) {
    try {
        await main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}