import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
    createReleaseMetadata,
    RELEASE_TARGETS,
} from "../scripts/create-release-metadata.ts";

type ReleaseTarget = (typeof RELEASE_TARGETS)[number];
type AssetChanges = Partial<Record<ReleaseTarget, string>>;

const version = "0.1.0";
const commitSha = "0123456789abcdef0123456789abcdef01234567";

async function createArtifactFixture(
    artifactVersion: string,
    changes: AssetChanges = {},
): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "ralphie-metadata-test-"));
    for (const target of RELEASE_TARGETS) {
        const asset = `ralphie-${target}`;
        const artifactDirectory = join(
            root,
            `ralphie-${artifactVersion}-${target}`,
        );
        await mkdir(artifactDirectory);
        const bytes = changes[target] ?? `binary for ${target}`;
        const digest = createHash("sha256").update(bytes).digest("hex");
        await writeFile(join(artifactDirectory, asset), bytes);
        await writeFile(
            join(artifactDirectory, `${asset}.sha256`),
            `${digest}  ${asset}\n`,
        );
    }
    return root;
}

describe("release metadata aggregation", () => {
    test("creates a deterministic verified bundle", async () => {
        const fixture = await createArtifactFixture(version);
        const output = join(fixture, "bundle");
        try {
            await createReleaseMetadata({
                artifactDirectory: fixture,
                commitSha,
                outputDirectory: output,
                tag: `v${version}`,
                version,
            });
            const metadata = JSON.parse(
                await readFile(join(output, "release-metadata.json"), "utf8"),
            );
            expect(metadata.schema).toBe("ralphie.release-metadata.v1");
            expect(metadata.tag).toBe(`v${version}`);
            expect(metadata.version).toBe(version);
            expect(metadata.commit).toBe(commitSha);
            expect(
                metadata.assets.map((asset: { name: string }) => asset.name),
            ).toEqual(RELEASE_TARGETS.map((target) => `ralphie-${target}`));
            expect(
                await readFile(join(output, "SHA256SUMS"), "utf8"),
            ).toContain("ralphie-linux-x64");
        } finally {
            await rm(fixture, { recursive: true, force: true });
        }
    });

    test("rejects checksum mismatches and unexpected artifacts", async () => {
        const fixture = await createArtifactFixture(version);
        try {
            await writeFile(
                join(
                    fixture,
                    `ralphie-${version}-linux-x64`,
                    "ralphie-linux-x64.sha256",
                ),
                "0".repeat(64) + "  ralphie-linux-x64\n",
            );
            await expect(
                createReleaseMetadata({
                    artifactDirectory: fixture,
                    commitSha,
                    outputDirectory: join(fixture, "bundle"),
                    tag: `v${version}`,
                    version,
                }),
            ).rejects.toThrow("does not match its contents");
        } finally {
            await rm(fixture, { recursive: true, force: true });
        }

        const extraFixture = await createArtifactFixture(version);
        try {
            await mkdir(join(extraFixture, `ralphie-${version}-extra`));
            await expect(
                createReleaseMetadata({
                    artifactDirectory: extraFixture,
                    commitSha,
                    outputDirectory: join(extraFixture, "bundle"),
                    tag: `v${version}`,
                    version,
                }),
            ).rejects.toThrow("Release artifacts must be exactly");
        } finally {
            await rm(extraFixture, { recursive: true, force: true });
        }
    });
});