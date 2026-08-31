import { createHash } from "node:crypto";
import {
    mkdtemp,
    mkdir,
    readFile,
    readdir,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
    createSboms,
    RELEASE_TARGETS,
    validateSbomSet,
} from "../scripts/create-sboms.ts";

type ReleaseTarget = (typeof RELEASE_TARGETS)[number];

const version = "1.2.3";
const tag = `v${version}`;
const buildCommand = "bun run build -- --commit-sha COMMIT --version 1.2.3";

const runGit = (root: string, args: ReadonlyArray<string>): string => {
    const result = Bun.spawnSync(["git", "-C", root, ...args], {
        stdout: "pipe",
        stderr: "pipe",
    });
    if (result.exitCode !== 0) {
        throw new Error(new TextDecoder().decode(result.stderr));
    }
    return new TextDecoder().decode(result.stdout).trim();
};

async function createFixture(): Promise<{
    readonly root: string;
    readonly assets: string;
    readonly commitSha: string;
}> {
    const root = await mkdtemp(join(tmpdir(), "ralphie-sbom-test-"));
    await mkdir(join(root, "src"));
    await mkdir(join(root, "scripts"));
    await writeFile(join(root, "index.ts"), 'console.log("fixture");\n');
    await writeFile(
        join(root, "src", "main.ts"),
        "export const fixture = true;\n",
    );
    await writeFile(
        join(root, "scripts", "build.ts"),
        "await Bun.build({});\n",
    );
    await writeFile(
        join(root, "package.json"),
        JSON.stringify({ name: "fixture", version }, null, 2),
    );
    await writeFile(
        join(root, "bun.lock"),
        `{
  lockfileVersion: 1,
  packages: {
    zod: ["zod@4.4.3", "", {}, "sha512-fixture"],
  },
}\n`,
    );
    runGit(root, ["init", "-q"]);
    runGit(root, ["config", "user.email", "sbom@example.invalid"]);
    runGit(root, ["config", "user.name", "SBOM test"]);
    runGit(root, ["add", "."]);
    const commitProcess = Bun.spawnSync(
        ["git", "-C", root, "commit", "-qm", "fixture"],
        {
            env: {
                ...process.env,
                GIT_AUTHOR_DATE: "2024-01-02T03:04:05Z",
                GIT_COMMITTER_DATE: "2024-01-02T03:04:05Z",
            },
            stdout: "pipe",
            stderr: "pipe",
        },
    );
    if (commitProcess.exitCode !== 0) {
        throw new Error(new TextDecoder().decode(commitProcess.stderr));
    }
    const commitSha = runGit(root, ["rev-parse", "HEAD"]);
    const assets = join(root, "release-assets");
    await mkdir(assets);
    const sums: string[] = [];
    const releaseAssets: Array<{ name: string; sha256: string }> = [];
    for (const target of RELEASE_TARGETS) {
        const name = `ralphie-${target}`;
        const bytes = `final ${target} bytes\n`;
        const digest = createHash("sha256").update(bytes).digest("hex");
        await writeFile(join(assets, name), bytes);
        await writeFile(join(assets, `${name}.sha256`), `${digest}  ${name}\n`);
        releaseAssets.push({ name, sha256: digest });
        sums.push(`${digest}  ${name}`);
    }
    await writeFile(join(assets, "SHA256SUMS"), `${sums.join("\n")}\n`);
    await writeFile(
        join(assets, "release-metadata.json"),
        `${JSON.stringify(
            {
                schema: "ralphie.release-metadata.v1",
                tag,
                version,
                commit: commitSha,
                assets: releaseAssets,
            },
            null,
            2,
        )}\n`,
    );
    return { root, assets, commitSha };
}

const optionsFor = (
    fixture: Awaited<ReturnType<typeof createFixture>>,
    outputDirectory: string,
) => ({
    assetsDirectory: fixture.assets,
    buildCommand,
    buildToolVersion: "1.3.14",
    bunVersion: "1.3.14",
    commitSha: fixture.commitSha,
    outputDirectory,
    sourceDirectory: fixture.root,
    tag,
    version,
});

describe("deterministic native release SBOMs", () => {
    test("writes four deterministic SPDX documents bound to final bytes and inputs", async () => {
        const fixture = await createFixture();
        try {
            const firstOutput = join(fixture.root, "sboms-one");
            const secondOutput = join(fixture.root, "sboms-two");
            await createSboms(optionsFor(fixture, firstOutput));
            await createSboms(optionsFor(fixture, secondOutput));
            await validateSbomSet(
                firstOutput,
                version,
                tag,
                fixture.commitSha,
                fixture.root,
                fixture.assets,
            );
            const names = await readdir(firstOutput);
            expect(names.sort()).toEqual(
                RELEASE_TARGETS.map(
                    (target) => `ralphie-${target}.sbom.spdx.json`,
                ).sort(),
            );
            for (const target of RELEASE_TARGETS) {
                const name = `ralphie-${target}.sbom.spdx.json`;
                const first = await readFile(join(firstOutput, name), "utf8");
                expect(first).toBe(
                    await readFile(join(secondOutput, name), "utf8"),
                );
                const document = JSON.parse(first) as {
                    spdxVersion: string;
                    files: Array<{
                        fileName: string;
                        checksums: Array<{
                            algorithm: string;
                            checksumValue: string;
                        }>;
                    }>;
                    creationInfo: { comment: string };
                };
                expect(document.spdxVersion).toBe("SPDX-2.3");
                const metadata = JSON.parse(document.creationInfo.comment) as {
                    releaseTag: string;
                    releaseVersion: string;
                    commitSha: string;
                    target: ReleaseTarget;
                    finalBinaryFilename: string;
                    finalBinarySha256: string;
                    finalBinarySize: number;
                    buildInputs: string[];
                    lockfile: { fileName: string; sha256: string };
                    buildCommand: string;
                    bunVersion: string;
                    buildTool: { version: string };
                    sbomGenerator: { name: string; version: string };
                };
                expect(metadata).toMatchObject({
                    releaseTag: tag,
                    releaseVersion: version,
                    commitSha: fixture.commitSha,
                    target,
                    finalBinaryFilename: `ralphie-${target}`,
                    buildCommand,
                    bunVersion: "1.3.14",
                    buildTool: { name: "Bun", version: "1.3.14" },
                    sbomGenerator: {
                        name: "ralphie-sbom-generator",
                        version: "1.0.0",
                    },
                    lockfile: { fileName: "bun.lock" },
                });
                expect(metadata.buildInputs).toEqual(
                    expect.arrayContaining([
                        "index.ts",
                        "src/main.ts",
                        "package.json",
                        "bun.lock",
                        "scripts/build.ts",
                    ]),
                );
                const lockfile = document.files.find(
                    (file) => file.fileName === "bun.lock",
                );
                expect(lockfile?.checksums[0]?.checksumValue).toBe(
                    metadata.lockfile.sha256,
                );
                const binary = document.files.find(
                    (file) => file.fileName === `ralphie-${target}`,
                );
                expect(metadata.finalBinarySize).toBe(
                    (await stat(join(fixture.assets, `ralphie-${target}`)))
                        .size,
                );
                expect(binary?.checksums[0]?.checksumValue).toBe(
                    metadata.finalBinarySha256,
                );
            }
        } finally {
            await rm(fixture.root, { recursive: true, force: true });
        }
    });

    test("binds validation to the checked-out source and lockfile independently", async () => {
        const fixture = await createFixture();
        try {
            const output = join(fixture.root, "tampered-source");
            await createSboms(optionsFor(fixture, output));
            const name = "ralphie-darwin-arm64.sbom.spdx.json";
            const path = join(output, name);
            const document = JSON.parse(await readFile(path, "utf8")) as {
                creationInfo: { comment: string };
                files: Array<{
                    fileName: string;
                    checksums: Array<{ checksumValue: string }>;
                }>;
            };
            const metadata = JSON.parse(document.creationInfo.comment) as {
                buildInputs: string[];
                lockfile: { fileName: string; sha256: string; size: number };
                sourceFiles: Array<{
                    fileName: string;
                    sha256: string;
                    size: number;
                }>;
            };
            const tamperedDigest = "f".repeat(64);
            metadata.buildInputs = [...metadata.buildInputs, "tampered.ts"];
            metadata.lockfile.sha256 = tamperedDigest;
            const sourceMetadata = metadata.sourceFiles.find(
                (file) => file.fileName === "index.ts",
            );
            const lockfile = document.files.find(
                (file) => file.fileName === "bun.lock",
            );
            const sourceFile = document.files.find(
                (file) => file.fileName === "index.ts",
            );
            if (
                sourceMetadata === undefined ||
                lockfile?.checksums[0] === undefined ||
                sourceFile?.checksums[0] === undefined
            ) {
                throw new Error("Fixture inventory is incomplete.");
            }
            sourceMetadata.sha256 = tamperedDigest;
            lockfile.checksums[0].checksumValue = tamperedDigest;
            sourceFile.checksums[0].checksumValue = tamperedDigest;
            document.creationInfo.comment = JSON.stringify(metadata);
            await writeFile(path, `${JSON.stringify(document, null, 2)}\n`);

            await expect(
                validateSbomSet(
                    output,
                    version,
                    tag,
                    fixture.commitSha,
                    fixture.root,
                    fixture.assets,
                ),
            ).rejects.toThrow("validated source checkout");
        } finally {
            await rm(fixture.root, { recursive: true, force: true });
        }
    });

    test("binds package inventory and rejects invalid SPDX identifiers", async () => {
        const fixture = await createFixture();
        try {
            const packageOutput = join(fixture.root, "tampered-packages");
            await createSboms(optionsFor(fixture, packageOutput));
            const packagePath = join(
                packageOutput,
                "ralphie-darwin-arm64.sbom.spdx.json",
            );
            const packageDocument = JSON.parse(
                await readFile(packagePath, "utf8"),
            ) as {
                packages: Array<Record<string, unknown>>;
            };
            const packageEntry = packageDocument.packages[0];
            if (packageEntry === undefined) {
                throw new Error("Fixture package inventory is incomplete.");
            }
            packageEntry.SPDXID = "SPDXRef-Package-tampered";
            packageEntry.versionInfo = "999.0.0";
            await writeFile(
                packagePath,
                `${JSON.stringify(packageDocument, null, 2)}\n`,
            );
            await expect(
                validateSbomSet(
                    packageOutput,
                    version,
                    tag,
                    fixture.commitSha,
                    fixture.root,
                    fixture.assets,
                ),
            ).rejects.toThrow("does not conform to the SPDX release contract");

            const schemaOutput = join(fixture.root, "tampered-schema");
            await createSboms(optionsFor(fixture, schemaOutput));
            const schemaPath = join(
                schemaOutput,
                "ralphie-darwin-arm64.sbom.spdx.json",
            );
            const schemaDocument = JSON.parse(
                await readFile(schemaPath, "utf8"),
            ) as {
                files: Array<Record<string, unknown>>;
            };
            const schemaFile = schemaDocument.files[0];
            if (schemaFile === undefined) {
                throw new Error("Fixture file inventory is incomplete.");
            }
            schemaFile.SPDXID = "bad";
            await writeFile(
                schemaPath,
                `${JSON.stringify(schemaDocument, null, 2)}\n`,
            );
            await expect(
                validateSbomSet(
                    schemaOutput,
                    version,
                    tag,
                    fixture.commitSha,
                    fixture.root,
                    fixture.assets,
                ),
            ).rejects.toThrow("invalid SPDX identifier");
        } finally {
            await rm(fixture.root, { recursive: true, force: true });
        }
    });

    test("rejects an element identifier that collides with the document", async () => {
        const fixture = await createFixture();
        try {
            const output = join(fixture.root, "duplicate-document-id");
            await createSboms(optionsFor(fixture, output));
            const path = join(output, "ralphie-darwin-arm64.sbom.spdx.json");
            const document = JSON.parse(await readFile(path, "utf8")) as {
                files: Array<{ SPDXID: string }>;
            };
            const file = document.files[0];
            if (file === undefined) {
                throw new Error("Fixture file inventory is incomplete.");
            }
            file.SPDXID = "SPDXRef-DOCUMENT";
            await writeFile(path, `${JSON.stringify(document, null, 2)}\n`);
            await expect(
                validateSbomSet(
                    output,
                    version,
                    tag,
                    fixture.commitSha,
                    fixture.root,
                    fixture.assets,
                ),
            ).rejects.toThrow("duplicate SPDX identifiers");
        } finally {
            await rm(fixture.root, { recursive: true, force: true });
        }
    });

    test("rejects dangling SPDX references when a binary identifier changes", async () => {
        const fixture = await createFixture();
        try {
            const output = join(fixture.root, "dangling-reference");
            await createSboms(optionsFor(fixture, output));
            const path = join(output, "ralphie-darwin-arm64.sbom.spdx.json");
            const document = JSON.parse(await readFile(path, "utf8")) as {
                files: Array<{ fileName: string; SPDXID: string }>;
            };
            const binary = document.files.find(
                (file) => file.fileName === "ralphie-darwin-arm64",
            );
            if (binary === undefined) {
                throw new Error("Fixture binary inventory is incomplete.");
            }
            binary.SPDXID = "SPDXRef-File-dangling";
            await writeFile(path, `${JSON.stringify(document, null, 2)}\n`);

            await expect(
                validateSbomSet(
                    output,
                    version,
                    tag,
                    fixture.commitSha,
                    fixture.root,
                    fixture.assets,
                ),
            ).rejects.toThrow("dangling SPDX reference");
        } finally {
            await rm(fixture.root, { recursive: true, force: true });
        }
    });

    test("fails closed for incomplete, cross-release, duplicate, and mismatched outputs", async () => {
        const fixture = await createFixture();
        try {
            const output = join(fixture.root, "sboms");
            await createSboms(optionsFor(fixture, output));
            await writeFile(
                join(output, "ralphie-unexpected.sbom.spdx.json"),
                "{}\n",
            );
            await expect(
                validateSbomSet(
                    output,
                    version,
                    tag,
                    fixture.commitSha,
                    fixture.root,
                    fixture.assets,
                ),
            ).rejects.toThrow("exactly one document per native target");
            await rm(join(output, "ralphie-unexpected.sbom.spdx.json"));
            await rm(join(output, "ralphie-linux-x64.sbom.spdx.json"));
            await expect(
                validateSbomSet(
                    output,
                    version,
                    tag,
                    fixture.commitSha,
                    fixture.root,
                    fixture.assets,
                ),
            ).rejects.toThrow("exactly one document per native target");

            await expect(
                validateSbomSet(
                    output,
                    "1.2.4",
                    tag,
                    fixture.commitSha,
                    fixture.root,
                    fixture.assets,
                ),
            ).rejects.toThrow("does not match version");

            const mismatch = join(fixture.root, "mismatch");
            await writeFile(
                join(fixture.assets, "ralphie-linux-x64"),
                "changed\n",
            );
            await expect(
                createSboms(optionsFor(fixture, mismatch)),
            ).rejects.toThrow("digest does not match");
        } finally {
            await rm(fixture.root, { recursive: true, force: true });
        }
    });
});