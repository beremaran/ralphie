import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import {
    containerCandidateArchiveName,
    containerCandidateArtifactName,
    containerCandidateContractName,
    containerCandidatePlatform,
} from "../../src/release/container-candidate.ts";

/**
 * Deterministic in-memory builders for the `stage-container` artifacts
 * (`ralphie-container-candidate-<version>-<arch>`): a real POSIX ustar tar
 * (optionally gzipped) carrying an OCI layout (`oci-layout`, `index.json`,
 * and the manifest/config/layer blobs), plus the
 * `ralphie.container-candidate.v1` contract JSON. The fixture mirrors what
 * `docker/build-push-action` with `type=oci,dest=...oci.tar` produces, so the
 * validator is driven against faithful byte-level inputs.
 */

export const OCI_IMAGE_MANIFEST_MEDIA_TYPE =
    "application/vnd.oci.image.manifest.v1+json" as const;
export const OCI_CONFIG_MEDIA_TYPE =
    "application/vnd.oci.image.config.v1+json" as const;
export const OCI_LAYER_MEDIA_TYPE =
    "application/vnd.oci.image.layer.v1.tar+gzip" as const;

export type OciArchiveContent = {
    readonly manifest: Uint8Array;
    readonly manifestDigest: string;
    readonly config: Uint8Array;
    readonly configDigest: string;
    readonly layer: Uint8Array;
    readonly layerDigest: string;
};

export const sha256Hex = (bytes: Uint8Array): string =>
    createHash("sha256").update(bytes).digest("hex");

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

export const buildOciArchiveContent = ({
    arch,
    version,
    sourceRef,
    layerMediaType = OCI_LAYER_MEDIA_TYPE,
    manifestMediaType = OCI_IMAGE_MANIFEST_MEDIA_TYPE,
    extraLabels = {},
    configOverrides = {},
}: {
    readonly arch: "amd64" | "arm64";
    readonly version: string;
    readonly sourceRef: string;
    readonly layerMediaType?: string;
    readonly manifestMediaType?: string;
    readonly extraLabels?: Readonly<Record<string, string>>;
    readonly configOverrides?: Readonly<{
        readonly architecture?: string;
        readonly os?: string;
    }>;
}): OciArchiveContent => {
    const configBytes = encode(
        JSON.stringify({
            architecture: configOverrides.architecture ?? arch,
            os: configOverrides.os ?? "linux",
            config: {
                Labels: {
                    "org.opencontainers.image.licenses": "MIT",
                    "org.opencontainers.image.version": version,
                    "org.opencontainers.image.revision": sourceRef,
                    ...extraLabels,
                },
            },
        }),
    );
    const layerBytes = encode(`ralphie-container-fixture-layer-${arch}`);
    const configDigest = `sha256:${sha256Hex(configBytes)}`;
    const layerDigest = `sha256:${sha256Hex(layerBytes)}`;
    const manifestBytes = encode(
        JSON.stringify({
            schemaVersion: 2,
            mediaType: manifestMediaType,
            config: {
                mediaType: OCI_CONFIG_MEDIA_TYPE,
                size: configBytes.byteLength,
                digest: configDigest,
            },
            layers: [
                {
                    mediaType: layerMediaType,
                    size: layerBytes.byteLength,
                    digest: layerDigest,
                },
            ],
        }),
    );
    const manifestDigest = `sha256:${sha256Hex(manifestBytes)}`;
    return {
        manifest: manifestBytes,
        manifestDigest,
        config: configBytes,
        configDigest,
        layer: layerBytes,
        layerDigest,
    };
};

/** The exact file set of a valid single-platform OCI layout tar. */
export const validOciLayoutFiles = (
    content: OciArchiveContent,
    arch: "amd64" | "arm64",
): ReadonlyArray<{ readonly name: string; readonly bytes: Uint8Array }> => [
    {
        name: "oci-layout",
        bytes: encode(JSON.stringify({ imageLayoutVersion: "1.0.0" })),
    },
    {
        name: "index.json",
        bytes: encode(
            JSON.stringify({
                schemaVersion: 2,
                manifests: [
                    {
                        mediaType: OCI_IMAGE_MANIFEST_MEDIA_TYPE,
                        size: content.manifest.byteLength,
                        digest: content.manifestDigest,
                        platform: { architecture: arch, os: "linux" },
                    },
                ],
            }),
        ),
    },
    {
        name: `blobs/sha256/${content.manifestDigest.slice("sha256:".length)}`,
        bytes: content.manifest,
    },
    {
        name: `blobs/sha256/${content.configDigest.slice("sha256:".length)}`,
        bytes: content.config,
    },
    {
        name: `blobs/sha256/${content.layerDigest.slice("sha256:".length)}`,
        bytes: content.layer,
    },
];

const TAR_BLOCK_SIZE = 512;

const concatenate = (blocks: ReadonlyArray<Uint8Array>): Uint8Array => {
    const total = blocks.reduce((sum, block) => sum + block.byteLength, 0);
    const output = new Uint8Array(total);
    let offset = 0;
    for (const block of blocks) {
        output.set(block, offset);
        offset += block.byteLength;
    }
    return output;
};

const tarHeader = (
    name: string,
    size: number,
    typeflag: number = 0x30,
): Uint8Array => {
    const block = new Uint8Array(TAR_BLOCK_SIZE);
    block.set(encode(name), 0);
    block.set(encode("0000644\0"), 100);
    block.set(encode("0000000\0"), 108);
    block.set(encode("0000000\0"), 116);
    block.set(encode(`${size.toString(8).padStart(11, "0")}\0`), 124);
    block.set(encode("00000000000\0"), 136);
    for (let index = 148; index < 156; index += 1) block[index] = 0x20;
    block[156] = typeflag;
    block.set(encode("ustar\0"), 257);
    block.set(encode("00"), 263);
    block.set(encode("0000000\0"), 329);
    block.set(encode("0000000\0"), 337);
    const checksum = block.reduce((sum, byte) => sum + byte, 0);
    block.set(encode(`${checksum.toString(8).padStart(6, "0")}\0 `), 148);
    return block;
};

/**
 * Serialize entries into a POSIX ustar stream (regular files in lexicographic
 * order plus optional directory entries, two zero-block terminator) and
 * optionally gzip it. Production stages a plain `.oci.tar`; gzip is provided
 * to prove the validator accepts the compressed form too. Directory entries
 * may carry the conventional trailing slash, as real tar writers emit.
 */
export const formatOciArchiveBytes = (
    files: ReadonlyArray<{ readonly name: string; readonly bytes: Uint8Array }>,
    options?: {
        readonly gzip?: boolean;
        readonly directories?: ReadonlyArray<string>;
    },
): Uint8Array => {
    const sorted = [...files].sort((left, right) =>
        left.name.localeCompare(right.name),
    );
    const blocks: Uint8Array[] = [];
    for (const directory of options?.directories ?? []) {
        blocks.push(tarHeader(directory, 0, 0x35));
    }
    for (const file of sorted) {
        blocks.push(tarHeader(file.name, file.bytes.byteLength));
        blocks.push(file.bytes);
        const padding =
            (TAR_BLOCK_SIZE - (file.bytes.byteLength % TAR_BLOCK_SIZE)) %
            TAR_BLOCK_SIZE;
        if (padding > 0) blocks.push(new Uint8Array(padding));
    }
    blocks.push(new Uint8Array(TAR_BLOCK_SIZE * 2));
    const tar = concatenate(blocks);
    return options?.gzip === true ? gzipSync(tar) : tar;
};

export type CandidateContractInput = {
    readonly arch: "amd64" | "arm64";
    readonly version: string;
    readonly sourceRef: string;
    readonly digest: string;
    readonly archiveSha256: string;
    readonly overrides?: Readonly<Record<string, unknown>>;
};

/** Serialize a `ralphie.container-candidate.v1` contract in canonical order. */
export const buildCandidateContract = (
    input: CandidateContractInput,
): Uint8Array => {
    const fields = {
        schema: "ralphie.container-candidate.v1",
        artifact: containerCandidateArtifactName(input.version, input.arch),
        version: input.version,
        source_ref: input.sourceRef,
        platform: containerCandidatePlatform(input.arch),
        digest: input.digest,
        format: "oci-archive",
        archive: containerCandidateArchiveName(input.arch),
        archive_sha256: input.archiveSha256,
        image_license: "MIT",
        image_version: input.version,
        image_revision: input.sourceRef,
        ...input.overrides,
    };
    return encode(`${JSON.stringify(fields)}\n`);
};

export const artifactFileNames = (
    arch: "amd64" | "arm64",
): { readonly archive: string; readonly contract: string } => ({
    archive: containerCandidateArchiveName(arch),
    contract: containerCandidateContractName(arch),
});

export { containerCandidateArtifactName, containerCandidateContractName };