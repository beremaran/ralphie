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
    type ContainerReconcilePlan,
    type ContainerTagPlanDocument,
} from "../../src/release/container-index.ts";
import {
    ContainerRegistryReconcileError,
    reconcileContainerRegistry,
} from "../../src/release/container-registry-reconcile.ts";
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

type BuiltContent = {
    readonly amd64: ReturnType<typeof buildOciArchiveContent>;
    readonly arm64: ReturnType<typeof buildOciArchiveContent>;
};

const buildFixtureInput = async (
    base: string,
    contents: BuiltContent,
): Promise<{
    plan: ContainerReconcilePlan;
    planDir: string;
    candidatesDir: string;
}> => {
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

const defaultContents = (): BuiltContent => ({
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

const clientFor = (fixture: RegistryFixture) =>
    createOciRegistryHttpClient({
        baseUrl: fixture.baseUrl,
        username: REGISTRY_FIXTURE_USERNAME,
        password: REGISTRY_FIXTURE_PASSWORD,
    });

const runWithFixture = async (
    options: Parameters<typeof startRegistryFixture>[0],
    run: (
        fixture: RegistryFixture,
        plan: ContainerReconcilePlan,
        planDir: string,
    ) => Promise<void>,
): Promise<void> => {
    const fixture = await startRegistryFixture(options);
    const base = await mkdtemp(join(tmpdir(), "ralphie-reconcile-test-"));
    try {
        const { plan, planDir } = await buildFixtureInput(
            base,
            defaultContents(),
        );
        await run(fixture, plan, planDir);
    } finally {
        await rm(base, { recursive: true, force: true });
        await fixture.close();
    }
};

describe("create-only container registry reconciliation", () => {
    test("promotes the two platform tags create-only and writes publication subjects", async () => {
        await runWithFixture({}, async (fixture, plan, planDir) => {
            const result = await reconcileContainerRegistry({
                client: clientFor(fixture),
                plan,
                planDir,
                stage: "platform",
                publicationSubjectsPath: `${planDir}/publication-subjects.json`,
            });
            expect(result.stage).toBe("platform");
            expect(result.created).toBe(2);
            expect(result.reused).toBe(0);
            for (const arch of CONTAINER_CANDIDATE_ARCHS) {
                const view = fixture.tag(REPOSITORY, plan.platform[arch].tag);
                expect(view?.digest).toBe(plan.platform[arch].digest);
            }
            const subjects = JSON.parse(
                new TextDecoder().decode(
                    await import("node:fs/promises").then((fs) =>
                        fs.readFile(`${planDir}/publication-subjects.json`),
                    ),
                ),
            ) as {
                schema: string;
                image: string;
                version: string;
                source_ref: string;
                subjects: ReadonlyArray<{
                    platform: string;
                    digest: string;
                    reference: string;
                }>;
            };
            expect(subjects.schema).toBe("ralphie.publication-subjects.v1");
            expect(subjects.image).toBe(IMAGE);
            expect(subjects.version).toBe(VERSION);
            expect(subjects.source_ref).toBe(SOURCE_REF);
            expect(
                subjects.subjects.map((subject) => subject.platform).sort(),
            ).toEqual(["linux/amd64", "linux/arm64"]);
            expect(
                subjects.subjects.every(
                    (subject) =>
                        subject.reference === `${IMAGE}@${subject.digest}` &&
                        subject.digest ===
                            plan.platform[
                                subject.platform === "linux/amd64"
                                    ? "amd64"
                                    : "arm64"
                            ].digest,
                ),
            ).toBe(true);
        });
    });

    test("a rerun reuses the exact platform digests without moving a tag", async () => {
        await runWithFixture({}, async (fixture, plan, planDir) => {
            const first = await reconcileContainerRegistry({
                client: clientFor(fixture),
                plan,
                planDir,
                stage: "platform",
                publicationSubjectsPath: `${planDir}/publication-subjects.json`,
            });
            expect(first.created).toBe(2);
            const second = await reconcileContainerRegistry({
                client: clientFor(fixture),
                plan,
                planDir,
                stage: "platform",
                publicationSubjectsPath: `${planDir}/publication-subjects.json`,
            });
            expect(second.created).toBe(0);
            expect(second.reused).toBe(2);
        });
    });

    test("creates every release-index alias from the single assembled index", async () => {
        await runWithFixture({}, async (fixture, plan, planDir) => {
            // Index aliases are created from the exact assembled index bytes
            // with a create-only write per tag.
            const result = await reconcileContainerRegistry({
                client: clientFor(fixture),
                plan,
                planDir,
                stage: "index",
            });
            expect(result.stage).toBe("index");
            expect(result.created).toBe(plan.index_tags.length);
            expect(result.reused).toBe(0);
            for (const tag of plan.index_tags) {
                const view = fixture.tag(REPOSITORY, tag);
                expect(view?.digest).toBe(plan.index.digest);
            }
            const second = await reconcileContainerRegistry({
                client: clientFor(fixture),
                plan,
                planDir,
                stage: "index",
            });
            expect(second.created).toBe(0);
            expect(second.reused).toBe(plan.index_tags.length);
        });
    });

    test("a partial run is repeatable: index aliases are created even when platform tags were never promoted", async () => {
        await runWithFixture({}, async (fixture, plan, planDir) => {
            // Simulate an interrupted first run: only the index stage ran.
            const result = await reconcileContainerRegistry({
                client: clientFor(fixture),
                plan,
                planDir,
                stage: "index",
            });
            expect(result.created).toBe(plan.index_tags.length);
            // Platform promotion afterwards reuses the content-addressed
            // manifests it already established.
            const platform = await reconcileContainerRegistry({
                client: clientFor(fixture),
                plan,
                planDir,
                stage: "platform",
                publicationSubjectsPath: `${planDir}/publication-subjects.json`,
            });
            expect(platform.created).toBe(2);
            expect(platform.reused).toBe(0);
        });
    });

    test("a preflight conflict is rejected before any production write", async () => {
        await runWithFixture({}, async (fixture, plan, planDir) => {
            const foreign = new TextEncoder().encode(
                JSON.stringify({
                    schemaVersion: 2,
                    mediaType: "x",
                    manifests: [],
                }),
            );
            fixture.setTag(
                REPOSITORY,
                plan.platform.amd64.tag,
                foreign,
                "application/vnd.oci.image.manifest.v1+json",
            );
            const attempt = reconcileContainerRegistry({
                client: clientFor(fixture),
                plan,
                planDir,
                stage: "platform",
                publicationSubjectsPath: `${planDir}/publication-subjects.json`,
            });
            await expect(attempt).rejects.toThrow(
                ContainerRegistryReconcileError,
            );
            await expect(attempt).rejects.toThrow(/Preflight conflict/);
            // The conflict is detected before the capability probe, so no
            // manifest write or delete may have reached the registry.
            const writes = fixture
                .observations()
                .filter((observation) =>
                    ["PUT", "DELETE"].includes(observation.method),
                );
            expect(writes).toHaveLength(0);
        });
    });

    test("authentication failures fail closed before any tag is created", async () => {
        await runWithFixture(
            { denyAuthorizedRequests: true },
            async (fixture, plan, planDir) => {
                const attempt = reconcileContainerRegistry({
                    client: clientFor(fixture),
                    plan,
                    planDir,
                    stage: "platform",
                    publicationSubjectsPath: `${planDir}/publication-subjects.json`,
                });
                await expect(attempt).rejects.toThrow();
                expect(
                    fixture.tag(REPOSITORY, plan.platform.amd64.tag),
                ).toBeUndefined();
                expect(
                    fixture.tag(REPOSITORY, plan.platform.arm64.tag),
                ).toBeUndefined();
            },
        );
    });

    test("blob and child-manifest content is uploaded before manifests are accepted", async () => {
        await runWithFixture(
            { validateReferencedContent: true },
            async (fixture, plan, planDir) => {
                const result = await reconcileContainerRegistry({
                    client: clientFor(fixture),
                    plan,
                    planDir,
                    stage: "platform",
                    publicationSubjectsPath: `${planDir}/publication-subjects.json`,
                });
                expect(result.created).toBe(2);
                // The registry validated the referenced blobs before
                // accepting every manifest put: blobs must exist for each
                // platform config and layer.
                for (const arch of CONTAINER_CANDIDATE_ARCHS) {
                    const entry = plan.platform[arch];
                    for (const blob of [entry.config, ...entry.layers]) {
                        expect(
                            fixture.blob(REPOSITORY, blob.digest),
                        ).toBeDefined();
                    }
                }
            },
        );
    });

    test("a prerelease-style plan (no latest) creates exactly the planned aliases", async () => {
        const fixture = await startRegistryFixture({});
        const base = await mkdtemp(join(tmpdir(), "ralphie-reconcile-test-"));
        try {
            const { plan, planDir } = await buildFixtureInput(
                base,
                defaultContents(),
            );
            const prereleasePlan: ContainerReconcilePlan = {
                ...plan,
                index_tags: [VERSION, "0.1", `sha-${SOURCE_REF}`],
            };
            const result = await reconcileContainerRegistry({
                client: clientFor(fixture),
                plan: prereleasePlan,
                planDir,
                stage: "index",
            });
            expect(result.created).toBe(3);
            expect(fixture.tag(REPOSITORY, "latest")).toBeUndefined();
        } finally {
            await rm(base, { recursive: true, force: true });
            await fixture.close();
        }
    });
});