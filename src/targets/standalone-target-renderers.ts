/**
 * Stable consumer renderers (typed projections) over the standalone release
 * target catalog.
 *
 * Built exclusively on top of the shared query API in
 * `standalone-target-query.ts` and the canonical manifest in
 * `standalone-targets.ts`: every entry point takes unknown input, parses and
 * exact-target-validates the whole manifest through
 * `createStandaloneTargetQueryClient` before deriving anything, and throws
 * before any output value exists for malformed or non-canonical manifests.
 * This module never carries its own target list — the four-target catalog is
 * always read from the validated manifest — and it never edits the query API
 * or the serializers.
 *
 * Documented shapes and format names:
 *
 * - `posix-installer-target` —
 *   `renderPosixInstallerTarget(value, os, arch)` normalizes the
 *   OS/architecture pair through the query API and returns the matching full
 *   manifest record (`StandaloneTarget`). The downloaded asset is exactly the
 *   record's `releaseAssetName`; it is never reconstructed from the pair.
 *
 * - `homebrew-target-rows` —
 *   `renderHomebrewTargetRows(value, version)` returns rows sorted
 *   lexicographically by stable `id`. Each row contains the complete manifest
 *   record nested under `target` — every named field intact
 *   (`releaseAssetName`, `bunCompileTarget`, `targetTriple`, `runner`,
 *   `binaryFormat`, `bunVersion`, `dockerPlatform`) — plus the explicit
 *   `version` input (a plain `<major>.<minor>.<patch>`, never a constant) and
 *   a derived `downloadUrl` built from `target.releaseAssetName` and the
 *   `v<version>` release tag.
 *
 * - `target-documentation-catalog` —
 *   `renderDocumentationTargets(value)` returns the complete catalog sorted
 *   lexicographically by stable `id`, with every validated field preserved,
 *   as typed values for documentation consumers.
 *
 * Consumers pair these typed projections with the document serializers
 * (`serializeStandaloneTargets`, `serializeStandaloneTargetMatrix`) when they
 * need a finished JSON document; the renderers themselves stay in memory.
 */
import { RalphieError } from "../shared/error.ts";
import { createStandaloneTargetQueryClient } from "./standalone-target-query.ts";
import type {
    StandaloneTarget,
    StandaloneTargets,
} from "./standalone-targets.ts";

/** Base of every standalone release download URL on the canonical repository. */
export const RALPHIE_RELEASE_DOWNLOAD_BASE_URL =
    "https://github.com/beremaran/ralphie/releases/download";

/** Release tags on the canonical repository are the version with a `v` prefix. */
const RELEASE_TAG_PREFIX = "v";

const releaseVersionPattern =
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

const describeValue = (value: unknown): string => {
    if (typeof value === "string") return JSON.stringify(value);
    if (value === null) return "null";
    if (Array.isArray(value)) return "an array";
    return `a ${typeof value}`;
};

/**
 * A Homebrew version input that is not a plain `<major>.<minor>.<patch>` with
 * no leading zeros, prerelease, or build suffix.
 */
export class InvalidHomebrewVersionError extends RalphieError {
    override readonly _tag = "InvalidHomebrewVersionError";
    constructor(input: { readonly message: string; readonly cause?: unknown }) {
        super(input);
        this.name = "InvalidHomebrewVersionError";
    }
}

/** Validate unknown input through the canonical query API and return its catalog. */
const validatedCatalogOf = (value: unknown): StandaloneTargets =>
    createStandaloneTargetQueryClient(value).list();

/** Compare two target records by stable `id`, lexicographically. */
const compareTargetIds = (
    left: StandaloneTarget,
    right: StandaloneTarget,
): number => {
    if (left.id < right.id) return -1;
    if (left.id > right.id) return 1;
    return 0;
};

/**
 * Return a frozen copy of the catalog sorted lexicographically by stable
 * `id`; the records themselves are the query API's frozen manifest records.
 */
const sortedCatalog = (
    catalog: ReadonlyArray<StandaloneTarget>,
): ReadonlyArray<StandaloneTarget> =>
    Object.freeze([...catalog].sort(compareTargetIds));

/** Reject anything that is not a plain `<major>.<minor>.<patch>` version. */
const assertHomebrewVersion = (version: string): void => {
    if (releaseVersionPattern.test(version)) return;
    throw new InvalidHomebrewVersionError({
        message: `Homebrew target version must be a plain <major>.<minor>.<patch> with no leading zeros, prerelease, or build suffix; received ${describeValue(version)}.`,
    });
};

/** The `v<version>`-tagged release download URL for an exact asset name. */
const releaseDownloadUrl = (
    version: string,
    releaseAssetName: string,
): string =>
    `${RALPHIE_RELEASE_DOWNLOAD_BASE_URL}/${RELEASE_TAG_PREFIX}${version}/${releaseAssetName}`;

/**
 * POSIX installer mapping (`posix-installer-target`).
 *
 * Normalize an OS/architecture pair through the query API and return the
 * matching full target record. The downloaded asset is that record's
 * `releaseAssetName`; no field (`bunCompileTarget`, `targetTriple`, `runner`,
 * `binaryFormat`, `bunVersion`, `dockerPlatform`) is reconstructed from the
 * asset name.
 */
export const renderPosixInstallerTarget = (
    value: unknown,
    os: string,
    arch: string,
): StandaloneTarget =>
    createStandaloneTargetQueryClient(value).query({ os, arch });

/** A sorted Homebrew row: the full manifest record plus a versioned download URL. */
export type HomebrewTargetRow = {
    /** The complete validated manifest record; every field is preserved. */
    readonly target: StandaloneTarget;
    /** The explicit version input, passed through unmodified. */
    readonly version: string;
    /** `https://github.com/beremaran/ralphie/releases/download/v<version>/<releaseAssetName>`. */
    readonly downloadUrl: string;
};

/**
 * Homebrew mapping (`homebrew-target-rows`).
 *
 * Emit rows sorted lexicographically by stable `id`; each row contains the
 * full manifest record plus a versioned download URL derived from that
 * record's `releaseAssetName`. The version is an explicit validated input,
 * never a constant.
 */
export const renderHomebrewTargetRows = (
    value: unknown,
    version: string,
): ReadonlyArray<HomebrewTargetRow> => {
    assertHomebrewVersion(version);
    return Object.freeze(
        sortedCatalog(validatedCatalogOf(value)).map((target) => ({
            target,
            version,
            downloadUrl: releaseDownloadUrl(version, target.releaseAssetName),
        })),
    );
};

/**
 * Documentation mapping (`target-documentation-catalog`).
 *
 * Emit the complete catalog sorted lexicographically by stable `id`, with all
 * fields available to documentation consumers.
 */
export const renderDocumentationTargets = (
    value: unknown,
): ReadonlyArray<StandaloneTarget> => sortedCatalog(validatedCatalogOf(value));