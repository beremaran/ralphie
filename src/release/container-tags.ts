import { RalphieError } from "../shared/error.ts";
import {
    CONTAINER_CANDIDATE_ARCHS,
    type ContainerCandidateArch,
} from "./container-candidate.ts";

/**
 * Deterministic semver-aware GHCR tag planning (`rel20-publisher-container-
 * tag-plan`), the executable seam behind the `push-container` job of
 * `.github/workflows/release.yml` (steps "Derive container tag plan",
 * "Promote platform images and persist publication subjects", and "Create
 * manifest aliases from immutable digests").
 *
 * The planner consumes the already validated release version and source
 * commit and derives every container tag from parsed SemVer fields; it never
 * truncates with shell `${VERSION%.*}`-style patterns and never delegates tag
 * inference to `docker/metadata-action`. The policy is exact:
 *
 * - the leading `v` is removed;
 * - a prerelease suffix is retained (`1.2.3-rc.1` stays `1.2.3-rc.1`);
 * - the minor alias is derived from the parsed numeric major/minor fields
 *   (`1.2.3-rc.1` -> `1.2`);
 * - `latest` is included only when the SemVer has no prerelease identifier;
 * - `sha-<validated source_ref>` is always included;
 * - the release-index list is exactly ordered and deduplicated.
 *
 * OCI/Docker tags cannot contain `+`, so build metadata is normalized out of
 * every emitted tag (`1.2.3+build.7` produces the OCI-safe tag `1.2.3`)
 * while the full validated version (including the build metadata) is
 * retained in `version` for candidate/image metadata. A raw value such as
 * `1.2.3+build.7` is therefore never passed to a registry. Malformed SemVer,
 * an invalid source ref, or any derived tag that would not be a valid OCI tag
 * name fails closed with `ContainerTagPlanError`, and no alias outside the
 * documented list is ever emitted.
 */

export const CONTAINER_TAG_PLAN_SCHEMA =
    "ralphie.container-tag-plan.v1" as const;

export class ContainerTagPlanError extends RalphieError {}

/** SemVer 2.0.0 grammar, with an optional leading `v` release-tag prefix. */
const SEMVER_PATTERN =
    /^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*)|([0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))(\.((0|[1-9][0-9]*)|([0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)))*)?(\+([0-9A-Za-z-]+)(\.[0-9A-Za-z-]+)*)?$(?![\s\S])/;

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$(?![\s\S])/;

/** OCI Distribution tag name grammar (`[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}`). */
const OCI_TAG_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$/;

export type ParsedContainerVersion = {
    readonly major: number;
    readonly minor: number;
    readonly patch: number;
    /** Prerelease suffix including the leading dash, or null. */
    readonly prerelease: string | null;
    /** Build metadata suffix including the leading plus, or null. */
    readonly build: string | null;
    /** Full version with the leading `v` removed, build metadata retained. */
    readonly version: string;
    /** OCI-safe version: build metadata normalized out. */
    readonly versionTag: string;
};

export type ContainerTagPlanInput = {
    /**
     * Already validated release version. An optional leading `v`, a
     * prerelease suffix, and build metadata are accepted; anything else
     * fails closed.
     */
    readonly version: string;
    /** Already validated 40-character lowercase source commit SHA. */
    readonly sourceRef: string;
    /** Platform architecture suffixes; defaults to the amd64/arm64 pair. */
    readonly platformArchs?: ReadonlyArray<ContainerCandidateArch>;
};

export type ContainerTagPlan = {
    /** The full validated version with the leading `v` removed. */
    readonly version: string;
    /** Validated 40-character lowercase source commit SHA. */
    readonly sourceRef: string;
    readonly major: number;
    readonly minor: number;
    readonly patch: number;
    readonly prerelease: string | null;
    readonly build: string | null;
    /** OCI-safe version tag (<version> without build metadata). */
    readonly versionTag: string;
    /** `<major>.<minor>` alias derived from the parsed numeric fields. */
    readonly minorTag: string;
    /** True only when the SemVer has no prerelease identifier. */
    readonly latest: boolean;
    /** Always-present immutable `sha-<sourceRef>` tag. */
    readonly sourceTag: string;
    /** Platform tag base shared by every platform-specific promotion. */
    readonly platformTagBase: string;
    /** Ordered per-architecture platform tags, `<versionTag>-<arch>`. */
    readonly platformTags: ReadonlyArray<string>;
    /** Exact ordered, deduplicated release-index tag list. */
    readonly indexTags: ReadonlyArray<string>;
};

const fail = (message: string): never => {
    throw new ContainerTagPlanError({ message });
};

const assertOciSafe = (tag: string, description: string): void => {
    if (!OCI_TAG_PATTERN.test(tag) || tag.includes("+")) {
        fail(
            `Derived container tag '${tag}' (${description}) is not a valid OCI/Docker tag name; a tag must match ${String(OCI_TAG_PATTERN)} and must never contain '+'.`,
        );
    }
};

/**
 * Strictly parse a release version (`[v]<major>.<minor>.<patch>[-<prerelease>]
 * [+<build>]`). Numeric components and prerelease identifiers cannot have
 * leading zeroes, every dot-separated identifier must be non-empty, and the
 * value must not carry trailing whitespace or line terminators. Any other
 * value fails closed.
 */
export const parseContainerVersion = (
    version: string,
): ParsedContainerVersion => {
    const match = SEMVER_PATTERN.exec(version);
    if (match === null) {
        return fail(
            `Release version '${version}' is not a valid SemVer 2.0.0 version (v<major>.<minor>.<patch>[-<prerelease>][+<build>]); numeric identifiers cannot have leading zeroes.`,
        );
    }
    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3]);
    const prerelease = match[4] ?? null;
    const build = match[12] ?? null;
    const versionTag = `${major}.${minor}.${patch}${prerelease ?? ""}`;
    assertOciSafe(versionTag, "version tag");
    return {
        major,
        minor,
        patch,
        prerelease,
        build,
        version: `${major}.${minor}.${patch}${prerelease ?? ""}${build ?? ""}`,
        versionTag,
    };
};

/**
 * Compute the exact, deterministic container tag plan for the already
 * validated release version and source commit. The release-index tags are,
 * in order: the OCI-safe version, the `<major>.<minor>` alias, `latest` (only
 * without a prerelease identifier), and `sha-<sourceRef>`, deduplicated. The
 * platform tag base equals the OCI-safe version tag, and each platform tag is
 * that base suffixed with the architecture.
 */
export const planContainerTags = (
    input: ContainerTagPlanInput,
): ContainerTagPlan => {
    if (!COMMIT_SHA_PATTERN.test(input.sourceRef)) {
        fail(
            `Source ref '${input.sourceRef}' must be a 40-character lowercase commit SHA.`,
        );
    }
    const parsed = parseContainerVersion(input.version);
    const platformArchs = input.platformArchs ?? [...CONTAINER_CANDIDATE_ARCHS];
    const platformTags = platformArchs.map(
        (arch) => `${parsed.versionTag}-${arch}`,
    );
    const minorTag = `${parsed.major}.${parsed.minor}`;
    const sourceTag = `sha-${input.sourceRef}`;
    assertOciSafe(minorTag, "minor alias");
    assertOciSafe(sourceTag, "source-ref tag");
    for (const tag of platformTags) {
        assertOciSafe(tag, "platform tag");
    }

    const indexTags: string[] = [];
    const pushUnique = (tag: string): void => {
        if (!indexTags.includes(tag)) indexTags.push(tag);
    };
    pushUnique(parsed.versionTag);
    pushUnique(minorTag);
    if (parsed.prerelease === null) pushUnique("latest");
    pushUnique(sourceTag);

    return {
        version: parsed.version,
        sourceRef: input.sourceRef,
        major: parsed.major,
        minor: parsed.minor,
        patch: parsed.patch,
        prerelease: parsed.prerelease,
        build: parsed.build,
        versionTag: parsed.versionTag,
        minorTag,
        latest: parsed.prerelease === null,
        sourceTag,
        platformTagBase: parsed.versionTag,
        platformTags,
        indexTags,
    };
};