#!/usr/bin/env bun

/**
 * Deterministic OCI index assembly seam used by the protected `publish` job
 * of `.github/workflows/release.yml` (step "Assemble deterministic container
 * index and reconcile plan") and runnable locally:
 *
 *   bun scripts/assemble-container-index.ts \
 *     --candidates-dir <dir> \
 *     --version <version> \
 *     --source-ref <sha> \
 *     --image ghcr.io/beremaran/ralphie \
 *     --tag-plan <container-tag-plan.json> \
 *     --output <dir>
 *
 * It re-runs the exact validated container-candidate check
 * (`validateContainerCandidates`), re-verifies each archive SHA-256 against
 * the validated contract, extracts the exactly referenced blobs, assembles
 * the single deterministic OCI image index (fixed amd64-then-arm64 mapping,
 * exact media types/sizes/digests, no annotations), and writes the
 * `ralphie.container-reconcile-plan.v1` document plus the exact manifest and
 * blob files the no-overwrite registry reconciler consumes. It never logs in
 * to GHCR, writes a tag, rebuilds an image, or performs network I/O; every
 * mismatch fails closed with a non-zero exit.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

import {
    CONTAINER_CANDIDATE_ARCHS,
    readOciArchiveBlobs,
    validateContainerCandidates,
    type ContainerCandidateArch,
    type ValidatedContainerCandidates,
} from "../src/release/container-candidate.ts";
import {
    assembleContainerIndex,
    buildContainerReconcilePlan,
    CONTAINER_INDEX_FILE,
    CONTAINER_PLATFORM_MANIFEST_FILE,
    CONTAINER_RECONCILE_PLAN_FILE,
    parseContainerReconcilePlan,
    type ContainerTagPlanDocument,
} from "../src/release/container-index.ts";

const optionValue = (args: ReadonlyArray<string>, option: string): string => {
    const index = args.indexOf(option);
    const value = args[index + 1];
    if (index === -1 || value === undefined || value.startsWith("--")) {
        throw new Error(`${option} requires a value.`);
    }
    return value;
};

const main = async (): Promise<void> => {
    const args = Bun.argv.slice(2);
    if (args.length !== 12) {
        throw new Error(
            "Usage: assemble-container-index.ts --candidates-dir <path> --version <version> --source-ref <sha> --image <ghcr.io/owner/name> --tag-plan <path> --output <dir>",
        );
    }
    const candidatesDir = optionValue(args, "--candidates-dir");
    const version = optionValue(args, "--version");
    const sourceRef = optionValue(args, "--source-ref");
    const image = optionValue(args, "--image");
    const tagPlanPath = optionValue(args, "--tag-plan");
    const output = optionValue(args, "--output");

    const candidates: ValidatedContainerCandidates =
        await validateContainerCandidates({
            candidatesDir,
            sourceRef,
            version,
        });

    const tagPlan = parseTagPlanFile(await readTextFile(tagPlanPath));
    const plan = buildContainerReconcilePlan({ candidates, tagPlan, image });
    // Re-validating the freshly built document through the strict parser
    // proves the persisted bytes match the emitted contract.
    parseContainerReconcilePlan(`${JSON.stringify(plan, null, 2)}\n`);

    await mkdir(`${output}/blobs`, { recursive: true });

    const assembly = assembleContainerIndex(candidates);
    await writeFile(`${output}/${CONTAINER_INDEX_FILE}`, assembly.bytes);

    for (const arch of CONTAINER_CANDIDATE_ARCHS) {
        const candidate = candidates.byPlatform[arch];
        await writeFile(
            `${output}/${CONTAINER_PLATFORM_MANIFEST_FILE(arch)}`,
            candidate.image.bytes,
        );
        await writeBlobs(output, arch, candidate);
    }

    await writeFile(
        `${output}/${CONTAINER_RECONCILE_PLAN_FILE}`,
        `${JSON.stringify(plan, null, 2)}\n`,
    );

    console.log(
        `Assembled container index ${assembly.digest} (${assembly.bytes.byteLength} bytes) with platforms ${CONTAINER_CANDIDATE_ARCHS.join(", ")}; reconcile plan written to ${output}/${CONTAINER_RECONCILE_PLAN_FILE}`,
    );
    for (const arch of CONTAINER_CANDIDATE_ARCHS) {
        const candidate = candidates.byPlatform[arch];
        console.log(
            `${arch}: ${candidate.image.digest} (${candidate.image.bytes.byteLength} bytes) -> ${plan.platform[arch].tag}`,
        );
    }
};

const parseTagPlanFile = (raw: string): ContainerTagPlanDocument => {
    let value: unknown;
    try {
        value = JSON.parse(raw) as unknown;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Container tag plan is not valid JSON: ${message}`);
    }
    return value as ContainerTagPlanDocument;
};

const readTextFile = async (path: string): Promise<string> => {
    try {
        return await readFile(path, "utf8");
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Cannot read '${path}': ${message}`);
    }
};

const writeBlobs = async (
    output: string,
    arch: ContainerCandidateArch,
    candidate: ValidatedContainerCandidates["byPlatform"][ContainerCandidateArch],
): Promise<void> => {
    const archiveBytes = await readFile(candidate.archivePath);
    const recomputedSha256 = sha256Hex(archiveBytes);
    if (recomputedSha256 !== candidate.archiveSha256) {
        throw new Error(
            `Container candidate archive '${candidate.archivePath}' digests to ${recomputedSha256}, expected the validated ${candidate.archiveSha256}; refusing to assemble.`,
        );
    }
    const blobs = await readOciArchiveBlobs(archiveBytes);
    const referenced = new Set([
        candidate.image.config.digest,
        ...candidate.image.layers.map((layer) => layer.digest),
    ]);
    for (const digest of referenced) {
        const bytes = blobs.get(digest);
        if (bytes === undefined) {
            throw new Error(
                `${arch} candidate is missing referenced blob ${digest}; refusing to assemble.`,
            );
        }
        await writeFile(
            `${output}/blobs/${digest.slice("sha256:".length)}`,
            bytes,
        );
    }
};

const sha256Hex = (bytes: Uint8Array): string =>
    createHash("sha256").update(bytes).digest("hex");

if (import.meta.main) {
    try {
        await main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}