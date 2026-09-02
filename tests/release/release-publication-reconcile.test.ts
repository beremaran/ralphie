import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    test,
} from "bun:test";

import {
    reconcileReleasePublication,
    RELEASE_ASSET_NAMES,
    ReleaseAssetConflictError,
    ReleaseArtifactVerificationError,
    ReleaseCreateConflictError,
    ReleaseHandleValidationError,
    ReleaseNotesMismatchError,
    ReleasePreflightError,
    type ReleaseAssetReference,
    type ReleaseHandle,
    type ReleasePublicationOutcome,
} from "../../src/release/release-publication.ts";

/**
 * Deterministic tests for the release publication reconciliation seam
 * (`src/release/release-publication.ts`), which re-implements the `publish`
 * job steps of `.github/workflows/release.yml` ("Create or reuse draft
 * release handle" and "Upload assets and publish GitHub release") against a
 * narrow injected GitHub API/CLI adapter.
 *
 * The tests never contact GitHub or any registry: staged asset bytes live in
 * files under a disposable temp directory, and the GitHub API is the
 * in-memory fake below, which records every read and records mutations in a
 * channel-tagged ledger (`release-asset`, `image`, `npm`, `formula`). The
 * reconciliation seam only ever drives the `release-asset` channel; failure
 * scenarios additionally prove that zero image, npm, or formula mutations
 * occur.
 */

const OWNER = "beremaran";
const REPO = "ralphie";
const TAG = "v1.2.3";
const VERSION = "1.2.3";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const OTHER_COMMIT = "0123456789abcdef0123456789abcdef01234566";
const FAKE_PUBLISHED_AT = "2025-03-01T00:00:00Z";

const MUTATION_CHANNELS = ["release-asset", "image", "npm", "formula"] as const;

type MutationChannel = (typeof MUTATION_CHANNELS)[number];

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

const sha256Hex = (bytes: Uint8Array): string =>
    createHash("sha256").update(bytes).digest("hex");

/** Deterministic per-name binary bytes, identical for staging and seeding. */
const binaryBytesFor = (name: string): Uint8Array =>
    text(`fixture-binary:${name}:${VERSION}`);

const checksumManifestBytes = (): Uint8Array =>
    text(
        RELEASE_ASSET_NAMES.map((name) =>
            name === "SHA256SUMS" || name === "SHA256SUMS.sigstore.json"
                ? ""
                : `${sha256Hex(binaryBytesFor(name))}  ${name}`,
        )
            .filter((line) => line !== "")
            .join("\n") + "\n",
    );

const sigstoreBundleBytes = (): Uint8Array =>
    text(
        JSON.stringify({
            mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
            messageSignature: {
                messageDigest: {
                    algorithm: "SHA2_256",
                    digest: Buffer.from(
                        sha256Hex(checksumManifestBytes()),
                        "hex",
                    ).toString("base64"),
                },
            },
            verificationMaterial: {},
        }),
    );

const stagedBytesOf = (name: string): Uint8Array => {
    if (name === "SHA256SUMS") return checksumManifestBytes();
    if (name === "SHA256SUMS.sigstore.json") return sigstoreBundleBytes();
    return binaryBytesFor(name);
};

const writeStagedAssets = async (dir: string): Promise<void> => {
    for (const name of RELEASE_ASSET_NAMES) {
        await writeFile(join(dir, name), stagedBytesOf(name));
    }
};

let sandbox: string | undefined;
let assetsDir: string;

beforeAll(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "ralphie-release-publication-"));
    const repositoryRoot = resolve(import.meta.dir, "..", "..");
    const relation = relative(repositoryRoot, sandbox);
    if (!(relation === ".." || relation.startsWith(`..${sep}`))) {
        await rm(sandbox, { force: true, recursive: true });
        throw new Error(
            `release publication sandbox is inside the checkout: ${sandbox}`,
        );
    }
    assetsDir = join(sandbox, "release-assets");
    await mkdir(assetsDir, { recursive: true });
});

beforeEach(async () => {
    if (assetsDir === undefined) throw new Error("sandbox was not created");
    await writeStagedAssets(assetsDir);
});

afterAll(async () => {
    if (sandbox !== undefined) {
        await rm(sandbox, { force: true, recursive: true });
    }
});

const generatedNotesFor = (tag: string): string =>
    `Generated release notes for ${tag}`;

type FakeObservation =
    | { readonly kind: "read"; readonly op: string; readonly detail: string }
    | {
          readonly kind: "mutation";
          readonly channel: MutationChannel;
          readonly op: string;
          readonly detail: string;
      };

type FakeReleaseRecord = {
    readonly id: number;
    readonly tag: string;
    readonly commit: string;
    readonly uploadUrlId: number | null;
    draft: boolean;
    publishedAt: string | null;
    readonly body: string;
    readonly assets: FakeAssetRecord[];
};

type FakeAssetRecord = {
    readonly id: number;
    readonly releaseId: number;
    readonly name: string;
    readonly bytes: Uint8Array;
};

type FakeReleaseSnapshot = {
    readonly id: number;
    readonly tag: string;
    readonly commit: string;
    readonly draft: boolean;
    readonly publishedAt: string | null;
    readonly assetCount: number;
};

/**
 * In-memory fake for the workflow's `gh`/REST GitHub surface. It records
 * every read (tag/id lookups, asset enumeration, per-asset downloads,
 * generated notes, create conflicts) and every mutation in a channel-tagged
 * ledger. The reconciliation seam drives only the `release-asset` channel;
 * the `image`, `npm`, and `formula` channels exist so tests can prove zero
 * cross-channel mutations, and the `delete` op exists only to prove the
 * contract never deletes. Seeding helpers bypass the ledger, exactly like
 * pre-existing GitHub state.
 */
class FakeReleasePublicationApi {
    readonly owner: string;
    readonly repo: string;
    private readonly records = new Map<number, FakeReleaseRecord>();
    private readonly idsByTag = new Map<string, number>();
    private readonly assetsById = new Map<number, FakeAssetRecord>();
    private nextReleaseId = 1000;
    private nextAssetId = 5000;
    private uploadCounter = 0;
    private failUploadAtIndex: number | undefined;
    private readonly ledger: FakeObservation[] = [];
    private readonly beforeCreateHooks: Array<() => void> = [];

    constructor(owner: string, repo: string) {
        this.owner = owner;
        this.repo = repo;
    }

    // ---- seeding helpers (bypass the ledger, like pre-existing state) ----

    seedRelease(input: {
        readonly tag: string;
        readonly commit: string;
        readonly draft?: boolean;
        readonly body?: string;
        /** Corrupt the validated handle: embed this id in the upload URL. */
        readonly uploadUrlId?: number;
    }): number {
        const draft = input.draft ?? true;
        const id = this.nextReleaseId;
        this.nextReleaseId += 1;
        const record: FakeReleaseRecord = {
            id,
            tag: input.tag,
            commit: input.commit,
            uploadUrlId: input.uploadUrlId ?? null,
            draft,
            publishedAt: draft ? null : FAKE_PUBLISHED_AT,
            body: input.body ?? generatedNotesFor(input.tag),
            assets: [],
        };
        this.records.set(id, record);
        this.idsByTag.set(input.tag, id);
        return id;
    }

    seedAssets(
        releaseId: number,
        assets: ReadonlyArray<{
            readonly name: string;
            readonly bytes: Uint8Array;
        }>,
    ): void {
        const record = this.requireRecord(releaseId);
        for (const asset of assets) {
            this.pushAsset(record, asset.name, asset.bytes);
        }
    }

    /** Seed the tag during the next create attempt, then make it conflict. */
    onceBeforeCreate(hook: () => void): void {
        this.beforeCreateHooks.push(hook);
    }

    /** Fail the upload at the Nth upload call since this knob was set. */
    setFailUploadAt(index: number | undefined): void {
        this.failUploadAtIndex = index;
        this.uploadCounter = 0;
    }

    // ---- state queries for assertions ----

    releaseCount(): number {
        return this.records.size;
    }

    releaseForTag(tag: string): FakeReleaseSnapshot | undefined {
        const id = this.idsByTag.get(tag);
        if (id === undefined) return undefined;
        const record = this.requireRecord(id);
        return {
            id: record.id,
            tag: record.tag,
            commit: record.commit,
            draft: record.draft,
            publishedAt: record.publishedAt,
            assetCount: record.assets.length,
        };
    }

    assetNames(releaseId: number): readonly string[] {
        return this.requireRecord(releaseId).assets.map((asset) => asset.name);
    }

    assetBytes(releaseId: number, name: string): Uint8Array | undefined {
        return this.requireRecord(releaseId).assets.find(
            (asset) => asset.name === name,
        )?.bytes;
    }

    observations(): readonly FakeObservation[] {
        return [...this.ledger];
    }

    takeObservations(): readonly FakeObservation[] {
        return this.ledger.splice(0, this.ledger.length);
    }

    mutations(): readonly FakeObservation[] {
        return this.ledger.filter(
            (observation) => observation.kind === "mutation",
        );
    }

    mutationsOfChannel(channel: MutationChannel): readonly FakeObservation[] {
        return this.ledger.filter(
            (observation) =>
                observation.kind === "mutation" &&
                observation.channel === channel,
        );
    }

    // ---- adapter implementation (recorded) ----

    async getReleaseByTag(tag: string): Promise<ReleaseHandle | undefined> {
        this.recordRead("getReleaseByTag", `tag=${tag}`);
        const id = this.idsByTag.get(tag);
        return id === undefined
            ? undefined
            : this.handleView(this.requireRecord(id));
    }

    async getReleaseById(releaseId: number): Promise<ReleaseHandle> {
        this.recordRead("getReleaseById", `releaseId=${releaseId}`);
        return this.handleView(this.requireRecord(releaseId));
    }

    async createDraftRelease(input: {
        readonly tag: string;
        readonly targetCommitish: string;
    }): Promise<ReleaseHandle> {
        this.beforeCreateHooks.shift()?.();
        const existing = this.idsByTag.get(input.tag);
        if (existing !== undefined) {
            this.recordRead("createRelease", `conflict tag=${input.tag}`);
            throw new ReleaseCreateConflictError({
                message: `Release already exists for tag ${input.tag}`,
            });
        }
        const id = this.nextReleaseId;
        this.nextReleaseId += 1;
        const record: FakeReleaseRecord = {
            id,
            tag: input.tag,
            commit: input.targetCommitish,
            uploadUrlId: null,
            draft: true,
            publishedAt: null,
            body: generatedNotesFor(input.tag),
            assets: [],
        };
        this.records.set(id, record);
        this.idsByTag.set(input.tag, id);
        this.recordMutation(
            "release-asset",
            "create",
            `tag=${input.tag} releaseId=${id}`,
        );
        return this.handleView(record);
    }

    async listReleaseAssets(
        releaseId: number,
    ): Promise<ReadonlyArray<ReleaseAssetReference>> {
        this.recordRead("listReleaseAssets", `releaseId=${releaseId}`);
        return this.requireRecord(releaseId).assets.map((asset) =>
            this.assetView(asset),
        );
    }

    async downloadAssetBytes(
        asset: ReleaseAssetReference,
    ): Promise<Uint8Array> {
        this.recordRead(
            "downloadAsset",
            `assetId=${asset.id} name=${asset.name}`,
        );
        const stored = this.assetsById.get(asset.id);
        if (stored === undefined) {
            throw new Error(`Fixture has no bytes for asset ${asset.id}`);
        }
        return stored.bytes;
    }

    async uploadAsset(input: {
        readonly releaseId: number;
        readonly name: string;
        readonly bytes: Uint8Array;
    }): Promise<void> {
        this.uploadCounter += 1;
        if (this.uploadCounter === this.failUploadAtIndex) {
            throw new Error(`fixture upload failure for ${input.name}`);
        }
        const record = this.requireRecord(input.releaseId);
        this.pushAsset(record, input.name, input.bytes);
        this.recordMutation(
            "release-asset",
            "upload",
            `releaseId=${input.releaseId} name=${input.name}`,
        );
    }

    async generateNotes(tag: string): Promise<string> {
        this.recordRead("generateNotes", `tag=${tag}`);
        return generatedNotesFor(tag);
    }

    async publishRelease(releaseId: number): Promise<void> {
        const record = this.requireRecord(releaseId);
        record.draft = false;
        record.publishedAt = FAKE_PUBLISHED_AT;
        this.recordMutation(
            "release-asset",
            "publish",
            `releaseId=${releaseId}`,
        );
    }

    // ---- internals ----

    private requireRecord(releaseId: number): FakeReleaseRecord {
        const record = this.records.get(releaseId);
        if (record === undefined) {
            throw new Error(`Fixture has no release ${releaseId}`);
        }
        return record;
    }

    private pushAsset(
        record: FakeReleaseRecord,
        name: string,
        bytes: Uint8Array,
    ): FakeAssetRecord {
        const id = this.nextAssetId;
        this.nextAssetId += 1;
        const asset: FakeAssetRecord = {
            id,
            releaseId: record.id,
            name,
            bytes,
        };
        this.assetsById.set(id, asset);
        record.assets.push(asset);
        return asset;
    }

    private handleView(record: FakeReleaseRecord): ReleaseHandle {
        return {
            id: record.id,
            tagName: record.tag,
            targetCommitish: record.commit,
            draft: record.draft,
            publishedAt: record.publishedAt,
            body: record.body,
            uploadUrl: `https://uploads.github.com/repos/${this.owner}/${this.repo}/releases/${record.uploadUrlId ?? record.id}/assets{?name,label}`,
        };
    }

    private assetView(asset: FakeAssetRecord): ReleaseAssetReference {
        const tag = this.requireRecord(asset.releaseId).tag;
        return {
            id: asset.id,
            name: asset.name,
            browserDownloadUrl: `https://github.com/${this.owner}/${this.repo}/releases/download/${tag}/${asset.name}`,
        };
    }

    private recordRead(op: string, detail: string): void {
        this.ledger.push({ kind: "read", op, detail });
    }

    private recordMutation(
        channel: MutationChannel,
        op: string,
        detail: string,
    ): void {
        this.ledger.push({ kind: "mutation", channel, op, detail });
    }
}

const apiFor = (): FakeReleasePublicationApi =>
    new FakeReleasePublicationApi(OWNER, REPO);

const runReconcile = (
    api: FakeReleasePublicationApi,
): Promise<ReleasePublicationOutcome> =>
    reconcileReleasePublication(api, {
        owner: OWNER,
        repo: REPO,
        tag: TAG,
        version: VERSION,
        sourceRef: COMMIT,
        assetsDir,
    });

const opTrace = (api: FakeReleasePublicationApi): readonly string[] =>
    api
        .observations()
        .map((observation) =>
            observation.kind === "read"
                ? `read:${observation.op}`
                : `mutate:${observation.channel}:${observation.op}`,
        );

const expectZeroMutations = (api: FakeReleasePublicationApi): void => {
    for (const channel of MUTATION_CHANNELS) {
        expect(api.mutationsOfChannel(channel)).toEqual([]);
    }
};

const six = [...RELEASE_ASSET_NAMES];

describe("release publication reconciliation seam", () => {
    test("first run creates one validated draft handle, uploads all six assets, and publishes", async () => {
        const api = apiFor();
        const outcome = await runReconcile(api);
        if (outcome.kind !== "created-and-published") {
            throw new Error(`unexpected outcome: ${outcome.kind}`);
        }
        const releaseId = outcome.releaseId;

        expect(api.releaseCount()).toBe(1);
        const release = api.releaseForTag(TAG);
        expect(release?.commit).toBe(COMMIT);
        expect(release?.draft).toBe(false);
        expect(release?.publishedAt).not.toBeNull();
        expect(api.assetNames(releaseId)).toEqual(six);

        // One create, exactly six uploads, one publish mutation; the
        // cross-channel ledger has no image/npm/formula entries at all.
        expect(
            api
                .mutationsOfChannel("release-asset")
                .map((observation) => observation.op),
        ).toEqual([
            "create",
            "upload",
            "upload",
            "upload",
            "upload",
            "upload",
            "upload",
            "publish",
        ]);
        for (const channel of ["image", "npm", "formula"] as const) {
            expect(api.mutationsOfChannel(channel)).toEqual([]);
        }
        expect(opTrace(api)).toEqual([
            "read:getReleaseByTag",
            "mutate:release-asset:create",
            "read:listReleaseAssets",
            "mutate:release-asset:upload",
            "mutate:release-asset:upload",
            "mutate:release-asset:upload",
            "mutate:release-asset:upload",
            "mutate:release-asset:upload",
            "mutate:release-asset:upload",
            "read:getReleaseById",
            "read:generateNotes",
            "mutate:release-asset:publish",
        ]);
    });

    test("a same-tag/same-commit retry reuses the single validated handle with no duplicate upload or second publish", async () => {
        const api = apiFor();
        const first = await runReconcile(api);
        if (first.kind !== "created-and-published") {
            throw new Error(`unexpected first outcome: ${first.kind}`);
        }
        const releaseId = first.releaseId;
        api.takeObservations();

        const second = await runReconcile(api);
        expect(second).toEqual({
            kind: "published-reconciled",
            releaseId,
        });

        // The published handle is terminal: the same id is reused, no second
        // release is created, and no asset bytes or metadata are rewritten.
        expect(api.releaseCount()).toBe(1);
        expect(api.assetNames(releaseId)).toEqual(six);
        expect(api.mutations()).toEqual([]);
        expect(api.mutationsOfChannel("release-asset")).toEqual([]);
        for (const channel of ["image", "npm", "formula"] as const) {
            expect(api.mutationsOfChannel(channel)).toEqual([]);
        }
        expect(opTrace(api)).toEqual([
            "read:getReleaseByTag",
            "read:listReleaseAssets",
            "read:downloadAsset",
            "read:downloadAsset",
            "read:downloadAsset",
            "read:downloadAsset",
            "read:downloadAsset",
            "read:downloadAsset",
            "read:getReleaseById",
            "read:generateNotes",
        ]);
        for (const name of RELEASE_ASSET_NAMES) {
            expect(api.assetBytes(releaseId, name)).toEqual(
                stagedBytesOf(name),
            );
        }
    });

    test("an interrupted run is repaired by a same-tag retry on the same handle without creating duplicates", async () => {
        const api = apiFor();
        // The fourth upload (linux-x64) fails after three succeeded.
        api.setFailUploadAt(4);
        await expect(runReconcile(api)).rejects.toThrow(
            "fixture upload failure",
        );
        expect(api.releaseCount()).toBe(1);
        expect(api.releaseForTag(TAG)?.draft).toBe(true);

        api.setFailUploadAt(undefined);
        const retry = await runReconcile(api);
        const retriedId = api.releaseForTag(TAG);
        if (retriedId === undefined) {
            throw new Error("retry did not reuse the released handle");
        }
        expect(retry).toEqual({
            kind: "draft-repaired-and-published",
            releaseId: retriedId.id,
        });

        // Exactly six distinct asset uploads across both runs, one create,
        // one publish, and no deletes anywhere.
        expect(api.releaseCount()).toBe(1);
        expect(api.assetNames(retriedId.id)).toEqual(six);
        const uploads = api
            .mutationsOfChannel("release-asset")
            .filter((observation) => observation.op === "upload");
        expect(uploads).toHaveLength(6);
        const uploadedNames = uploads.map((observation) => {
            const name = /name=(\S+)$/.exec(observation.detail);
            return name === null ? "" : (name[1] ?? "");
        });
        expect(new Set(uploadedNames).size).toBe(6);
        expect(new Set([...uploadedNames, ...six]).size).toBe(6);
        expect(
            api
                .mutationsOfChannel("release-asset")
                .filter((observation) => observation.op === "create"),
        ).toHaveLength(1);
        expect(
            api
                .mutationsOfChannel("release-asset")
                .filter((observation) => observation.op === "publish"),
        ).toHaveLength(1);
        expect(
            api
                .mutationsOfChannel("release-asset")
                .filter((observation) => observation.op === "delete"),
        ).toEqual([]);
        for (const channel of ["image", "npm", "formula"] as const) {
            expect(api.mutationsOfChannel(channel)).toEqual([]);
        }
    });

    test("a draft retry never re-uploads or touches assets whose bytes already match", async () => {
        const api = apiFor();
        const releaseId = api.seedRelease({ tag: TAG, commit: COMMIT });
        const preSeeded = [
            "ralphie-darwin-arm64",
            "ralphie-linux-x64",
            "SHA256SUMS",
        ];
        api.seedAssets(
            releaseId,
            preSeeded.map((name) => ({ name, bytes: stagedBytesOf(name) })),
        );

        const outcome = await runReconcile(api);
        expect(outcome).toEqual({
            kind: "draft-repaired-and-published",
            releaseId,
        });

        // Only the three missing assets were uploaded; the pre-seeded
        // identical assets were left byte-for-byte untouched.
        const uploads = api
            .mutationsOfChannel("release-asset")
            .filter((observation) => observation.op === "upload");
        expect(uploads.map((observation) => observation.detail)).toEqual([
            "releaseId=1000 name=ralphie-darwin-x64",
            "releaseId=1000 name=ralphie-linux-arm64",
            "releaseId=1000 name=SHA256SUMS.sigstore.json",
        ]);
        expect(api.assetNames(releaseId).slice().sort()).toEqual(
            six.slice().sort(),
        );
        for (const name of preSeeded) {
            expect(api.assetBytes(releaseId, name)).toEqual(
                stagedBytesOf(name),
            );
        }
        expect(
            api
                .mutationsOfChannel("release-asset")
                .filter((observation) => observation.op === "delete"),
        ).toEqual([]);
    });

    test("an already-published handle is terminal: no second upload and no publish mutation", async () => {
        const api = apiFor();
        const releaseId = api.seedRelease({
            tag: TAG,
            commit: COMMIT,
            draft: false,
        });
        api.seedAssets(
            releaseId,
            six.map((name) => ({ name, bytes: stagedBytesOf(name) })),
        );

        const outcome = await runReconcile(api);
        expect(outcome).toEqual({
            kind: "published-reconciled",
            releaseId,
        });
        expect(api.releaseForTag(TAG)?.draft).toBe(false);
        expect(api.releaseForTag(TAG)?.publishedAt).toBe(FAKE_PUBLISHED_AT);
        expect(api.mutationsOfChannel("release-asset")).toEqual([]);
        expectZeroMutations(api);
    });

    test("an existing handle targeting a different commit fails closed before any destructive or publishing call", async () => {
        const api = apiFor();
        api.seedRelease({ tag: TAG, commit: OTHER_COMMIT, draft: true });

        await expect(runReconcile(api)).rejects.toThrow(
            ReleaseHandleValidationError,
        );
        expect(api.releaseForTag(TAG)?.draft).toBe(true);
        expect(api.assetNames(api.releaseForTag(TAG)?.id ?? 0)).toEqual([]);
        expect(opTrace(api)).toEqual(["read:getReleaseByTag"]);
        expectZeroMutations(api);
    });

    test("an existing handle whose upload_url references another release id fails closed before any mutation", async () => {
        const api = apiFor();
        api.seedRelease({
            tag: TAG,
            commit: COMMIT,
            draft: true,
            // The validated handle invariant requires id and upload_url to
            // agree; a conflicting URL is an explicit conflict.
            uploadUrlId: 999,
        });

        await expect(runReconcile(api)).rejects.toThrow(
            ReleaseHandleValidationError,
        );
        expect(api.releaseForTag(TAG)?.draft).toBe(true);
        expect(opTrace(api)).toEqual(["read:getReleaseByTag"]);
        expectZeroMutations(api);
    });

    test("a version/tag mismatch fails the preflight before any API call", async () => {
        const api = apiFor();
        await expect(
            reconcileReleasePublication(api, {
                owner: OWNER,
                repo: REPO,
                tag: TAG,
                version: "1.2.4",
                sourceRef: COMMIT,
                assetsDir,
            }),
        ).rejects.toThrow(ReleasePreflightError);
        expect(api.observations()).toEqual([]);
        expectZeroMutations(api);
    });

    test("a malformed source ref fails the preflight before any API call", async () => {
        const api = apiFor();
        await expect(
            reconcileReleasePublication(api, {
                owner: OWNER,
                repo: REPO,
                tag: TAG,
                version: VERSION,
                sourceRef: "not-a-commit",
                assetsDir,
            }),
        ).rejects.toThrow(ReleasePreflightError);
        expect(api.observations()).toEqual([]);
        expectZeroMutations(api);
    });

    test("a same-name asset with different bytes is never deleted or overwritten", async () => {
        const api = apiFor();
        const releaseId = api.seedRelease({ tag: TAG, commit: COMMIT });
        const foreignBytes = text("foreign-bytes-for-darwin-arm64");
        api.seedAssets(releaseId, [
            { name: "ralphie-darwin-arm64", bytes: foreignBytes },
        ]);

        await expect(runReconcile(api)).rejects.toThrow(
            ReleaseAssetConflictError,
        );
        expect(api.assetBytes(releaseId, "ralphie-darwin-arm64")).toEqual(
            foreignBytes,
        );
        expect(api.assetNames(releaseId)).toEqual(["ralphie-darwin-arm64"]);
        expect(api.releaseForTag(TAG)?.draft).toBe(true);
        expectZeroMutations(api);
    });

    test("a mismatched asset on a published handle also fails closed and stays published", async () => {
        const api = apiFor();
        const releaseId = api.seedRelease({
            tag: TAG,
            commit: COMMIT,
            draft: false,
        });
        const foreignBytes = text("foreign-bytes-for-darwin-arm64");
        api.seedAssets(releaseId, [
            { name: "ralphie-darwin-arm64", bytes: foreignBytes },
        ]);

        await expect(runReconcile(api)).rejects.toThrow(
            ReleaseAssetConflictError,
        );
        expect(api.assetBytes(releaseId, "ralphie-darwin-arm64")).toEqual(
            foreignBytes,
        );
        expect(api.releaseForTag(TAG)?.draft).toBe(false);
        expectZeroMutations(api);
    });

    test("an asset outside the six-asset set is an explicit conflict and is never deleted", async () => {
        const api = apiFor();
        const releaseId = api.seedRelease({ tag: TAG, commit: COMMIT });
        api.seedAssets(releaseId, [
            { name: "release-notes.pdf", bytes: text("notes") },
        ]);

        await expect(runReconcile(api)).rejects.toThrow(
            ReleaseAssetConflictError,
        );
        expect(api.assetBytes(releaseId, "release-notes.pdf")).toEqual(
            text("notes"),
        );
        expectZeroMutations(api);
    });

    test("duplicate same-name assets are an explicit conflict and neither is removed", async () => {
        const api = apiFor();
        const releaseId = api.seedRelease({ tag: TAG, commit: COMMIT });
        api.seedAssets(releaseId, [
            { name: "ralphie-darwin-arm64", bytes: text("first") },
            { name: "ralphie-darwin-arm64", bytes: text("second") },
        ]);

        await expect(runReconcile(api)).rejects.toThrow(
            ReleaseAssetConflictError,
        );
        expect(api.assetNames(releaseId)).toEqual([
            "ralphie-darwin-arm64",
            "ralphie-darwin-arm64",
        ]);
        expectZeroMutations(api);
    });

    test("a published release missing one of the six assets fails closed without uploading", async () => {
        const api = apiFor();
        const releaseId = api.seedRelease({
            tag: TAG,
            commit: COMMIT,
            draft: false,
        });
        api.seedAssets(
            releaseId,
            six
                .filter((name) => name !== "SHA256SUMS.sigstore.json")
                .map((name) => ({ name, bytes: stagedBytesOf(name) })),
        );

        await expect(runReconcile(api)).rejects.toThrow(
            ReleaseAssetConflictError,
        );
        expect(api.assetNames(releaseId)).toHaveLength(5);
        expectZeroMutations(api);
    });

    test("a checksum manifest that does not match the staged binaries fails artifact verification with zero mutations", async () => {
        const api = apiFor();
        await writeFile(
            join(assetsDir, "SHA256SUMS"),
            text(`${"0".repeat(64)}  ralphie-darwin-arm64\n`),
        );

        await expect(runReconcile(api)).rejects.toThrow(
            ReleaseArtifactVerificationError,
        );
        expect(api.observations()).toEqual([]);
        expectZeroMutations(api);
    });

    test("a Sigstore bundle signing different bytes fails artifact verification with zero mutations", async () => {
        const api = apiFor();
        await writeFile(
            join(assetsDir, "SHA256SUMS.sigstore.json"),
            text(
                JSON.stringify({
                    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
                    messageSignature: {
                        messageDigest: {
                            algorithm: "SHA2_256",
                            digest: Buffer.from(
                                "00".repeat(32),
                                "hex",
                            ).toString("base64"),
                        },
                    },
                    verificationMaterial: {},
                }),
            ),
        );

        await expect(runReconcile(api)).rejects.toThrow(
            ReleaseArtifactVerificationError,
        );
        expect(api.observations()).toEqual([]);
        expectZeroMutations(api);
    });

    test("a missing staged asset file fails artifact verification with zero mutations", async () => {
        const api = apiFor();
        await rm(join(assetsDir, "ralphie-linux-x64"), { force: true });

        await expect(runReconcile(api)).rejects.toThrow(
            ReleaseArtifactVerificationError,
        );
        expect(api.observations()).toEqual([]);
        expectZeroMutations(api);
    });

    test("a create conflict resolves by re-reading and validating the returned handle before mutation", async () => {
        const api = apiFor();
        api.onceBeforeCreate(() => {
            api.seedRelease({ tag: TAG, commit: COMMIT, draft: true });
        });

        const outcome = await runReconcile(api);
        const resolvedId = api.releaseForTag(TAG);
        if (resolvedId === undefined) {
            throw new Error("release was not resolved");
        }
        expect(outcome).toEqual({
            kind: "draft-repaired-and-published",
            releaseId: resolvedId.id,
        });
        expect(api.releaseCount()).toBe(1);
        expect(
            api
                .mutationsOfChannel("release-asset")
                .filter((observation) => observation.op === "create"),
        ).toEqual([]);
        expect(opTrace(api)).toEqual([
            "read:getReleaseByTag",
            "read:createRelease",
            "read:getReleaseByTag",
            "read:listReleaseAssets",
            "mutate:release-asset:upload",
            "mutate:release-asset:upload",
            "mutate:release-asset:upload",
            "mutate:release-asset:upload",
            "mutate:release-asset:upload",
            "mutate:release-asset:upload",
            "read:getReleaseById",
            "read:generateNotes",
            "mutate:release-asset:publish",
        ]);
    });

    test("a create conflict whose re-read fails validation is fail-closed with zero mutations", async () => {
        const api = apiFor();
        api.onceBeforeCreate(() => {
            api.seedRelease({ tag: TAG, commit: OTHER_COMMIT, draft: true });
        });

        await expect(runReconcile(api)).rejects.toThrow(
            ReleaseHandleValidationError,
        );
        expect(opTrace(api)).toEqual([
            "read:getReleaseByTag",
            "read:createRelease",
            "read:getReleaseByTag",
        ]);
        expect(api.releaseForTag(TAG)?.draft).toBe(true);
        expect(api.assetNames(api.releaseForTag(TAG)?.id ?? 0)).toEqual([]);
        expectZeroMutations(api);
    });

    test("release notes that do not match the generated notes fail closed without publishing", async () => {
        const api = apiFor();
        const releaseId = api.seedRelease({
            tag: TAG,
            commit: COMMIT,
            body: "custom notes that were never generated",
        });
        api.seedAssets(
            releaseId,
            six.map((name) => ({ name, bytes: stagedBytesOf(name) })),
        );

        await expect(runReconcile(api)).rejects.toThrow(
            ReleaseNotesMismatchError,
        );
        expect(api.releaseForTag(TAG)?.draft).toBe(true);
        expectZeroMutations(api);
    });
});