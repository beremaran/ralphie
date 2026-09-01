import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import packageJson from "../../package.json";
import {
    stageReleasePackage,
    validateStagedReleasePackage,
} from "../../scripts/stage-release-package.ts";

const repositoryRoot = resolve(import.meta.dir, "../..");
const version = packageJson.version;
const sourceRevision = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    stdout: "pipe",
    stderr: "pipe",
})
    .stdout.toString()
    .trim();

let fixture: string;
const stagingDirectory = () => join(fixture, "release-package");

beforeAll(async () => {
    fixture = await mkdtemp(join(tmpdir(), "ralphie-package-staging-test-"));
    await stageReleasePackage({
        outputDirectory: stagingDirectory(),
        sourceDirectory: repositoryRoot,
        sourceRevision,
        version,
    });
});

afterAll(async () => {
    await rm(fixture, { force: true, recursive: true });
});

describe("release package staging", () => {
    test("creates validated package and installer inputs", async () => {
        const result = await validateStagedReleasePackage({
            outputDirectory: stagingDirectory(),
            sourceDirectory: repositoryRoot,
            sourceRevision,
            version,
        });

        expect(result.version).toBe(version);
        expect(result.sourceRevision).toBe(sourceRevision);
        expect(result.packagePath).toBe(
            join(stagingDirectory(), `beremaran-ralphie-${version}.tgz`),
        );
        expect(result.packageSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(await readFile(result.installerPath, "utf8")).toBe(
            await readFile(join(repositoryRoot, "scripts/install.sh"), "utf8"),
        );
    });

    test("rejects a wrong package version", async () => {
        await expect(
            validateStagedReleasePackage({
                outputDirectory: stagingDirectory(),
                sourceDirectory: repositoryRoot,
                sourceRevision,
                version: "0.0.1",
            }),
        ).rejects.toThrow("source package version");
    });

    test("accepts valid prerelease syntax before checking package identity", async () => {
        const outputDirectory = await mkdtemp(
            join(tmpdir(), "ralphie-package-prerelease-test-"),
        );
        try {
            await expect(
                stageReleasePackage({
                    outputDirectory,
                    sourceDirectory: repositoryRoot,
                    sourceRevision,
                    version: `${version}-rc.1`,
                }),
            ).rejects.toThrow("source package version");
        } finally {
            await rm(outputDirectory, { force: true, recursive: true });
        }
    });

    test("rejects a missing installer", async () => {
        const installerPath = join(stagingDirectory(), "scripts/install.sh");
        const installer = await readFile(installerPath);
        await rm(installerPath);
        try {
            await expect(
                validateStagedReleasePackage({
                    outputDirectory: stagingDirectory(),
                    sourceDirectory: repositoryRoot,
                    sourceRevision,
                    version,
                }),
            ).rejects.toThrow("install.sh");
        } finally {
            await writeFile(installerPath, installer, { mode: 0o755 });
        }
    });

    test("rejects extra staging files", async () => {
        const extraPath = join(stagingDirectory(), "unintended.txt");
        await writeFile(extraPath, "unexpected\n");
        try {
            await expect(
                validateStagedReleasePackage({
                    outputDirectory: stagingDirectory(),
                    sourceDirectory: repositoryRoot,
                    sourceRevision,
                    version,
                }),
            ).rejects.toThrow("package staging root entries");
        } finally {
            await rm(extraPath, { force: true });
        }
    });

    test("rejects a source revision mismatch before building", async () => {
        const outputDirectory = await mkdtemp(
            join(tmpdir(), "ralphie-package-mismatch-test-"),
        );
        try {
            await expect(
                stageReleasePackage({
                    outputDirectory,
                    sourceDirectory: repositoryRoot,
                    sourceRevision: "0".repeat(40),
                    version,
                }),
            ).rejects.toThrow("source revision mismatch");
        } finally {
            await rm(outputDirectory, { force: true, recursive: true });
        }
    });
});