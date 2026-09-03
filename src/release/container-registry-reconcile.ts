import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { RalphieError } from "../shared/error.ts";
import {
    CONTAINER_CANDIDATE_ARCHS,
    type ContainerCandidateArch,
} from "./container-candidate.ts";
import {
    CONTAINER_INDEX_MEDIA_TYPE,
    type ContainerReconcilePlan,
} from "./container-index.ts";
import {
    manifestDigest,
    OCI_IMAGE_INDEX_MEDIA_TYPE,
    probeCreateOnlyPublishing,
    reconcileManifestTag,
    type ManifestMediaType,
    type RegistryBlobDescriptor,
    type RegistryClient,
} from "./registry-reconcile.ts";

/**
 * Verified create-only promotion of the exact validated platform manifests
 * and the one deterministic OCI index (`rel20-publisher-container-registry-
 * reconcile` integration), driven by `scripts/reconcile-container-registry.ts`
 * from the `ralphie.container-reconcile-plan.v1` document.
 *
 * Both stages preflight every destination tag first and reject any mismatch
 * before a production write; exact existing digests are reused (the tag is
 * never moved), missing tags are created only through the server-enforced
 * compare-and-swap that `probeCreateOnlyPublishing` proved against the real
 * registry, and every write is reread. Content (blobs and child manifests)
 * is content-addressed and idempotent, so a partial run is safely repeatable
 * without moving a tag or creating an alternate copy. Authentication and
 * push failures throw and propagate: the platform stage runs before the
 * index stage in the protected publisher, so a failure prevents later alias
 * publication and fails the job.
 */

export class ContainerRegistryReconcileError extends RalphieError {}

const PROBE_TAG_PREFIX = "ralphie-release-promotion";

export type ContainerRegistryStage = "platform" | "index";

export type ContainerRegistryReconcileInput = {
    readonly client: RegistryClient;
    readonly plan: ContainerReconcilePlan;
    /** Absolute directory holding the plan's manifests and blobs. */
    readonly planDir: string;
    readonly stage: ContainerRegistryStage;
    /** Platform stage only: where to write `ralphie.publication-subjects.v1`. */
    readonly publicationSubjectsPath?: string;
};

export type ContainerRegistryReconcileResult = {
    readonly stage: ContainerRegistryStage;
    readonly created: number;
    readonly reused: number;
    readonly references: ReadonlyArray<string>;
};

const fail = (message: string): never => {
    throw new ContainerRegistryReconcileError({ message });
};

const sha256Hex = (bytes: Uint8Array): string =>
    createHash("sha256").update(bytes).digest("hex");

const blobFile = (planDir: string, digest: string): string => {
    const hex = digest.slice("sha256:".length);
    if (!/^[0-9a-f]{64}$/.test(hex)) {
        return fail(
            `Blob digest '${digest}' is not a canonical sha256 digest.`,
        );
    }
    return join(planDir, "blobs", hex);
};

const readBlobBytes = async (
    planDir: string,
    blob: RegistryBlobDescriptor,
): Promise<Uint8Array> => {
    let bytes: Uint8Array;
    try {
        bytes = await readFile(blobFile(planDir, blob.digest));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fail(
            `Cannot read staged blob ${blob.digest} from the reconcile plan: ${message}`,
        );
    }
    if (bytes.byteLength !== blob.size) {
        return fail(
            `Staged blob ${blob.digest} has ${bytes.byteLength} bytes, expected ${blob.size}.`,
        );
    }
    if (`sha256:${sha256Hex(bytes)}` !== blob.digest) {
        return fail(
            `Staged blob ${blob.digest} content digests to something else; refusing to push.`,
        );
    }
    return bytes;
};

const readPlanManifestFile = async (
    planDir: string,
    file: string,
    expectedDigest: string,
    description: string,
): Promise<Uint8Array> => {
    let bytes: Uint8Array;
    try {
        bytes = await readFile(join(planDir, file));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fail(
            `Cannot read staged ${description} '${file}' from the reconcile plan: ${message}`,
        );
    }
    const digest = manifestDigest(bytes);
    if (digest !== expectedDigest) {
        return fail(
            `Staged ${description} '${file}' digests to ${digest}, expected ${expectedDigest}; refusing to push.`,
        );
    }
    return bytes;
};

const ensureBlobPresent = async (
    client: RegistryClient,
    repository: string,
    blob: RegistryBlobDescriptor,
    planDir: string,
): Promise<void> => {
    const bytes = await readBlobBytes(planDir, blob);
    const pushed = await client.pushBlob(repository, bytes);
    if (pushed.digest !== blob.digest || pushed.size !== blob.size) {
        return fail(
            `Registry stored blob ${pushed.digest} (${pushed.size} bytes) for ${repository}, expected ${blob.digest} (${blob.size} bytes).`,
        );
    }
};

/**
 * Ensure the exact manifest content exists under its content address. An
 * existing entry is accepted only when its digest matches exactly; a missing
 * entry is created through the compare-and-swap put and reread, and any
 * raced or contradictory answer fails closed.
 */
const ensureManifestByDigest = async (
    client: RegistryClient,
    repository: string,
    bytes: Uint8Array,
    mediaType: ManifestMediaType,
    expectedDigest: string,
): Promise<void> => {
    const current = await client.inspectManifestReference(
        repository,
        expectedDigest,
    );
    if (current.kind === "present") {
        if (current.digest !== expectedDigest) {
            return fail(
                `Registry content address ${repository}@${expectedDigest} resolved to ${current.digest}; refusing to continue.`,
            );
        }
        return;
    }
    const write = await client.putManifest(
        repository,
        expectedDigest,
        bytes,
        mediaType,
    );
    if (
        write.status !== 200 &&
        write.status !== 201 &&
        write.status !== 409 &&
        write.status !== 412
    ) {
        return fail(
            `Registry rejected the content push of ${repository}@${expectedDigest} (${mediaType}) with HTTP ${write.status}.`,
        );
    }
    const after = await client.inspectManifestReference(
        repository,
        expectedDigest,
    );
    if (after.kind === "missing" || after.digest !== expectedDigest) {
        return fail(
            `Content push of ${repository}@${expectedDigest} resolved to ${
                after.kind === "missing" ? "missing" : after.digest
            }; refusing to promote a tag.`,
        );
    }
};

const preflight = async ({
    client,
    plan,
    destinations,
    stage,
}: {
    readonly client: RegistryClient;
    readonly plan: ContainerReconcilePlan;
    readonly destinations: ReadonlyArray<{
        readonly reference: string;
        readonly digest: string;
    }>;
    readonly stage: ContainerRegistryStage;
}): Promise<void> => {
    for (const destination of destinations) {
        const current = await client.inspectManifestReference(
            plan.repository,
            destination.reference,
        );
        if (
            current.kind === "present" &&
            current.digest !== destination.digest
        ) {
            return fail(
                `Preflight conflict for ${stage} tag ${plan.repository}:${destination.reference}: expected digest ${destination.digest}, found ${current.digest}. No production write was performed.`,
            );
        }
    }
};

const platformMediaTypes = (
    plan: ContainerReconcilePlan,
): ReadonlyArray<ManifestMediaType> => {
    const unique: ManifestMediaType[] = [];
    for (const arch of CONTAINER_CANDIDATE_ARCHS) {
        const mediaType = plan.platform[arch].media_type;
        if (!unique.includes(mediaType)) unique.push(mediaType);
    }
    return unique;
};

const ensureContentForArch = async (
    client: RegistryClient,
    plan: ContainerReconcilePlan,
    planDir: string,
    arch: ContainerCandidateArch,
): Promise<Uint8Array> => {
    const entry = plan.platform[arch];
    const manifestBytes = await readPlanManifestFile(
        planDir,
        entry.manifest_file,
        entry.digest,
        `${arch} platform manifest`,
    );
    for (const blob of [entry.config, ...entry.layers]) {
        await ensureBlobPresent(client, plan.repository, blob, planDir);
    }
    await ensureManifestByDigest(
        client,
        plan.repository,
        manifestBytes,
        entry.media_type,
        entry.digest,
    );
    return manifestBytes;
};

const reconcilePlatformStage = async ({
    client,
    plan,
    planDir,
    publicationSubjectsPath,
}: {
    readonly client: RegistryClient;
    readonly plan: ContainerReconcilePlan;
    readonly planDir: string;
    readonly publicationSubjectsPath: string | undefined;
}): Promise<ContainerRegistryReconcileResult> => {
    const destinations = CONTAINER_CANDIDATE_ARCHS.map((arch) => ({
        reference: plan.platform[arch].tag,
        digest: plan.platform[arch].digest,
    }));
    await preflight({ client, plan, destinations, stage: "platform" });
    const mediaTypes = platformMediaTypes(plan);
    const probe = await probeCreateOnlyPublishing(client, {
        repository: plan.repository,
        mediaTypes,
        probeTagPrefix: PROBE_TAG_PREFIX,
    });
    const verified = new Set(probe.verifiedMediaTypes);
    let created = 0;
    let reused = 0;
    const references: string[] = [];
    for (const arch of CONTAINER_CANDIDATE_ARCHS) {
        const entry = plan.platform[arch];
        const manifestBytes = await ensureContentForArch(
            client,
            plan,
            planDir,
            arch,
        );
        const outcome = await reconcileManifestTag(client, {
            repository: plan.repository,
            reference: entry.tag,
            manifestBytes,
            mediaType: entry.media_type,
            expectedDigest: entry.digest,
            verifiedCreateOnlyMediaTypes: verified,
        });
        if (outcome.kind === "created") created += 1;
        else reused += 1;
        references.push(`${plan.repository}:${entry.tag}`);
    }
    if (publicationSubjectsPath !== undefined) {
        const subjects = CONTAINER_CANDIDATE_ARCHS.map((arch) => {
            const entry = plan.platform[arch];
            return {
                platform: entry.platform,
                digest: entry.digest,
                reference: `${plan.image}@${entry.digest}`,
            };
        });
        const document = {
            schema: "ralphie.publication-subjects.v1",
            image: plan.image,
            version: plan.version,
            source_ref: plan.source_ref,
            subjects,
        };
        await writeFile(
            publicationSubjectsPath,
            `${JSON.stringify(document, null, 2)}\n`,
        );
    }
    return { stage: "platform", created, reused, references };
};

const reconcileIndexStage = async ({
    client,
    plan,
    planDir,
}: {
    readonly client: RegistryClient;
    readonly plan: ContainerReconcilePlan;
    readonly planDir: string;
}): Promise<ContainerRegistryReconcileResult> => {
    const destinations = plan.index_tags.map((reference) => ({
        reference,
        digest: plan.index.digest,
    }));
    await preflight({ client, plan, destinations, stage: "index" });
    const probe = await probeCreateOnlyPublishing(client, {
        repository: plan.repository,
        mediaTypes: [OCI_IMAGE_INDEX_MEDIA_TYPE],
        probeTagPrefix: PROBE_TAG_PREFIX,
    });
    const verified = new Set(probe.verifiedMediaTypes);
    for (const arch of CONTAINER_CANDIDATE_ARCHS) {
        await ensureContentForArch(client, plan, planDir, arch);
    }
    const indexBytes = await readPlanManifestFile(
        planDir,
        plan.index.file,
        plan.index.digest,
        "container index",
    );
    await ensureManifestByDigest(
        client,
        plan.repository,
        indexBytes,
        CONTAINER_INDEX_MEDIA_TYPE,
        plan.index.digest,
    );
    let created = 0;
    let reused = 0;
    const references: string[] = [];
    for (const tag of plan.index_tags) {
        const outcome = await reconcileManifestTag(client, {
            repository: plan.repository,
            reference: tag,
            manifestBytes: indexBytes,
            mediaType: CONTAINER_INDEX_MEDIA_TYPE,
            expectedDigest: plan.index.digest,
            verifiedCreateOnlyMediaTypes: verified,
        });
        if (outcome.kind === "created") created += 1;
        else reused += 1;
        references.push(`${plan.repository}:${tag}`);
    }
    return { stage: "index", created, reused, references };
};

/**
 * Reconcile one stage of the promotion plan against the registry with
 * verified create-only semantics: preflight first, prove create-only
 * behavior for exactly the media types this stage writes, ensure the exact
 * content addresses, then promote each destination tag.
 */
export const reconcileContainerRegistry = async (
    input: ContainerRegistryReconcileInput,
): Promise<ContainerRegistryReconcileResult> => {
    const { client, plan, planDir, stage, publicationSubjectsPath } = input;
    if (stage === "platform") {
        return reconcilePlatformStage({
            client,
            plan,
            planDir,
            publicationSubjectsPath,
        });
    }
    return reconcileIndexStage({ client, plan, planDir });
};