import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
    CONTAINER_INDEX_MEDIA_TYPE,
    CONTAINER_RECONCILE_PLAN_SCHEMA,
    ContainerIndexError,
    imageReference,
    parseContainerReconcilePlan,
    type ContainerReconcilePlan,
    type ContainerTagPlanDocument,
} from "../../src/release/container-index.ts";
import { manifestDigest } from "../../src/release/registry-reconcile.ts";
import {
    buildCandidateContract,
    buildOciArchiveContent,
    formatOciArchiveBytes,
    OCI_IMAGE_MANIFEST_MEDIA_TYPE,
    sha256Hex,
    validOciLayoutFiles,
} from "./oci-archive-fixture.ts";

const VERSION = "0.1.2";
const SOURCE_REF = "c".repeat(40);
const IMAGE = "ghcr.io/beremaran/ralphie";

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

const writeCandidatesWithContents = async (
    base: string,
    contents: {
        amd64: ReturnType<typeof buildOciArchiveContent>;
        arm64: ReturnType<typeof buildOciArchiveContent>;
    },
): Promise<string> => {
    const candidatesDir = join(base, "candidates");
    await mkdir(candidatesDir, { recursive: true });
    for (const arch of CONTAINER_CANDIDATE_ARCHS) {
        const content = contents[arch];
        const archive = formatOciArchiveBytes(
            validOciLayoutFiles(content, arch),
        );
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
    return candidatesDir;
};

const writeCandidates = async (
    base: string,
): Promise<{
    candidatesDir: string;
    contents: {
        amd64: ReturnType<typeof buildOciArchiveContent>;
        arm64: ReturnType<typeof buildOciArchiveContent>;
    };
}> => {
    const contents = {
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
    };
    const candidatesDir = await writeCandidatesWithContents(base, contents);
    return { candidatesDir, contents };
};

describe("deterministic container index assembly", () => {
    test("assembles one fixed-order OCI index with exact descriptors and no annotations", async () => {
        const base = await mkdtemp(join(tmpdir(), "ralphie-index-test-"));
        try {
            const { candidatesDir, contents } = await writeCandidates(base);
            const candidates = await validateContainerCandidates({
                candidatesDir,
                version: VERSION,
                sourceRef: SOURCE_REF,
            });
            const assembly = assembleContainerIndex(candidates);
            expect(assembly.mediaType).toBe(CONTAINER_INDEX_MEDIA_TYPE);
            expect(assembly.digest).toBe(manifestDigest(assembly.bytes));
            expect(assembly.manifests).toEqual([
                {
                    arch: "amd64",
                    mediaType: OCI_IMAGE_MANIFEST_MEDIA_TYPE,
                    size: contents.amd64.manifest.byteLength,
                    digest: contents.amd64.manifestDigest,
                },
                {
                    arch: "arm64",
                    mediaType: OCI_IMAGE_MANIFEST_MEDIA_TYPE,
                    size: contents.arm64.manifest.byteLength,
                    digest: contents.arm64.manifestDigest,
                },
            ]);
            const document = JSON.parse(
                new TextDecoder().decode(assembly.bytes),
            ) as Record<string, unknown>;
            expect(document.schemaVersion).toBe(2);
            expect(document.mediaType).toBe(CONTAINER_INDEX_MEDIA_TYPE);
            expect("annotations" in document).toBe(false);
            const manifests = document.manifests as ReadonlyArray<
                Record<string, unknown>
            >;
            expect(manifests).toHaveLength(2);
            expect(manifests[0]).toEqual({
                mediaType: OCI_IMAGE_MANIFEST_MEDIA_TYPE,
                size: contents.amd64.manifest.byteLength,
                digest: contents.amd64.manifestDigest,
                platform: { architecture: "amd64", os: "linux" },
            });
            expect(manifests[1]).toEqual({
                mediaType: OCI_IMAGE_MANIFEST_MEDIA_TYPE,
                size: contents.arm64.manifest.byteLength,
                digest: contents.arm64.manifestDigest,
                platform: { architecture: "arm64", os: "linux" },
            });
        } finally {
            await rm(base, { recursive: true, force: true });
        }
    });

    test("assembly is byte-identical and digest-stable across repeated runs", async () => {
        const base = await mkdtemp(join(tmpdir(), "ralphie-index-test-"));
        try {
            const { candidatesDir } = await writeCandidates(base);
            const candidates = await validateContainerCandidates({
                candidatesDir,
                version: VERSION,
                sourceRef: SOURCE_REF,
            });
            const one = assembleContainerIndex(candidates);
            const two = assembleContainerIndex(candidates);
            expect(one.bytes).toEqual(two.bytes);
            expect(one.digest).toBe(two.digest);
        } finally {
            await rm(base, { recursive: true, force: true });
        }
    });

    test("the index digest changes when a platform manifest changes", async () => {
        const base = await mkdtemp(join(tmpdir(), "ralphie-index-test-"));
        try {
            const { candidatesDir } = await writeCandidates(base);
            const before = assembleContainerIndex(
                await validateContainerCandidates({
                    candidatesDir,
                    version: VERSION,
                    sourceRef: SOURCE_REF,
                }),
            );
            // Perturb the staged amd64 candidate and re-validate from
            // scratch: the index digest must follow the platform manifest.
            await rm(candidatesDir, { recursive: true, force: true });
            const contents = {
                amd64: buildOciArchiveContent({
                    arch: "amd64",
                    version: VERSION,
                    sourceRef: SOURCE_REF,
                    extraLabels: {
                        "org.opencontainers.image.ref.name": "x",
                    },
                }),
                arm64: buildOciArchiveContent({
                    arch: "arm64",
                    version: VERSION,
                    sourceRef: SOURCE_REF,
                }),
            };
            const after = assembleContainerIndex(
                await validateContainerCandidates({
                    candidatesDir: await writeCandidatesWithContents(
                        base,
                        contents,
                    ),
                    version: VERSION,
                    sourceRef: SOURCE_REF,
                }),
            );
            expect(after.digest).not.toBe(before.digest);
        } finally {
            await rm(base, { recursive: true, force: true });
        }
    });

    test("duplicate platform digests fail closed", async () => {
        const base = await mkdtemp(join(tmpdir(), "ralphie-index-test-"));
        try {
            const { candidatesDir } = await writeCandidates(base);
            const candidates = await validateContainerCandidates({
                candidatesDir,
                version: VERSION,
                sourceRef: SOURCE_REF,
            });
            const broken = {
                ...candidates,
                byPlatform: {
                    amd64: candidates.byPlatform.amd64,
                    // Fake arm64 with the amd64 manifest bytes, digest, and
                    // index descriptor so only the duplicate-digest check can
                    // reject it.
                    arm64: {
                        ...candidates.byPlatform.arm64,
                        image: {
                            ...candidates.byPlatform.arm64.image,
                            bytes: candidates.byPlatform.amd64.image.bytes,
                            digest: candidates.byPlatform.amd64.image.digest,
                            indexDescriptor:
                                candidates.byPlatform.amd64.image
                                    .indexDescriptor,
                        },
                    },
                },
            };
            expect(() => assembleContainerIndex(broken)).toThrow(
                ContainerIndexError,
            );
            expect(() => assembleContainerIndex(broken)).toThrow(
                "unique digests",
            );
        } finally {
            await rm(base, { recursive: true, force: true });
        }
    });

    test("unsupported platform manifest media type fails closed", async () => {
        const base = await mkdtemp(join(tmpdir(), "ralphie-index-test-"));
        try {
            const { candidatesDir } = await writeCandidates(base);
            const candidates = await validateContainerCandidates({
                candidatesDir,
                version: VERSION,
                sourceRef: SOURCE_REF,
            });
            const broken = {
                ...candidates,
                byPlatform: {
                    amd64: {
                        ...candidates.byPlatform.amd64,
                        image: {
                            ...candidates.byPlatform.amd64.image,
                            mediaType: "application/vnd.bogus.manifest.v1+json",
                        },
                    },
                    arm64: candidates.byPlatform.arm64,
                },
            } as unknown as Awaited<
                ReturnType<typeof validateContainerCandidates>
            >;
            expect(() => assembleContainerIndex(broken)).toThrow(
                ContainerIndexError,
            );
        } finally {
            await rm(base, { recursive: true, force: true });
        }
    });

    test("imageReference validates the exact GHCR reference", () => {
        expect(imageReference(IMAGE)).toBe("beremaran/ralphie");
        expect(() => imageReference("docker.io/library/ralphie")).toThrow(
            ContainerIndexError,
        );
        expect(() => imageReference("ghcr.io/beremaran")).toThrow(
            ContainerIndexError,
        );
        expect(() => imageReference("ghcr.io/Upper/Lower")).toThrow(
            ContainerIndexError,
        );
    });
});

describe("container reconcile plan", () => {
    test("builds a plan carrying the tag-plan tags and exact platform/index digests", async () => {
        const base = await mkdtemp(join(tmpdir(), "ralphie-plan-test-"));
        try {
            const { candidatesDir } = await writeCandidates(base);
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
            expect(plan.schema).toBe(CONTAINER_RECONCILE_PLAN_SCHEMA);
            expect(plan.image).toBe(IMAGE);
            expect(plan.repository).toBe("beremaran/ralphie");
            expect(plan.version).toBe(VERSION);
            expect(plan.source_ref).toBe(SOURCE_REF);
            expect(plan.platform_tags).toEqual([
                `${VERSION}-amd64`,
                `${VERSION}-arm64`,
            ]);
            expect(plan.index_tags).toEqual([
                VERSION,
                "0.1",
                "latest",
                `sha-${SOURCE_REF}`,
            ]);
            expect(plan.platform.amd64.tag).toBe(`${VERSION}-amd64`);
            expect(plan.platform.arm64.tag).toBe(`${VERSION}-arm64`);
            expect(plan.platform.amd64.digest).toBe(
                candidates.byPlatform.amd64.image.digest,
            );
            expect(plan.platform.arm64.digest).toBe(
                candidates.byPlatform.arm64.image.digest,
            );
            const assembly = assembleContainerIndex(candidates);
            expect(plan.index.digest).toBe(assembly.digest);
            expect(plan.index.media_type).toBe(CONTAINER_INDEX_MEDIA_TYPE);
            expect(plan.index.file).toBe("ralphie-container-index.json");
            expect(plan.index.size).toBe(assembly.bytes.byteLength);
        } finally {
            await rm(base, { recursive: true, force: true });
        }
    });

    test("the plan carries the tag plan's index tags verbatim, never adding latest", async () => {
        const base = await mkdtemp(join(tmpdir(), "ralphie-plan-test-"));
        try {
            const { candidatesDir } = await writeCandidates(base);
            const candidates = await validateContainerCandidates({
                candidatesDir,
                version: VERSION,
                sourceRef: SOURCE_REF,
            });
            const tagPlan = {
                ...tagPlanDocument(),
                // A manually supplied plan without latest must be honored
                // verbatim (proxy for the prerelease policy enforced by the
                // tag planner), so the reconciler can never invent an alias.
                latest: false,
                index_tags: [VERSION, "0.1", `sha-${SOURCE_REF}`],
            };
            const plan = buildContainerReconcilePlan({
                candidates,
                tagPlan,
                image: IMAGE,
            });
            expect(plan.index_tags).toEqual(tagPlan.index_tags);
            expect(plan.index_tags.includes("latest")).toBe(false);
        } finally {
            await rm(base, { recursive: true, force: true });
        }
    });

    test("parseContainerReconcilePlan round-trips the builder output", async () => {
        const base = await mkdtemp(join(tmpdir(), "ralphie-plan-test-"));
        try {
            const { candidatesDir } = await writeCandidates(base);
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
            const parsed = parseContainerReconcilePlan(
                `${JSON.stringify(plan, null, 2)}\n`,
            );
            expect(parsed).toEqual(plan);
        } finally {
            await rm(base, { recursive: true, force: true });
        }
    });

    test("a mismatched tag plan is rejected before a plan is built", async () => {
        const base = await mkdtemp(join(tmpdir(), "ralphie-plan-test-"));
        try {
            const { candidatesDir } = await writeCandidates(base);
            const candidates = await validateContainerCandidates({
                candidatesDir,
                version: VERSION,
                sourceRef: SOURCE_REF,
            });
            expect(() =>
                buildContainerReconcilePlan({
                    candidates,
                    tagPlan: {
                        ...tagPlanDocument(),
                        platform_tags: [`${VERSION}-s390x`, `${VERSION}-arm64`],
                    },
                    image: IMAGE,
                }),
            ).toThrow(ContainerIndexError);
            expect(() =>
                buildContainerReconcilePlan({
                    candidates,
                    tagPlan: { ...tagPlanDocument(), latest: false },
                    image: IMAGE,
                }),
            ).toThrow(/latest/);
            expect(() =>
                buildContainerReconcilePlan({
                    candidates,
                    tagPlan: tagPlanDocument(),
                    image: "docker.io/library/ralphie",
                }),
            ).toThrow(ContainerIndexError);
        } finally {
            await rm(base, { recursive: true, force: true });
        }
    });

    test("rejects corrupted persisted plans", async () => {
        const base = await mkdtemp(join(tmpdir(), "ralphie-plan-test-"));
        try {
            const { candidatesDir } = await writeCandidates(base);
            const candidates = await validateContainerCandidates({
                candidatesDir,
                version: VERSION,
                sourceRef: SOURCE_REF,
            });
            const plan: ContainerReconcilePlan = buildContainerReconcilePlan({
                candidates,
                tagPlan: tagPlanDocument(),
                image: IMAGE,
            });

            const corrupted = [
                {
                    ...plan,
                    index: { ...plan.index, digest: "sha256:xyz" },
                },
                {
                    ...plan,
                    index_tags: [...plan.index_tags, "latest+2"],
                },
                { ...plan, schema: "ralphie.wrong.v1" },
                {
                    ...plan,
                    platform_tags: [
                        plan.platform_tags[0],
                        `bad-${plan.platform_tags[1]}`,
                    ],
                },
                {
                    ...plan,
                    index: { ...plan.index, file: "../evil.json" },
                },
                {
                    ...plan,
                    source_ref: "not-a-commit",
                },
            ];
            for (const candidate of corrupted) {
                const attempt = () =>
                    parseContainerReconcilePlan(
                        `${JSON.stringify(candidate)}\n`,
                    );
                expect(attempt).toThrow(ContainerIndexError);
            }
        } finally {
            await rm(base, { recursive: true, force: true });
        }
    });
});