import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
    createSha256Sums,
    RELEASE_TARGETS,
} from "../scripts/create-sha256sums.ts";

type ReleaseTarget = (typeof RELEASE_TARGETS)[number];
type AssetChanges = Partial<Record<ReleaseTarget, string>>;

const version = "0.1.0";

async function createArtifactFixture(
    artifactVersion: string,
    changes: AssetChanges = {},
): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "ralphie-checksum-test-"));
    for (const target of RELEASE_TARGETS) {
        const artifactDirectory = join(
            root,
            `ralphie-${artifactVersion}-${target}`,
        );
        await mkdir(artifactDirectory);
        await writeFile(
            join(artifactDirectory, `ralphie-${target}`),
            changes[target] ?? `binary for ${target}`,
        );
    }
    return root;
}

async function readManifest(
    artifactVersion = version,
    changes: AssetChanges = {},
): Promise<Map<string, string>> {
    const fixture = await createArtifactFixture(artifactVersion, changes);
    try {
        await createSha256Sums({
            artifactDirectory: fixture,
            outputDirectory: fixture,
            version,
        });
        const lines = (await readFile(join(fixture, "SHA256SUMS"), "utf8"))
            .trimEnd()
            .split("\n");
        return new Map(
            lines.map((line) => {
                const separator = line.indexOf("  ");
                return [line.slice(separator + 2), line.slice(0, separator)];
            }),
        );
    } finally {
        await rm(fixture, { recursive: true, force: true });
    }
}

describe("release SHA-256 manifest", () => {
    test("changes the entry for every changed binary", async () => {
        const original = await readManifest();

        expect([...original.keys()]).toEqual(
            RELEASE_TARGETS.map((target) => `ralphie-${target}`),
        );
        for (const target of RELEASE_TARGETS) {
            const changed = await readManifest(version, {
                [target]: `changed bytes for ${target}`,
            });
            const assetName = `ralphie-${target}`;
            expect(changed.get(assetName)).not.toBe(original.get(assetName));
            expect(changed.get(assetName)).toMatch(/^[0-9a-f]{64}$/);
            for (const otherTarget of RELEASE_TARGETS) {
                if (otherTarget === target) continue;
                const otherAsset = `ralphie-${otherTarget}`;
                expect(changed.get(otherAsset)).toBe(original.get(otherAsset));
            }
        }
    });

    test("hashes exact bytes in deterministic target order", async () => {
        const fixture = await createArtifactFixture(version);
        try {
            await createSha256Sums({
                artifactDirectory: fixture,
                outputDirectory: fixture,
                version,
            });
            const manifest = await readFile(
                join(fixture, "SHA256SUMS"),
                "utf8",
            );
            const expected = RELEASE_TARGETS.map((target) => {
                const bytes = `binary for ${target}`;
                const digest = createHash("sha256").update(bytes).digest("hex");
                return `${digest}  ralphie-${target}`;
            }).join("\n");
            expect(manifest).toBe(`${expected}\n`);
        } finally {
            await rm(fixture, { recursive: true, force: true });
        }
    });

    test("rejects duplicate and cross-platform or cross-release artifacts", async () => {
        const duplicateFixture = await createArtifactFixture(version);
        try {
            await writeFile(
                join(
                    duplicateFixture,
                    `ralphie-${version}-linux-x64`,
                    "ralphie-linux-x64.duplicate",
                ),
                "duplicate bytes",
            );
            await expect(
                createSha256Sums({
                    artifactDirectory: duplicateFixture,
                    outputDirectory: duplicateFixture,
                    version,
                }),
            ).rejects.toThrow("exactly one binary");
        } finally {
            await rm(duplicateFixture, { recursive: true, force: true });
        }

        const platformFixture = await createArtifactFixture(version);
        try {
            await rm(
                join(
                    platformFixture,
                    `ralphie-${version}-darwin-arm64`,
                    "ralphie-darwin-arm64",
                ),
            );
            await writeFile(
                join(
                    platformFixture,
                    `ralphie-${version}-darwin-arm64`,
                    "ralphie-linux-arm64",
                ),
                "linux bytes",
            );
            await expect(
                createSha256Sums({
                    artifactDirectory: platformFixture,
                    outputDirectory: platformFixture,
                    version,
                }),
            ).rejects.toThrow("exactly one binary");
        } finally {
            await rm(platformFixture, { recursive: true, force: true });
        }

        const releaseFixture = await createArtifactFixture("0.2.0");
        try {
            await expect(
                createSha256Sums({
                    artifactDirectory: releaseFixture,
                    outputDirectory: releaseFixture,
                    version,
                }),
            ).rejects.toThrow("must be exactly");
        } finally {
            await rm(releaseFixture, { recursive: true, force: true });
        }
    });
});