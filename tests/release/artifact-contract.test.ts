import { describe, expect, test } from "bun:test";

import {
    canonicalReleaseArtifactManifest,
    computeReleaseArtifactBundleId,
    createReleaseArtifactManifest,
    DETERMINISTIC_ARCHIVE_RULES,
    releaseArtifactManifestSchema,
    releasePayloadsForVersion,
    validateReleaseArtifactManifest,
} from "../../src/release/artifact-contract.ts";

const version = "1.2.3";
const sourceRevision = "0123456789abcdef0123456789abcdef01234567";

const unsignedManifest = () => ({
    schema: "ralphie.release-artifact-manifest.v1" as const,
    version,
    sourceRevision,
    payloads: releasePayloadsForVersion(version).map((payload, index) =>
        payload.type === "oci-index"
            ? { ...payload, digest: `sha256:${String(index).repeat(64)}` }
            : { ...payload, sha256: String(index + 1).repeat(64) },
    ),
});

const validManifest = () => createReleaseArtifactManifest(unsignedManifest());

describe("release artifact contract", () => {
    test("creates the canonical ordered payload set and content address", () => {
        const manifest = validManifest();

        expect(manifest.payloads.map((payload) => payload.path)).toEqual([
            "beremaran-ralphie-1.2.3.tgz",
            "scripts/install.sh",
            "ralphie-darwin-arm64",
            "ralphie-darwin-x64",
            "ralphie-linux-arm64",
            "ralphie-linux-x64",
            "Formula/ralphie.rb",
            "ralphie-container-amd64.oci.tar",
            "ralphie-container-arm64.oci.tar",
            "oci/index",
        ]);
        expect(manifest.bundleId).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(manifest.bundleId).toBe(
            computeReleaseArtifactBundleId(unsignedManifest()),
        );
        expect(canonicalReleaseArtifactManifest(manifest)).not.toContain(
            "bundleId",
        );
        expect(validateReleaseArtifactManifest(manifest)).toEqual(manifest);
    });

    test("fixes the exact tar representation and gzip encoding", () => {
        expect(DETERMINISTIC_ARCHIVE_RULES.tar).toMatchObject({
            dialect: "POSIX.1-1988-ustar",
            blockSize: 512,
            recordSize: 512,
            entryOrder: "lexicographic-by-UTF-8-bytes",
            path: {
                encoding: "UTF-8",
                normalization: "none",
                maximumEncodedBytes: 99,
                prefixField: "zero-filled",
            },
            entryTypes: {
                regularFile: { typeFlag: "0", mode: 0o644 },
                directories: "implicit-only",
                symbolicLinks: "rejected",
                hardLinks: "rejected",
                devices: "rejected",
                paxHeaders: "rejected",
                gnuExtensions: "rejected",
            },
            header: {
                byteLength: 512,
                initialization: "zero-filled",
                numericFields: {
                    encoding: "ASCII-octal",
                    padding: "leading-zero",
                    sign: "unsigned-only",
                    overflow: "rejected",
                    base256: "rejected",
                    checksum: {
                        input: "512-byte-header-with-eight-space-checksum-field",
                        calculation: "unsigned-byte-sum",
                        overflow: "rejected",
                    },
                },
            },
            fileData: {
                bytes: "exact-input-bytes",
                padding: "zero-filled-to-next-512-byte-boundary",
                paddingLength:
                    "0-when-aligned-otherwise-512-minus-size-mod-512",
            },
            end: {
                terminator: "exactly-two-zero-filled-512-byte-blocks",
                trailingPadding: "none",
            },
        });
        expect(
            DETERMINISTIC_ARCHIVE_RULES.tar.header.fieldLayout.map(
                ({ field, offset, length }) => ({ field, offset, length }),
            ),
        ).toEqual([
            { field: "name", offset: 0, length: 100 },
            { field: "mode", offset: 100, length: 8 },
            { field: "uid", offset: 108, length: 8 },
            { field: "gid", offset: 116, length: 8 },
            { field: "size", offset: 124, length: 12 },
            { field: "mtime", offset: 136, length: 12 },
            { field: "checksum", offset: 148, length: 8 },
            { field: "typeflag", offset: 156, length: 1 },
            { field: "linkname", offset: 157, length: 100 },
            { field: "magic", offset: 257, length: 6 },
            { field: "version", offset: 263, length: 2 },
            { field: "uname", offset: 265, length: 32 },
            { field: "gname", offset: 297, length: 32 },
            { field: "devmajor", offset: 329, length: 8 },
            { field: "devminor", offset: 337, length: 8 },
            { field: "prefix", offset: 345, length: 155 },
            { field: "reserved", offset: 500, length: 12 },
        ]);
        expect(DETERMINISTIC_ARCHIVE_RULES.gzip).toEqual({
            container: "RFC-1952",
            memberCount: 1,
            header: {
                identifier: [0x1f, 0x8b],
                compressionMethod: 8,
                flags: 0,
                modificationTime: 0,
                extraFlags: 0,
                operatingSystem: 255,
                optionalFields: "omitted",
            },
            deflate: {
                format: "RFC-1951",
                blockType: "stored",
                maximumBlockPayloadBytes: 65535,
                partition: "greedy-consecutive-chunks",
                fullFinalChunk: "final-without-extra-empty-block",
                emptyInput: "one-empty-final-block",
                bitOrder: "least-significant-bit-first",
                storedBlockLength: "little-endian-uint16",
                storedBlockComplement:
                    "little-endian-bitwise-complement-uint16",
                paddingBits: "zero-to-byte-boundary",
                finalBlock: "last-block-only",
            },
            trailer: {
                crc32: {
                    algorithm: "CRC-32/ISO-HDLC",
                    polynomial: "0xedb88320-reflected",
                    initial: 0xffffffff,
                    finalXor: 0xffffffff,
                    input: "uncompressed-tar-bytes",
                    byteOrder: "little-endian",
                },
                inputSize: "uncompressed-tar-length-modulo-2^32",
                inputSizeByteOrder: "little-endian",
            },
        });
    });

    test("rejects bad context and content addresses", () => {
        const manifest = validManifest();
        for (const [field, value] of [
            ["version", "v1.2.3"],
            ["version", "1.2.3-rc.1"],
            ["sourceRevision", sourceRevision.toUpperCase()],
            ["sourceRevision", "0".repeat(39)],
        ] as const) {
            expect(() =>
                createReleaseArtifactManifest({
                    ...unsignedManifest(),
                    [field]: value,
                }),
            ).toThrow("Invalid release artifact manifest");
        }
        expect(() =>
            validateReleaseArtifactManifest({
                ...manifest,
                bundleId: "sha256:" + "0".repeat(64),
            }),
        ).toThrow("bundleId");
    });

    test("rejects trailing line terminators in canonical metadata", () => {
        for (const terminator of ["\n", "\r", "\r\n", "\u2028", "\u2029"]) {
            expect(() =>
                createReleaseArtifactManifest({
                    ...unsignedManifest(),
                    version: `${version}${terminator}`,
                }),
            ).toThrow("Invalid release artifact manifest");
            expect(() =>
                createReleaseArtifactManifest({
                    ...unsignedManifest(),
                    sourceRevision: `${sourceRevision}${terminator}`,
                }),
            ).toThrow("Invalid release artifact manifest");

            const fileHashPayloads = unsignedManifest().payloads.map(
                (payload, index) =>
                    index === 0 && payload.type !== "oci-index"
                        ? {
                              ...payload,
                              sha256: `${payload.sha256}${terminator}`,
                          }
                        : payload,
            );
            expect(() =>
                createReleaseArtifactManifest({
                    ...unsignedManifest(),
                    payloads: fileHashPayloads as never,
                }),
            ).toThrow("64 lowercase");

            const indexDigestPayloads = unsignedManifest().payloads.map(
                (payload) =>
                    payload.type === "oci-index"
                        ? {
                              ...payload,
                              digest: `${payload.digest}${terminator}`,
                          }
                        : payload,
            );
            expect(() =>
                createReleaseArtifactManifest({
                    ...unsignedManifest(),
                    payloads: indexDigestPayloads as never,
                }),
            ).toThrow("64 lowercase");
        }
    });

    test("rejects missing, duplicate, unexpected, malformed, and reordered payloads", () => {
        const manifest = validManifest();
        const payloads = [...manifest.payloads];
        payloads.pop();
        expect(() =>
            createReleaseArtifactManifest({
                ...unsignedManifest(),
                payloads,
            }),
        ).toThrow("exactly 10");

        const duplicate = [...manifest.payloads];
        duplicate[1] = duplicate[0] as (typeof duplicate)[number];
        expect(() =>
            createReleaseArtifactManifest({
                ...unsignedManifest(),
                payloads: duplicate,
            }),
        ).toThrow("duplicated");

        const reordered = [...unsignedManifest().payloads].reverse();
        expect(() =>
            createReleaseArtifactManifest({
                ...unsignedManifest(),
                payloads: reordered,
            }),
        ).toThrow("must be npm-tarball");

        const malformed = unsignedManifest().payloads.map((payload) =>
            payload.type === "oci-index"
                ? { ...payload, digest: "sha256:" + "A".repeat(64) }
                : { ...payload, sha256: "0".repeat(63) },
        );
        expect(() =>
            createReleaseArtifactManifest({
                ...unsignedManifest(),
                payloads: malformed as never,
            }),
        ).toThrow("64 lowercase");

        const unexpected = [...unsignedManifest().payloads];
        unexpected[0] = {
            ...unexpected[0]!,
            path: "unexpected.tgz",
        } as never;
        expect(() =>
            createReleaseArtifactManifest({
                ...unsignedManifest(),
                payloads: unexpected,
            }),
        ).toThrow("must be npm-tarball");
    });

    test("rejects metadata whose key order or shape is not canonical", () => {
        const manifest = validManifest();
        const reordered = JSON.parse(JSON.stringify(manifest)) as Record<
            string,
            unknown
        >;
        const entries = Object.entries(reordered);
        reordered.payloads = entries.find(([key]) => key === "payloads")?.[1];
        delete reordered.payloads;
        reordered.payloads = manifest.payloads;
        expect(() => validateReleaseArtifactManifest(reordered)).toThrow(
            "canonical key order",
        );

        const firstPayload = manifest.payloads[0]!;
        const reorderedPayload = {
            path: firstPayload.path,
            type: firstPayload.type,
            sha256: "sha256" in firstPayload ? firstPayload.sha256 : "",
            platform: firstPayload.platform,
        };
        const reorderedPayloadManifest = {
            ...manifest,
            payloads: [reorderedPayload, ...manifest.payloads.slice(1)],
        };
        expect(() =>
            validateReleaseArtifactManifest(reorderedPayloadManifest),
        ).toThrow("canonical key order");
        expect(
            releaseArtifactManifestSchema.safeParse(reorderedPayloadManifest)
                .success,
        ).toBe(false);

        expect(() =>
            validateReleaseArtifactManifest({
                ...manifest,
                generatedAt: "now",
            }),
        ).toThrow();
    });
});