import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { RalphieError } from "../shared/error.ts";

/**
 * Release-handle and six-asset publication reconciliation, the deterministic
 * seam behind the `publish` job of `.github/workflows/release.yml`
 * ("Create or reuse draft release handle" and "Upload assets and publish
 * GitHub release"). The inline actions/github-script and gh/curl logic cannot
 * be invoked directly from Bun, so this module re-implements the exact
 * contract against a narrow injected GitHub API/CLI adapter
 * (`ReleasePublicationApi`); deterministic tests drive it with the in-memory
 * fake in `tests/release/release-publication-reconcile.test.ts`.
 *
 * Contract highlights (rel20-release-contract):
 * - The six-asset set below is exact: anything else on the release handle is
 *   an explicit conflict, and nothing is ever deleted, overwritten, ignored,
 *   or recreated.
 * - An existing release handle is reused only when its validated tag,
 *   source ref, id/upload_url, and draft/published state all match; a
 *   published handle is terminal and read-only.
 * - Release assets are immutable by name: an existing asset is accepted only
 *   when its downloaded bytes have exactly the staged SHA-256 digest; a
 *   missing asset on a draft handle may be uploaded; a missing asset on a
 *   published handle is an explicit conflict.
 * - Every release-state mutation is preceded by a re-read of the exact
 *   release by id with the same handle invariants, and a create conflict is
 *   resolved only by re-reading by tag and validating the returned handle
 *   before any mutation.
 */

/** The four native binaries on every validated release handle. */
export const RELEASE_BINARY_NAMES = [
    "ralphie-darwin-arm64",
    "ralphie-darwin-x64",
    "ralphie-linux-arm64",
    "ralphie-linux-x64",
] as const;

export type ReleaseBinaryName = (typeof RELEASE_BINARY_NAMES)[number];

/** The exact six-asset set carried by every validated release handle. */
export const RELEASE_ASSET_NAMES = [
    ...RELEASE_BINARY_NAMES,
    "SHA256SUMS",
    "SHA256SUMS.sigstore.json",
] as const;

export type ReleaseAssetName = (typeof RELEASE_ASSET_NAMES)[number];

export const isReleaseAssetName = (value: string): value is ReleaseAssetName =>
    (RELEASE_ASSET_NAMES as readonly string[]).includes(value);

const STABLE_TAG_PATTERN =
    /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$(?![\s\S])/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$(?![\s\S])/;
const MANIFEST_LINE_PATTERN =
    /^[0-9a-f]{64}  (ralphie-darwin-arm64|ralphie-darwin-x64|ralphie-linux-arm64|ralphie-linux-x64)$/;
const UPLOAD_URL_PATTERN =
    /^https:\/\/uploads\.github\.com\/repos\/[^/]+\/[^/]+\/releases\/([1-9][0-9]*)\/assets\{\?name,label\}$/;

export const sha256Hex = (bytes: Uint8Array): string =>
    createHash("sha256").update(bytes).digest("hex");

/** A release handle as returned by the GitHub releases API. */
export type ReleaseHandle = {
    readonly id: number;
    readonly tagName: string;
    readonly targetCommitish: string;
    readonly draft: boolean;
    readonly publishedAt: string | null;
    readonly body: string;
    readonly uploadUrl: string;
};

/** A release asset as returned by the GitHub assets API. */
export type ReleaseAssetReference = {
    readonly id: number;
    readonly name: string;
    readonly browserDownloadUrl: string;
};

/** A GitHub-API create was rejected because a release for the tag exists. */
export class ReleaseCreateConflictError extends RalphieError {}

/** The released tag/version/source-ref context is not a releasable set. */
export class ReleasePreflightError extends RalphieError {}

/** Staged assets are missing or do not match their checksum/signature. */
export class ReleaseArtifactVerificationError extends RalphieError {}

/** A release handle or its assets contradict the validated contract. */
export class ReleaseHandleValidationError extends RalphieError {}

/** An asset is missing, duplicated, extra, or byte-different. */
export class ReleaseAssetConflictError extends RalphieError {}

/** The release body does not equal the notes GitHub generates for the tag. */
export class ReleaseNotesMismatchError extends RalphieError {}

/**
 * The narrow injected GitHub API/CLI surface the reconciler needs: tag/id
 * reads, draft creation (create conflicts surface as
 * `ReleaseCreateConflictError`), asset reads and uploads, generated notes,
 * and the final publish mutation. A production implementation shells out to
 * `gh`/the REST API exactly like the workflow; the deterministic tests inject
 * the in-memory fake.
 */
export type ReleasePublicationApi = {
    getReleaseByTag(tag: string): Promise<ReleaseHandle | undefined>;
    getReleaseById(releaseId: number): Promise<ReleaseHandle>;
    createDraftRelease(input: {
        readonly tag: string;
        readonly targetCommitish: string;
    }): Promise<ReleaseHandle>;
    listReleaseAssets(
        releaseId: number,
    ): Promise<ReadonlyArray<ReleaseAssetReference>>;
    downloadAssetBytes(asset: ReleaseAssetReference): Promise<Uint8Array>;
    uploadAsset(input: {
        readonly releaseId: number;
        readonly name: string;
        readonly bytes: Uint8Array;
    }): Promise<void>;
    generateNotes(tag: string): Promise<string>;
    publishRelease(releaseId: number): Promise<void>;
};

export type ReleasePublicationInput = {
    readonly owner: string;
    readonly repo: string;
    /** Validated release tag, `v<major>.<minor>.<patch>`. */
    readonly tag: string;
    /** Package version, `<major>.<minor>.<patch>` without the leading v. */
    readonly version: string;
    /** Validated 40-character commit SHA targeted by the tag. */
    readonly sourceRef: string;
    /** Directory holding the six release assets. */
    readonly assetsDir: string;
};

/** Byte-verified staged release assets, keyed by canonical asset name. */
export type VerifiedReleaseAssets = {
    readonly byName: Readonly<Record<ReleaseAssetName, Uint8Array>>;
};

export type ChecksumManifestEntry = {
    readonly sha256: string;
    readonly name: string;
};

export type ReleasePublicationOutcome =
    | { readonly kind: "created-and-published"; readonly releaseId: number }
    | {
          readonly kind: "draft-repaired-and-published";
          readonly releaseId: number;
      }
    | { readonly kind: "published-reconciled"; readonly releaseId: number };

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean =>
    left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === (right[index] ?? 0));

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Fail-closed preflight of the released context: the tag must be a stable
 * `v<major>.<minor>.<patch>`, the version must equal the tag without the
 * leading v, and the source ref must be a full commit SHA. Any mismatch
 * aborts before a single API call, matching the workflow's
 * `validate-release-context.ts` seam.
 */
export const assertReleaseInput = (input: ReleasePublicationInput): void => {
    if (!STABLE_TAG_PATTERN.test(input.tag)) {
        throw new ReleasePreflightError({
            message: `Unsupported release tag: ${input.tag}`,
        });
    }
    if (input.version !== input.tag.slice(1)) {
        throw new ReleasePreflightError({
            message: `Release tag ${input.tag} does not match version ${input.version}`,
        });
    }
    if (!COMMIT_SHA_PATTERN.test(input.sourceRef)) {
        throw new ReleasePreflightError({
            message: `Source ref ${input.sourceRef} is not a 40-character lowercase commit SHA`,
        });
    }
    if (input.owner === "" || input.repo === "") {
        throw new ReleasePreflightError({
            message: "Repository owner and name are required",
        });
    }
};

const readAssetFile = async (
    dir: string,
    name: string,
): Promise<Uint8Array> => {
    try {
        return await readFile(join(dir, name));
    } catch (error) {
        throw new ReleaseArtifactVerificationError({
            message: `Release asset ${name} is missing or unreadable: ${
                error instanceof Error ? error.message : String(error)
            }`,
        });
    }
};

/**
 * Parse the rel20 checksum manifest: exactly four
 * `<64-lowercase-hex>  <filename>` lines over the four binaries, with no
 * sidecar, signature, or note lines.
 */
export const parseChecksumManifest = (
    bytes: Uint8Array,
): ReadonlyArray<ChecksumManifestEntry> => {
    const lines = new TextDecoder().decode(bytes).split("\n");
    const entries: ChecksumManifestEntry[] = [];
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        if (index === lines.length - 1 && line === "") break;
        const match = MANIFEST_LINE_PATTERN.exec(line);
        if (match === null) {
            throw new ReleaseArtifactVerificationError({
                message: `SHA256SUMS line ${index + 1} violates the '<64-lowercase-hex>  <filename>' contract`,
            });
        }
        entries.push({
            sha256: match[1] as string,
            name: match[2] as string,
        });
    }
    if (entries.length !== RELEASE_BINARY_NAMES.length) {
        throw new ReleaseArtifactVerificationError({
            message: `SHA256SUMS must contain exactly ${RELEASE_BINARY_NAMES.length} entries, found ${entries.length}`,
        });
    }
    return entries;
};

const isVerifiedSigstoreBundle = (
    value: unknown,
): value is {
    readonly mediaType: string;
    readonly messageSignature: {
        readonly messageDigest: {
            readonly algorithm: string;
            readonly digest: string;
        };
    };
} => {
    if (!isRecord(value)) return false;
    if (typeof value.mediaType !== "string") return false;
    if (!isRecord(value.verificationMaterial)) return false;
    const signature = value.messageSignature;
    if (!isRecord(signature) || !isRecord(signature.messageDigest))
        return false;
    const digest = signature.messageDigest;
    return digest.algorithm === "SHA2_256" && typeof digest.digest === "string";
};

/**
 * Verify the Sigstore bundle shape and that it signs exactly the staged
 * SHA256SUMS bytes (hex-decoded message digest), mirroring the workflow's
 * jq + `base64 -d | od` checks.
 */
export const verifySigstoreBundleBytes = (
    bundleBytes: Uint8Array,
    manifestSha256: string,
): void => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(new TextDecoder().decode(bundleBytes)) as unknown;
    } catch {
        throw new ReleaseArtifactVerificationError({
            message: "SHA256SUMS.sigstore.json is not valid JSON",
        });
    }
    if (!isVerifiedSigstoreBundle(parsed)) {
        throw new ReleaseArtifactVerificationError({
            message: "SHA256SUMS.sigstore.json is not a valid Sigstore bundle",
        });
    }
    const signedHex = Buffer.from(
        parsed.messageSignature.messageDigest.digest,
        "base64",
    ).toString("hex");
    if (signedHex !== manifestSha256) {
        throw new ReleaseArtifactVerificationError({
            message:
                "SHA256SUMS.sigstore.json signs a different manifest than the staged SHA256SUMS",
        });
    }
};

/**
 * Read and verify the staged assets before any API call: every asset file
 * must exist, the checksum manifest must byte-match a fresh recomputation
 * from the exact staged binaries, and the Sigstore bundle must sign exactly
 * the staged checksum manifest.
 */
export const verifyStagedReleaseAssets = async (
    assetsDir: string,
): Promise<VerifiedReleaseAssets> => {
    const binaries = new Map<ReleaseBinaryName, Uint8Array>();
    for (const name of RELEASE_BINARY_NAMES) {
        binaries.set(name, await readAssetFile(assetsDir, name));
    }
    const checksumManifest = await readAssetFile(assetsDir, "SHA256SUMS");
    const sigstoreBundle = await readAssetFile(
        assetsDir,
        "SHA256SUMS.sigstore.json",
    );
    const stagedBinary = (name: ReleaseBinaryName): Uint8Array => {
        const bytes = binaries.get(name);
        if (bytes === undefined) {
            throw new ReleaseArtifactVerificationError({
                message: `Release asset ${name} is missing`,
            });
        }
        return bytes;
    };
    const recomputed = new TextEncoder().encode(
        RELEASE_BINARY_NAMES.map(
            (name) => `${sha256Hex(stagedBinary(name))}  ${name}`,
        ).join("\n") + "\n",
    );
    if (!bytesEqual(checksumManifest, recomputed)) {
        throw new ReleaseArtifactVerificationError({
            message:
                "SHA256SUMS does not match the exact staged binary digests",
        });
    }
    parseChecksumManifest(checksumManifest);
    const manifestSha256 = sha256Hex(checksumManifest);
    verifySigstoreBundleBytes(sigstoreBundle, manifestSha256);
    return {
        byName: {
            "ralphie-darwin-arm64": stagedBinary("ralphie-darwin-arm64"),
            "ralphie-darwin-x64": stagedBinary("ralphie-darwin-x64"),
            "ralphie-linux-arm64": stagedBinary("ralphie-linux-arm64"),
            "ralphie-linux-x64": stagedBinary("ralphie-linux-x64"),
            SHA256SUMS: checksumManifest,
            "SHA256SUMS.sigstore.json": sigstoreBundle,
        },
    };
};

/**
 * Validate every release-handle invariant used by the workflow's github-script
 * step and its `assert_release_handle` re-read: positive safe integer id,
 * exact tag and source ref, a consistent draft/published state, and an
 * upload_url that references exactly this release id.
 */
export const validateReleaseHandle = (
    release: ReleaseHandle,
    tag: string,
    sourceRef: string,
): ReleaseHandle => {
    if (!Number.isSafeInteger(release.id) || release.id <= 0) {
        throw new ReleaseHandleValidationError({
            message: `Release id is invalid: ${release.id}`,
        });
    }
    if (release.tagName !== tag) {
        throw new ReleaseHandleValidationError({
            message: `Release tag mismatch: expected ${tag}, got ${release.tagName}`,
        });
    }
    if (release.targetCommitish !== sourceRef) {
        throw new ReleaseHandleValidationError({
            message: `Release target mismatch: expected ${sourceRef}, got ${release.targetCommitish}`,
        });
    }
    if (typeof release.draft !== "boolean") {
        throw new ReleaseHandleValidationError({
            message: "Release draft state is missing or invalid",
        });
    }
    if (release.draft && release.publishedAt !== null) {
        throw new ReleaseHandleValidationError({
            message: "A draft release must not have a published timestamp",
        });
    }
    if (!release.draft && typeof release.publishedAt !== "string") {
        throw new ReleaseHandleValidationError({
            message: "A published release must have a published timestamp",
        });
    }
    const match = UPLOAD_URL_PATTERN.exec(release.uploadUrl);
    if (
        match === null ||
        Number(match[1] as string) !== release.id ||
        typeof release.uploadUrl !== "string"
    ) {
        throw new ReleaseHandleValidationError({
            message: "Release upload_url is missing or invalid",
        });
    }
    return release;
};

/**
 * Resolve the single validated release handle for the tag. An existing
 * handle is reused as-is; a missing handle is created as a draft; a create
 * conflict (422) is resolved only by re-reading by tag — and in every case
 * the returned handle is fully validated before the caller may mutate
 * anything on it.
 */
export const resolveReleaseHandle = async (
    api: ReleasePublicationApi,
    input: ReleasePublicationInput,
): Promise<{
    readonly release: ReleaseHandle;
    readonly origin: "created" | "existing";
}> => {
    const existing = await api.getReleaseByTag(input.tag);
    if (existing !== undefined) {
        return {
            release: validateReleaseHandle(
                existing,
                input.tag,
                input.sourceRef,
            ),
            origin: "existing" as const,
        };
    }
    try {
        const created = await api.createDraftRelease({
            tag: input.tag,
            targetCommitish: input.sourceRef,
        });
        return {
            release: validateReleaseHandle(created, input.tag, input.sourceRef),
            origin: "created" as const,
        };
    } catch (error) {
        if (!(error instanceof ReleaseCreateConflictError)) throw error;
        const reread = await api.getReleaseByTag(input.tag);
        if (reread === undefined) {
            throw new ReleaseHandleValidationError({
                message:
                    "Release creation conflicted but no release could be found",
            });
        }
        return {
            release: validateReleaseHandle(reread, input.tag, input.sourceRef),
            origin: "existing" as const,
        };
    }
};

const expectedDownloadUrl = (
    input: ReleasePublicationInput,
    name: string,
): string =>
    `https://github.com/${input.owner}/${input.repo}/releases/download/${input.tag}/${name}`;

const assertNoUnexpectedAssets = (
    remote: ReadonlyArray<ReleaseAssetReference>,
    releaseId: number,
): void => {
    for (const asset of remote) {
        if (!isReleaseAssetName(asset.name)) {
            throw new ReleaseAssetConflictError({
                message: `Release ${releaseId} has assets outside the exact six-asset contract: ${asset.name}`,
            });
        }
    }
};

/**
 * Reconcile one asset by name: duplicates are conflicts, an existing asset
 * is accepted only byte-identical, and a missing asset is uploaded only on
 * a draft handle.
 */
const reconcileOneAsset = async (
    api: ReleasePublicationApi,
    input: ReleasePublicationInput,
    release: ReleaseHandle,
    name: ReleaseAssetName,
    staged: Uint8Array,
    remote: ReadonlyArray<ReleaseAssetReference>,
): Promise<void> => {
    const matches = remote.filter((asset) => asset.name === name);
    if (matches.length > 1) {
        throw new ReleaseAssetConflictError({
            message: `Release contains duplicate assets named ${name}`,
        });
    }
    const existing = matches[0];
    if (existing === undefined) {
        if (!release.draft) {
            throw new ReleaseAssetConflictError({
                message: `Published release ${release.id} is missing asset ${name}; refusing to upload, delete, or republish`,
            });
        }
        await api.uploadAsset({ releaseId: release.id, name, bytes: staged });
        return;
    }
    if (existing.browserDownloadUrl !== expectedDownloadUrl(input, name)) {
        throw new ReleaseAssetConflictError({
            message: `Release asset ${name} has an unexpected download URL`,
        });
    }
    const remoteBytes = await api.downloadAssetBytes(existing);
    if (sha256Hex(remoteBytes) !== sha256Hex(staged)) {
        throw new ReleaseAssetConflictError({
            message: `Existing release asset differs: ${name}`,
        });
    }
};

/**
 * Reconcile the exact six-asset set on the validated handle. Extra assets
 * and duplicate names are explicit conflicts (never deleted or ignored);
 * an existing asset is accepted only when its downloaded bytes have exactly
 * the staged SHA-256 (never overwritten); a missing asset is uploaded only
 * on a draft handle.
 */
export const reconcileReleaseAssets = async (
    api: ReleasePublicationApi,
    input: ReleasePublicationInput,
    release: ReleaseHandle,
    assets: VerifiedReleaseAssets,
): Promise<void> => {
    const remote = await api.listReleaseAssets(release.id);
    assertNoUnexpectedAssets(remote, release.id);
    for (const name of RELEASE_ASSET_NAMES) {
        const staged = assets.byName[name];
        if (staged === undefined) {
            throw new ReleaseArtifactVerificationError({
                message: `Staged asset ${name} is missing`,
            });
        }
        await reconcileOneAsset(api, input, release, name, staged, remote);
    }
};

/**
 * Re-read the exact release by id and re-assert every handle invariant plus
 * the draft state observed at resolution. Any mismatch fails closed
 * immediately before the caller's next mutation.
 */
export const assertReleaseHandleByState = async (
    api: ReleasePublicationApi,
    input: ReleasePublicationInput,
    releaseId: number,
    expectedDraft: boolean,
): Promise<ReleaseHandle> => {
    const reread = await api.getReleaseById(releaseId);
    validateReleaseHandle(reread, input.tag, input.sourceRef);
    if (reread.draft !== expectedDraft) {
        throw new ReleaseHandleValidationError({
            message: `Release ${releaseId} draft state changed from ${expectedDraft} to ${reread.draft}`,
        });
    }
    return reread;
};

/**
 * Verify the release notes as handle content: non-empty and byte-identical
 * to the notes GitHub generates for the validated tag.
 */
export const verifyReleaseNotes = async (
    api: ReleasePublicationApi,
    release: ReleaseHandle,
): Promise<void> => {
    if (release.body.length === 0) {
        throw new ReleaseNotesMismatchError({
            message: `Release ${release.id} has empty or missing release notes`,
        });
    }
    const generated = await api.generateNotes(release.tagName);
    if (release.body !== generated) {
        throw new ReleaseNotesMismatchError({
            message: `Release ${release.id} notes do not match the generated notes for tag ${release.tagName}`,
        });
    }
};

/**
 * Publish the validated release idempotently:
 *
 * 1. preflight the tag/version/source-ref context (no API calls);
 * 2. verify the staged six-asset set (no API calls);
 * 3. resolve/reuse the single validated release handle (draft creation with
 *    conflict re-read);
 * 4. reconcile the six assets (uploads only for missing assets on draft
 *    handles);
 * 5. re-read and re-validate the handle, verify notes, and publish only a
 *    draft. A published handle is terminal and never mutated.
 */
export const reconcileReleasePublication = async (
    api: ReleasePublicationApi,
    input: ReleasePublicationInput,
): Promise<ReleasePublicationOutcome> => {
    assertReleaseInput(input);
    const assets = await verifyStagedReleaseAssets(input.assetsDir);
    const { release, origin } = await resolveReleaseHandle(api, input);
    await reconcileReleaseAssets(api, input, release, assets);
    const reread = await assertReleaseHandleByState(
        api,
        input,
        release.id,
        release.draft,
    );
    await verifyReleaseNotes(api, reread);
    if (!release.draft) {
        return { kind: "published-reconciled", releaseId: release.id };
    }
    await api.publishRelease(release.id);
    return origin === "created"
        ? { kind: "created-and-published", releaseId: release.id }
        : { kind: "draft-repaired-and-published", releaseId: release.id };
};