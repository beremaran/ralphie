#!/usr/bin/env bun

/**
 * Side-effect-free validation seam for the exact staged container-candidate
 * set, used by the protected `push-container` job of
 * `.github/workflows/release.yml` (step "Validate exact staged container
 * candidate set") and runnable locally:
 *
 *   bun scripts/validate-container-candidates.ts \
 *     --candidates-dir <dir> --version <version> --source-ref <sha>
 *
 * The candidates directory must contain exactly the two immutable staging
 * artifacts `ralphie-container-candidate-<version>-amd64|arm64`, each with
 * exactly its `ralphie.container-candidate.v1` contract and OCI archive. The
 * validator strictly parses the contract, recomputes the archive SHA-256,
 * and inspects the archive's own `index.json` and actual image manifest,
 * comparing the recomputed manifest content digest with the recorded BuildKit
 * digest. The module never logs in to GHCR, writes a registry tag, rebuilds
 * an image, or performs any network I/O; every mismatch fails closed with a
 * non-zero exit and no output is considered validated.
 */

import {
    validateContainerCandidates,
    type ValidatedContainerCandidates,
} from "../src/release/container-candidate.ts";

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
    if (args.length !== 6) {
        throw new Error(
            "Usage: validate-container-candidates.ts --candidates-dir <path> --version <version> --source-ref <sha>",
        );
    }
    const validated: ValidatedContainerCandidates =
        await validateContainerCandidates({
            candidatesDir: optionValue(args, "--candidates-dir"),
            sourceRef: optionValue(args, "--source-ref"),
            version: optionValue(args, "--version"),
        });
    const lines = Object.values(validated.byPlatform).map((candidate) => {
        const arch = candidate.arch;
        return `${arch}: ${candidate.platform} ${candidate.image.digest} ${candidate.archivePath} (sha256:${candidate.archiveSha256})`;
    });
    console.log(
        `Validated container candidates for ${validated.version}@${validated.sourceRef}`,
    );
    for (const line of lines) console.log(line);
};

if (import.meta.main) {
    try {
        await main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}