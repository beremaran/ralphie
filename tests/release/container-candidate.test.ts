import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    CONTAINER_CANDIDATE_ARCHS,
    ContainerCandidateValidationError,
    containerCandidateArchiveName,
    containerCandidateArtifactName,
    validateContainerCandidates,
} from "../../src/release/container-candidate.ts";
import {
    artifactFileNames,
    buildCandidateContract,
    buildOciArchiveContent,
    formatOciArchiveBytes,
    sha256Hex,
    validOciLayoutFiles,
} from "./oci-archive-fixture.ts";

const VERSION = "0.1.2";
const SOURCE_REF = "c".repeat(40);

type ArtifactSpec = {
    readonly arch: "amd64" | "arm64";
    readonly contract?: Uint8Array;
    readonly archive?: Uint8Array;
    readonly omitContract?: boolean;
    readonly omitArchive?: boolean;
    readonly extraFiles?: ReadonlyArray<string>;
    readonly extraDirectories?: ReadonlyArray<string>;
};

type TreeSpec = {
    readonly version?: string;
    readonly sourceRef?: string;
    readonly artifacts?: ReadonlyArray<ArtifactSpec>;
    readonly omitAllArtifacts?: boolean;
    readonly extraEntries?: ReadonlyArray<string>;
};

/** A default artifact whose contract records exactly the staged bytes. */
const stubbedArtifact = (
    arch: "amd64" | "arm64",
    overrides: Readonly<Record<string, unknown>> = {},
): ArtifactSpec => {
    const content = buildOciArchiveContent({
        arch,
        version: VERSION,
        sourceRef: SOURCE_REF,
    });
    const archive = formatOciArchiveBytes(validOciLayoutFiles(content, arch));
    return {
        arch,
        archive,
        contract: buildCandidateContract({
            arch,
            version: VERSION,
            sourceRef: SOURCE_REF,
            digest: content.manifestDigest,
            archiveSha256: sha256Hex(archive),
            overrides,
        }),
    };
};

/** A mutable copy of the canonical OCI layout for one architecture. */
const layoutOf = (
    arch: "amd64" | "arm64",
): {
    readonly content: ReturnType<typeof buildOciArchiveContent>;
    readonly files: ReadonlyArray<{
        readonly name: string;
        readonly bytes: Uint8Array;
    }>;
} => {
    const content = buildOciArchiveContent({
        arch,
        version: VERSION,
        sourceRef: SOURCE_REF,
    });
    return { content, files: validOciLayoutFiles(content, arch) };
};

const defaultArtifact = async (
    base: string,
    version: string,
    sourceRef: string,
    arch: "amd64" | "arm64",
    spec: ArtifactSpec,
): Promise<void> => {
    const artifactDir = join(
        base,
        containerCandidateArtifactName(version, arch),
    );
    await mkdir(artifactDir, { recursive: true });
    const names = artifactFileNames(arch);
    const content = buildOciArchiveContent({ arch, version, sourceRef });
    const archive =
        spec.archive ??
        formatOciArchiveBytes(validOciLayoutFiles(content, arch));
    if (spec.archive !== undefined || !spec.omitArchive) {
        await writeFile(join(artifactDir, names.archive), archive);
    }
    if (!spec.omitContract) {
        const contract =
            spec.contract ??
            buildCandidateContract({
                arch,
                version,
                sourceRef,
                digest: content.manifestDigest,
                archiveSha256: sha256Hex(archive),
            });
        await writeFile(join(artifactDir, names.contract), contract);
    }
    for (const name of spec.extraFiles ?? []) {
        await writeFile(join(artifactDir, name), new TextEncoder().encode("x"));
    }
    for (const name of spec.extraDirectories ?? []) {
        await mkdir(join(artifactDir, name), { recursive: true });
    }
};

const writeCandidatesTree = async (
    base: string,
    spec: TreeSpec,
): Promise<string> => {
    const version = spec.version ?? VERSION;
    const sourceRef = spec.sourceRef ?? SOURCE_REF;
    const candidatesDir = join(base, "candidates");
    await mkdir(candidatesDir, { recursive: true });
    if (!spec.omitAllArtifacts) {
        const byArch = new Map(
            (spec.artifacts ?? []).map((artifact) => [artifact.arch, artifact]),
        );
        for (const arch of CONTAINER_CANDIDATE_ARCHS) {
            const artifact = byArch.get(arch) ?? { arch };
            await defaultArtifact(
                candidatesDir,
                version,
                sourceRef,
                arch,
                artifact,
            );
        }
    }
    for (const name of spec.extraEntries ?? []) {
        const entry = join(candidatesDir, name);
        if (name.endsWith("/")) {
            await mkdir(entry, { recursive: true });
        } else {
            await writeFile(entry, new TextEncoder().encode("x"));
        }
    }
    return candidatesDir;
};

const withTree = async (
    spec: TreeSpec,
    run: (candidatesDir: string) => Promise<void>,
): Promise<void> => {
    const base = await mkdtemp(join(tmpdir(), "ralphie-candidate-test-"));
    try {
        const candidatesDir = await writeCandidatesTree(base, spec);
        await run(candidatesDir);
    } finally {
        await rm(base, { recursive: true, force: true });
    }
};

const validSpec = (): TreeSpec => ({ artifacts: [] });

const expectRejected = async (
    candidatesDir: string,
    messagePart?: string,
): Promise<void> => {
    const attempt = validateContainerCandidates({
        candidatesDir,
        version: VERSION,
        sourceRef: SOURCE_REF,
    });
    await expect(attempt).rejects.toThrow(ContainerCandidateValidationError);
    if (messagePart !== undefined) {
        await expect(attempt).rejects.toThrow(messagePart);
    }
};

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean =>
    left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === (right[index] ?? 0));

describe("container candidate validation", () => {
    test("accepts the exact amd64/arm64 candidate set and returns validated inputs", async () => {
        await withTree(validSpec(), async (candidatesDir) => {
            const result = await validateContainerCandidates({
                candidatesDir,
                version: VERSION,
                sourceRef: SOURCE_REF,
            });
            expect(result.version).toBe(VERSION);
            expect(result.sourceRef).toBe(SOURCE_REF);
            expect(Object.keys(result.byPlatform).sort()).toEqual([
                "amd64",
                "arm64",
            ]);
            for (const arch of CONTAINER_CANDIDATE_ARCHS) {
                const candidate = result.byPlatform[arch];
                expect(candidate.arch).toBe(arch);
                expect(candidate.artifactName).toBe(
                    containerCandidateArtifactName(VERSION, arch),
                );
                expect(candidate.platform).toBe(
                    arch === "amd64" ? "linux/amd64" : "linux/arm64",
                );
                expect(candidate.archivePath).toBe(
                    join(
                        candidatesDir,
                        containerCandidateArtifactName(VERSION, arch),
                        containerCandidateArchiveName(arch),
                    ),
                );
                const content = buildOciArchiveContent({
                    arch,
                    version: VERSION,
                    sourceRef: SOURCE_REF,
                });
                const expectedArchive = formatOciArchiveBytes(
                    validOciLayoutFiles(content, arch),
                );
                expect(candidate.archiveSha256).toBe(
                    sha256Hex(expectedArchive),
                );
                expect(candidate.image.digest).toBe(content.manifestDigest);
                expect(
                    bytesEqual(candidate.image.bytes, content.manifest),
                ).toBe(true);
                expect(candidate.image.indexDescriptor.digest).toBe(
                    content.manifestDigest,
                );
                expect(candidate.image.indexDescriptor.size).toBe(
                    content.manifest.byteLength,
                );
                expect(candidate.image.config.digest).toBe(
                    content.configDigest,
                );
                expect(candidate.image.layers).toHaveLength(1);
                expect(candidate.image.layers[0]?.digest).toBe(
                    content.layerDigest,
                );
            }
        });
    });

    test("accepts ./-prefixed archive entry paths", async () => {
        const { content, files } = layoutOf("amd64");
        const archive = formatOciArchiveBytes(
            files.map((file) => ({
                name: `./${file.name}`,
                bytes: file.bytes,
            })),
        );
        await withTree(
            { artifacts: [{ arch: "amd64", archive }] },
            async (candidatesDir) => {
                const result = await validateContainerCandidates({
                    candidatesDir,
                    version: VERSION,
                    sourceRef: SOURCE_REF,
                });
                expect(result.byPlatform.amd64.image.digest).toBe(
                    content.manifestDigest,
                );
            },
        );
    });

    test("accepts the conventional blobs/ and blobs/sha256/ directory entries", async () => {
        const { content, files } = layoutOf("amd64");
        const archive = formatOciArchiveBytes(files, {
            directories: ["blobs/", "blobs/sha256/"],
        });
        await withTree(
            { artifacts: [{ arch: "amd64", archive }] },
            async (candidatesDir) => {
                const result = await validateContainerCandidates({
                    candidatesDir,
                    version: VERSION,
                    sourceRef: SOURCE_REF,
                });
                expect(result.byPlatform.amd64.image.digest).toBe(
                    content.manifestDigest,
                );
            },
        );
    });

    test("accepts a './' root directory entry", async () => {
        const { content, files } = layoutOf("amd64");
        const archive = formatOciArchiveBytes(files, { directories: ["./"] });
        await withTree(
            { artifacts: [{ arch: "amd64", archive }] },
            async (candidatesDir) => {
                const result = await validateContainerCandidates({
                    candidatesDir,
                    version: VERSION,
                    sourceRef: SOURCE_REF,
                });
                expect(result.byPlatform.amd64.image.digest).toBe(
                    content.manifestDigest,
                );
            },
        );
    });

    test("accepts a gzip-compressed archive", async () => {
        const { content, files } = layoutOf("amd64");
        const gzipped = formatOciArchiveBytes(files, { gzip: true });
        await withTree(
            {
                artifacts: [
                    {
                        arch: "amd64",
                        archive: gzipped,
                        contract: buildCandidateContract({
                            arch: "amd64",
                            version: VERSION,
                            sourceRef: SOURCE_REF,
                            digest: content.manifestDigest,
                            archiveSha256: sha256Hex(gzipped),
                        }),
                    },
                ],
            },
            async (candidatesDir) => {
                const result = await validateContainerCandidates({
                    candidatesDir,
                    version: VERSION,
                    sourceRef: SOURCE_REF,
                });
                expect(result.byPlatform.amd64.image.digest).toBe(
                    content.manifestDigest,
                );
            },
        );
    });

    test("rejects a missing candidate artifact", async () => {
        await withTree({ omitAllArtifacts: true }, async (candidatesDir) => {
            await expectRejected(candidatesDir, "must be exactly");
        });
    });

    test("rejects a cross-release candidate artifact", async () => {
        await withTree(
            { extraEntries: ["ralphie-container-candidate-0.0.1-amd64"] },
            async (candidatesDir) => {
                await expectRejected(candidatesDir, "must be exactly");
            },
        );
    });

    test("rejects an unexpected file in the candidates directory", async () => {
        await withTree(
            { extraEntries: ["unexpected.txt"] },
            async (candidatesDir) => {
                await expectRejected(candidatesDir, "must be exactly");
            },
        );
    });

    test("rejects a non-artifact directory in the candidates directory", async () => {
        await withTree(
            { extraEntries: ["leftover/"] },
            async (candidatesDir) => {
                await expectRejected(candidatesDir, "must be exactly");
            },
        );
    });

    test("rejects a candidate artifact missing its contract", async () => {
        await withTree(
            { artifacts: [{ arch: "amd64", omitContract: true }] },
            async (candidatesDir) => {
                await expectRejected(candidatesDir, "must be exactly");
            },
        );
    });

    test("rejects a candidate artifact missing its archive", async () => {
        await withTree(
            { artifacts: [{ arch: "arm64", omitArchive: true }] },
            async (candidatesDir) => {
                await expectRejected(candidatesDir, "must be exactly");
            },
        );
    });

    test("rejects an extra file inside a candidate artifact", async () => {
        await withTree(
            { artifacts: [{ arch: "amd64", extraFiles: ["surprise.bin"] }] },
            async (candidatesDir) => {
                await expectRejected(candidatesDir, "must be exactly");
            },
        );
    });

    test("rejects a non-file entry inside a candidate artifact", async () => {
        await withTree(
            { artifacts: [{ arch: "arm64", extraDirectories: ["nested/"] }] },
            async (candidatesDir) => {
                await expectRejected(candidatesDir, "non-file entry");
            },
        );
    });

    test("rejects an unreadable candidates directory", async () => {
        await withTree(validSpec(), async (candidatesDir) => {
            await expectRejected(join(candidatesDir, "absent"), "unreadable");
        });
    });

    test("rejects an invalid release context", async () => {
        await withTree(validSpec(), async (candidatesDir) => {
            const attempt = validateContainerCandidates({
                candidatesDir,
                version: "not-a-version",
                sourceRef: SOURCE_REF,
            });
            await expect(attempt).rejects.toThrow(
                ContainerCandidateValidationError,
            );
            await expect(attempt).rejects.toThrow("canonical");
            const attemptRef = validateContainerCandidates({
                candidatesDir,
                version: VERSION,
                sourceRef: "short",
            });
            await expect(attemptRef).rejects.toThrow(
                ContainerCandidateValidationError,
            );
        });
    });

    test("rejects a malformed contract (not JSON)", async () => {
        const { content, files } = layoutOf("amd64");
        const archive = formatOciArchiveBytes(files);
        await withTree(
            {
                artifacts: [
                    {
                        arch: "amd64",
                        archive,
                        contract: new TextEncoder().encode("{not json"),
                    },
                ],
            },
            async (candidatesDir) => {
                await expectRejected(candidatesDir, "not valid JSON");
            },
        );
    });

    test("rejects a contract with a missing field", async () => {
        const spec = stubbedArtifact("amd64", { digest: undefined });
        await withTree({ artifacts: [spec] }, async (candidatesDir) => {
            await expectRejected(candidatesDir, "missing: digest");
        });
    });

    test("rejects a contract with an extra field", async () => {
        await withTree(
            { artifacts: [stubbedArtifact("amd64", { extra: "x" })] },
            async (candidatesDir) => {
                await expectRejected(candidatesDir, "unexpected: extra");
            },
        );
    });

    test("accepts a contract with reordered fields", async () => {
        const { content, files } = layoutOf("amd64");
        const archive = formatOciArchiveBytes(files);
        const contract = buildCandidateContract({
            arch: "amd64",
            version: VERSION,
            sourceRef: SOURCE_REF,
            digest: content.manifestDigest,
            archiveSha256: sha256Hex(archive),
        });
        const parsed = JSON.parse(new TextDecoder().decode(contract)) as Record<
            string,
            unknown
        >;
        const reordered = new TextEncoder().encode(
            `${JSON.stringify(Object.fromEntries(Object.entries(parsed).reverse()))}\n`,
        );
        await withTree(
            { artifacts: [{ arch: "amd64", archive, contract: reordered }] },
            async (candidatesDir) => {
                const result = await validateContainerCandidates({
                    candidatesDir,
                    version: VERSION,
                    sourceRef: SOURCE_REF,
                });
                expect(result.byPlatform.amd64.image.digest).toBe(
                    content.manifestDigest,
                );
                expect(result.byPlatform.amd64.archiveSha256).toBe(
                    sha256Hex(archive),
                );
            },
        );
    });

    test("rejects a wrong artifact name in the contract", async () => {
        await withTree(
            { artifacts: [stubbedArtifact("amd64", { artifact: "other" })] },
            async (candidatesDir) => {
                await expectRejected(candidatesDir, "artifact must be");
            },
        );
    });

    test("rejects a wrong version in the contract", async () => {
        await withTree(
            { artifacts: [stubbedArtifact("arm64", { version: "9.9.9" })] },
            async (candidatesDir) => {
                await expectRejected(candidatesDir, "version must be");
            },
        );
    });

    test("rejects a wrong source_ref in the contract", async () => {
        await withTree(
            {
                artifacts: [
                    stubbedArtifact("amd64", { source_ref: "d".repeat(40) }),
                ],
            },
            async (candidatesDir) => {
                await expectRejected(candidatesDir, "source_ref must be");
            },
        );
    });

    test("rejects a wrong platform in the contract", async () => {
        await withTree(
            {
                artifacts: [
                    stubbedArtifact("amd64", { platform: "linux/arm64" }),
                ],
            },
            async (candidatesDir) => {
                await expectRejected(candidatesDir, "platform must be");
            },
        );
    });

    test("rejects a traversal archive filename in the contract", async () => {
        await withTree(
            {
                artifacts: [
                    stubbedArtifact("amd64", { archive: "../../evil.oci.tar" }),
                ],
            },
            async (candidatesDir) => {
                await expectRejected(candidatesDir, "archive must be");
            },
        );
    });

    test("rejects a wrong format in the contract", async () => {
        await withTree(
            {
                artifacts: [
                    stubbedArtifact("arm64", { format: "docker-archive" }),
                ],
            },
            async (candidatesDir) => {
                await expectRejected(candidatesDir, "format must be");
            },
        );
    });

    test("rejects wrong recorded labels in the contract", async () => {
        await withTree(
            {
                artifacts: [
                    stubbedArtifact("amd64", { image_license: "Apache-2.0" }),
                ],
            },
            async (candidatesDir) => {
                await expectRejected(candidatesDir, "image_license must be");
            },
        );
    });

    test("rejects a malformed digest in the contract", async () => {
        await withTree(
            {
                artifacts: [
                    stubbedArtifact("amd64", { digest: "md5:deadbeef" }),
                ],
            },
            async (candidatesDir) => {
                await expectRejected(candidatesDir, "must match sha256");
            },
        );
    });

    test("rejects an archive checksum mismatch", async () => {
        const { content, files } = layoutOf("amd64");
        const original = formatOciArchiveBytes(files);
        const corrupt = original.slice();
        corrupt[0] = (corrupt[0] ?? 0x30) ^ 0xff;
        await withTree(
            {
                artifacts: [
                    {
                        arch: "amd64",
                        archive: corrupt,
                        contract: buildCandidateContract({
                            arch: "amd64",
                            version: VERSION,
                            sourceRef: SOURCE_REF,
                            digest: content.manifestDigest,
                            archiveSha256: sha256Hex(original),
                        }),
                    },
                ],
            },
            async (candidatesDir) => {
                await expectRejected(candidatesDir, "digests to");
            },
        );
    });

    test("rejects an archive whose index descriptor digest differs from the recorded digest", async () => {
        const { content, files } = layoutOf("amd64");
        const tamperedIndex = new TextEncoder().encode(
            JSON.stringify({
                schemaVersion: 2,
                manifests: [
                    {
                        mediaType: "application/vnd.oci.image.manifest.v1+json",
                        size: content.manifest.byteLength,
                        digest: `sha256:${"e".repeat(64)}`,
                        platform: { architecture: "amd64", os: "linux" },
                    },
                ],
            }),
        );
        const archive = formatOciArchiveBytes(
            files.map((file) =>
                file.name === "index.json"
                    ? { ...file, bytes: tamperedIndex }
                    : file,
            ),
        );
        await withTree(
            { artifacts: [{ arch: "amd64", archive }] },
            async (candidatesDir) => {
                await expectRejected(
                    candidatesDir,
                    "does not match the recorded BuildKit digest",
                );
            },
        );
    });

    test("rejects an archive whose actual manifest bytes do not match their recorded digest", async () => {
        const { content, files } = layoutOf("amd64");
        const manifestHex = content.manifestDigest.slice("sha256:".length);
        const tampered = content.manifest.slice();
        tampered[0] = (tampered[0] ?? 0x7b) ^ 0xff;
        const archive = formatOciArchiveBytes(
            files.map((file) =>
                file.name === `blobs/sha256/${manifestHex}`
                    ? { ...file, bytes: tampered }
                    : file,
            ),
        );
        await withTree(
            { artifacts: [{ arch: "amd64", archive }] },
            async (candidatesDir) => {
                await expectRejected(candidatesDir, "blob content digests to");
            },
        );
    });

    test("rejects an archive missing its manifest blob", async () => {
        const { content, files } = layoutOf("amd64");
        const manifestHex = content.manifestDigest.slice("sha256:".length);
        const archive = formatOciArchiveBytes(
            files.filter((file) => file.name !== `blobs/sha256/${manifestHex}`),
        );
        await withTree(
            { artifacts: [{ arch: "amd64", archive }] },
            async (candidatesDir) => {
                await expectRejected(
                    candidatesDir,
                    "missing the required file",
                );
            },
        );
    });

    test("rejects a config blob whose content differs from its descriptor", async () => {
        const { content, files } = layoutOf("amd64");
        const configHex = content.configDigest.slice("sha256:".length);
        const tampered = content.config.slice();
        tampered[0] = (tampered[0] ?? 0x7b) ^ 0xff;
        const archive = formatOciArchiveBytes(
            files.map((file) =>
                file.name === `blobs/sha256/${configHex}`
                    ? { ...file, bytes: tampered }
                    : file,
            ),
        );
        await withTree(
            { artifacts: [{ arch: "amd64", archive }] },
            async (candidatesDir) => {
                await expectRejected(candidatesDir, "blob content digests to");
            },
        );
    });

    test("rejects a missing referenced layer blob", async () => {
        const { content, files } = layoutOf("amd64");
        const layerHex = content.layerDigest.slice("sha256:".length);
        const archive = formatOciArchiveBytes(
            files.filter((file) => file.name !== `blobs/sha256/${layerHex}`),
        );
        await withTree(
            { artifacts: [{ arch: "amd64", archive }] },
            async (candidatesDir) => {
                await expectRejected(
                    candidatesDir,
                    "missing the required file",
                );
            },
        );
    });

    test("rejects a layer blob whose content differs from its descriptor", async () => {
        const { content, files } = layoutOf("amd64");
        const layerHex = content.layerDigest.slice("sha256:".length);
        const tampered = content.layer.slice();
        tampered[0] = (tampered[0] ?? 0x72) ^ 0xff;
        const archive = formatOciArchiveBytes(
            files.map((file) =>
                file.name === `blobs/sha256/${layerHex}`
                    ? { ...file, bytes: tampered }
                    : file,
            ),
        );
        await withTree(
            { artifacts: [{ arch: "amd64", archive }] },
            async (candidatesDir) => {
                await expectRejected(candidatesDir, "blob content digests to");
            },
        );
    });

    test("rejects a layer blob whose size differs from its descriptor", async () => {
        const { content, files } = layoutOf("amd64");
        const layerHex = content.layerDigest.slice("sha256:".length);
        const replaced = new TextEncoder().encode("shorter-layer-content");
        const archive = formatOciArchiveBytes(
            files.map((file) =>
                file.name === `blobs/sha256/${layerHex}`
                    ? { ...file, bytes: replaced }
                    : file,
            ),
        );
        await withTree(
            { artifacts: [{ arch: "amd64", archive }] },
            async (candidatesDir) => {
                await expectRejected(candidatesDir, "bytes, expected");
            },
        );
    });

    test("rejects an unreferenced extra blob", async () => {
        const { files } = layoutOf("amd64");
        const archive = formatOciArchiveBytes([
            ...files,
            {
                name: `blobs/sha256/${"a".repeat(64)}`,
                bytes: new TextEncoder().encode("stray"),
            },
        ]);
        await withTree(
            { artifacts: [{ arch: "amd64", archive }] },
            async (candidatesDir) => {
                await expectRejected(candidatesDir, "unreferenced blob");
            },
        );
    });

    test("rejects an unexpected root file in the archive", async () => {
        const { files } = layoutOf("amd64");
        const archive = formatOciArchiveBytes([
            ...files,
            { name: "manifest.json", bytes: new TextEncoder().encode("{}") },
        ]);
        await withTree(
            { artifacts: [{ arch: "amd64", archive }] },
            async (candidatesDir) => {
                await expectRejected(candidatesDir, "unexpected file");
            },
        );
    });

    test("rejects a duplicate archive entry", async () => {
        const { files } = layoutOf("amd64");
        const indexFile = files.find((file) => file.name === "index.json");
        if (indexFile === undefined) {
            throw new Error("fixture missing index.json");
        }
        const archive = formatOciArchiveBytes([
            ...files,
            { name: "index.json", bytes: indexFile.bytes },
        ]);
        await withTree(
            { artifacts: [{ arch: "amd64", archive }] },
            async (candidatesDir) => {
                await expectRejected(candidatesDir, "duplicate entry");
            },
        );
    });

    test("rejects an archive entry with a traversal path", async () => {
        const { files } = layoutOf("amd64");
        const archive = formatOciArchiveBytes([
            ...files,
            { name: "../escape", bytes: new TextEncoder().encode("boom") },
        ]);
        await withTree(
            { artifacts: [{ arch: "amd64", archive }] },
            async (candidatesDir) => {
                await expectRejected(candidatesDir, "traversal");
            },
        );
    });

    test("rejects an archive entry with an absolute path", async () => {
        const { files } = layoutOf("amd64");
        const archive = formatOciArchiveBytes([
            ...files,
            { name: "/etc/passwd", bytes: new TextEncoder().encode("root") },
        ]);
        await withTree(
            { artifacts: [{ arch: "amd64", archive }] },
            async (candidatesDir) => {
                await expectRejected(candidatesDir, "unsafe path");
            },
        );
    });

    test("rejects an unexpected directory entry in the archive", async () => {
        const { files } = layoutOf("amd64");
        const archive = formatOciArchiveBytes(files, {
            directories: ["mystery/"],
        });
        await withTree(
            { artifacts: [{ arch: "amd64", archive }] },
            async (candidatesDir) => {
                await expectRejected(candidatesDir, "unexpected directory");
            },
        );
    });

    test("rejects a truncated archive", async () => {
        const { files } = layoutOf("amd64");
        const archive = formatOciArchiveBytes(files);
        const truncated = archive.slice(0, Math.floor(archive.byteLength / 2));
        await withTree(
            { artifacts: [{ arch: "amd64", archive: truncated }] },
            async (candidatesDir) => {
                await expectRejected(candidatesDir);
            },
        );
    });

    test("rejects mismatched image config labels inside the archive", async () => {
        const content = buildOciArchiveContent({
            arch: "amd64",
            version: VERSION,
            sourceRef: SOURCE_REF,
            extraLabels: {
                "org.opencontainers.image.version": "9.9.9",
                "org.opencontainers.image.licenses": "Apache-2.0",
            },
        });
        const archive = formatOciArchiveBytes(
            validOciLayoutFiles(content, "amd64"),
        );
        await withTree(
            {
                artifacts: [
                    {
                        arch: "amd64",
                        archive,
                        contract: buildCandidateContract({
                            arch: "amd64",
                            version: VERSION,
                            sourceRef: SOURCE_REF,
                            digest: content.manifestDigest,
                            archiveSha256: sha256Hex(archive),
                        }),
                    },
                ],
            },
            async (candidatesDir) => {
                await expectRejected(candidatesDir, "must have label");
            },
        );
    });

    test("rejects mismatched image config platform inside the archive", async () => {
        const content = buildOciArchiveContent({
            arch: "amd64",
            version: VERSION,
            sourceRef: SOURCE_REF,
            configOverrides: { architecture: "arm64" },
        });
        const archive = formatOciArchiveBytes(
            validOciLayoutFiles(content, "amd64"),
        );
        await withTree(
            {
                artifacts: [
                    {
                        arch: "amd64",
                        archive,
                        contract: buildCandidateContract({
                            arch: "amd64",
                            version: VERSION,
                            sourceRef: SOURCE_REF,
                            digest: content.manifestDigest,
                            archiveSha256: sha256Hex(archive),
                        }),
                    },
                ],
            },
            async (candidatesDir) => {
                await expectRejected(candidatesDir, "must be linux/amd64");
            },
        );
    });

    test("rejects a wrong image revision label recorded in the contract", async () => {
        await withTree(
            {
                artifacts: [
                    stubbedArtifact("arm64", {
                        image_revision: "e".repeat(40),
                    }),
                ],
            },
            async (candidatesDir) => {
                await expectRejected(candidatesDir, "image_revision must be");
            },
        );
    });
});