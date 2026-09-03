import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    CONTAINER_CANDIDATE_ARCHS,
    containerCandidateArchiveName,
    containerCandidateArtifactName,
    containerCandidateContractName,
    validateContainerCandidates,
} from "../../src/release/container-candidate.ts";
import {
    assembleContainerIndex,
    buildContainerReconcilePlan,
    type ContainerReconcilePlan,
    type ContainerTagPlanDocument,
} from "../../src/release/container-index.ts";
import {
    ContainerRegistryReconcileError,
    reconcileContainerRegistry,
} from "../../src/release/container-registry-reconcile.ts";
import {
    DOCKER_SCHEMA2_MANIFEST_MEDIA_TYPE,
    manifestDigest,
    OCI_IMAGE_INDEX_MEDIA_TYPE,
    OCI_IMAGE_MANIFEST_MEDIA_TYPE,
    reconcileManifestTag,
    RegistryCapabilityProbeError,
    RegistryConflictError,
    RegistryRequestError,
    RegistryWriteGuardError,
} from "../../src/release/registry-reconcile.ts";
import {
    REGISTRY_FIXTURE_PASSWORD,
    REGISTRY_FIXTURE_USERNAME,
    startRegistryFixture,
    type RegistryFixture,
} from "../../src/release/registry-fixture.ts";
import { createOciRegistryHttpClient } from "../../src/release/registry-http-client.ts";
import {
    buildCandidateContract,
    buildOciArchiveContent,
    formatOciArchiveBytes,
    sha256Hex,
    validOciLayoutFiles,
} from "./oci-archive-fixture.ts";

const VERSION = "0.1.2";
const SOURCE_REF = "c".repeat(40);
const IMAGE = "ghcr.io/beremaran/ralphie";
const REPOSITORY = "beremaran/ralphie";

const DOCKER_LAYER_MEDIA_TYPE =
    "application/vnd.docker.image.rootfs.diff.tar.gzip";

type BuiltContent = {
    readonly amd64: ReturnType<typeof buildOciArchiveContent>;
    readonly arm64: ReturnType<typeof buildOciArchiveContent>;
};

type LayoutFiles = ReadonlyArray<{
    readonly name: string;
    readonly bytes: Uint8Array;
}>;

const tagPlanDocument = (): ContainerTagPlanDocument => {
    const minor = VERSION.split(".").slice(0, 2).join(".");
    return {
        schema: "ralphie.container-tag-plan.v1",
        version: VERSION,
        source_ref: SOURCE_REF,
        version_tag: VERSION,
        minor_tag: minor,
        latest: true,
        source_tag: `sha-${SOURCE_REF}`,
        platform_tag_base: VERSION,
        platform_tags: [`${VERSION}-amd64`, `${VERSION}-arm64`],
        index_tags: [VERSION, minor, "latest", `sha-${SOURCE_REF}`],
    };
};

const ociContents = (): BuiltContent => ({
    amd64: buildOciArchiveContent({
        arch: "amd64",
        version: VERSION,
        sourceRef: SOURCE_REF,
    }),
    arm64: buildOciArchiveContent({
        arch: "arm64",
        version: VERSION,
        sourceRef: SOURCE_REF,
    }),
});

/** Docker schema-2 manifest candidates with Docker layer media types. */
const dockerContents = (): BuiltContent => ({
    amd64: buildOciArchiveContent({
        arch: "amd64",
        version: VERSION,
        sourceRef: SOURCE_REF,
        manifestMediaType: DOCKER_SCHEMA2_MANIFEST_MEDIA_TYPE,
        layerMediaType: DOCKER_LAYER_MEDIA_TYPE,
    }),
    arm64: buildOciArchiveContent({
        arch: "arm64",
        version: VERSION,
        sourceRef: SOURCE_REF,
        manifestMediaType: DOCKER_SCHEMA2_MANIFEST_MEDIA_TYPE,
        layerMediaType: DOCKER_LAYER_MEDIA_TYPE,
    }),
});

const mixedContents = (): BuiltContent => ({
    amd64: buildOciArchiveContent({
        arch: "amd64",
        version: VERSION,
        sourceRef: SOURCE_REF,
    }),
    arm64: buildOciArchiveContent({
        arch: "arm64",
        version: VERSION,
        sourceRef: SOURCE_REF,
        manifestMediaType: DOCKER_SCHEMA2_MANIFEST_MEDIA_TYPE,
        layerMediaType: DOCKER_LAYER_MEDIA_TYPE,
    }),
});

/** Docker-schema2 candidates serialized with a Docker-manifest index.json. */
const dockerLayoutFiles = (
    content: ReturnType<typeof buildOciArchiveContent>,
    arch: "amd64" | "arm64",
): LayoutFiles =>
    validOciLayoutFiles(content, arch).map((file) => {
        if (file.name !== "index.json") return file;
        return {
            name: file.name,
            bytes: new TextEncoder().encode(
                JSON.stringify({
                    schemaVersion: 2,
                    manifests: [
                        {
                            mediaType: DOCKER_SCHEMA2_MANIFEST_MEDIA_TYPE,
                            size: content.manifest.byteLength,
                            digest: content.manifestDigest,
                            platform: { architecture: arch, os: "linux" },
                        },
                    ],
                }),
            ),
        };
    });

const buildFixtureInput = async (
    base: string,
    contents: BuiltContent,
    layout: (
        content: ReturnType<typeof buildOciArchiveContent>,
        arch: "amd64" | "arm64",
    ) => LayoutFiles = validOciLayoutFiles,
): Promise<{
    plan: ContainerReconcilePlan;
    planDir: string;
    candidatesDir: string;
}> => {
    const candidatesDir = join(base, "candidates");
    await mkdir(candidatesDir, { recursive: true });
    for (const arch of CONTAINER_CANDIDATE_ARCHS) {
        const content = contents[arch];
        const archive = formatOciArchiveBytes(layout(content, arch));
        const artifactDir = join(
            candidatesDir,
            containerCandidateArtifactName(VERSION, arch),
        );
        await mkdir(artifactDir, { recursive: true });
        await writeFile(
            join(artifactDir, containerCandidateArchiveName(arch)),
            archive,
        );
        await writeFile(
            join(artifactDir, containerCandidateContractName(arch)),
            buildCandidateContract({
                arch,
                version: VERSION,
                sourceRef: SOURCE_REF,
                digest: content.manifestDigest,
                archiveSha256: sha256Hex(archive),
            }),
        );
    }
    const candidates = await validateContainerCandidates({
        candidatesDir,
        version: VERSION,
        sourceRef: SOURCE_REF,
    });
    const plan = buildContainerReconcilePlan({
        candidates,
        tagPlan: tagPlanDocument(),
        image: IMAGE,
    });
    const planDir = join(base, "plan");
    await mkdir(join(planDir, "blobs"), { recursive: true });
    for (const arch of CONTAINER_CANDIDATE_ARCHS) {
        const entry = plan.platform[arch];
        const content = contents[arch];
        await writeFile(join(planDir, entry.manifest_file), content.manifest);
        const blobBytes: Readonly<Record<string, Uint8Array>> = {
            [content.configDigest]: content.config,
            [content.layerDigest]: content.layer,
        };
        for (const blob of [entry.config, ...entry.layers]) {
            const bytes = blobBytes[blob.digest];
            if (bytes === undefined) {
                throw new Error(`Missing staged blob ${blob.digest}`);
            }
            await writeFile(
                join(planDir, "blobs", blob.digest.slice("sha256:".length)),
                bytes,
            );
        }
    }
    const assembly = assembleContainerIndex(candidates);
    await writeFile(join(planDir, plan.index.file), assembly.bytes);
    return { plan, planDir, candidatesDir };
};

const clientFor = (fixture: RegistryFixture) =>
    createOciRegistryHttpClient({
        baseUrl: fixture.baseUrl,
        username: REGISTRY_FIXTURE_USERNAME,
        password: REGISTRY_FIXTURE_PASSWORD,
    });

const withFixtureAndPlan = async (
    options: Parameters<typeof startRegistryFixture>[0],
    contents: BuiltContent,
    run: (
        fixture: RegistryFixture,
        plan: ContainerReconcilePlan,
        planDir: string,
    ) => Promise<void>,
    layout?: (
        content: ReturnType<typeof buildOciArchiveContent>,
        arch: "amd64" | "arm64",
    ) => LayoutFiles,
): Promise<void> => {
    const fixture = await startRegistryFixture(options);
    const base = await mkdtemp(join(tmpdir(), "ralphie-regression-test-"));
    try {
        const { plan, planDir } = await buildFixtureInput(
            base,
            contents,
            layout,
        );
        await run(fixture, plan, planDir);
    } finally {
        await rm(base, { recursive: true, force: true });
        await fixture.close();
    }
};

const withFixture = async (
    options: Parameters<typeof startRegistryFixture>[0],
    run: (
        fixture: RegistryFixture,
        plan: ContainerReconcilePlan,
        planDir: string,
    ) => Promise<void>,
): Promise<void> => withFixtureAndPlan(options, ociContents(), run);

const platformManifestBytes = async (
    planDir: string,
    plan: ContainerReconcilePlan,
    arch: "amd64" | "arm64",
): Promise<Uint8Array> =>
    readFile(join(planDir, plan.platform[arch].manifest_file));

/** PUT observations whose path targets a production tag reference. */
const productionTagPuts = (
    fixture: RegistryFixture,
    references: ReadonlyArray<string>,
) =>
    fixture
        .observations()
        .filter(
            (observation) =>
                observation.method === "PUT" &&
                references.some((reference) =>
                    observation.path.endsWith(`/manifests/${reference}`),
                ),
        );

const expectNoProductionTags = (
    fixture: RegistryFixture,
    plan: ContainerReconcilePlan,
): void => {
    for (const arch of CONTAINER_CANDIDATE_ARCHS) {
        expect(
            fixture.tag(REPOSITORY, plan.platform[arch].tag),
        ).toBeUndefined();
    }
    for (const tag of plan.index_tags) {
        expect(fixture.tag(REPOSITORY, tag)).toBeUndefined();
    }
};

describe("container publication and reconciliation regression coverage", () => {
    test("a blob upload failure fails the platform stage before any production tag", async () => {
        await withFixture(
            { failBlobUploads: true },
            async (fixture, plan, planDir) => {
                const attempt = reconcileContainerRegistry({
                    client: clientFor(fixture),
                    plan,
                    planDir,
                    stage: "platform",
                    publicationSubjectsPath: `${planDir}/publication-subjects.json`,
                });
                await expect(attempt).rejects.toThrow(
                    RegistryCapabilityProbeError,
                );
                expectNoProductionTags(fixture, plan);
            },
        );
    });

    test("a manifest push failure surfaces as a request error and never creates the tag", async () => {
        await withFixture(
            { forcedManifestPutStatus: 500 },
            async (fixture, plan, planDir) => {
                const client = clientFor(fixture);
                const entry = plan.platform.amd64;
                const attempt = reconcileManifestTag(client, {
                    repository: REPOSITORY,
                    reference: entry.tag,
                    manifestBytes: await platformManifestBytes(
                        planDir,
                        plan,
                        "amd64",
                    ),
                    mediaType: entry.media_type,
                    expectedDigest: entry.digest,
                    verifiedCreateOnlyMediaTypes: new Set([entry.media_type]),
                });
                await expect(attempt).rejects.toThrow(RegistryRequestError);
                expect(fixture.tag(REPOSITORY, entry.tag)).toBeUndefined();
            },
        );
    });

    test("a registry with no compare-and-swap operation fails the capability probe before any production write", async () => {
        await withFixture(
            { rejectConditionalWrites: true },
            async (fixture, plan, planDir) => {
                const attempt = reconcileContainerRegistry({
                    client: clientFor(fixture),
                    plan,
                    planDir,
                    stage: "platform",
                    publicationSubjectsPath: `${planDir}/publication-subjects.json`,
                });
                await expect(attempt).rejects.toThrow(
                    RegistryCapabilityProbeError,
                );
                await expect(attempt).rejects.toThrow(
                    "did not prove create-only manifest promotion",
                );
                expectNoProductionTags(fixture, plan);
                // The probe defeated before the first production tag put, so
                // no manifest write or delete may target a production ref.
                expect(
                    productionTagPuts(fixture, plan.platform_tags),
                ).toHaveLength(0);
                expect(
                    fixture
                        .observations()
                        .filter(
                            (observation) => observation.method === "DELETE",
                        )
                        .map((observation) => observation.path),
                ).toEqual([]);
            },
        );
    });

    test("a registry that ignores conditional headers fails the platform capability probe", async () => {
        await withFixture(
            { ignoreConditionalHeaders: true },
            async (fixture, plan, planDir) => {
                const attempt = reconcileContainerRegistry({
                    client: clientFor(fixture),
                    plan,
                    planDir,
                    stage: "platform",
                    publicationSubjectsPath: `${planDir}/publication-subjects.json`,
                });
                await expect(attempt).rejects.toThrow(
                    RegistryCapabilityProbeError,
                );
                await expect(attempt).rejects.toThrow(
                    "did not prove create-only manifest promotion",
                );
                const probe = (await attempt.catch(
                    (error: unknown) => error,
                )) as RegistryCapabilityProbeError;
                const entry = probe.entries[0];
                expect(entry?.outcome).toBe("failed");
                if (entry?.outcome === "failed") {
                    expect(entry.stage).toBe("competing-write");
                    expect(entry.detail).toContain(
                        "ignores the create-only compare-and-swap",
                    );
                }
                expectNoProductionTags(fixture, plan);
            },
        );
    });

    test("a registry that ignores conditional headers fails the index capability probe", async () => {
        await withFixture(
            { ignoreConditionalHeaders: true },
            async (fixture, plan, planDir) => {
                const attempt = reconcileContainerRegistry({
                    client: clientFor(fixture),
                    plan,
                    planDir,
                    stage: "index",
                });
                await expect(attempt).rejects.toThrow(
                    RegistryCapabilityProbeError,
                );
                expectNoProductionTags(fixture, plan);
            },
        );
    });

    test("every production platform manifest put carries the If-None-Match create-only guard", async () => {
        await withFixture({}, async (fixture, plan, planDir) => {
            const result = await reconcileContainerRegistry({
                client: clientFor(fixture),
                plan,
                planDir,
                stage: "platform",
                publicationSubjectsPath: `${planDir}/publication-subjects.json`,
            });
            expect(result.created).toBe(2);
            const puts = productionTagPuts(fixture, plan.platform_tags);
            expect(puts).toHaveLength(2);
            for (const observation of puts) {
                expect(observation.ifNoneMatch).toBe("*");
            }
        });
    });

    test("an exact rerun reuses digests without a single additional production tag move", async () => {
        await withFixture({}, async (fixture, plan, planDir) => {
            const first = await reconcileContainerRegistry({
                client: clientFor(fixture),
                plan,
                planDir,
                stage: "platform",
                publicationSubjectsPath: `${planDir}/publication-subjects.json`,
            });
            expect(first.created).toBe(2);
            fixture.takeObservations();
            const second = await reconcileContainerRegistry({
                client: clientFor(fixture),
                plan,
                planDir,
                stage: "platform",
                publicationSubjectsPath: `${planDir}/publication-subjects.json`,
            });
            expect(second.reused).toBe(2);
            expect(productionTagPuts(fixture, plan.platform_tags)).toHaveLength(
                0,
            );
        });
    });

    test("an existing index whose children match but whose own bytes/digest differ is a preflight conflict", async () => {
        await withFixture({}, async (fixture, plan, planDir) => {
            // The surviving index references exactly the planned children
            // (same descriptors) but serializes them differently, so its
            // digest differs even though every child matches.
            const conflicting: Record<string, unknown> = {
                schemaVersion: 2,
                mediaType: plan.index.media_type,
                manifests: [
                    {
                        mediaType: plan.platform.amd64.media_type,
                        size: plan.platform.amd64.size,
                        digest: plan.platform.amd64.digest,
                        platform: { architecture: "amd64", os: "linux" },
                    },
                    {
                        mediaType: plan.platform.arm64.media_type,
                        size: plan.platform.arm64.size,
                        digest: plan.platform.arm64.digest,
                        platform: { architecture: "arm64", os: "linux" },
                    },
                ],
                annotations: {
                    "org.opencontainers.image.title": "stale",
                },
            };
            const bytes = new TextEncoder().encode(JSON.stringify(conflicting));
            expect(manifestDigest(bytes)).not.toBe(plan.index.digest);
            fixture.setTag(
                REPOSITORY,
                plan.index_tags[0] as string,
                bytes,
                plan.index.media_type,
            );
            const attempt = reconcileContainerRegistry({
                client: clientFor(fixture),
                plan,
                planDir,
                stage: "index",
            });
            await expect(attempt).rejects.toThrow(
                ContainerRegistryReconcileError,
            );
            await expect(attempt).rejects.toThrow(/Preflight conflict/);
            expect(
                fixture
                    .observations()
                    .filter((observation) =>
                        ["PUT", "DELETE"].includes(observation.method),
                    ),
            ).toHaveLength(0);
            expect(
                fixture.tag(REPOSITORY, plan.index_tags[0] as string)?.digest,
            ).toBe(manifestDigest(bytes));
        });
    });

    test("a conflicting release-index alias fails closed before any production write", async () => {
        await withFixture({}, async (fixture, plan, planDir) => {
            const foreign = new TextEncoder().encode(
                JSON.stringify({ schemaVersion: 2, manifests: [] }),
            );
            fixture.setTag(
                REPOSITORY,
                "latest",
                foreign,
                plan.index.media_type,
            );
            const attempt = reconcileContainerRegistry({
                client: clientFor(fixture),
                plan,
                planDir,
                stage: "index",
            });
            await expect(attempt).rejects.toThrow(
                ContainerRegistryReconcileError,
            );
            await expect(attempt).rejects.toThrow(/Preflight conflict/);
            expect(
                fixture
                    .observations()
                    .filter((observation) =>
                        ["PUT", "DELETE"].includes(observation.method),
                    ),
            ).toHaveLength(0);
            expect(fixture.tag(REPOSITORY, "latest")?.digest).toBe(
                manifestDigest(foreign),
            );
        });
    });

    test("a concurrent writer between read and create fails closed without overwriting the racing reference", async () => {
        await withFixture({}, async (fixture, plan, planDir) => {
            const client = clientFor(fixture);
            const entry = plan.platform.amd64;
            const writerBytes = new TextEncoder().encode(
                '{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json"}',
            );
            const writerDigest = manifestDigest(writerBytes);
            fixture.onceBeforePut(() => {
                fixture.setTag(
                    REPOSITORY,
                    entry.tag,
                    writerBytes,
                    entry.media_type,
                );
            });
            const attempt = reconcileManifestTag(client, {
                repository: REPOSITORY,
                reference: entry.tag,
                manifestBytes: await platformManifestBytes(
                    planDir,
                    plan,
                    "amd64",
                ),
                mediaType: entry.media_type,
                expectedDigest: entry.digest,
                verifiedCreateOnlyMediaTypes: new Set([entry.media_type]),
            });
            await expect(attempt).rejects.toThrow(RegistryConflictError);
            // The CAS rejection preserved the racing writer's manifest: the
            // publisher never overwrote the conflicting reference.
            expect(fixture.tag(REPOSITORY, entry.tag)?.digest).toBe(
                writerDigest,
            );
        });
    });

    test("a create race answered 409 fails closed the same way", async () => {
        await withFixture(
            { conflictOnExistingCreate: true },
            async (fixture, plan, planDir) => {
                const client = clientFor(fixture);
                const entry = plan.platform.arm64;
                const writerBytes = new TextEncoder().encode(
                    '{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json"}',
                );
                const writerDigest = manifestDigest(writerBytes);
                fixture.onceBeforePut(() => {
                    fixture.setTag(
                        REPOSITORY,
                        entry.tag,
                        writerBytes,
                        entry.media_type,
                    );
                });
                const attempt = reconcileManifestTag(client, {
                    repository: REPOSITORY,
                    reference: entry.tag,
                    manifestBytes: await platformManifestBytes(
                        planDir,
                        plan,
                        "arm64",
                    ),
                    mediaType: entry.media_type,
                    expectedDigest: entry.digest,
                    verifiedCreateOnlyMediaTypes: new Set([entry.media_type]),
                });
                await expect(attempt).rejects.toThrow(RegistryConflictError);
                expect(fixture.tag(REPOSITORY, entry.tag)?.digest).toBe(
                    writerDigest,
                );
            },
        );
    });

    test("a create race landing the exact intended digest is accepted only after reread", async () => {
        await withFixture({}, async (fixture, plan, planDir) => {
            const client = clientFor(fixture);
            const entry = plan.platform.amd64;
            const intended = await platformManifestBytes(
                planDir,
                plan,
                "amd64",
            );
            fixture.onceBeforePut(() => {
                fixture.setTag(
                    REPOSITORY,
                    entry.tag,
                    intended,
                    entry.media_type,
                );
            });
            const outcome = await reconcileManifestTag(client, {
                repository: REPOSITORY,
                reference: entry.tag,
                manifestBytes: intended,
                mediaType: entry.media_type,
                expectedDigest: entry.digest,
                verifiedCreateOnlyMediaTypes: new Set([entry.media_type]),
            });
            expect(outcome.kind).toBe("created");
            expect(fixture.tag(REPOSITORY, entry.tag)?.digest).toBe(
                entry.digest,
            );
        });
    });

    test("creating a missing tag is refused before its media type is verified", async () => {
        await withFixture({}, async (fixture, plan, planDir) => {
            const client = clientFor(fixture);
            const entry = plan.platform.amd64;
            const attempt = reconcileManifestTag(client, {
                repository: REPOSITORY,
                reference: `${entry.tag}-unverified`,
                manifestBytes: await platformManifestBytes(
                    planDir,
                    plan,
                    "amd64",
                ),
                mediaType: entry.media_type,
                expectedDigest: entry.digest,
                verifiedCreateOnlyMediaTypes: new Set(),
            });
            await expect(attempt).rejects.toThrow(RegistryWriteGuardError);
            expect(
                fixture.tag(REPOSITORY, `${entry.tag}-unverified`),
            ).toBeUndefined();
        });
    });

    test("docker-schema2 platform manifests are promoted create-only and index aliases use the OCI index media type", async () => {
        await withFixtureAndPlan(
            {},
            dockerContents(),
            async (fixture, plan, planDir) => {
                const platform = await reconcileContainerRegistry({
                    client: clientFor(fixture),
                    plan,
                    planDir,
                    stage: "platform",
                    publicationSubjectsPath: `${planDir}/publication-subjects.json`,
                });
                expect(platform.created).toBe(2);
                for (const arch of CONTAINER_CANDIDATE_ARCHS) {
                    expect(plan.platform[arch].media_type).toBe(
                        DOCKER_SCHEMA2_MANIFEST_MEDIA_TYPE,
                    );
                    const view = fixture.tag(
                        REPOSITORY,
                        plan.platform[arch].tag,
                    );
                    expect(view?.digest).toBe(plan.platform[arch].digest);
                    expect(view?.mediaType).toBe(
                        DOCKER_SCHEMA2_MANIFEST_MEDIA_TYPE,
                    );
                }
                for (const observation of productionTagPuts(
                    fixture,
                    plan.platform_tags,
                )) {
                    expect(observation.contentType).toBe(
                        DOCKER_SCHEMA2_MANIFEST_MEDIA_TYPE,
                    );
                    expect(observation.ifNoneMatch).toBe("*");
                }
                const index = await reconcileContainerRegistry({
                    client: clientFor(fixture),
                    plan,
                    planDir,
                    stage: "index",
                });
                expect(index.created).toBe(plan.index_tags.length);
                for (const observation of productionTagPuts(
                    fixture,
                    plan.index_tags,
                )) {
                    expect(observation.contentType).toBe(
                        OCI_IMAGE_INDEX_MEDIA_TYPE,
                    );
                    expect(observation.ifNoneMatch).toBe("*");
                }
                for (const tag of plan.index_tags) {
                    expect(fixture.tag(REPOSITORY, tag)?.digest).toBe(
                        plan.index.digest,
                    );
                }
            },
            dockerLayoutFiles,
        );
    });

    test("a mixed OCI and docker-schema2 platform pair is probed and promoted for both media types", async () => {
        await withFixtureAndPlan(
            {},
            mixedContents(),
            async (fixture, plan, planDir) => {
                expect(plan.platform.amd64.media_type).toBe(
                    OCI_IMAGE_MANIFEST_MEDIA_TYPE,
                );
                expect(plan.platform.arm64.media_type).toBe(
                    DOCKER_SCHEMA2_MANIFEST_MEDIA_TYPE,
                );
                const result = await reconcileContainerRegistry({
                    client: clientFor(fixture),
                    plan,
                    planDir,
                    stage: "platform",
                    publicationSubjectsPath: `${planDir}/publication-subjects.json`,
                });
                expect(result.created).toBe(2);
                // The probe proved create-only behavior for both writable
                // platform media types before any production tag put.
                const probePaths = fixture
                    .observations()
                    .map((observation) => observation.path)
                    .filter(
                        (path) =>
                            path.includes("-oci-image") ||
                            path.includes("-docker-schema2"),
                    );
                expect(probePaths.length).toBeGreaterThanOrEqual(2);
                for (const arch of CONTAINER_CANDIDATE_ARCHS) {
                    expect(
                        fixture.tag(REPOSITORY, plan.platform[arch].tag)
                            ?.digest,
                    ).toBe(plan.platform[arch].digest);
                }
                const rerun = await reconcileContainerRegistry({
                    client: clientFor(fixture),
                    plan,
                    planDir,
                    stage: "platform",
                    publicationSubjectsPath: `${planDir}/publication-subjects.json`,
                });
                expect(rerun.reused).toBe(2);
            },
            (content, arch) =>
                arch === "amd64"
                    ? validOciLayoutFiles(content, arch)
                    : dockerLayoutFiles(content, arch),
        );
    });
});

describe("release-index alias media type coverage", () => {
    test("the index stage writes the OCI image index media type for every alias", async () => {
        await withFixture({}, async (fixture, plan, planDir) => {
            const result = await reconcileContainerRegistry({
                client: clientFor(fixture),
                plan,
                planDir,
                stage: "index",
            });
            expect(result.created).toBe(plan.index_tags.length);
            const puts = productionTagPuts(fixture, plan.index_tags);
            expect(puts).toHaveLength(plan.index_tags.length);
            for (const observation of puts) {
                expect(observation.contentType).toBe(
                    OCI_IMAGE_INDEX_MEDIA_TYPE,
                );
                expect(observation.ifNoneMatch).toBe("*");
            }
        });
    });
});