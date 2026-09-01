import { createHash } from "node:crypto";
import { z } from "zod";

/** The version of the release artifact contract. */
export const RELEASE_ARTIFACT_MANIFEST_SCHEMA =
    "ralphie.release-artifact-manifest.v1" as const;

export const RELEASE_ARTIFACT_TYPES = [
    "npm-tarball",
    "installer",
    "standalone-binary",
    "homebrew-formula",
    "oci-image-input",
    "oci-index",
] as const;

export type ReleaseArtifactType = (typeof RELEASE_ARTIFACT_TYPES)[number];

export const RELEASE_ARTIFACT_PLATFORMS = [
    "universal",
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "linux/amd64",
    "linux/arm64",
    "linux",
] as const;

export type ReleaseArtifactPlatform =
    (typeof RELEASE_ARTIFACT_PLATFORMS)[number];

export type ReleaseArtifactFilePayload = {
    readonly path: string;
    readonly type: Exclude<ReleaseArtifactType, "oci-index">;
    readonly platform: Exclude<ReleaseArtifactPlatform, "linux">;
    readonly sha256: string;
};

export type ReleaseArtifactIndexPayload = {
    readonly path: "oci/index";
    readonly type: "oci-index";
    readonly platform: "linux";
    readonly digest: string;
};

export type ReleaseArtifactPayload =
    | ReleaseArtifactFilePayload
    | ReleaseArtifactIndexPayload;

export type ReleaseArtifactManifest = {
    readonly schema: typeof RELEASE_ARTIFACT_MANIFEST_SCHEMA;
    readonly version: string;
    readonly sourceRevision: string;
    readonly payloads: ReadonlyArray<ReleaseArtifactPayload>;
    readonly bundleId: string;
};

export type ReleaseArtifactManifestUnsigned = Omit<
    ReleaseArtifactManifest,
    "bundleId"
>;

/**
 * Archive inputs must be made using this exact byte-level representation.
 *
 * The tar stream is a POSIX ustar stream with one 512-byte header per regular
 * file, raw file bytes, zero padding to the next 512-byte boundary, and
 * exactly two zero blocks at the end. Extension records and other tar entry
 * types are not allowed. The gzip member uses RFC 1951 stored blocks instead
 * of a compressor: split the tar bytes into greedy consecutive chunks of at
 * most 65,535 bytes, emit a stored block for each chunk, set BFINAL only on
 * the last block, zero-align each block, and encode LEN/NLEN as little-endian
 * uint16 values. This leaves no compressor implementation choice that can
 * produce a different deflate bitstream while still conforming to the
 * contract.
 */
export const DETERMINISTIC_ARCHIVE_RULES = Object.freeze({
    format: "tar" as const,
    compression: "gzip" as const,
    tar: Object.freeze({
        dialect: "POSIX.1-1988-ustar" as const,
        blockSize: 512,
        recordSize: 512,
        entryOrder: "lexicographic-by-UTF-8-bytes" as const,
        path: Object.freeze({
            encoding: "UTF-8" as const,
            normalization: "none" as const,
            separators: "forward-slash" as const,
            maximumEncodedBytes: 99,
            prefixField: "zero-filled" as const,
            dotSegments: "rejected" as const,
            nulBytes: "rejected" as const,
            backslashes: "rejected" as const,
            trailingSlash: "rejected" as const,
        }),
        entryTypes: Object.freeze({
            regularFile: Object.freeze({
                typeFlag: "0" as const,
                mode: 0o644,
            }),
            directories: "implicit-only" as const,
            symbolicLinks: "rejected" as const,
            hardLinks: "rejected" as const,
            devices: "rejected" as const,
            paxHeaders: "rejected" as const,
            gnuExtensions: "rejected" as const,
        }),
        header: Object.freeze({
            byteLength: 512,
            initialization: "zero-filled" as const,
            fieldLayout: Object.freeze([
                {
                    field: "name",
                    offset: 0,
                    length: 100,
                    encoding: "UTF-8-NUL-padded" as const,
                },
                {
                    field: "mode",
                    offset: 100,
                    length: 8,
                    encoding: "ASCII-octal-7-digits-NUL" as const,
                },
                {
                    field: "uid",
                    offset: 108,
                    length: 8,
                    encoding: "ASCII-octal-7-digits-NUL" as const,
                },
                {
                    field: "gid",
                    offset: 116,
                    length: 8,
                    encoding: "ASCII-octal-7-digits-NUL" as const,
                },
                {
                    field: "size",
                    offset: 124,
                    length: 12,
                    encoding: "ASCII-octal-11-digits-NUL" as const,
                },
                {
                    field: "mtime",
                    offset: 136,
                    length: 12,
                    encoding: "ASCII-octal-11-digits-NUL" as const,
                },
                {
                    field: "checksum",
                    offset: 148,
                    length: 8,
                    encoding: "ASCII-octal-6-digits-NUL-space" as const,
                },
                {
                    field: "typeflag",
                    offset: 156,
                    length: 1,
                    encoding: "ASCII-literal-0" as const,
                },
                {
                    field: "linkname",
                    offset: 157,
                    length: 100,
                    encoding: "zero-filled" as const,
                },
                {
                    field: "magic",
                    offset: 257,
                    length: 6,
                    encoding: "ASCII-literal-ustar-NUL" as const,
                },
                {
                    field: "version",
                    offset: 263,
                    length: 2,
                    encoding: "ASCII-literal-00" as const,
                },
                {
                    field: "uname",
                    offset: 265,
                    length: 32,
                    encoding: "zero-filled" as const,
                },
                {
                    field: "gname",
                    offset: 297,
                    length: 32,
                    encoding: "zero-filled" as const,
                },
                {
                    field: "devmajor",
                    offset: 329,
                    length: 8,
                    encoding: "ASCII-octal-7-digits-NUL" as const,
                },
                {
                    field: "devminor",
                    offset: 337,
                    length: 8,
                    encoding: "ASCII-octal-7-digits-NUL" as const,
                },
                {
                    field: "prefix",
                    offset: 345,
                    length: 155,
                    encoding: "zero-filled" as const,
                },
                {
                    field: "reserved",
                    offset: 500,
                    length: 12,
                    encoding: "zero-filled" as const,
                },
            ] as const),
            numericFields: Object.freeze({
                encoding: "ASCII-octal" as const,
                padding: "leading-zero" as const,
                sign: "unsigned-only" as const,
                overflow: "rejected" as const,
                base256: "rejected" as const,
                checksum: Object.freeze({
                    input: "512-byte-header-with-eight-space-checksum-field" as const,
                    calculation: "unsigned-byte-sum" as const,
                    overflow: "rejected" as const,
                }),
            }),
            fixedMetadata: Object.freeze({
                uid: 0,
                gid: 0,
                modificationTime: 0,
                userName: "empty" as const,
                groupName: "empty" as const,
                linkName: "empty" as const,
                deviceMajor: 0,
                deviceMinor: 0,
            }),
        }),
        fileData: Object.freeze({
            bytes: "exact-input-bytes" as const,
            padding: "zero-filled-to-next-512-byte-boundary" as const,
            paddingLength:
                "0-when-aligned-otherwise-512-minus-size-mod-512" as const,
        }),
        end: Object.freeze({
            terminator: "exactly-two-zero-filled-512-byte-blocks" as const,
            trailingPadding: "none" as const,
        }),
    }),
    gzip: Object.freeze({
        container: "RFC-1952" as const,
        memberCount: 1,
        header: Object.freeze({
            identifier: [0x1f, 0x8b] as const,
            compressionMethod: 8,
            flags: 0,
            modificationTime: 0,
            extraFlags: 0,
            operatingSystem: 255,
            optionalFields: "omitted" as const,
        }),
        deflate: Object.freeze({
            format: "RFC-1951" as const,
            blockType: "stored" as const,
            maximumBlockPayloadBytes: 65535,
            partition: "greedy-consecutive-chunks" as const,
            fullFinalChunk: "final-without-extra-empty-block" as const,
            emptyInput: "one-empty-final-block" as const,
            bitOrder: "least-significant-bit-first" as const,
            storedBlockLength: "little-endian-uint16" as const,
            storedBlockComplement:
                "little-endian-bitwise-complement-uint16" as const,
            paddingBits: "zero-to-byte-boundary" as const,
            finalBlock: "last-block-only" as const,
        }),
        trailer: Object.freeze({
            crc32: Object.freeze({
                algorithm: "CRC-32/ISO-HDLC" as const,
                polynomial: "0xedb88320-reflected" as const,
                initial: 0xffffffff,
                finalXor: 0xffffffff,
                input: "uncompressed-tar-bytes" as const,
                byteOrder: "little-endian" as const,
            }),
            inputSize: "uncompressed-tar-length-modulo-2^32" as const,
            inputSizeByteOrder: "little-endian" as const,
        }),
    }),
});

export type DeterministicArchiveRules = typeof DETERMINISTIC_ARCHIVE_RULES;

/** Stable name used by release staging implementations. */
export const RELEASE_ARCHIVE_RULES = DETERMINISTIC_ARCHIVE_RULES;

const VERSION_PATTERN =
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$(?![\s\S])/;
const REVISION_PATTERN = /^[0-9a-f]{40}$(?![\s\S])/;
const SHA256_PATTERN = /^[0-9a-f]{64}$(?![\s\S])/;
const OCI_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$(?![\s\S])/;
const PATH_PATTERN =
    /^(?!\/)(?!.*(?:^|\/)\.\.?$)(?!.*\\)(?!.*(?:^|\/)(?:\.\.?)(?:\/|$)).+$/;

const filePayloadSchema = z
    .object({
        path: z.string(),
        type: z.enum([
            "npm-tarball",
            "installer",
            "standalone-binary",
            "homebrew-formula",
            "oci-image-input",
        ]),
        platform: z.enum([
            "universal",
            "darwin-arm64",
            "darwin-x64",
            "linux-arm64",
            "linux-x64",
            "linux/amd64",
            "linux/arm64",
        ]),
        sha256: z.string(),
    })
    .strict();

const indexPayloadSchema = z
    .object({
        path: z.literal("oci/index"),
        type: z.literal("oci-index"),
        platform: z.literal("linux"),
        digest: z.string(),
    })
    .strict();

const payloadSchema = z.union([filePayloadSchema, indexPayloadSchema]);

const unsignedManifestSchema = z
    .object({
        schema: z.literal(RELEASE_ARTIFACT_MANIFEST_SCHEMA),
        version: z.string(),
        sourceRevision: z.string(),
        payloads: z.array(payloadSchema).readonly(),
    })
    .strict();

const manifestSchema = unsignedManifestSchema
    .extend({ bundleId: z.string() })
    .strict();

const expectedPayloads = (
    version: string,
): ReadonlyArray<
    | Omit<ReleaseArtifactFilePayload, "sha256">
    | Omit<ReleaseArtifactIndexPayload, "digest">
> => [
    {
        path: `beremaran-ralphie-${version}.tgz`,
        type: "npm-tarball",
        platform: "universal",
    },
    {
        path: "scripts/install.sh",
        type: "installer",
        platform: "universal",
    },
    {
        path: "ralphie-darwin-arm64",
        type: "standalone-binary",
        platform: "darwin-arm64",
    },
    {
        path: "ralphie-darwin-x64",
        type: "standalone-binary",
        platform: "darwin-x64",
    },
    {
        path: "ralphie-linux-arm64",
        type: "standalone-binary",
        platform: "linux-arm64",
    },
    {
        path: "ralphie-linux-x64",
        type: "standalone-binary",
        platform: "linux-x64",
    },
    {
        path: "Formula/ralphie.rb",
        type: "homebrew-formula",
        platform: "universal",
    },
    {
        path: "ralphie-container-amd64.oci.tar",
        type: "oci-image-input",
        platform: "linux/amd64",
    },
    {
        path: "ralphie-container-arm64.oci.tar",
        type: "oci-image-input",
        platform: "linux/arm64",
    },
    { path: "oci/index", type: "oci-index", platform: "linux" },
];

/** Return the exact, ordered payload names required for a release version. */
export const releasePayloadsForVersion = (
    version: string,
): ReadonlyArray<
    | Omit<ReleaseArtifactFilePayload, "sha256">
    | Omit<ReleaseArtifactIndexPayload, "digest">
> => expectedPayloads(version);

export const RELEASE_PAYLOAD_PATHS = Object.freeze({
    npmTarball: (version: string): string => `beremaran-ralphie-${version}.tgz`,
    installer: "scripts/install.sh",
    darwinArm64: "ralphie-darwin-arm64",
    darwinX64: "ralphie-darwin-x64",
    linuxArm64: "ralphie-linux-arm64",
    linuxX64: "ralphie-linux-x64",
    homebrewFormula: "Formula/ralphie.rb",
    ociAmd64: "ralphie-container-amd64.oci.tar",
    ociArm64: "ralphie-container-arm64.oci.tar",
    ociIndex: "oci/index",
});

function assert(condition: boolean, message: string): asserts condition {
    if (!condition)
        throw new Error(`Invalid release artifact manifest: ${message}`);
}

const exactKeys = (
    value: Record<string, unknown>,
    keys: ReadonlyArray<string>,
    label: string,
): void => {
    const actual = Object.keys(value);
    assert(
        actual.length === keys.length &&
            actual.every((key, index) => key === keys[index]),
        `${label} metadata must use the canonical key order (${keys.join(", ")}).`,
    );
};

const assertVersion = (version: string): void => {
    assert(
        VERSION_PATTERN.test(version),
        `version '${version}' must be canonical <major>.<minor>.<patch> without a leading v, prerelease, or build suffix.`,
    );
};

const assertPayloadPath = (path: string): void => {
    assert(
        path.length > 0 && PATH_PATTERN.test(path),
        `payload path '${path}' is not a safe relative path.`,
    );
};

const assertCanonicalPayload = (
    payload: ReleaseArtifactPayload,
    expected: ReturnType<typeof expectedPayloads>[number],
    index: number,
): void => {
    const payloadRecord = payload as unknown as Record<string, unknown>;
    const expectedKeys =
        payload.type === "oci-index"
            ? ["path", "type", "platform", "digest"]
            : ["path", "type", "platform", "sha256"];
    exactKeys(payloadRecord, expectedKeys, `payload ${index + 1}`);
    assert(
        payload.path === expected.path &&
            payload.type === expected.type &&
            payload.platform === expected.platform,
        `payload ${index + 1} must be ${expected.type} '${expected.path}' for platform '${expected.platform}'.`,
    );

    if (payload.type === "oci-index") {
        assert(
            OCI_DIGEST_PATTERN.test(payload.digest) &&
                !/^sha256:0+$/.test(payload.digest),
            `OCI index digest '${payload.digest}' must match sha256:<64 lowercase hexadecimal characters> and must not be a placeholder.`,
        );
        return;
    }
    assertPayloadPath(payload.path);
    assert(
        SHA256_PATTERN.test(payload.sha256) && !/^0+$/.test(payload.sha256),
        `SHA-256 for '${payload.path}' must be 64 lowercase hexadecimal characters and must not be a placeholder.`,
    );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const assertManifestMetadataOrder = (value: unknown, signed: boolean): void => {
    assert(isRecord(value), "manifest must be an object.");
    exactKeys(
        value,
        signed
            ? ["schema", "version", "sourceRevision", "payloads", "bundleId"]
            : ["schema", "version", "sourceRevision", "payloads"],
        "manifest",
    );
    if (!Array.isArray(value.payloads)) return;
    value.payloads.forEach((payload, index) => {
        if (!isRecord(payload)) return;
        const keys =
            payload.type === "oci-index"
                ? ["path", "type", "platform", "digest"]
                : ["path", "type", "platform", "sha256"];
        exactKeys(payload, keys, `payload ${index + 1}`);
    });
};

const unsignedManifestFrom = (
    manifest: ReleaseArtifactManifestUnsigned,
): ReleaseArtifactManifestUnsigned => ({
    schema: manifest.schema,
    version: manifest.version,
    sourceRevision: manifest.sourceRevision,
    payloads: manifest.payloads.map((payload) =>
        payload.type === "oci-index"
            ? {
                  path: payload.path,
                  type: payload.type,
                  platform: payload.platform,
                  digest: payload.digest,
              }
            : {
                  path: payload.path,
                  type: payload.type,
                  platform: payload.platform,
                  sha256: payload.sha256,
              },
    ),
});

/**
 * Serialize only the signed contract fields. The bundle identifier is
 * intentionally excluded, preventing a hash cycle while retaining content
 * addressing through every file digest and the OCI index digest.
 */
export const canonicalReleaseArtifactManifest = (
    manifest: ReleaseArtifactManifestUnsigned,
): string => JSON.stringify(unsignedManifestFrom(manifest));

export const computeReleaseArtifactBundleId = (
    manifest: ReleaseArtifactManifestUnsigned,
): string =>
    `sha256:${createHash("sha256")
        .update(canonicalReleaseArtifactManifest(manifest), "utf8")
        .digest("hex")}`;

/** Short alias for callers that only need the content address. */
export const contentAddressedBundleId = computeReleaseArtifactBundleId;

const validateUnsigned = (value: unknown): ReleaseArtifactManifestUnsigned => {
    assertManifestMetadataOrder(value, false);
    const parsed = unsignedManifestSchema.parse(
        value,
    ) as ReleaseArtifactManifestUnsigned;
    const record = parsed as unknown as Record<string, unknown>;
    exactKeys(
        record,
        ["schema", "version", "sourceRevision", "payloads"],
        "manifest",
    );
    assertVersion(parsed.version);
    assert(
        REVISION_PATTERN.test(parsed.sourceRevision),
        `source revision '${parsed.sourceRevision}' must be a 40-character lowercase hexadecimal commit.`,
    );

    const expected = expectedPayloads(parsed.version);
    assert(
        parsed.payloads.length === expected.length,
        `payloads must contain exactly ${expected.length} canonical entries.`,
    );
    const paths = new Set<string>();
    parsed.payloads.forEach((payload, index) => {
        assert(
            !paths.has(payload.path),
            `payload path '${payload.path}' is duplicated.`,
        );
        paths.add(payload.path);
        assertCanonicalPayload(
            payload,
            expected[index] as ReturnType<typeof expectedPayloads>[number],
            index,
        );
    });
    return unsignedManifestFrom(parsed);
};

/** Validate and return the canonical unsigned portion of a release manifest. */
export const validateReleaseArtifactManifest = (
    value: unknown,
): ReleaseArtifactManifest => {
    assertManifestMetadataOrder(value, true);
    const parsed = manifestSchema.parse(value) as ReleaseArtifactManifest;
    const unsigned = validateUnsigned({
        schema: parsed.schema,
        version: parsed.version,
        sourceRevision: parsed.sourceRevision,
        payloads: parsed.payloads,
    });
    assert(
        OCI_DIGEST_PATTERN.test(
            (
                unsigned.payloads.find(
                    (payload) => payload.type === "oci-index",
                ) as ReleaseArtifactIndexPayload
            ).digest,
        ),
        "OCI index digest is malformed.",
    );
    assert(
        parsed.bundleId === computeReleaseArtifactBundleId(unsigned),
        "bundleId does not match the canonical manifest content.",
    );
    return {
        schema: parsed.schema,
        version: parsed.version,
        sourceRevision: parsed.sourceRevision,
        payloads: unsigned.payloads,
        bundleId: parsed.bundleId,
    };
};

export const parseReleaseArtifactManifest = validateReleaseArtifactManifest;

/** Build and validate a manifest from staged payload metadata. */
export const createReleaseArtifactManifest = (
    input: ReleaseArtifactManifestUnsigned,
): ReleaseArtifactManifest => {
    const unsigned = validateUnsigned(input);
    return validateReleaseArtifactManifest({
        ...unsigned,
        bundleId: computeReleaseArtifactBundleId(unsigned),
    });
};

/** Zod schema including semantic completeness and content-address checks. */
export const releaseArtifactManifestSchema = z
    .unknown()
    .superRefine((value, context) => {
        try {
            assertManifestMetadataOrder(value, true);
        } catch (error) {
            context.addIssue({
                code: "custom",
                message: error instanceof Error ? error.message : String(error),
            });
        }
    })
    .pipe(manifestSchema)
    .superRefine((value, context) => {
        try {
            const unsigned = validateUnsigned({
                schema: value.schema,
                version: value.version,
                sourceRevision: value.sourceRevision,
                payloads: value.payloads,
            });
            assert(
                value.bundleId === computeReleaseArtifactBundleId(unsigned),
                "bundleId does not match the canonical manifest content.",
            );
        } catch (error) {
            context.addIssue({
                code: "custom",
                message: error instanceof Error ? error.message : String(error),
            });
        }
    });