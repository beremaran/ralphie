import { RalphieError } from "../shared/error.ts";
import {
    CONTAINER_CANDIDATE_ARCHS,
    containerCandidatePlatform,
    type ContainerCandidateArch,
    type ContainerCandidatePlatform,
    type ValidatedContainerCandidates,
} from "./container-candidate.ts";
import { parseContainerVersion } from "./container-tags.ts";
import {
    DOCKER_SCHEMA2_MANIFEST_MEDIA_TYPE,
    isContentDigest,
    manifestDigest,
    OCI_IMAGE_MANIFEST_MEDIA_TYPE,
    type ManifestMediaType,
    type RegistryBlobDescriptor,
} from "./registry-reconcile.ts";

/**
 * Deterministic multi-architecture OCI index assembly and the
 * `ralphie.container-reconcile-plan.v1` promotion plan
 * (`rel20-publisher-container-registry-reconcile` integration), the pure
 * seams behind `scripts/assemble-container-index.ts` and
 * `scripts/reconcile-container-registry.ts`.
 *
 * `assembleContainerIndex` builds exactly one OCI image index from the two
 * validated platform candidates with a fixed amd64-then-arm64 mapping and
 * ordering, the exact validated media types, sizes, and digests of the two
 * platform manifests, and no incidental annotations; the exact serialized
 * bytes are returned so the promotion path computes and pushes the digest of
 * exactly those bytes.
 *
 * `buildContainerReconcilePlan` / `parseContainerReconcilePlan` produce and
 * strictly re-validate the promotion plan consumed by every registry write:
 * the image/repository, the per-platform tags from the validated tag plan,
 * the exact index document digest, and every release index tag from the tag
 * plan. Nothing here writes to a registry.
 */

export const CONTAINER_INDEX_MEDIA_TYPE =
    "application/vnd.oci.image.index.v1+json" as const;

export const CONTAINER_RECONCILE_PLAN_SCHEMA =
    "ralphie.container-reconcile-plan.v1" as const;

export const CONTAINER_INDEX_FILE = "ralphie-container-index.json" as const;
export const CONTAINER_PLATFORM_MANIFEST_FILE = (
    arch: ContainerCandidateArch,
): string => `ralphie-container-${arch}.manifest.json`;
export const CONTAINER_RECONCILE_PLAN_FILE =
    "ralphie-reconcile-plan.json" as const;

export class ContainerIndexError extends RalphieError {}

const IMAGE_MANIFEST_MEDIA_TYPES = [
    OCI_IMAGE_MANIFEST_MEDIA_TYPE,
    DOCKER_SCHEMA2_MANIFEST_MEDIA_TYPE,
] as const;

const OCI_TAG_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$/;
const VERSION_NO_V_PATTERN =
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$(?![\s\S])/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$(?![\s\S])/;
const RELATIVE_FILE_PATTERN = /^[a-zA-Z0-9._-]+$/;

const fail = (message: string): never => {
    throw new ContainerIndexError({ message });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const exactKeys = (
    record: Record<string, unknown>,
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
    record: Record<string, unknown>,
    key: string,
    label: string,
): string => {
    const value = record[key];
    if (typeof value !== "string") {
        return fail(`${label} must have a string '${key}'.`);
    }
    return value;
};

const stringArrayField = (
    record: Record<string, unknown>,
    key: string,
    label: string,
): ReadonlyArray<string> => {
    const value = record[key];
    if (
        !Array.isArray(value) ||
        value.some((entry) => typeof entry !== "string")
    ) {
        return fail(`${label} must have a string array '${key}'.`);
    }
    return value as ReadonlyArray<string>;
};

const optionalBooleanField = (
    record: Record<string, unknown>,
    key: string,
    label: string,
): boolean | undefined => {
    const value = record[key];
    if (value === undefined) return undefined;
    if (typeof value !== "boolean") {
        return fail(`${label} must have a boolean '${key}'.`);
    }
    return value;
};

const assertOciSafeTag = (tag: string, description: string): void => {
    if (!OCI_TAG_PATTERN.test(tag) || tag.includes("+")) {
        fail(
            `Container tag '${tag}' (${description}) is not a valid OCI/Docker tag name; a tag must match ${String(OCI_TAG_PATTERN)} and must never contain '+'.`,
        );
    }
};

const assertDigest = (digest: string, description: string): void => {
    if (
        !isContentDigest(digest) ||
        digest ===
            "sha256:0000000000000000000000000000000000000000000000000000000000000000"
    ) {
        fail(
            `${description} digest '${digest}' must be a canonical non-placeholder sha256 digest.`,
        );
    }
};

const assertRelativeSafeFile = (path: string, description: string): void => {
    if (!RELATIVE_FILE_PATTERN.test(path)) {
        fail(
            `${description} file '${path}' must be a plain relative file name.`,
        );
    }
};

const assertPositiveSize = (size: unknown, description: string): number => {
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) {
        return fail(`${description} must have a positive safe-integer size.`);
    }
    return size;
};

export type ContainerIndexManifestEntry = {
    readonly arch: ContainerCandidateArch;
    readonly mediaType: ManifestMediaType;
    readonly size: number;
    readonly digest: string;
};

export type ContainerIndexAssembly = {
    /** Exact serialized OCI image index bytes, the bytes that are pushed. */
    readonly bytes: Uint8Array;
    /** Content digest over the exact serialized index bytes. */
    readonly digest: string;
    readonly mediaType: typeof CONTAINER_INDEX_MEDIA_TYPE;
    /** Fixed amd64-then-arm64 descriptor list. */
    readonly manifests: ReadonlyArray<ContainerIndexManifestEntry>;
};

/**
 * Assemble the single deterministic OCI image index for the two validated
 * platform candidates. Ordering is the fixed amd64-then-arm64 mapping;
 * descriptors carry the exact validated media type, size, and digest of each
 * platform manifest; the platform section uses the fixed linux/amd64 and
 * linux/arm64 mapping; and no annotations are emitted. Any mismatch between
 * the two validated candidates (duplicate digests, wrong platform mapping,
 * unsupported manifest media type, or an index descriptor size that does not
 * match the exact manifest bytes) fails closed before a plan is produced.
 */
export const assembleContainerIndex = (
    candidates: ValidatedContainerCandidates,
): ContainerIndexAssembly => {
    const manifests = CONTAINER_CANDIDATE_ARCHS.map((arch) => {
        const candidate = candidates.byPlatform[arch];
        if (candidate === undefined) {
            return fail(`Validated container candidates are missing ${arch}.`);
        }
        if (candidate.platform !== containerCandidatePlatform(arch)) {
            return fail(
                `${arch} candidate platform must be '${containerCandidatePlatform(arch)}', found '${candidate.platform}'.`,
            );
        }
        const image = candidate.image;
        if (
            !(IMAGE_MANIFEST_MEDIA_TYPES as readonly string[]).includes(
                image.mediaType,
            )
        ) {
            return fail(
                `${arch} candidate manifest media type '${image.mediaType}' is not a supported image manifest type.`,
            );
        }
        assertDigest(image.digest, `${arch} candidate`);
        if (image.indexDescriptor.size !== image.bytes.byteLength) {
            return fail(
                `${arch} candidate index descriptor size ${image.indexDescriptor.size} does not match the exact manifest bytes length ${image.bytes.byteLength}.`,
            );
        }
        return {
            arch,
            mediaType: image.mediaType,
            size: image.bytes.byteLength,
            digest: image.digest,
        };
    });
    const uniqueDigests = new Set(manifests.map((entry) => entry.digest));
    if (uniqueDigests.size !== manifests.length) {
        return fail(
            "The two validated platform manifests must have unique digests.",
        );
    }
    const document = {
        schemaVersion: 2,
        mediaType: CONTAINER_INDEX_MEDIA_TYPE,
        manifests: manifests.map((entry) => ({
            mediaType: entry.mediaType,
            size: entry.size,
            digest: entry.digest,
            platform: { architecture: entry.arch, os: "linux" },
        })),
    };
    const bytes = new TextEncoder().encode(JSON.stringify(document));
    return {
        bytes,
        digest: manifestDigest(bytes),
        mediaType: CONTAINER_INDEX_MEDIA_TYPE,
        manifests,
    };
};

/** The `ralphie.container-tag-plan.v1` document consumed by plan building. */
export type ContainerTagPlanDocument = {
    readonly schema: string;
    readonly version: string;
    readonly source_ref: string;
    readonly version_tag: string;
    readonly minor_tag: string;
    readonly latest: boolean;
    readonly source_tag: string;
    readonly platform_tag_base: string;
    readonly platform_tags: ReadonlyArray<string>;
    readonly index_tags: ReadonlyArray<string>;
};

const parseTagPlanDocument = (raw: string): ContainerTagPlanDocument => {
    let value: unknown;
    try {
        value = JSON.parse(raw) as unknown;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fail(`Container tag plan is not valid JSON: ${message}`);
    }
    if (!isRecord(value)) {
        return fail("Container tag plan must be a JSON object.");
    }
    exactKeys(
        value,
        [
            "schema",
            "version",
            "source_ref",
            "version_tag",
            "minor_tag",
            "latest",
            "source_tag",
            "platform_tag_base",
            "platform_tags",
            "index_tags",
        ],
        "container tag plan",
    );
    const schema = stringField(value, "schema", "container tag plan");
    if (schema !== "ralphie.container-tag-plan.v1") {
        return fail(
            `Container tag plan schema must be 'ralphie.container-tag-plan.v1', found '${schema}'.`,
        );
    }
    const version = stringField(value, "version", "container tag plan");
    const sourceRef = stringField(value, "source_ref", "container tag plan");
    const versionTag = stringField(value, "version_tag", "container tag plan");
    const minorTag = stringField(value, "minor_tag", "container tag plan");
    const latest = value.latest;
    if (typeof latest !== "boolean") {
        return fail("Container tag plan must have a boolean 'latest'.");
    }
    const sourceTag = stringField(value, "source_tag", "container tag plan");
    const platformTagBase = stringField(
        value,
        "platform_tag_base",
        "container tag plan",
    );
    const platformTags = stringArrayField(
        value,
        "platform_tags",
        "container tag plan",
    );
    const indexTags = stringArrayField(
        value,
        "index_tags",
        "container tag plan",
    );
    return {
        schema,
        version,
        source_ref: sourceRef,
        version_tag: versionTag,
        minor_tag: minorTag,
        latest,
        source_tag: sourceTag,
        platform_tag_base: platformTagBase,
        platform_tags: platformTags,
        index_tags: indexTags,
    };
};

export type ContainerReconcilePlatformEntry = {
    readonly arch: ContainerCandidateArch;
    readonly platform: ContainerCandidatePlatform;
    readonly tag: string;
    readonly media_type: ManifestMediaType;
    readonly digest: string;
    readonly size: number;
    readonly manifest_file: string;
    readonly config: RegistryBlobDescriptor;
    readonly layers: ReadonlyArray<RegistryBlobDescriptor>;
};

export type ContainerReconcilePlan = {
    readonly schema: typeof CONTAINER_RECONCILE_PLAN_SCHEMA;
    readonly image: string;
    readonly repository: string;
    readonly version: string;
    readonly source_ref: string;
    readonly platform_tags: ReadonlyArray<string>;
    readonly index_tags: ReadonlyArray<string>;
    readonly platform: Readonly<
        Record<ContainerCandidateArch, ContainerReconcilePlatformEntry>
    >;
    readonly index: {
        readonly media_type: typeof CONTAINER_INDEX_MEDIA_TYPE;
        readonly digest: string;
        readonly size: number;
        readonly file: string;
    };
};

const GHCR_IMAGE_PATTERN = /^ghcr\.io\/[a-z0-9][a-z0-9._-]*\/[a-z0-9._-]+$/;

/**
 * The image reference must be an exact GHCR reference
 * (`ghcr.io/<owner>/<name>`); the repository is derived from it. Anything
 * else fails closed so a typo can never point the reconciler at another
 * package path.
 */
export const imageReference = (image: string): string => {
    if (!GHCR_IMAGE_PATTERN.test(image)) {
        return fail(
            `Container image reference '${image}' must be ghcr.io/<owner>/<name>.`,
        );
    }
    return image.slice("ghcr.io/".length);
};

const validateTagPlanForCandidates = (
    tagPlan: ContainerTagPlanDocument,
    candidates: ValidatedContainerCandidates,
): void => {
    if (tagPlan.version !== candidates.version) {
        return fail(
            `Container tag plan version '${tagPlan.version}' does not match the validated version '${candidates.version}'.`,
        );
    }
    if (tagPlan.source_ref !== candidates.sourceRef) {
        return fail(
            `Container tag plan source_ref does not match the validated source ref.`,
        );
    }
    assertTagPlanVersionTag(tagPlan);
    assertTagPlanPlatformTags(tagPlan);
    assertTagPlanIndexTags(tagPlan);
};

const assertTagPlanVersionTag = (tagPlan: ContainerTagPlanDocument): void => {
    if (
        parseContainerVersion(tagPlan.version).versionTag !==
        tagPlan.version_tag
    ) {
        return fail(
            "Container tag plan version_tag does not match the parsed version.",
        );
    }
    if (tagPlan.platform_tag_base !== tagPlan.version_tag) {
        return fail(
            "Container tag plan platform_tag_base must equal version_tag.",
        );
    }
};

const assertTagPlanPlatformTags = (tagPlan: ContainerTagPlanDocument): void => {
    const expectedPlatformTags = CONTAINER_CANDIDATE_ARCHS.map(
        (arch) => `${tagPlan.version_tag}-${arch}`,
    );
    if (
        tagPlan.platform_tags.length !== expectedPlatformTags.length ||
        tagPlan.platform_tags.some(
            (tag, index) => tag !== expectedPlatformTags[index],
        )
    ) {
        return fail(
            `Container tag plan platform_tags must be exactly ${expectedPlatformTags.join(", ")}.`,
        );
    }
    for (const tag of tagPlan.platform_tags) {
        assertOciSafeTag(tag, "tag plan");
    }
};

const assertTagPlanIndexTags = (tagPlan: ContainerTagPlanDocument): void => {
    const sourceTag = `sha-${tagPlan.source_ref}`;
    if (tagPlan.index_tags[0] !== tagPlan.version_tag) {
        return fail(
            "Container tag plan index_tags must start with the version tag.",
        );
    }
    if (tagPlan.index_tags[1] !== tagPlan.minor_tag) {
        return fail(
            "Container tag plan index_tags must put the minor alias second.",
        );
    }
    if (tagPlan.index_tags[tagPlan.index_tags.length - 1] !== sourceTag) {
        return fail(
            "Container tag plan index_tags must end with the source-ref tag.",
        );
    }
    if (tagPlan.index_tags.includes("latest") && !tagPlan.latest) {
        return fail(
            "Container tag plan index_tags contain 'latest' for a prerelease plan.",
        );
    }
    if (!tagPlan.index_tags.includes("latest") && tagPlan.latest) {
        return fail(
            "Container tag plan index_tags omit 'latest' for a stable plan.",
        );
    }
    if (new Set(tagPlan.index_tags).size !== tagPlan.index_tags.length) {
        return fail("Container tag plan index_tags must be deduplicated.");
    }
    for (const tag of tagPlan.index_tags) {
        assertOciSafeTag(tag, "tag plan");
    }
};

export type ContainerReconcilePlanInput = {
    readonly candidates: ValidatedContainerCandidates;
    readonly tagPlan: ContainerTagPlanDocument;
    readonly image: string;
};

const blobDescriptorFromPlan = (
    arch: ContainerCandidateArch,
    blob: unknown,
    label: string,
): RegistryBlobDescriptor => {
    if (!isRecord(blob)) {
        return fail(`${arch} candidate ${label} must be an object.`);
    }
    const mediaType = stringField(blob, "mediaType", label);
    const digest = stringField(blob, "digest", label);
    const size = assertPositiveSize(blob.size, label);
    if (mediaType.length === 0) {
        return fail(`${label} must have a non-empty mediaType.`);
    }
    assertDigest(digest, `${arch} candidate ${label} blob`);
    return { mediaType, size, digest };
};

/**
 * Build the deterministic `ralphie.container-reconcile-plan.v1` document
 * from the validated candidates, the validated tag plan, and the exact image
 * reference. The document carries every value the registry reconciler needs
 * — the per-platform tags, the exact index digest and file, and every
 * release index tag — so the promotion steps never derive a tag or digest
 * from shell code.
 */
export const buildContainerReconcilePlan = ({
    candidates,
    tagPlan,
    image,
}: ContainerReconcilePlanInput): ContainerReconcilePlan => {
    const repository = imageReference(image);
    validateTagPlanForCandidates(tagPlan, candidates);
    const hostVersion = parseContainerVersion(candidates.version);
    if (hostVersion.version !== candidates.version) {
        return fail(
            `Validated release version '${candidates.version}' must not carry a leading 'v'.`,
        );
    }
    const assembly = assembleContainerIndex(candidates);
    const platform = {} as Record<
        ContainerCandidateArch,
        ContainerReconcilePlatformEntry
    >;
    for (const arch of CONTAINER_CANDIDATE_ARCHS) {
        const candidate = candidates.byPlatform[arch];
        platform[arch] = {
            arch,
            platform: candidate.platform,
            tag: `${tagPlan.version_tag}-${arch}`,
            media_type: candidate.image.mediaType,
            digest: candidate.image.digest,
            size: candidate.image.bytes.byteLength,
            manifest_file: CONTAINER_PLATFORM_MANIFEST_FILE(arch),
            config: candidate.image.config,
            layers: [...candidate.image.layers],
        };
    }
    return {
        schema: CONTAINER_RECONCILE_PLAN_SCHEMA,
        image,
        repository,
        version: candidates.version,
        source_ref: candidates.sourceRef,
        platform_tags: [...tagPlan.platform_tags],
        index_tags: [...tagPlan.index_tags],
        platform,
        index: {
            media_type: CONTAINER_INDEX_MEDIA_TYPE,
            digest: assembly.digest,
            size: assembly.bytes.byteLength,
            file: CONTAINER_INDEX_FILE,
        },
    };
};

export type ContainerReconcilePlatformDocument = {
    readonly arch: string;
    readonly platform: string;
    readonly tag: string;
    readonly media_type: string;
    readonly digest: string;
    readonly size: number;
    readonly manifest_file: string;
    readonly config: unknown;
    readonly layers: ReadonlyArray<unknown>;
};

const parsePlatformEntry = (
    arch: ContainerCandidateArch,
    value: unknown,
): ContainerReconcilePlatformEntry => {
    if (!isRecord(value)) {
        return fail(`Reconcile plan platform '${arch}' must be an object.`);
    }
    exactKeys(
        value,
        [
            "arch",
            "platform",
            "tag",
            "media_type",
            "digest",
            "size",
            "manifest_file",
            "config",
            "layers",
        ],
        `reconcile plan platform ${arch}`,
    );
    const parsedArch = stringField(value, "arch", "reconcile plan platform");
    if (parsedArch !== arch) {
        return fail(
            `Reconcile plan platform key '${arch}' must record arch '${arch}', found '${parsedArch}'.`,
        );
    }
    const platform = stringField(value, "platform", "reconcile plan platform");
    if (platform !== containerCandidatePlatform(arch)) {
        return fail(
            `Reconcile plan platform ${arch} must be '${containerCandidatePlatform(arch)}', found '${platform}'.`,
        );
    }
    const tag = stringField(value, "tag", "reconcile plan platform");
    const mediaType = stringField(
        value,
        "media_type",
        "reconcile plan platform",
    );
    const digest = stringField(value, "digest", "reconcile plan platform");
    const manifestFile = stringField(
        value,
        "manifest_file",
        "reconcile plan platform",
    );
    const size = assertPositiveSize(value.size, "reconcile plan platform");
    assertOciSafeTag(tag, `${arch} platform tag`);
    assertDigest(digest, `${arch} platform`);
    assertRelativeSafeFile(manifestFile, `${arch} manifest`);
    if (
        !(IMAGE_MANIFEST_MEDIA_TYPES as readonly string[]).includes(mediaType)
    ) {
        return fail(
            `Reconcile plan platform ${arch} media_type '${mediaType}' is not a supported image manifest type.`,
        );
    }
    const layersValue = value.layers;
    if (
        !Array.isArray(layersValue) ||
        layersValue.some((layer) => !isRecord(layer))
    ) {
        return fail(
            `Reconcile plan platform ${arch} must have an object-array 'layers'.`,
        );
    }
    return {
        arch,
        platform: containerCandidatePlatform(arch),
        tag,
        media_type: mediaType as ManifestMediaType,
        digest,
        size,
        manifest_file: manifestFile,
        config: blobDescriptorFromPlan(arch, value.config, "config descriptor"),
        layers: (layersValue as ReadonlyArray<Record<string, unknown>>).map(
            (layer, index) =>
                blobDescriptorFromPlan(arch, layer, `layer ${index + 1}`),
        ),
    };
};

/**
 * Strictly re-validate a persisted `ralphie.container-reconcile-plan.v1`
 * document. Every field is checked exactly as the plan builder emits it, and
 * every cross-field invariant (digests, sizes, media types, platform tags
 * matching the plan's platform_tags list, index tags from the tag plan, OCI
 * tag safety) is re-asserted so a corrupted or hand-edited plan fails closed
 * in the reconciler.
 */
export const parseContainerReconcilePlan = (
    raw: string,
): ContainerReconcilePlan => {
    const value = parseJsonObject(raw, "Container reconcile plan");
    exactKeys(
        value,
        [
            "schema",
            "image",
            "repository",
            "version",
            "source_ref",
            "platform_tags",
            "index_tags",
            "platform",
            "index",
        ],
        "container reconcile plan",
    );
    const header = parsePlanDocumentFields(value);
    const platformTags = stringArrayField(
        value,
        "platform_tags",
        "container reconcile plan",
    );
    const indexTags = stringArrayField(
        value,
        "index_tags",
        "container reconcile plan",
    );
    assertPlanTagLists(platformTags, indexTags);
    const platform = parsePlanPlatformMap(value);
    assertPlanPlatformTagsMatch(platformTags, platform);
    const index = parsePlanIndexSection(value.index);
    return {
        schema: CONTAINER_RECONCILE_PLAN_SCHEMA,
        image: header.image,
        repository: header.repository,
        version: header.version,
        source_ref: header.sourceRef,
        platform_tags: [...platformTags],
        index_tags: [...indexTags],
        platform,
        index,
    };
};

const parseJsonObject = (
    raw: string,
    label: string,
): Record<string, unknown> => {
    let value: unknown;
    try {
        value = JSON.parse(raw) as unknown;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fail(`${label} is not valid JSON: ${message}`);
    }
    if (isRecord(value)) return value;
    return fail(`${label} must be a JSON object.`);
};

type ParsedPlanHeader = {
    readonly image: string;
    readonly repository: string;
    readonly version: string;
    readonly sourceRef: string;
};

const parsePlanDocumentFields = (
    value: Record<string, unknown>,
): ParsedPlanHeader => {
    const schema = stringField(value, "schema", "container reconcile plan");
    if (schema !== CONTAINER_RECONCILE_PLAN_SCHEMA) {
        return fail(
            `Container reconcile plan schema must be '${CONTAINER_RECONCILE_PLAN_SCHEMA}', found '${schema}'.`,
        );
    }
    const image = stringField(value, "image", "container reconcile plan");
    const repository = stringField(
        value,
        "repository",
        "container reconcile plan",
    );
    if (repository !== imageReference(image)) {
        return fail(
            "Container reconcile plan repository must be derived from the image reference.",
        );
    }
    const version = stringField(value, "version", "container reconcile plan");
    if (!VERSION_NO_V_PATTERN.test(version)) {
        return fail(
            `Container reconcile plan version '${version}' must be canonical <major>.<minor>.<patch> without 'v'.`,
        );
    }
    const sourceRef = stringField(
        value,
        "source_ref",
        "container reconcile plan",
    );
    if (!COMMIT_SHA_PATTERN.test(sourceRef)) {
        return fail(
            "Container reconcile plan source_ref must be a 40-character lowercase commit SHA.",
        );
    }
    return { image, repository, version, sourceRef };
};

const assertPlanTagLists = (
    platformTags: ReadonlyArray<string>,
    indexTags: ReadonlyArray<string>,
): void => {
    if (platformTags.length !== CONTAINER_CANDIDATE_ARCHS.length) {
        return fail(
            `Container reconcile plan platform_tags must contain exactly ${CONTAINER_CANDIDATE_ARCHS.length} entries.`,
        );
    }
    if (new Set(indexTags).size !== indexTags.length) {
        return fail(
            "Container reconcile plan index_tags must be deduplicated.",
        );
    }
    for (const tag of [...platformTags, ...indexTags]) {
        assertOciSafeTag(tag, "reconcile plan");
    }
};

const parsePlanPlatformMap = (
    value: Record<string, unknown>,
): Record<ContainerCandidateArch, ContainerReconcilePlatformEntry> => {
    const platformValue = value.platform;
    if (!isRecord(platformValue)) {
        return fail("Container reconcile plan must have a 'platform' object.");
    }
    exactKeys(
        platformValue,
        CONTAINER_CANDIDATE_ARCHS,
        "reconcile plan platform map",
    );
    const platform = {} as Record<
        ContainerCandidateArch,
        ContainerReconcilePlatformEntry
    >;
    for (const arch of CONTAINER_CANDIDATE_ARCHS) {
        platform[arch] = parsePlatformEntry(arch, platformValue[arch]);
    }
    if (platform.amd64.digest === platform.arm64.digest) {
        return fail(
            "The two platform manifests in the reconcile plan must have unique digests.",
        );
    }
    return platform;
};

const assertPlanPlatformTagsMatch = (
    platformTags: ReadonlyArray<string>,
    platform: Record<ContainerCandidateArch, ContainerReconcilePlatformEntry>,
): void => {
    const expectedPlatformTags = CONTAINER_CANDIDATE_ARCHS.map(
        (arch) => platform[arch].tag,
    );
    if (
        platformTags.length !== expectedPlatformTags.length ||
        platformTags.some((tag, index) => tag !== expectedPlatformTags[index])
    ) {
        return fail(
            "Container reconcile plan platform_tags must equal the per-platform tag list in amd64, arm64 order.",
        );
    }
};

const parsePlanIndexSection = (
    value: unknown,
): ContainerReconcilePlan["index"] => {
    if (!isRecord(value)) {
        return fail("Container reconcile plan must have an 'index' object.");
    }
    exactKeys(
        value,
        ["media_type", "digest", "size", "file"],
        "reconcile plan index",
    );
    const indexMediaType = stringField(
        value,
        "media_type",
        "reconcile plan index",
    );
    if (indexMediaType !== CONTAINER_INDEX_MEDIA_TYPE) {
        return fail(
            `Reconcile plan index media_type must be '${CONTAINER_INDEX_MEDIA_TYPE}', found '${indexMediaType}'.`,
        );
    }
    const indexDigest = stringField(value, "digest", "reconcile plan index");
    const indexFile = stringField(value, "file", "reconcile plan index");
    const indexSize = assertPositiveSize(value.size, "reconcile plan index");
    assertDigest(indexDigest, "reconcile plan index");
    assertRelativeSafeFile(indexFile, "reconcile plan index");
    return {
        media_type: CONTAINER_INDEX_MEDIA_TYPE,
        digest: indexDigest,
        size: indexSize,
        file: indexFile,
    };
};