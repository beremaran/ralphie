#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import Ajv from "ajv";

import spdxSchema from "../schemas/spdx-2.3.schema.json";
import { RELEASE_TARGETS } from "./create-sha256sums.ts";

export { RELEASE_TARGETS };

export const SBOM_GENERATOR_NAME = "ralphie-sbom-generator";
export const SBOM_GENERATOR_VERSION = "1.0.0";
export const SPDX_VERSION = "SPDX-2.3";

type ReleaseTarget = (typeof RELEASE_TARGETS)[number];

type CreateSbomsOptions = {
    readonly assetsDirectory: string;
    readonly buildCommand: string;
    readonly buildToolVersion: string;
    readonly bunVersion: string;
    readonly commitSha: string;
    readonly outputDirectory: string;
    readonly sourceDirectory: string;
    readonly tag: string;
    readonly version: string;
};

type BinaryMetadata = {
    readonly name: string;
    readonly sha256: string;
};

type InventoryFile = {
    readonly fileName: string;
    readonly sha256: string;
    readonly size: number;
};

type SbomMetadata = {
    readonly buildCommand: string;
    readonly buildInputs: ReadonlyArray<string>;
    readonly buildTool: { readonly name: string; readonly version: string };
    readonly bunVersion: string;
    readonly commitSha: string;
    readonly finalBinaryFilename: string;
    readonly finalBinarySha256: string;
    readonly finalBinarySize: number;
    readonly lockfile: InventoryFile;
    readonly releaseTag: string;
    readonly releaseVersion: string;
    readonly sbomGenerator: { readonly name: string; readonly version: string };
    readonly sourceFiles: ReadonlyArray<InventoryFile>;
    readonly target: ReleaseTarget;
};

type SourceInventory = {
    readonly buildInputs: ReadonlyArray<string>;
    readonly created: string;
    readonly lockfile: InventoryFile;
    readonly packages: ReadonlyArray<Record<string, unknown>>;
    readonly sourceFiles: ReadonlyArray<InventoryFile>;
};

type SpdxFile = Record<string, unknown> & {
    readonly SPDXID: string;
    readonly fileName: string;
    readonly checksums: ReadonlyArray<Record<string, unknown>>;
};

type SpdxPackage = Record<string, unknown> & {
    readonly SPDXID: string;
};

type SbomDocument = {
    readonly SPDXID: "SPDXRef-DOCUMENT";
    readonly spdxVersion: typeof SPDX_VERSION;
    readonly dataLicense: "CC0-1.0";
    readonly name: string;
    readonly documentNamespace: string;
    readonly creationInfo: {
        readonly created: string;
        readonly creators: ReadonlyArray<string>;
        readonly comment: string;
    };
    readonly packages: ReadonlyArray<Record<string, unknown>>;
    readonly files: ReadonlyArray<Record<string, unknown>>;
    readonly relationships: ReadonlyArray<Record<string, string>>;
};

const releaseVersionPattern =
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const commitShaPattern = /^[0-9a-f]{40}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const sourceInputPaths = [
    "index.ts",
    "package.json",
    "bun.lock",
    "scripts/build.ts",
] as const;

const expectedAssetName = (target: ReleaseTarget): string =>
    `ralphie-${target}`;

const expectedSbomName = (target: ReleaseTarget): string =>
    `${expectedAssetName(target)}.sbom.spdx.json`;

const isSbomFileName = (name: string): boolean => name.endsWith(".spdx.json");

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

const sha256 = async (path: string): Promise<string> =>
    createHash("sha256")
        .update(await readFile(path))
        .digest("hex");

const assertReleaseContext = (
    version: string,
    tag: string,
    commitSha: string,
): void => {
    if (!releaseVersionPattern.test(version) || tag !== `v${version}`) {
        throw new Error(
            `Release tag '${tag}' does not match version '${version}'.`,
        );
    }
    if (!commitShaPattern.test(commitSha)) {
        throw new Error(
            "Release commit SHA must be a 40-character lowercase SHA-1.",
        );
    }
};

const runGit = async (
    sourceDirectory: string,
    args: ReadonlyArray<string>,
): Promise<string> => {
    const process = Bun.spawn(["git", "-C", sourceDirectory, ...args], {
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
    ]);
    if (exitCode !== 0) {
        throw new Error(
            `Git command failed: git ${args.join(" ")}: ${stderr.trim()}`,
        );
    }
    return stdout.trim();
};

const assertCleanValidatedCheckout = async (
    sourceDirectory: string,
    commitSha: string,
): Promise<string> => {
    const head = await runGit(sourceDirectory, ["rev-parse", "HEAD"]);
    if (head !== commitSha) {
        throw new Error(
            `Source checkout is at '${head}', expected validated commit '${commitSha}'.`,
        );
    }
    await runGit(sourceDirectory, ["diff", "--quiet", "--"]);
    await runGit(sourceDirectory, ["diff", "--cached", "--quiet", "--"]);
    return runGit(sourceDirectory, ["show", "-s", "--format=%ct", commitSha]);
};

const trackedBuildInputs = async (
    sourceDirectory: string,
): Promise<ReadonlyArray<string>> => {
    const output = await runGit(sourceDirectory, [
        "ls-files",
        "-z",
        "--",
        ...sourceInputPaths,
        "src",
    ]);
    const paths = output
        .split("\0")
        .filter((path): path is string => path.length > 0)
        .sort();
    for (const requiredPath of sourceInputPaths) {
        if (!paths.includes(requiredPath)) {
            throw new Error(
                `Required build input '${requiredPath}' is not tracked.`,
            );
        }
    }
    const sourceFiles = paths.filter(
        (path) => path === "index.ts" || path.startsWith("src/"),
    );
    if (sourceFiles.length === 0) {
        throw new Error("The validated checkout has no tracked source files.");
    }
    return paths;
};

const readInventoryFile = async (
    sourceDirectory: string,
    fileName: string,
): Promise<InventoryFile> => {
    const path = join(sourceDirectory, fileName);
    const fileStat = await stat(path);
    if (!fileStat.isFile()) {
        throw new Error(`Build input '${fileName}' is not a file.`);
    }
    return {
        fileName,
        sha256: await sha256(path),
        size: fileStat.size,
    };
};

const readSourceInventory = async (
    sourceDirectory: string,
    paths: ReadonlyArray<string>,
): Promise<{
    readonly buildInputs: ReadonlyArray<string>;
    readonly lockfile: InventoryFile;
    readonly sourceFiles: ReadonlyArray<InventoryFile>;
}> => {
    const files = await Promise.all(
        paths.map((path) => readInventoryFile(sourceDirectory, path)),
    );
    const lockfile = files.find((file) => file.fileName === "bun.lock");
    if (lockfile === undefined)
        throw new Error("bun.lock is not in the build inventory.");
    return {
        buildInputs: paths,
        lockfile,
        sourceFiles: files.filter((file) => file.fileName !== "bun.lock"),
    };
};

const parsePackageVersion = (name: string, record: unknown): string => {
    if (!Array.isArray(record) || typeof record[0] !== "string") {
        throw new Error(`Lockfile package '${name}' has an invalid record.`);
    }
    const prefix = `${name}@`;
    if (!record[0].startsWith(prefix)) {
        throw new Error(
            `Lockfile package '${name}' has an invalid version record.`,
        );
    }
    return record[0].slice(prefix.length);
};

const packageId = (name: string, version: string): string => {
    const suffix = createHash("sha256")
        .update(`${name}@${version}`)
        .digest("hex")
        .slice(0, 12);
    return `SPDXRef-Package-${suffix}`;
};

const readPackages = async (
    sourceDirectory: string,
): Promise<ReadonlyArray<Record<string, unknown>>> => {
    const packageJson = JSON.parse(
        await readFile(join(sourceDirectory, "package.json"), "utf8"),
    ) as unknown;
    if (
        typeof packageJson !== "object" ||
        packageJson === null ||
        !("name" in packageJson) ||
        typeof packageJson.name !== "string" ||
        !("version" in packageJson) ||
        typeof packageJson.version !== "string"
    ) {
        throw new Error(
            "package.json must contain a package name and version.",
        );
    }
    const lockfile = Bun.JSON5.parse(
        await readFile(join(sourceDirectory, "bun.lock"), "utf8"),
    ) as unknown;
    if (
        typeof lockfile !== "object" ||
        lockfile === null ||
        !("packages" in lockfile) ||
        typeof lockfile.packages !== "object" ||
        lockfile.packages === null
    ) {
        throw new Error("bun.lock has no valid packages map.");
    }

    const entries: Array<[string, string]> = [
        [packageJson.name, packageJson.version],
    ];
    for (const [name, record] of Object.entries(lockfile.packages)) {
        entries.push([name, parsePackageVersion(name, record)]);
    }
    const uniqueEntries = new Map<string, [string, string]>();
    for (const [name, version] of entries) {
        uniqueEntries.set(`${name}@${version}`, [name, version]);
    }
    return [...uniqueEntries.values()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([name, version]) => ({
            SPDXID: packageId(name, version),
            name,
            versionInfo: version,
            downloadLocation: "NOASSERTION",
            filesAnalyzed: false,
            licenseConcluded: "NOASSERTION",
            licenseDeclared: "NOASSERTION",
            copyrightText: "NOASSERTION",
        }));
};

const commitCreationDate = (timestamp: string): string => {
    const seconds = Number.parseInt(timestamp, 10);
    if (!Number.isSafeInteger(seconds) || seconds < 0) {
        throw new Error("Validated commit has an invalid timestamp.");
    }
    return new Date(seconds * 1000).toISOString();
};

const readValidatedSource = async (
    sourceDirectory: string,
    commitSha: string,
): Promise<SourceInventory> => {
    const timestamp = await assertCleanValidatedCheckout(
        sourceDirectory,
        commitSha,
    );
    const inputPaths = await trackedBuildInputs(sourceDirectory);
    const inventory = await readSourceInventory(sourceDirectory, inputPaths);
    return {
        ...inventory,
        created: commitCreationDate(timestamp),
        packages: await readPackages(sourceDirectory),
    };
};

const binaryMetadata = async (
    assetsDirectory: string,
    target: ReleaseTarget,
    expectedDigest: string,
): Promise<{ readonly metadata: BinaryMetadata; readonly size: number }> => {
    const name = expectedAssetName(target);
    const path = join(assetsDirectory, name);
    const fileStat = await stat(path);
    if (!fileStat.isFile() || fileStat.size === 0) {
        throw new Error(`Final release asset '${name}' is missing or empty.`);
    }
    const digest = await sha256(path);
    if (digest !== expectedDigest) {
        throw new Error(
            `Final release asset '${name}' digest does not match release metadata.`,
        );
    }
    const sidecar = (
        await readFile(join(assetsDirectory, `${name}.sha256`), "utf8")
    ).trim();
    if (sidecar !== `${digest}  ${name}`) {
        throw new Error(
            `Final release asset checksum for '${name}' does not match its contents.`,
        );
    }
    return { metadata: { name, sha256: digest }, size: fileStat.size };
};

const readReleaseAssets = async (
    assetsDirectory: string,
    version: string,
    tag: string,
    commitSha: string,
): Promise<
    ReadonlyArray<{
        readonly target: ReleaseTarget;
        readonly binary: BinaryMetadata;
        readonly size: number;
    }>
> => {
    const metadataPath = join(assetsDirectory, "release-metadata.json");
    const releaseMetadata = JSON.parse(
        await readFile(metadataPath, "utf8"),
    ) as unknown;
    if (
        typeof releaseMetadata !== "object" ||
        releaseMetadata === null ||
        !("schema" in releaseMetadata) ||
        releaseMetadata.schema !== "ralphie.release-metadata.v1" ||
        !("tag" in releaseMetadata) ||
        releaseMetadata.tag !== tag ||
        !("version" in releaseMetadata) ||
        releaseMetadata.version !== version ||
        !("commit" in releaseMetadata) ||
        releaseMetadata.commit !== commitSha ||
        !("assets" in releaseMetadata) ||
        !Array.isArray(releaseMetadata.assets)
    ) {
        throw new Error(
            "Release metadata is incomplete or belongs to another release.",
        );
    }
    if (releaseMetadata.assets.length !== RELEASE_TARGETS.length) {
        throw new Error(
            "Release metadata must contain exactly four native assets.",
        );
    }
    const assets = new Map<string, string>();
    for (const asset of releaseMetadata.assets) {
        if (
            typeof asset !== "object" ||
            asset === null ||
            !("name" in asset) ||
            typeof asset.name !== "string" ||
            !("sha256" in asset) ||
            typeof asset.sha256 !== "string" ||
            !digestPattern.test(asset.sha256) ||
            assets.has(asset.name)
        ) {
            throw new Error(
                "Release metadata contains an invalid or duplicate asset.",
            );
        }
        assets.set(asset.name, asset.sha256);
    }
    const expectedNames = RELEASE_TARGETS.map(expectedAssetName);
    if (
        assets.size !== expectedNames.length ||
        expectedNames.some((name) => !assets.has(name))
    ) {
        throw new Error(
            "Release metadata does not contain the exact native target set.",
        );
    }

    const manifest = await readFile(
        join(assetsDirectory, "SHA256SUMS"),
        "utf8",
    );
    const expectedManifest = `${RELEASE_TARGETS.map((target) => `${assets.get(expectedAssetName(target))}  ${expectedAssetName(target)}`).join("\n")}\n`;
    if (manifest !== expectedManifest) {
        throw new Error("SHA256SUMS does not match the release metadata.");
    }
    return Promise.all(
        RELEASE_TARGETS.map(async (target) => {
            const binary = await binaryMetadata(
                assetsDirectory,
                target,
                assets.get(expectedAssetName(target)) as string,
            );
            return { target, binary: binary.metadata, size: binary.size };
        }),
    );
};

const fileId = (fileName: string): string =>
    `SPDXRef-File-${createHash("sha256").update(fileName).digest("hex").slice(0, 16)}`;

const createDocument = (
    metadata: SbomMetadata,
    packages: ReadonlyArray<Record<string, unknown>>,
    sourceFiles: ReadonlyArray<InventoryFile>,
    lockfile: InventoryFile,
    created: string,
): SbomDocument => {
    const binaryId = `SPDXRef-File-${metadata.target}`;
    const files = [
        ...[...sourceFiles, lockfile].map((file) => ({
            SPDXID: fileId(file.fileName),
            fileName: file.fileName,
            checksums: [{ algorithm: "SHA256", checksumValue: file.sha256 }],
            licenseConcluded: "NOASSERTION",
            licenseInfoInFiles: ["NOASSERTION"],
            copyrightText: "NOASSERTION",
        })),
        {
            SPDXID: binaryId,
            fileName: metadata.finalBinaryFilename,
            fileTypes: ["BINARY"],
            checksums: [
                {
                    algorithm: "SHA256",
                    checksumValue: metadata.finalBinarySha256,
                },
            ],
            licenseConcluded: "NOASSERTION",
            licenseInfoInFiles: ["NOASSERTION"],
            copyrightText: "NOASSERTION",
        },
    ];
    return {
        SPDXID: "SPDXRef-DOCUMENT",
        spdxVersion: SPDX_VERSION,
        dataLicense: "CC0-1.0",
        name: `ralphie-${metadata.releaseVersion}-${metadata.target}`,
        documentNamespace: `https://github.com/beremaran/ralphie/sbom/${metadata.releaseTag}/${metadata.target}`,
        creationInfo: {
            created,
            creators: [
                `Tool: ${SBOM_GENERATOR_NAME}-${SBOM_GENERATOR_VERSION}`,
            ],
            comment: JSON.stringify(metadata),
        },
        packages,
        files,
        relationships: [
            {
                spdxElementId: "SPDXRef-DOCUMENT",
                relationshipType: "DESCRIBES",
                relatedSpdxElement: binaryId,
            },
        ],
    };
};

const isSpdxChecksum = (value: unknown): boolean =>
    isRecord(value) &&
    value.algorithm === "SHA256" &&
    typeof value.checksumValue === "string" &&
    digestPattern.test(value.checksumValue);

const isSpdxFile = (value: unknown): value is SpdxFile =>
    isRecord(value) &&
    hasStringProperties(value, [
        "SPDXID",
        "fileName",
        "licenseConcluded",
        "copyrightText",
    ]) &&
    Array.isArray(value.checksums) &&
    value.checksums.length === 1 &&
    isSpdxChecksum(value.checksums[0]);

const isSpdxPackage = (value: unknown): value is SpdxPackage =>
    isRecord(value) &&
    hasStringProperties(value, [
        "SPDXID",
        "name",
        "versionInfo",
        "downloadLocation",
        "licenseConcluded",
        "licenseDeclared",
        "copyrightText",
    ]) &&
    value.filesAnalyzed === false;

const assertDocumentIdentity = (
    candidate: Partial<SbomDocument>,
    expected: SbomMetadata,
): void => {
    if (
        candidate.SPDXID !== "SPDXRef-DOCUMENT" ||
        candidate.spdxVersion !== SPDX_VERSION ||
        candidate.dataLicense !== "CC0-1.0" ||
        candidate.name !==
            `ralphie-${expected.releaseVersion}-${expected.target}` ||
        candidate.documentNamespace !==
            `https://github.com/beremaran/ralphie/sbom/${expected.releaseTag}/${expected.target}` ||
        candidate.creationInfo === undefined ||
        !Array.isArray(candidate.files) ||
        !Array.isArray(candidate.packages) ||
        !Array.isArray(candidate.relationships)
    ) {
        throw new Error("SBOM does not conform to the SPDX release contract.");
    }
};

const assertCreationInfo = (
    creationInfo: SbomDocument["creationInfo"],
    expected: SbomMetadata,
    created: string,
): void => {
    if (
        creationInfo.created !== created ||
        Number.isNaN(Date.parse(creationInfo.created)) ||
        !creationInfo.creators.includes(
            `Tool: ${SBOM_GENERATOR_NAME}-${SBOM_GENERATOR_VERSION}`,
        ) ||
        creationInfo.comment !== JSON.stringify(expected)
    ) {
        throw new Error("SBOM metadata is incomplete or mismatched.");
    }
};

const assertPackagesAndRelationships = (
    candidate: SbomDocument,
    expected: SbomMetadata,
    expectedPackages: ReadonlyArray<Record<string, unknown>>,
): Record<string, string> => {
    const packages = candidate.packages.filter(isSpdxPackage);
    const relationship = candidate.relationships[0];
    if (
        packages.length === 0 ||
        packages.length !== candidate.packages.length ||
        JSON.stringify(candidate.packages) !==
            JSON.stringify(expectedPackages) ||
        relationship === undefined ||
        candidate.relationships.length !== 1 ||
        relationship.spdxElementId !== "SPDXRef-DOCUMENT" ||
        relationship.relationshipType !== "DESCRIBES" ||
        relationship.relatedSpdxElement !== `SPDXRef-File-${expected.target}`
    ) {
        throw new Error("SBOM does not conform to the SPDX release contract.");
    }
    return relationship;
};

const assertFileInventory = (
    candidate: SbomDocument,
    expected: SbomMetadata,
): ReadonlyArray<SpdxFile> => {
    const files = candidate.files.filter(isSpdxFile);
    const expectedFiles = [...expected.sourceFiles, expected.lockfile];
    if (
        files.length !== expectedFiles.length + 1 ||
        files.length !== candidate.files.length
    ) {
        throw new Error("SBOM source and binary inventory is incomplete.");
    }
    for (const expectedFile of expectedFiles) {
        const file = files.find(
            (candidateFile) => candidateFile.fileName === expectedFile.fileName,
        );
        if (
            file === undefined ||
            file.checksums[0]?.checksumValue !== expectedFile.sha256
        ) {
            throw new Error(
                "SBOM source and lockfile inventory is mismatched.",
            );
        }
    }
    return files;
};

const assertBinary = (
    files: ReadonlyArray<SpdxFile>,
    expected: SbomMetadata,
): SpdxFile => {
    const binary = files.find(
        (file) => file.fileName === expected.finalBinaryFilename,
    );
    if (
        binary === undefined ||
        binary.checksums[0]?.checksumValue !== expected.finalBinarySha256
    ) {
        throw new Error("SBOM final binary digest or size is mismatched.");
    }
    return binary;
};

const assertBinaryRelationship = (
    binary: SpdxFile,
    relationship: Record<string, string>,
): void => {
    if (binary.SPDXID !== relationship.relatedSpdxElement) {
        throw new Error("SBOM binary SPDXID does not match its relationship.");
    }
};

const sameInventoryFile = (
    left: InventoryFile | undefined,
    right: InventoryFile | undefined,
): boolean =>
    left !== undefined &&
    right !== undefined &&
    left.fileName === right.fileName &&
    left.sha256 === right.sha256 &&
    left.size === right.size;

const sameInventory = (
    left: ReadonlyArray<InventoryFile>,
    right: ReadonlyArray<InventoryFile>,
): boolean =>
    left.length === right.length &&
    left.every((file, index) => sameInventoryFile(file, right[index]));

const sameStrings = (
    left: ReadonlyArray<string>,
    right: ReadonlyArray<string>,
): boolean =>
    left.length === right.length &&
    left.every((value, index) => value === right[index]);

const assertSourceBinding = (
    expected: SbomMetadata,
    source: SourceInventory,
): void => {
    if (
        !sameStrings(expected.buildInputs, source.buildInputs) ||
        !sameInventoryFile(expected.lockfile, source.lockfile) ||
        !sameInventory(expected.sourceFiles, source.sourceFiles)
    ) {
        throw new Error(
            "SBOM source inventory is not bound to the validated source checkout.",
        );
    }
};

const spdxReferenceProperties = new Set([
    "documentDescribes",
    "fileDependencies",
    "hasFiles",
    "relatedSpdxElement",
    "snippetFromFile",
    "spdxElementId",
]);

const collectSpdxIds = (value: unknown, ids: Set<string>): void => {
    if (Array.isArray(value)) {
        for (const child of value) collectSpdxIds(child, ids);
        return;
    }
    if (!isRecord(value)) return;
    if (typeof value.SPDXID === "string") {
        if (ids.has(value.SPDXID)) {
            throw new Error("SBOM contains duplicate SPDX identifiers.");
        }
        ids.add(value.SPDXID);
    }
    for (const child of Object.values(value)) collectSpdxIds(child, ids);
};

const assertSpdxReferenceList = (
    value: unknown,
    declaredIds: ReadonlySet<string>,
): void => {
    const references = Array.isArray(value) ? value : [value];
    for (const reference of references) {
        if (typeof reference !== "string" || !declaredIds.has(reference)) {
            throw new Error("SBOM contains a dangling SPDX reference.");
        }
    }
};

const assertSpdxReferences = (
    value: unknown,
    declaredIds: ReadonlySet<string>,
): void => {
    if (Array.isArray(value)) {
        for (const child of value) assertSpdxReferences(child, declaredIds);
        return;
    }
    if (!isRecord(value)) return;
    for (const [property, child] of Object.entries(value)) {
        if (spdxReferenceProperties.has(property)) {
            assertSpdxReferenceList(child, declaredIds);
            continue;
        }
        assertSpdxReferences(child, declaredIds);
    }
};

const validateDocument = (
    document: unknown,
    expected: SbomMetadata,
    source: SourceInventory,
): void => {
    validateSpdxSchema(document);
    if (!isRecord(document)) {
        throw new Error("SBOM is not a JSON object.");
    }
    const candidate = document as Partial<SbomDocument>;
    assertDocumentIdentity(candidate, expected);
    const complete = candidate as SbomDocument;
    assertCreationInfo(complete.creationInfo, expected, source.created);
    assertSourceBinding(expected, source);
    const relationship = assertPackagesAndRelationships(
        complete,
        expected,
        source.packages,
    );
    const files = assertFileInventory(complete, expected);
    const binary = assertBinary(files, expected);
    const ids = new Set<string>();
    collectSpdxIds(document, ids);
    assertSpdxReferences(document, ids);
    assertBinaryRelationship(binary, relationship);
};

export const createSboms = async ({
    assetsDirectory,
    buildCommand,
    buildToolVersion,
    bunVersion,
    commitSha,
    outputDirectory,
    sourceDirectory,
    tag,
    version,
}: CreateSbomsOptions): Promise<ReadonlyArray<string>> => {
    assertReleaseContext(version, tag, commitSha);
    const source = await readValidatedSource(sourceDirectory, commitSha);
    const assets = await readReleaseAssets(
        assetsDirectory,
        version,
        tag,
        commitSha,
    );
    const outputEntries = await readDirectory(outputDirectory);
    const existingSboms = outputEntries
        .filter((entry) => entry.isFile() && isSbomFileName(entry.name))
        .map((entry) => entry.name);
    if (existingSboms.length > 0) {
        throw new Error("SBOM output already contains generated documents.");
    }
    await mkdir(outputDirectory, { recursive: true });

    const documents = assets.map(({ target, binary, size }) => {
        const metadata: SbomMetadata = {
            buildCommand,
            buildInputs: source.buildInputs,
            buildTool: { name: "Bun", version: buildToolVersion },
            bunVersion,
            commitSha,
            finalBinaryFilename: binary.name,
            finalBinarySha256: binary.sha256,
            finalBinarySize: size,
            lockfile: source.lockfile,
            releaseTag: tag,
            releaseVersion: version,
            sbomGenerator: {
                name: SBOM_GENERATOR_NAME,
                version: SBOM_GENERATOR_VERSION,
            },
            sourceFiles: source.sourceFiles,
            target,
        };
        const document = createDocument(
            metadata,
            source.packages,
            source.sourceFiles,
            source.lockfile,
            source.created,
        );
        validateDocument(document, metadata, source);
        return { document, name: expectedSbomName(target) };
    });
    for (const { document, name } of documents) {
        await writeFile(
            join(outputDirectory, name),
            `${JSON.stringify(document, null, 2)}\n`,
            "utf8",
        );
    }
    return documents.map(({ name }) => join(outputDirectory, name));
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;

const spdxValidator = new Ajv({
    allErrors: true,
} as unknown as ConstructorParameters<typeof Ajv>[0]).compile(spdxSchema);
const spdxIdentifierPattern = /^SPDXRef-[A-Za-z0-9.-]+$/;

const assertSpdxIdentifiers = (value: unknown): void => {
    if (Array.isArray(value)) {
        for (const child of value) assertSpdxIdentifiers(child);
        return;
    }
    if (!isRecord(value)) return;
    if (
        "SPDXID" in value &&
        (typeof value.SPDXID !== "string" ||
            !spdxIdentifierPattern.test(value.SPDXID))
    ) {
        throw new Error("SBOM contains an invalid SPDX identifier.");
    }
    for (const child of Object.values(value)) assertSpdxIdentifiers(child);
};

const validateSpdxSchema = (document: unknown): void => {
    if (!spdxValidator(document)) {
        const error = spdxValidator.errors?.[0];
        throw new Error(
            `SBOM does not conform to the SPDX 2.3 schema${
                error !== undefined && "instancePath" in error
                    ? String(error.instancePath ?? "")
                    : ""
            }.`,
        );
    }
    assertSpdxIdentifiers(document);
};

const hasStringProperties = (
    value: Record<string, unknown>,
    names: ReadonlyArray<string>,
): boolean => names.every((name) => typeof value[name] === "string");

const isInventoryFile = (value: unknown): value is InventoryFile =>
    isRecord(value) &&
    hasStringProperties(value, ["fileName", "sha256"]) &&
    digestPattern.test(value.sha256 as string) &&
    typeof value.size === "number" &&
    Number.isSafeInteger(value.size) &&
    value.size >= 0;

const metadataFromDocument = (document: unknown): SbomMetadata => {
    if (
        !isRecord(document) ||
        !isRecord(document.creationInfo) ||
        typeof document.creationInfo.comment !== "string"
    ) {
        throw new Error("SBOM release metadata comment is missing.");
    }
    const metadata = JSON.parse(document.creationInfo.comment) as unknown;
    if (!isRecord(metadata)) {
        throw new Error("SBOM release metadata comment is invalid.");
    }
    const buildTool = metadata.buildTool;
    const sbomGenerator = metadata.sbomGenerator;
    if (
        !hasStringProperties(metadata, [
            "buildCommand",
            "bunVersion",
            "commitSha",
            "finalBinaryFilename",
            "finalBinarySha256",
            "releaseTag",
            "releaseVersion",
            "target",
        ]) ||
        !commitShaPattern.test(metadata.commitSha as string) ||
        !digestPattern.test(metadata.finalBinarySha256 as string) ||
        !RELEASE_TARGETS.includes(metadata.target as ReleaseTarget) ||
        typeof metadata.finalBinarySize !== "number" ||
        !Number.isSafeInteger(metadata.finalBinarySize) ||
        metadata.finalBinarySize <= 0 ||
        !Array.isArray(metadata.buildInputs) ||
        !metadata.buildInputs.every((value) => typeof value === "string") ||
        !isInventoryFile(metadata.lockfile) ||
        !Array.isArray(metadata.sourceFiles) ||
        !metadata.sourceFiles.every(isInventoryFile) ||
        !isRecord(buildTool) ||
        !hasStringProperties(buildTool, ["name", "version"]) ||
        buildTool.name !== "Bun" ||
        !metadata.buildInputs.includes("bun.lock") ||
        !metadata.buildInputs.includes("scripts/build.ts") ||
        metadata.sourceFiles.length === 0 ||
        metadata.lockfile.fileName !== "bun.lock" ||
        !isRecord(sbomGenerator) ||
        sbomGenerator.name !== SBOM_GENERATOR_NAME ||
        sbomGenerator.version !== SBOM_GENERATOR_VERSION
    ) {
        throw new Error("SBOM release metadata comment is invalid.");
    }
    return metadata as SbomMetadata;
};

export const validateSbomSet = async (
    outputDirectory: string,
    version: string,
    tag: string,
    commitSha: string,
    sourceDirectory: string,
    assetsDirectory = outputDirectory,
): Promise<void> => {
    assertReleaseContext(version, tag, commitSha);
    const source = await readValidatedSource(sourceDirectory, commitSha);
    await readReleaseAssets(assetsDirectory, version, tag, commitSha);
    const entries = await readDirectory(outputDirectory);
    const actual = entries
        .filter((entry) => entry.isFile() && isSbomFileName(entry.name))
        .map((entry) => entry.name)
        .sort();
    const expected = RELEASE_TARGETS.map(expectedSbomName).sort();
    if (
        actual.length !== expected.length ||
        actual.some((name, index) => name !== expected[index])
    ) {
        throw new Error(
            "SBOM output must contain exactly one document per native target.",
        );
    }
    for (const target of RELEASE_TARGETS) {
        const document = JSON.parse(
            await readFile(
                join(outputDirectory, expectedSbomName(target)),
                "utf8",
            ),
        ) as unknown;
        const metadata = metadataFromDocument(document);
        const binaryPath = join(assetsDirectory, expectedAssetName(target));
        const fileStat = await stat(binaryPath);
        const digest = await sha256(binaryPath);
        if (
            metadata.releaseVersion !== version ||
            metadata.releaseTag !== tag ||
            metadata.commitSha !== commitSha ||
            metadata.target !== target ||
            metadata.finalBinaryFilename !== expectedAssetName(target) ||
            metadata.finalBinarySize !== fileStat.size ||
            metadata.finalBinarySha256 !== digest
        ) {
            throw new Error(
                "SBOM metadata does not match the validated release assets.",
            );
        }
        validateDocument(document, metadata, source);
    }
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
    if (args.length !== 18) {
        throw new Error(
            "Usage: create-sboms.ts --assets-dir <path> --output-dir <path> --source-dir <path> --version <version> --tag <tag> --commit-sha <sha> --bun-version <version> --build-tool-version <version> --build-command <command>",
        );
    }
    const options = {
        assetsDirectory: optionValue(args, "--assets-dir"),
        buildCommand: optionValue(args, "--build-command"),
        buildToolVersion: optionValue(args, "--build-tool-version"),
        bunVersion: optionValue(args, "--bun-version"),
        commitSha: optionValue(args, "--commit-sha"),
        outputDirectory: optionValue(args, "--output-dir"),
        sourceDirectory: optionValue(args, "--source-dir"),
        tag: optionValue(args, "--tag"),
        version: optionValue(args, "--version"),
    };
    await createSboms(options);
    await validateSbomSet(
        options.outputDirectory,
        options.version,
        options.tag,
        options.commitSha,
        options.sourceDirectory,
        options.assetsDirectory,
    );
};

if (import.meta.main) {
    try {
        await main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    }
}