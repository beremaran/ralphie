import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

import { RalphieError } from "../shared/error.ts";
import {
    DOCKER_SCHEMA2_MANIFEST_MEDIA_TYPE,
    manifestDigest,
    OCI_IMAGE_MANIFEST_MEDIA_TYPE,
    type ManifestMediaType,
    type RegistryBlobDescriptor,
} from "./registry-reconcile.ts";

/**
 * Side-effect-free validation of the staged container-candidate set produced
 * by the `stage-container` job of `.github/workflows/release.yml` and
 * consumed by the protected `push-container` publisher.
 *
 * Each immutable staging artifact (`ralphie-container-candidate-<version>-<arch>`)
 * carries exactly two files: the `ralphie.container-candidate.v1` contract
 * (`ralphie-container-<arch>.metadata.json`) and the platform OCI archive
 * (`ralphie-container-<arch>.oci.tar`). This module requires the exact
 * amd64/arm64 artifact-name pair for the validated release version and
 * rejects missing, duplicate, extra, or cross-release candidates, unexpected
 * files, archive paths containing traversal/absolute components, and any
 * artifact that does not contain exactly its contract and archive.
 *
 * The validator then strictly parses the contract, requiring the exact
 * artifact name, version, 40-character lowercase `source_ref`, expected
 * platform, `format: oci-archive`, expected archive filename, lowercase
 * archive SHA-256, lowercase `sha256:` BuildKit manifest digest, and the
 * recorded MIT/version/revision image labels against the release context. It
 * recomputes the archive SHA-256 and inspects the archive's own `index.json`
 * and the actual image manifest blob, comparing the recomputed manifest
 * content digest with the recorded BuildKit digest — checking only labels,
 * config, or child layer digests is insufficient. Every referenced blob must
 * exist with the exact recorded size and digest, and no unreferenced blob or
 * unexpected archive file or directory may be present (directory entries are
 * permitted only for the `blobs/` layout skeleton).
 *
 * The validated archive paths, exact manifest bytes/descriptors, and expected
 * digests are returned for later index assembly. This component never logs in
 * to GHCR, writes a registry tag, rebuilds an image, or silently continues
 * after a validation error: it performs no network I/O and throws
 * `ContainerCandidateValidationError` on every mismatch.
 */

export const CONTAINER_CANDIDATE_SCHEMA =
    "ralphie.container-candidate.v1" as const;
export const CONTAINER_CANDIDATE_FORMAT = "oci-archive" as const;

export const CONTAINER_CANDIDATE_ARCHS = ["amd64", "arm64"] as const;

export type ContainerCandidateArch = (typeof CONTAINER_CANDIDATE_ARCHS)[number];

export type ContainerCandidatePlatform = "linux/amd64" | "linux/arm64";

export const containerCandidatePlatform = (
    arch: ContainerCandidateArch,
): ContainerCandidatePlatform =>
    arch === "amd64" ? "linux/amd64" : "linux/arm64";

export const containerCandidateArtifactName = (
    version: string,
    arch: ContainerCandidateArch,
): string => `ralphie-container-candidate-${version}-${arch}`;

export const containerCandidateArchiveName = (
    arch: ContainerCandidateArch,
): string => `ralphie-container-${arch}.oci.tar`;

export const containerCandidateContractName = (
    arch: ContainerCandidateArch,
): string => `ralphie-container-${arch}.metadata.json`;

export class ContainerCandidateValidationError extends RalphieError {}

const VERSION_PATTERN =
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$(?![\s\S])/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$(?![\s\S])/;
const SHA256_PATTERN = /^[0-9a-f]{64}$(?![\s\S])/;
const OCI_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$(?![\s\S])/;
const BLOB_FILE_PATTERN = /^blobs\/sha256\/([0-9a-f]{64})$/;

const OCI_CONFIG_MEDIA_TYPE = "application/vnd.oci.image.config.v1+json";
const DOCKER_CONFIG_MEDIA_TYPE =
    "application/vnd.docker.container.image.v1+json";
const OCI_LAYER_MEDIA_TYPE = "application/vnd.oci.image.layer.v1.tar+gzip";
const DOCKER_LAYER_MEDIA_TYPE =
    "application/vnd.docker.image.rootfs.diff.tar.gzip";

const IMAGE_MANIFEST_MEDIA_TYPES = [
    OCI_IMAGE_MANIFEST_MEDIA_TYPE,
    DOCKER_SCHEMA2_MANIFEST_MEDIA_TYPE,
] as const;

const CONFIG_MEDIA_TYPES = [
    OCI_CONFIG_MEDIA_TYPE,
    DOCKER_CONFIG_MEDIA_TYPE,
] as const;
const LAYER_MEDIA_TYPES = [
    OCI_LAYER_MEDIA_TYPE,
    DOCKER_LAYER_MEDIA_TYPE,
] as const;

const LABELS = Object.freeze({
    license: "org.opencontainers.image.licenses" as const,
    version: "org.opencontainers.image.version" as const,
    revision: "org.opencontainers.image.revision" as const,
});

type JsonRecord = {
    readonly [key: string]: unknown;
};

export type ContainerCandidateContract = {
    readonly schema: typeof CONTAINER_CANDIDATE_SCHEMA;
    readonly artifact: string;
    readonly version: string;
    readonly source_ref: string;
    readonly platform: ContainerCandidatePlatform;
    readonly digest: string;
    readonly format: typeof CONTAINER_CANDIDATE_FORMAT;
    readonly archive: string;
    readonly archive_sha256: string;
    readonly image_license: "MIT";
    readonly image_version: string;
    readonly image_revision: string;
};

/** The single platform manifest descriptor recorded in the archive index. */
export type ContainerIndexManifestDescriptor = {
    readonly mediaType: ManifestMediaType;
    readonly size: number;
    readonly digest: string;
};

export type ValidatedContainerCandidateImage = {
    /** Recorded BuildKit digest, equal to the recomputed manifest content digest. */
    readonly digest: string;
    /** Exact serialized image manifest bytes from inside the OCI archive. */
    readonly bytes: Uint8Array;
    readonly mediaType: ManifestMediaType;
    /** The archive's `index.json` descriptor for the single platform manifest. */
    readonly indexDescriptor: ContainerIndexManifestDescriptor;
    readonly config: RegistryBlobDescriptor;
    readonly layers: ReadonlyArray<RegistryBlobDescriptor>;
};

export type ValidatedContainerCandidate = {
    readonly arch: ContainerCandidateArch;
    readonly artifactName: string;
    readonly platform: ContainerCandidatePlatform;
    /** Absolute path to the validated OCI archive. */
    readonly archivePath: string;
    readonly archiveSha256: string;
    readonly image: ValidatedContainerCandidateImage;
};

export type ValidatedContainerCandidates = {
    readonly version: string;
    readonly sourceRef: string;
    readonly byPlatform: Readonly<
        Record<ContainerCandidateArch, ValidatedContainerCandidate>
    >;
};

export type ContainerCandidateValidationOptions = {
    /** Directory containing the two exact candidate artifact directories. */
    readonly candidatesDir: string;
    /** Validated release version, `<major>.<minor>.<patch>` without `v`. */
    readonly version: string;
    /** Validated 40-character lowercase release commit SHA. */
    readonly sourceRef: string;
};

const fail = (message: string): never => {
    throw new ContainerCandidateValidationError({ message });
};

const isRecord = (value: unknown): value is JsonRecord =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const exactKeys = (
    record: JsonRecord,
    keys: ReadonlyArray<string>,
    label: string,
): void => {
    const actual = Object.keys(record);
    const expected = new Set(keys);
    const missing = keys.filter((key) => !(key in record));
    const unexpected = actual.filter((key) => !expected.has(key));
    if (missing.length > 0 || unexpected.length > 0) {
        fail(
            `${label} must have exactly the fields (${keys.join(", ")}) in any order; missing: ${missing.join(", ") || "none"}, unexpected: ${unexpected.join(", ") || "none"}.`,
        );
    }
};

const stringField = (
    record: JsonRecord,
    key: string,
    label: string,
): string => {
    const value = record[key];
    if (typeof value !== "string") {
        return fail(`${label} must have a string '${key}'.`);
    }
    return value;
};

const assertReleaseContext = (version: string, sourceRef: string): void => {
    if (!VERSION_PATTERN.test(version)) {
        fail(
            `Release version '${version}' must be canonical <major>.<minor>.<patch>.`,
        );
    }
    if (!COMMIT_SHA_PATTERN.test(sourceRef)) {
        fail(
            `Release source ref '${sourceRef}' must be a 40-character lowercase commit SHA.`,
        );
    }
};

const assertExactNames = (
    actual: ReadonlyArray<string>,
    expected: ReadonlyArray<string>,
    description: string,
): void => {
    const sortedActual = [...actual].sort();
    const sortedExpected = [...expected].sort();
    if (
        sortedActual.length !== sortedExpected.length ||
        sortedActual.some((name, index) => name !== sortedExpected[index])
    ) {
        fail(
            `${description} must be exactly: ${sortedExpected.join(", ")}; found: ${sortedActual.join(", ") || "none"}.`,
        );
    }
};

const assertContractEquality = (
    values: ReadonlyArray<{
        readonly actual: string;
        readonly expected: string;
        readonly field: string;
    }>,
): void => {
    for (const { actual, expected, field } of values) {
        if (actual !== expected) {
            fail(
                `Container candidate ${field} must be '${expected}', found '${actual}'.`,
            );
        }
    }
};

const parseContract = (
    raw: string,
    version: string,
    sourceRef: string,
    arch: ContainerCandidateArch,
): ContainerCandidateContract => {
    const contractName = containerCandidateContractName(arch);
    let value: unknown;
    try {
        value = JSON.parse(raw) as unknown;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fail(
            `Container candidate contract '${contractName}' is not valid JSON: ${message}`,
        );
    }
    if (!isRecord(value)) {
        return fail(
            `Container candidate contract '${contractName}' must be a JSON object.`,
        );
    }
    exactKeys(
        value,
        [
            "schema",
            "artifact",
            "version",
            "source_ref",
            "platform",
            "digest",
            "format",
            "archive",
            "archive_sha256",
            "image_license",
            "image_version",
            "image_revision",
        ],
        "container candidate contract",
    );
    const fields = {
        schema: stringField(value, "schema", "container candidate contract"),
        artifact: stringField(
            value,
            "artifact",
            "container candidate contract",
        ),
        contractVersion: stringField(
            value,
            "version",
            "container candidate contract",
        ),
        contractSourceRef: stringField(
            value,
            "source_ref",
            "container candidate contract",
        ),
        platform: stringField(
            value,
            "platform",
            "container candidate contract",
        ),
        digest: stringField(value, "digest", "container candidate contract"),
        format: stringField(value, "format", "container candidate contract"),
        archive: stringField(value, "archive", "container candidate contract"),
        archiveSha256: stringField(
            value,
            "archive_sha256",
            "container candidate contract",
        ),
        imageLicense: stringField(
            value,
            "image_license",
            "container candidate contract",
        ),
        imageVersion: stringField(
            value,
            "image_version",
            "container candidate contract",
        ),
        imageRevision: stringField(
            value,
            "image_revision",
            "container candidate contract",
        ),
    };

    assertContractEquality([
        {
            actual: fields.schema,
            expected: CONTAINER_CANDIDATE_SCHEMA,
            field: "schema",
        },
        {
            actual: fields.artifact,
            expected: containerCandidateArtifactName(version, arch),
            field: "artifact",
        },
        { actual: fields.contractVersion, expected: version, field: "version" },
        {
            actual: fields.contractSourceRef,
            expected: sourceRef,
            field: "source_ref",
        },
        {
            actual: fields.platform,
            expected: containerCandidatePlatform(arch),
            field: "platform",
        },
        {
            actual: fields.format,
            expected: CONTAINER_CANDIDATE_FORMAT,
            field: "format",
        },
        {
            actual: fields.archive,
            expected: containerCandidateArchiveName(arch),
            field: "archive",
        },
        {
            actual: fields.imageLicense,
            expected: "MIT",
            field: "image_license",
        },
        {
            actual: fields.imageVersion,
            expected: version,
            field: "image_version",
        },
        {
            actual: fields.imageRevision,
            expected: sourceRef,
            field: "image_revision",
        },
    ]);
    if (
        !SHA256_PATTERN.test(fields.archiveSha256) ||
        /^0+$/.test(fields.archiveSha256)
    ) {
        fail(
            `Container candidate archive_sha256 '${fields.archiveSha256}' must be 64 lowercase hexadecimal characters and must not be a placeholder.`,
        );
    }
    if (
        !OCI_DIGEST_PATTERN.test(fields.digest) ||
        /^sha256:0+$/.test(fields.digest)
    ) {
        fail(
            `Container candidate digest '${fields.digest}' must match sha256:<64 lowercase hexadecimal characters> and must not be a placeholder.`,
        );
    }
    return {
        schema: CONTAINER_CANDIDATE_SCHEMA,
        artifact: fields.artifact,
        version: fields.contractVersion,
        source_ref: fields.contractSourceRef,
        platform: containerCandidatePlatform(arch),
        digest: fields.digest,
        format: CONTAINER_CANDIDATE_FORMAT,
        archive: fields.archive,
        archive_sha256: fields.archiveSha256,
        image_license: "MIT",
        image_version: fields.imageVersion,
        image_revision: fields.imageRevision,
    };
};

const readUtf8 = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const parseJson = (bytes: Uint8Array, label: string): JsonRecord => {
    let value: unknown;
    try {
        value = JSON.parse(readUtf8(bytes)) as unknown;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fail(`${label} is not valid JSON: ${message}`);
    }
    if (isRecord(value)) return value;
    return fail(`${label} must be a JSON object.`);
};

const TAR_BLOCK_SIZE = 512;

const isAllZero = (block: Uint8Array): boolean => {
    for (const byte of block) {
        if (byte !== 0) return false;
    }
    return true;
};

const cString = (bytes: Uint8Array, label: string): string => {
    const end = bytes.indexOf(0);
    const slice = end === -1 ? bytes : bytes.subarray(0, end);
    return new TextDecoder().decode(slice);
};

const parseOctalField = (field: Uint8Array, label: string): number => {
    if ((field[0] ?? 0) & 0x80) {
        fail(`${label} uses unsupported base-256 encoding.`);
    }
    let value = 0;
    let digits = 0;
    for (const byte of field) {
        if (byte === 0 || byte === 0x20) break;
        if (byte < 0x30 || byte > 0x37) {
            fail(`${label} is not an ASCII octal value.`);
        }
        value = value * 8 + (byte - 0x30);
        digits += 1;
        if (value > Number.MAX_SAFE_INTEGER) {
            fail(`${label} overflows a safe integer.`);
        }
    }
    if (digits === 0) {
        fail(`${label} is empty.`);
    }
    return value;
};

const normalizeArchivePath = (path: string): string =>
    path === "./" || path === "."
        ? ""
        : path.startsWith("./")
          ? path.slice(2)
          : path;

const assertSafeArchivePath = (path: string): void => {
    if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
        fail(`Archive contains an unsafe path '${path}'.`);
    }
    const components = path.split("/");
    if (
        components.some(
            (component) =>
                component === "" || component === "." || component === "..",
        )
    ) {
        fail(
            `Archive path '${path}' contains a traversal, current-directory, or empty component.`,
        );
    }
};

type ParsedTarEntry = {
    readonly path: string;
    readonly kind: "file" | "directory";
    readonly bytes: Uint8Array;
};

type TarHeaderFields = {
    readonly path: string;
    readonly typeflag: number;
    readonly size: number;
};

const entryPath = (name: string, prefix: string, typeflag: number): string => {
    const rawPath = normalizeArchivePath(
        prefix.length === 0 ? name : `${prefix}/${name}`,
    );
    // Directory entry names conventionally carry a trailing slash; drop it so
    // the safety checks and the exact entry-set comparison use one canonical
    // form for both conventions.
    return typeflag === 0x35 && rawPath.endsWith("/")
        ? rawPath.slice(0, -1)
        : rawPath;
};

const resolveEntryPath = (
    name: string,
    prefix: string,
    typeflag: number,
): string => {
    const path = entryPath(name, prefix, typeflag);
    // A root-directory entry (``, `.`, or `./`) is an optional tar writer
    // convention and is skipped by `consumeTarEntry`; every other entry must
    // be a safe relative path (no absolute, traversal, backslash, or empty
    // components).
    if (path !== "" || typeflag !== 0x35) {
        assertSafeArchivePath(path);
    }
    return path;
};

/**
 * Parse one 512-byte ustar header: verify the checksum, resolve the safe
 * relative entry path, and extract the type flag and size. Returns null for
 * the terminator's first zero block.
 */
const parseTarHeader = (block: Uint8Array): TarHeaderFields | null => {
    if (isAllZero(block)) return null;
    const checksumStored = parseOctalField(
        block.subarray(148, 156),
        "tar header checksum",
    );
    let checksumComputed = 0;
    for (let index = 0; index < TAR_BLOCK_SIZE; index += 1) {
        checksumComputed +=
            index >= 148 && index < 156 ? 0x20 : (block[index] ?? 0);
    }
    if (checksumComputed !== checksumStored) {
        return fail("Archive contains a tar header with an invalid checksum.");
    }
    const name = cString(block.subarray(0, 100), "tar entry name");
    const prefix = cString(block.subarray(345, 500), "tar entry prefix");
    const typeflag = block[156] ?? 0;
    if (typeflag !== 0x30 && typeflag !== 0 && typeflag !== 0x35) {
        return fail(
            `Archive entry '${entryPath(name, prefix, typeflag)}' is not a regular file or directory (typeflag ${typeflag}).`,
        );
    }
    const path = resolveEntryPath(name, prefix, typeflag);
    const size =
        typeflag === 0x35
            ? 0
            : parseOctalField(
                  block.subarray(124, 136),
                  `tar entry size of '${path}'`,
              );
    return { path, typeflag, size };
};

const consumeTarEntry = (
    entries: Map<string, ParsedTarEntry>,
    seenPaths: Set<string>,
    bytes: Uint8Array,
    offset: number,
): number | null => {
    const header = parseTarHeader(
        bytes.subarray(offset, offset + TAR_BLOCK_SIZE),
    );
    if (header === null) return null;
    if (seenPaths.has(header.path)) {
        return fail(`Archive contains a duplicate entry '${header.path}'.`);
    }
    seenPaths.add(header.path);
    if (header.path === "" && header.typeflag === 0x35) {
        // Root-directory entries are an optional tar writer convention.
        return offset + TAR_BLOCK_SIZE;
    }
    if (header.typeflag === 0x35) {
        entries.set(header.path, {
            path: header.path,
            kind: "directory",
            bytes: new Uint8Array(0),
        });
        return offset + TAR_BLOCK_SIZE;
    }
    const paddedSize = Math.ceil(header.size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
    const dataStart = offset + TAR_BLOCK_SIZE;
    if (dataStart + paddedSize > bytes.length) {
        return fail(`Archive entry '${header.path}' is truncated.`);
    }
    entries.set(header.path, {
        path: header.path,
        kind: "file",
        bytes: bytes.subarray(dataStart, dataStart + header.size),
    });
    return dataStart + paddedSize;
};

/**
 * Parse a POSIX ustar stream without extracting anything: every header
 * checksum is verified, symlink/hardlink/device entries are rejected, archive
 * paths are constrained to safe relative paths (no absolute, traversal,
 * backslash, or empty components), duplicate entry paths are rejected, and
 * the stream must end with the two zero-block terminator followed only by
 * zero padding. The returned entries alias the input buffer (no copy).
 */
const parseTarEntries = (
    bytes: Uint8Array,
): ReadonlyMap<string, ParsedTarEntry> => {
    const entries = new Map<string, ParsedTarEntry>();
    const seenPaths = new Set<string>();
    let offset = 0;
    for (;;) {
        if (offset + TAR_BLOCK_SIZE > bytes.length) {
            return fail(
                "Archive is missing the two zero-block tar terminator.",
            );
        }
        const next = consumeTarEntry(entries, seenPaths, bytes, offset);
        if (next === null) break;
        offset = next;
    }
    if (offset + TAR_BLOCK_SIZE > bytes.length) {
        return fail("Archive is missing the second zero-block tar terminator.");
    }
    offset += TAR_BLOCK_SIZE;
    while (offset + TAR_BLOCK_SIZE <= bytes.length) {
        if (!isAllZero(bytes.subarray(offset, offset + TAR_BLOCK_SIZE))) {
            return fail("Archive contains data after the tar terminator.");
        }
        offset += TAR_BLOCK_SIZE;
    }
    return entries;
};

const sha256Hex = (bytes: Uint8Array): string =>
    createHash("sha256").update(bytes).digest("hex");

const fileAt = (
    entries: ReadonlyMap<string, ParsedTarEntry>,
    path: string,
): Uint8Array => {
    const entry = entries.get(path);
    if (entry === undefined || entry.kind !== "file") {
        return fail(`Archive is missing the required file '${path}'.`);
    }
    return entry.bytes;
};

const requireDescriptor = (
    value: unknown,
    label: string,
): RegistryBlobDescriptor => {
    if (!isRecord(value)) return fail(`${label} must be an object.`);
    const mediaType = stringField(value, "mediaType", label);
    const size = value.size;
    const digest = stringField(value, "digest", label);
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) {
        return fail(`${label} must have a positive safe-integer size.`);
    }
    if (!OCI_DIGEST_PATTERN.test(digest) || /^sha256:0+$/.test(digest)) {
        return fail(
            `${label} digest '${digest}' is not a canonical sha256 digest.`,
        );
    }
    return { mediaType, size, digest };
};

const requireBlob = (
    entries: ReadonlyMap<string, ParsedTarEntry>,
    descriptor: RegistryBlobDescriptor,
    label: string,
): Uint8Array => {
    const hex = descriptor.digest.slice("sha256:".length);
    const bytes = fileAt(entries, `blobs/sha256/${hex}`);
    if (bytes.byteLength !== descriptor.size) {
        return fail(
            `${label} blob '${descriptor.digest}' has ${bytes.byteLength} bytes, expected ${descriptor.size}.`,
        );
    }
    const digest = `sha256:${sha256Hex(bytes)}`;
    if (digest !== descriptor.digest) {
        return fail(
            `${label} blob content digests to ${digest}, expected ${descriptor.digest}.`,
        );
    }
    return bytes;
};

const assertImageLabel = (
    labels: JsonRecord,
    key: string,
    expected: string,
    platform: ContainerCandidatePlatform,
): void => {
    const value = labels[key];
    if (typeof value !== "string" || value !== expected) {
        fail(
            `Container image config for ${platform} must have label '${key}' equal to '${expected}', found '${String(value)}'.`,
        );
    }
};

const gunzipOrPlain = (
    archiveBytes: Uint8Array,
    isGzip: boolean,
): Uint8Array => {
    if (!isGzip) return archiveBytes;
    try {
        return gunzipSync(archiveBytes);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fail(
            `Container candidate OCI archive is not a valid archive: ${message}`,
        );
    }
};

type OciIndexView = {
    readonly descriptor: ContainerIndexManifestDescriptor;
    readonly manifestBytes: Uint8Array;
    readonly manifest: JsonRecord;
};

/**
 * Validate the archive layout basics and the single platform manifest entry:
 * `oci-layout` must be exactly `{'imageLayoutVersion':'1.0.0'}`, `index.json`
 * must hold exactly one manifest descriptor whose digest equals the recorded
 * BuildKit digest, and the archive's actual image manifest blob must be
 * present with a recomputed content digest equal to the recorded digest. The
 * descriptor's platform, when present, must match the expected architecture.
 */
const inspectIndex = (
    entries: ReadonlyMap<string, ParsedTarEntry>,
    recordedDigest: string,
    arch: ContainerCandidateArch,
): OciIndexView => {
    const layout = parseJson(fileAt(entries, "oci-layout"), "oci-layout");
    if (
        Object.keys(layout).length !== 1 ||
        layout.imageLayoutVersion !== "1.0.0"
    ) {
        return fail(
            "oci-layout must be exactly {'imageLayoutVersion':'1.0.0'}.",
        );
    }
    const index = parseJson(
        fileAt(entries, "index.json"),
        "the archive index.json",
    );
    if (index.schemaVersion !== 2) {
        return fail("The archive index.json must have schemaVersion 2.");
    }
    const manifests = index.manifests;
    if (!Array.isArray(manifests) || manifests.length !== 1) {
        return fail(
            "The archive index.json must contain exactly one manifest descriptor.",
        );
    }
    const descriptorValue = manifests[0] as unknown;
    if (!isRecord(descriptorValue)) {
        return fail(
            "The archive index.json manifest descriptor must be an object.",
        );
    }
    const descriptor = requireDescriptor(
        descriptorValue,
        "the archive index.json manifest descriptor",
    ) as ContainerIndexManifestDescriptor;
    if (
        !(IMAGE_MANIFEST_MEDIA_TYPES as readonly string[]).includes(
            descriptor.mediaType,
        )
    ) {
        return fail(
            `The archive index.json manifest media type '${descriptor.mediaType}' is not a supported image manifest type.`,
        );
    }
    if (descriptor.digest !== recordedDigest) {
        return fail(
            `The archive index.json descriptor digest ${descriptor.digest} does not match the recorded BuildKit digest ${recordedDigest}.`,
        );
    }
    const descriptorPlatform = descriptorValue.platform;
    if (
        isRecord(descriptorPlatform) &&
        (descriptorPlatform.os !== "linux" ||
            descriptorPlatform.architecture !== arch)
    ) {
        return fail(
            `The archive index.json descriptor platform must be linux/${arch}, found ${String(descriptorPlatform.os)}/${String(descriptorPlatform.architecture)}.`,
        );
    }
    const manifestBytes = requireBlob(entries, descriptor, "image manifest");
    // The same content digest over the exact serialized manifest bytes is the
    // decisive check: labels, config, and child layer digests alone are not.
    if (manifestDigest(manifestBytes) !== descriptor.digest) {
        return fail(
            `The archive's actual image manifest content digests to ${manifestDigest(manifestBytes)}, expected the recorded digest ${descriptor.digest}.`,
        );
    }
    const manifest = parseJson(manifestBytes, "the archive image manifest");
    return { descriptor, manifestBytes, manifest };
};

type OciManifestView = {
    readonly configDescriptor: RegistryBlobDescriptor;
    readonly configBytes: Uint8Array;
    readonly layerDescriptors: ReadonlyArray<RegistryBlobDescriptor>;
};

/**
 * Validate the image manifest itself: schema version, media type equality
 * with the index descriptor, exactly the config plus at least one layer, and
 * every referenced config/layer blob present with the exact recorded size and
 * digest. Checking only labels, config, or child layer digests is
 * insufficient without the manifest digest comparison in `inspectIndex`.
 */
const inspectManifestAndConfig = (
    entries: ReadonlyMap<string, ParsedTarEntry>,
    manifest: JsonRecord,
    descriptor: ContainerIndexManifestDescriptor,
): OciManifestView => {
    if (manifest.schemaVersion !== 2) {
        return fail("The archive image manifest must have schemaVersion 2.");
    }
    if (manifest.mediaType !== descriptor.mediaType) {
        return fail(
            `The archive image manifest media type '${String(manifest.mediaType)}' must equal the index descriptor media type '${descriptor.mediaType}'.`,
        );
    }
    const configDescriptor = requireDescriptor(
        manifest.config,
        "the archive image manifest config descriptor",
    );
    if (
        !(CONFIG_MEDIA_TYPES as readonly string[]).includes(
            configDescriptor.mediaType,
        )
    ) {
        return fail(
            `The archive config media type '${configDescriptor.mediaType}' is not a supported image config type.`,
        );
    }
    const layers = manifest.layers;
    if (!Array.isArray(layers) || layers.length === 0) {
        return fail(
            "The archive image manifest must reference at least one layer.",
        );
    }
    const layerDescriptors = layers.map((layer, index) => {
        const layerDescriptor = requireDescriptor(
            layer,
            `the archive image manifest layer ${index + 1}`,
        );
        if (
            !(LAYER_MEDIA_TYPES as readonly string[]).includes(
                layerDescriptor.mediaType,
            )
        ) {
            return fail(
                `The archive layer ${index + 1} media type '${layerDescriptor.mediaType}' is not a supported image layer type.`,
            );
        }
        // Every referenced layer blob must exist with the exact recorded
        // size and content digest, not merely match a path-derived hex name.
        requireBlob(entries, layerDescriptor, `image layer ${index + 1}`);
        return layerDescriptor;
    });
    return {
        configDescriptor,
        configBytes: requireBlob(entries, configDescriptor, "image config"),
        layerDescriptors,
    };
};

/**
 * Validate the image config content: linux on the expected architecture, and
 * the recorded MIT/version/revision OCI labels against the release context.
 */
const assertConfigIdentity = (
    config: JsonRecord,
    arch: ContainerCandidateArch,
    platform: ContainerCandidatePlatform,
    version: string,
    sourceRef: string,
): void => {
    if (config.os !== "linux" || config.architecture !== arch) {
        fail(
            `The archive image config must be linux/${arch}, found ${String(config.os)}/${String(config.architecture)}.`,
        );
    }
    const imageConfig = config.config;
    if (isRecord(imageConfig) && isRecord(imageConfig.Labels)) {
        assertImageLabel(imageConfig.Labels, LABELS.license, "MIT", platform);
        assertImageLabel(imageConfig.Labels, LABELS.version, version, platform);
        assertImageLabel(
            imageConfig.Labels,
            LABELS.revision,
            sourceRef,
            platform,
        );
        return;
    }
    fail(
        `The archive image config for ${platform} must carry a Labels object.`,
    );
};

/** The only directory entries a valid OCI layout tar may record. */
const ALLOWED_ARCHIVE_DIRECTORIES = new Set(["blobs", "blobs/sha256"]);

const assertAllowedDirectoryEntry = (path: string): void => {
    if (!ALLOWED_ARCHIVE_DIRECTORIES.has(path)) {
        return fail(
            `Archive contains an unexpected directory entry '${path}'.`,
        );
    }
};

const assertNoUnexpectedEntries = (
    entries: ReadonlyMap<string, ParsedTarEntry>,
    referencedDigests: ReadonlySet<string>,
): void => {
    for (const [path, entry] of entries) {
        if (entry.kind !== "file") {
            assertAllowedDirectoryEntry(path);
            continue;
        }
        if (path === "index.json" || path === "oci-layout") continue;
        const match = BLOB_FILE_PATTERN.exec(path);
        if (match === null) {
            return fail(`Archive contains an unexpected file '${path}'.`);
        }
        const digest = `sha256:${match[1] as string}`;
        if (!referencedDigests.has(digest)) {
            return fail(`Archive contains an unreferenced blob '${path}'.`);
        }
    }
};

/**
 * The archive may contain nothing beyond `oci-layout`, `index.json`, and
 * exactly the referenced blobs: no unexpected files, no unexpected
 * directories beyond the `blobs/` layout skeleton, and no unreferenced
 * blobs. (Presence of every referenced blob with the exact recorded size
 * and digest is already enforced by `requireBlob` during `inspectIndex` and
 * `inspectManifestAndConfig`.)
 */
const assertExactlyReferencedBlobs = (
    entries: ReadonlyMap<string, ParsedTarEntry>,
    referencedDigests: ReadonlySet<string>,
): void => {
    assertNoUnexpectedEntries(entries, referencedDigests);
};

/**
 * Inspect the OCI archive contents before any promotion: the recorded
 * BuildKit digest must equal the archive's index descriptor digest and the
 * recomputed content digest of the archive's actual image manifest, labels
 * and platform must match the release context, every referenced blob must
 * exist with the exact recorded size and digest, and nothing else may be
 * present.
 */
const inspectOciArchive = ({
    archiveBytes,
    arch,
    platform,
    version,
    sourceRef,
    recordedDigest,
}: {
    readonly archiveBytes: Uint8Array;
    readonly arch: ContainerCandidateArch;
    readonly platform: ContainerCandidatePlatform;
    readonly version: string;
    readonly sourceRef: string;
    readonly recordedDigest: string;
}): ValidatedContainerCandidateImage => {
    const isGzip =
        archiveBytes.length >= 2 &&
        archiveBytes[0] === 0x1f &&
        archiveBytes[1] === 0x8b;
    const entries = parseTarEntries(gunzipOrPlain(archiveBytes, isGzip));
    const { descriptor, manifestBytes, manifest } = inspectIndex(
        entries,
        recordedDigest,
        arch,
    );
    const { configDescriptor, configBytes, layerDescriptors } =
        inspectManifestAndConfig(entries, manifest, descriptor);
    assertConfigIdentity(
        parseJson(configBytes, "the archive image config"),
        arch,
        platform,
        version,
        sourceRef,
    );
    const referencedDigests = new Set([
        descriptor.digest,
        configDescriptor.digest,
        ...layerDescriptors.map((layer) => layer.digest),
    ]);
    assertExactlyReferencedBlobs(entries, referencedDigests);
    return {
        digest: descriptor.digest,
        bytes: manifestBytes,
        mediaType: descriptor.mediaType,
        indexDescriptor: descriptor,
        config: configDescriptor,
        layers: layerDescriptors,
    };
};

const readDirectoryEntries = async (path: string) => {
    try {
        return await readdir(path, { withFileTypes: true });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fail(`Candidate directory '${path}' is unreadable: ${message}`);
    }
};

const readArtifactFile = async (
    path: string,
    name: string,
): Promise<Uint8Array> => {
    try {
        return await readFile(path);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fail(
            `Container candidate file '${name}' is missing or unreadable: ${message}`,
        );
    }
};

const validateCandidate = async ({
    artifactDir,
    version,
    sourceRef,
    arch,
}: {
    readonly artifactDir: string;
    readonly version: string;
    readonly sourceRef: string;
    readonly arch: ContainerCandidateArch;
}): Promise<ValidatedContainerCandidate> => {
    const artifactName = containerCandidateArtifactName(version, arch);
    const contractName = containerCandidateContractName(arch);
    const archiveName = containerCandidateArchiveName(arch);
    const entries = await readDirectoryEntries(artifactDir);
    assertExactNames(
        entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
        [contractName, archiveName],
        `Container candidate artifact '${artifactDir}' files`,
    );
    if (entries.some((entry) => !entry.isFile())) {
        return fail(
            `Container candidate artifact '${artifactDir}' contains a non-file entry.`,
        );
    }

    const contractPath = `${artifactDir}/${contractName}`;
    const archivePath = `${artifactDir}/${archiveName}`;
    const contract = parseContract(
        readUtf8(await readArtifactFile(contractPath, contractName)),
        version,
        sourceRef,
        arch,
    );

    const archiveBytes = await readArtifactFile(archivePath, archiveName);
    const recomputedSha256 = sha256Hex(archiveBytes);
    if (recomputedSha256 !== contract.archive_sha256) {
        return fail(
            `Container candidate archive '${archivePath}' digests to ${recomputedSha256}, expected the recorded ${contract.archive_sha256}.`,
        );
    }

    const image = inspectOciArchive({
        archiveBytes,
        arch,
        platform: contract.platform,
        version,
        sourceRef,
        recordedDigest: contract.digest,
    });
    return {
        arch,
        artifactName,
        platform: contract.platform,
        archivePath,
        archiveSha256: recomputedSha256,
        image,
    };
};

/**
 * Validate the exact staged container-candidate set for the release context
 * and return the validated archive paths, exact image manifest bytes and
 * descriptors, and expected digests for later index assembly.
 *
 * The candidates directory must contain exactly the two immutable artifact
 * directories (amd64 and arm64, names including the validated version), each
 * containing exactly its contract and OCI archive. Nothing is written,
 * downloaded, or pushed; the only output is the returned value.
 */
export const validateContainerCandidates = async ({
    candidatesDir,
    version,
    sourceRef,
}: ContainerCandidateValidationOptions): Promise<ValidatedContainerCandidates> => {
    assertReleaseContext(version, sourceRef);
    const entries = await readDirectoryEntries(candidatesDir);
    assertExactNames(
        entries.map((entry) => entry.name),
        CONTAINER_CANDIDATE_ARCHS.map((arch) =>
            containerCandidateArtifactName(version, arch),
        ),
        `Container candidate artifacts in '${candidatesDir}'`,
    );
    if (entries.some((entry) => !entry.isDirectory())) {
        return fail(
            `Candidate directory '${candidatesDir}' contains a non-artifact entry.`,
        );
    }

    const byPlatform = {} as Record<
        ContainerCandidateArch,
        ValidatedContainerCandidate
    >;
    for (const arch of CONTAINER_CANDIDATE_ARCHS) {
        byPlatform[arch] = await validateCandidate({
            artifactDir: `${candidatesDir}/${containerCandidateArtifactName(version, arch)}`,
            version,
            sourceRef,
            arch,
        });
    }
    return { version, sourceRef, byPlatform };
};