import { createHash, randomBytes } from "node:crypto";

import { RalphieError } from "../shared/error.ts";

/**
 * Verified create-only manifest promotion over the OCI Distribution API.
 *
 * `reconcileManifestTag` owns the promotion policy: inspect the destination
 * reference first, reuse it only when its exact serialized digest equals the
 * intended digest, create it only through a server-enforced compare-and-swap
 * (`If-None-Match: *`) and only for media types that
 * `probeCreateOnlyPublishing` verified against the actual registry, and
 * reread the reference after every write so a raced or lying answer becomes a
 * conflict. An unconditional tag write is never used.
 *
 * `probeCreateOnlyPublishing` proves create-only behavior before any
 * production tag write: for each writable media type it seeds blobs, creates
 * a disposable, uniquely named probe tag, then attempts a competing second
 * manifest and requires the registry to reject it (412 or 409) while the
 * original digest remains unchanged. If the registry accepts the competing
 * write, ignores conditional headers, or lacks a supported compare-and-swap
 * operation, the probe fails closed and no production tag may be written.
 */

export const OCI_IMAGE_MANIFEST_MEDIA_TYPE =
    "application/vnd.oci.image.manifest.v1+json" as const;
export const DOCKER_SCHEMA2_MANIFEST_MEDIA_TYPE =
    "application/vnd.docker.distribution.manifest.v2+json" as const;
export const OCI_IMAGE_INDEX_MEDIA_TYPE =
    "application/vnd.oci.image.index.v1+json" as const;
export const DOCKER_MANIFEST_LIST_MEDIA_TYPE =
    "application/vnd.docker.distribution.manifest.list.v2+json" as const;

/** Every manifest media type this contract can write. */
export const WRITABLE_MANIFEST_MEDIA_TYPES = [
    OCI_IMAGE_MANIFEST_MEDIA_TYPE,
    DOCKER_SCHEMA2_MANIFEST_MEDIA_TYPE,
    OCI_IMAGE_INDEX_MEDIA_TYPE,
    DOCKER_MANIFEST_LIST_MEDIA_TYPE,
] as const;

export type ManifestMediaType = (typeof WRITABLE_MANIFEST_MEDIA_TYPES)[number];

export const isManifestMediaType = (
    value: string,
): value is ManifestMediaType =>
    (WRITABLE_MANIFEST_MEDIA_TYPES as readonly string[]).includes(value);

const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** True when the value is a canonical `sha256:` content digest. */
export const isContentDigest = (value: string): boolean =>
    SHA256_DIGEST_PATTERN.test(value);

/**
 * Deterministic content address over exact serialized manifest bytes. Media
 * type, descriptor ordering, sizes, and annotations all contribute, so an
 * index with the same child digests but different bytes has a different
 * digest and is rejected.
 */
export const manifestDigest = (bytes: Uint8Array): string =>
    `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export type RegistryBlobDescriptor = {
    readonly mediaType: string;
    readonly size: number;
    readonly digest: string;
};

export type RegistryPushedBlob = {
    readonly size: number;
    readonly digest: string;
};

export type RegistryManifestReferenceState =
    | { readonly kind: "missing" }
    | {
          readonly kind: "present";
          /** Digest recomputed over the exact serialized manifest bytes. */
          readonly digest: string;
          readonly bytes: Uint8Array;
          readonly mediaType: string | undefined;
      };

export type RegistryManifestPutResult = {
    /** HTTP status of the create-only write (200, 201, 409, or 412). */
    readonly status: number;
    /** Digest advertised by the registry, when the response provided one. */
    readonly digest: string | undefined;
};

/**
 * The OCI Distribution client surface used by reconciliation and the
 * capability probe. The transport implementation never performs an
 * unconditional tag write: every `putManifest` request carries the
 * server-enforced `If-None-Match: *` compare-and-swap, and a CAS rejection
 * (409/412) is returned as status data so the caller can reread the
 * reference. Authentication, blob, transport, and non-CAS registry failures
 * throw and propagate.
 */
export type RegistryClient = {
    readonly inspectManifestReference: (
        repository: string,
        reference: string,
    ) => Promise<RegistryManifestReferenceState>;
    readonly putManifest: (
        repository: string,
        reference: string,
        manifestBytes: Uint8Array,
        mediaType: ManifestMediaType,
    ) => Promise<RegistryManifestPutResult>;
    readonly deleteManifestReference: (
        repository: string,
        reference: string,
    ) => Promise<void>;
    readonly blobExists: (
        repository: string,
        digest: string,
    ) => Promise<boolean>;
    readonly pushBlob: (
        repository: string,
        bytes: Uint8Array,
    ) => Promise<RegistryPushedBlob>;
};

export class RegistryRequestError extends RalphieError {}

/** The tag exists but does not reference the exact intended manifest. */
export class RegistryConflictError extends RalphieError {}

/** A registry response contradicts its own bytes or the OCI contract. */
export class RegistryMalformedResponseError extends RalphieError {}

/**
 * A create was requested before the registry proved create-only behavior, so
 * an unconditional write would be the only option and is refused.
 */
export class RegistryWriteGuardError extends RalphieError {}

export type ReconcileManifestTagInput = {
    readonly repository: string;
    readonly reference: string;
    readonly manifestBytes: Uint8Array;
    readonly mediaType: ManifestMediaType;
    readonly expectedDigest: string;
    /**
     * Media types for which `probeCreateOnlyPublishing` verified the registry
     * enforces create-only writes. Creating a missing tag requires the
     * matching media type to be present; otherwise the write is refused.
     */
    readonly verifiedCreateOnlyMediaTypes: ReadonlySet<ManifestMediaType>;
};

export type ReconcileManifestTagResult =
    | { readonly kind: "reused" }
    | { readonly kind: "created" };

const conflictFor = (
    repository: string,
    reference: string,
    expected: string,
    observed: string,
): RegistryConflictError =>
    new RegistryConflictError({
        message: `Container tag ${repository}:${reference} does not reference the intended manifest. Expected ${expected}, found ${observed}.`,
    });

/**
 * Promote one manifest to one destination tag with exact-digest semantics.
 *
 * The current reference is inspected first. A missing tag may be created
 * through the verified compare-and-swap; an existing tag is reused only when
 * its full serialized digest equals the intended digest. Any other digest,
 * malformed response, or unexpected registry status is a conflict/failure,
 * and a create race is accepted only after rereading the tag and finding the
 * exact intended digest.
 */
export const reconcileManifestTag = async (
    client: RegistryClient,
    input: ReconcileManifestTagInput,
): Promise<ReconcileManifestTagResult> => {
    const byteDigest = manifestDigest(input.manifestBytes);
    if (byteDigest !== input.expectedDigest) {
        throw new RalphieError({
            message: `Supplied ${input.mediaType} bytes for ${input.repository}:${input.reference} digest to ${byteDigest}, not the stated expected digest ${input.expectedDigest}.`,
        });
    }
    const current = await client.inspectManifestReference(
        input.repository,
        input.reference,
    );
    if (current.kind === "present") {
        if (current.digest !== input.expectedDigest) {
            throw conflictFor(
                input.repository,
                input.reference,
                input.expectedDigest,
                current.digest,
            );
        }
        return { kind: "reused" };
    }
    if (!input.verifiedCreateOnlyMediaTypes.has(input.mediaType)) {
        throw new RegistryWriteGuardError({
            message: `Refusing to create ${input.repository}:${input.reference}: create-only promotion of ${input.mediaType} has not been verified for this registry, and an unconditional write is never allowed.`,
        });
    }
    const write = await client.putManifest(
        input.repository,
        input.reference,
        input.manifestBytes,
        input.mediaType,
    );
    if (
        write.status !== 200 &&
        write.status !== 201 &&
        write.status !== 409 &&
        write.status !== 412
    ) {
        throw new RegistryRequestError({
            message: `Registry rejected the create-only write of ${input.repository}:${input.reference} (${input.mediaType}) with HTTP ${write.status}.`,
        });
    }
    const afterWrite = await client.inspectManifestReference(
        input.repository,
        input.reference,
    );
    if (
        afterWrite.kind === "missing" ||
        afterWrite.digest !== input.expectedDigest
    ) {
        throw conflictFor(
            input.repository,
            input.reference,
            input.expectedDigest,
            afterWrite.kind === "missing" ? "missing" : afterWrite.digest,
        );
    }
    return { kind: "created" };
};

export type RegistryCreateOnlyProbeOptions = {
    readonly repository: string;
    /** Media types to prove; defaults to every writable media type. */
    readonly mediaTypes?: ReadonlyArray<ManifestMediaType>;
    /** Stable prefix for the disposable probe tags. */
    readonly probeTagPrefix?: string;
    /** Uniqueness salt; defaults to a random value. */
    readonly nonce?: string;
};

export type RegistryCreateOnlyProbeVerifiedEntry = {
    readonly outcome: "verified";
    readonly mediaType: ManifestMediaType;
    readonly probeTag: string;
    readonly primaryDigest: string;
    readonly competingDigest: string;
    readonly competingWriteStatus: number;
    readonly unchangedDigest: string;
};

export type RegistryCreateOnlyProbeFailedEntry = {
    readonly outcome: "failed";
    readonly mediaType: ManifestMediaType;
    readonly probeTag: string;
    readonly stage: string;
    readonly detail: string;
};

export type RegistryCreateOnlyProbeEntry =
    | RegistryCreateOnlyProbeVerifiedEntry
    | RegistryCreateOnlyProbeFailedEntry;

export type RegistryCreateOnlyProbeResult = {
    readonly verified: true;
    readonly repository: string;
    readonly verifiedMediaTypes: ReadonlyArray<ManifestMediaType>;
    readonly entries: ReadonlyArray<RegistryCreateOnlyProbeEntry>;
};

/** The capability probe failed closed; no production tag may be written. */
export class RegistryCapabilityProbeError extends RalphieError {
    readonly entries: ReadonlyArray<RegistryCreateOnlyProbeEntry>;

    constructor(input: {
        readonly repository: string;
        readonly entries: ReadonlyArray<RegistryCreateOnlyProbeEntry>;
    }) {
        const failures = input.entries.filter(
            (entry) => entry.outcome === "failed",
        );
        super({
            message: `Registry ${input.repository} did not prove create-only manifest promotion: ${failures.length} of ${input.entries.length} probed media types failed closed.`,
        });
        this.entries = [...input.entries];
    }
}

const TAG_NAME_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$/;
const DEFAULT_PROBE_TAG_PREFIX = "ralphie-create-only-probe";

const MEDIA_TYPE_SLUG: Readonly<Record<ManifestMediaType, string>> = {
    [OCI_IMAGE_MANIFEST_MEDIA_TYPE]: "oci-image",
    [DOCKER_SCHEMA2_MANIFEST_MEDIA_TYPE]: "docker-schema2",
    [OCI_IMAGE_INDEX_MEDIA_TYPE]: "oci-index",
    [DOCKER_MANIFEST_LIST_MEDIA_TYPE]: "docker-list",
};

const randomNonce = (): string =>
    `${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;

const messageOf = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

class ProbeStepError extends Error {
    readonly stage: string;

    constructor(stage: string, message: string) {
        super(message);
        this.stage = stage;
    }
}

const uniqueMediaTypes = (
    mediaTypes: ReadonlyArray<ManifestMediaType> | undefined,
): ReadonlyArray<ManifestMediaType> => {
    const requested =
        mediaTypes === undefined ? WRITABLE_MANIFEST_MEDIA_TYPES : mediaTypes;
    const seen = new Set<string>();
    const unique: ManifestMediaType[] = [];
    for (const mediaType of requested) {
        if (!isManifestMediaType(mediaType)) {
            throw new RalphieError({
                message: `Not a writable manifest media type: ${String(mediaType)}.`,
            });
        }
        if (!seen.has(mediaType)) {
            seen.add(mediaType);
            unique.push(mediaType);
        }
    }
    return unique;
};

/**
 * Prove that the registry enforces create-only manifest promotion for every
 * requested media type before any production tag write.
 *
 * Each media type gets its own disposable, uniquely named probe tag. The
 * probe seeds the referenced blobs (and, for index families, the two child
 * manifests by digest), creates the probe tag, requires a competing second
 * manifest to be rejected by the server (412 or 409), and requires the
 * original digest to be unchanged. Authentication, blob, and manifest pushes
 * that fail during the probe propagate as a fail-closed probe error with
 * per-media-type evidence.
 */
export const probeCreateOnlyPublishing = async (
    client: RegistryClient,
    options: RegistryCreateOnlyProbeOptions,
): Promise<RegistryCreateOnlyProbeResult> => {
    const mediaTypes = uniqueMediaTypes(options.mediaTypes);
    const prefix = options.probeTagPrefix ?? DEFAULT_PROBE_TAG_PREFIX;
    if (!TAG_NAME_PATTERN.test(prefix)) {
        throw new RalphieError({
            message: `Probe tag prefix '${prefix}' is not a valid registry tag.`,
        });
    }
    const nonce = options.nonce ?? randomNonce();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,63}$/.test(nonce)) {
        throw new RalphieError({
            message: `Probe nonce '${nonce}' is not a valid tag fragment.`,
        });
    }
    const entries: RegistryCreateOnlyProbeEntry[] = [];
    for (const mediaType of mediaTypes) {
        const probeTag = `${prefix}-${nonce}-${MEDIA_TYPE_SLUG[mediaType]}`;
        try {
            entries.push(
                await probeOneMediaType(
                    client,
                    options.repository,
                    mediaType,
                    probeTag,
                ),
            );
        } catch (error) {
            entries.push({
                outcome: "failed",
                mediaType,
                probeTag,
                stage:
                    error instanceof ProbeStepError
                        ? error.stage
                        : "probe-step",
                detail: messageOf(error),
            });
        }
    }
    if (entries.some((entry) => entry.outcome === "failed")) {
        throw new RegistryCapabilityProbeError({
            repository: options.repository,
            entries,
        });
    }
    return {
        verified: true,
        repository: options.repository,
        verifiedMediaTypes: mediaTypes,
        entries,
    };
};

const probeOneMediaType = async (
    client: RegistryClient,
    repository: string,
    mediaType: ManifestMediaType,
    probeTag: string,
): Promise<RegistryCreateOnlyProbeEntry> => {
    if (
        mediaType === OCI_IMAGE_INDEX_MEDIA_TYPE ||
        mediaType === DOCKER_MANIFEST_LIST_MEDIA_TYPE
    ) {
        return probeIndexMediaType(client, repository, mediaType, probeTag);
    }
    return probePlatformMediaType(client, repository, mediaType, probeTag);
};

const probePlatformMediaType = async (
    client: RegistryClient,
    repository: string,
    mediaType: ManifestMediaType,
    probeTag: string,
): Promise<RegistryCreateOnlyProbeVerifiedEntry> => {
    const content = await ensureProbeContent(client, repository, mediaType);
    const primary = buildPlatformManifest(mediaType, content, "primary");
    const competing = buildPlatformManifest(mediaType, content, "competing");
    const primaryDigest = manifestDigest(primary);
    await createProbeReference(
        client,
        repository,
        probeTag,
        primary,
        mediaType,
        primaryDigest,
    );
    const rejected = await requireCasRejection(
        client,
        repository,
        probeTag,
        mediaType,
        primaryDigest,
        competing,
    );
    await cleanupProbeReference(client, repository, probeTag);
    return {
        outcome: "verified",
        mediaType,
        probeTag,
        primaryDigest,
        competingDigest: rejected.competingDigest,
        competingWriteStatus: rejected.status,
        unchangedDigest: rejected.unchangedDigest,
    };
};

const probeIndexMediaType = async (
    client: RegistryClient,
    repository: string,
    mediaType: ManifestMediaType,
    probeTag: string,
): Promise<RegistryCreateOnlyProbeVerifiedEntry> => {
    const childMediaType =
        mediaType === OCI_IMAGE_INDEX_MEDIA_TYPE
            ? OCI_IMAGE_MANIFEST_MEDIA_TYPE
            : DOCKER_SCHEMA2_MANIFEST_MEDIA_TYPE;
    const content = await ensureProbeContent(
        client,
        repository,
        childMediaType,
    );
    const childAmd64 = buildPlatformManifest(
        childMediaType,
        content,
        "primary",
    );
    const childArm64 = buildPlatformManifest(
        childMediaType,
        content,
        "competing",
    );
    await ensureManifestContent(client, repository, childAmd64, childMediaType);
    await ensureManifestContent(client, repository, childArm64, childMediaType);
    const descriptors = (
        flavor: "primary" | "competing",
    ): ReadonlyArray<IndexProbeChild> =>
        flavor === "primary"
            ? [
                  { bytes: childAmd64, architecture: "amd64", childMediaType },
                  { bytes: childArm64, architecture: "arm64", childMediaType },
              ]
            : [
                  { bytes: childArm64, architecture: "arm64", childMediaType },
                  { bytes: childAmd64, architecture: "amd64", childMediaType },
              ];
    const primary = buildIndexManifest(mediaType, descriptors("primary"));
    const competing = buildIndexManifest(mediaType, descriptors("competing"));
    const primaryDigest = manifestDigest(primary);
    await createProbeReference(
        client,
        repository,
        probeTag,
        primary,
        mediaType,
        primaryDigest,
    );
    const rejected = await requireCasRejection(
        client,
        repository,
        probeTag,
        mediaType,
        primaryDigest,
        competing,
    );
    await cleanupProbeReference(client, repository, probeTag);
    return {
        outcome: "verified",
        mediaType,
        probeTag,
        primaryDigest,
        competingDigest: rejected.competingDigest,
        competingWriteStatus: rejected.status,
        unchangedDigest: rejected.unchangedDigest,
    };
};

const createProbeReference = async (
    client: RegistryClient,
    repository: string,
    reference: string,
    bytes: Uint8Array,
    mediaType: ManifestMediaType,
    expectedDigest: string,
): Promise<void> => {
    const write = await client.putManifest(
        repository,
        reference,
        bytes,
        mediaType,
    );
    if (write.status !== 200 && write.status !== 201) {
        throw new ProbeStepError(
            "create-probe-tag",
            `Registry answered the probe tag creation with HTTP ${write.status}, expected 201.`,
        );
    }
    await requireProbeDigest(
        client,
        repository,
        reference,
        mediaType,
        expectedDigest,
        "after probe tag creation",
    );
};

const requireProbeDigest = async (
    client: RegistryClient,
    repository: string,
    reference: string,
    mediaType: ManifestMediaType,
    expectedDigest: string,
    stage: string,
): Promise<void> => {
    const state = await client.inspectManifestReference(repository, reference);
    if (state.kind === "missing" || state.digest !== expectedDigest) {
        throw new ProbeStepError(
            stage,
            `${mediaType} probe reference ${repository}:${reference} resolved to ${
                state.kind === "missing" ? "missing" : state.digest
            } instead of ${expectedDigest}.`,
        );
    }
};

const requireCasRejection = async (
    client: RegistryClient,
    repository: string,
    reference: string,
    mediaType: ManifestMediaType,
    primaryDigest: string,
    competingBytes: Uint8Array,
): Promise<{
    readonly competingDigest: string;
    readonly status: number;
    readonly unchangedDigest: string;
}> => {
    const competingDigest = manifestDigest(competingBytes);
    const write = await client.putManifest(
        repository,
        reference,
        competingBytes,
        mediaType,
    );
    if (write.status === 200 || write.status === 201) {
        throw new ProbeStepError(
            "competing-write",
            `Registry accepted a competing ${mediaType} write (HTTP ${write.status}) to the existing probe tag ${repository}:${reference}: it ignores the create-only compare-and-swap (If-None-Match or equivalent).`,
        );
    }
    if (write.status !== 409 && write.status !== 412) {
        throw new ProbeStepError(
            "competing-write",
            `Unexpected registry status ${write.status} for the competing ${mediaType} write to ${repository}:${reference}.`,
        );
    }
    const unchanged = await client.inspectManifestReference(
        repository,
        reference,
    );
    if (unchanged.kind === "missing" || unchanged.digest !== primaryDigest) {
        throw new ProbeStepError(
            "digest-preserved",
            `The original ${mediaType} digest ${primaryDigest} at ${repository}:${reference} changed to ${
                unchanged.kind === "missing" ? "missing" : unchanged.digest
            } after the CAS-rejected competing write.`,
        );
    }
    return {
        competingDigest,
        status: write.status,
        unchangedDigest: unchanged.digest,
    };
};

const ensureManifestContent = async (
    client: RegistryClient,
    repository: string,
    bytes: Uint8Array,
    mediaType: ManifestMediaType,
): Promise<string> => {
    const digest = manifestDigest(bytes);
    const existing = await client.inspectManifestReference(repository, digest);
    if (existing.kind === "present" && existing.digest === digest)
        return digest;
    const write = await client.putManifest(
        repository,
        digest,
        bytes,
        mediaType,
    );
    if (
        write.status !== 200 &&
        write.status !== 201 &&
        write.status !== 409 &&
        write.status !== 412
    ) {
        throw new ProbeStepError(
            "child-content",
            `Pushing ${mediaType} child content to ${repository} by digest answered HTTP ${write.status}.`,
        );
    }
    await requireProbeDigest(
        client,
        repository,
        digest,
        mediaType,
        digest,
        "after child content push",
    );
    return digest;
};

const cleanupProbeReference = async (
    client: RegistryClient,
    repository: string,
    reference: string,
): Promise<void> => {
    try {
        await client.deleteManifestReference(repository, reference);
    } catch {
        // Probe tag names are disposable and unique; deletion is best-effort
        // because a registry may refuse manifest deletion entirely.
    }
};

const OCI_CONFIG_MEDIA_TYPE = "application/vnd.oci.image.config.v1+json";
const OCI_LAYER_MEDIA_TYPE = "application/vnd.oci.image.layer.v1.tar+gzip";
const DOCKER_CONFIG_MEDIA_TYPE =
    "application/vnd.docker.container.image.v1+json";
const DOCKER_LAYER_MEDIA_TYPE =
    "application/vnd.docker.image.rootfs.diff.tar.gzip";

const PROBE_CONFIG_BYTES = new TextEncoder().encode(
    '{"architecture":"amd64","os":"linux"}',
);
const PROBE_LAYER_PRIMARY_BYTES = new TextEncoder().encode(
    "ralphie-create-only-probe-content-a",
);
const PROBE_LAYER_COMPETING_BYTES = new TextEncoder().encode(
    "ralphie-create-only-probe-content-b",
);

type ProbeContent = {
    readonly config: RegistryBlobDescriptor;
    readonly primaryLayer: RegistryBlobDescriptor;
    readonly competingLayer: RegistryBlobDescriptor;
};

const ensureBlob = async (
    client: RegistryClient,
    repository: string,
    mediaType: string,
    bytes: Uint8Array,
): Promise<RegistryBlobDescriptor> => {
    const digest = manifestDigest(bytes);
    if (!(await client.blobExists(repository, digest))) {
        const pushed = await client.pushBlob(repository, bytes);
        if (pushed.digest !== digest) {
            throw new ProbeStepError(
                "blob-content",
                `Registry stored blob digest ${pushed.digest} for bytes that digest to ${digest}.`,
            );
        }
    }
    return { mediaType, size: bytes.byteLength, digest };
};

const ensureProbeContent = async (
    client: RegistryClient,
    repository: string,
    mediaType: ManifestMediaType,
): Promise<ProbeContent> => {
    const oci =
        mediaType === OCI_IMAGE_MANIFEST_MEDIA_TYPE ||
        mediaType === OCI_IMAGE_INDEX_MEDIA_TYPE;
    const config = await ensureBlob(
        client,
        repository,
        oci ? OCI_CONFIG_MEDIA_TYPE : DOCKER_CONFIG_MEDIA_TYPE,
        PROBE_CONFIG_BYTES,
    );
    const primaryLayer = await ensureBlob(
        client,
        repository,
        oci ? OCI_LAYER_MEDIA_TYPE : DOCKER_LAYER_MEDIA_TYPE,
        PROBE_LAYER_PRIMARY_BYTES,
    );
    const competingLayer = await ensureBlob(
        client,
        repository,
        oci ? OCI_LAYER_MEDIA_TYPE : DOCKER_LAYER_MEDIA_TYPE,
        PROBE_LAYER_COMPETING_BYTES,
    );
    return { config, primaryLayer, competingLayer };
};

const encodeJson = (value: unknown): Uint8Array =>
    new TextEncoder().encode(JSON.stringify(value));

const buildPlatformManifest = (
    mediaType: ManifestMediaType,
    content: ProbeContent,
    flavor: "primary" | "competing",
): Uint8Array => {
    const layer =
        flavor === "primary" ? content.primaryLayer : content.competingLayer;
    const config = {
        mediaType: content.config.mediaType,
        size: content.config.size,
        digest: content.config.digest,
    };
    if (mediaType === OCI_IMAGE_MANIFEST_MEDIA_TYPE) {
        return encodeJson({
            schemaVersion: 2,
            mediaType,
            config,
            layers: [
                {
                    mediaType: OCI_LAYER_MEDIA_TYPE,
                    size: layer.size,
                    digest: layer.digest,
                },
            ],
            annotations: {
                "org.opencontainers.image.title": `ralphie-probe-${flavor}`,
            },
        });
    }
    return encodeJson({
        schemaVersion: 2,
        mediaType,
        config,
        layers: [
            {
                mediaType: DOCKER_LAYER_MEDIA_TYPE,
                size: layer.size,
                digest: layer.digest,
            },
        ],
    });
};

type IndexProbeChild = {
    readonly bytes: Uint8Array;
    readonly architecture: string;
    readonly childMediaType: ManifestMediaType;
};

const buildIndexManifest = (
    mediaType: ManifestMediaType,
    children: ReadonlyArray<IndexProbeChild>,
): Uint8Array => {
    const manifests = children.map((child) => ({
        mediaType: child.childMediaType,
        size: child.bytes.byteLength,
        digest: manifestDigest(child.bytes),
        platform: { architecture: child.architecture, os: "linux" },
    }));
    if (mediaType === DOCKER_MANIFEST_LIST_MEDIA_TYPE) {
        return encodeJson({ schemaVersion: 2, mediaType, manifests });
    }
    return encodeJson({
        schemaVersion: 2,
        mediaType,
        manifests,
        annotations: {
            "org.opencontainers.image.title": "ralphie-probe-index",
        },
    });
};