import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Deterministic tests for the production package-publication validation used
 * by the `publish-npm` job of `.github/workflows/release.yml`. The validation
 * runs through the executable seam `scripts/validate-npm-context.ts` (the
 * same entry point the workflow step invokes), against temporary package
 * files and controlled event/ref inputs, with no GitHub, registry, network,
 * or credentials.
 *
 * Unlike the stable-only release path (`scripts/validate-release-context.ts`),
 * this gate accepts the full SemVer 2.0.0 grammar including prerelease and
 * build metadata. A rejected context must exit non-zero and write nothing to
 * `GITHUB_OUTPUT` (asserted against the sentinel), so the `npm publish` step
 * of the same job can never run.
 */

const repositoryRoot = resolve(import.meta.dir, "..", "..");
const validationScript = join(
    repositoryRoot,
    "scripts/validate-npm-context.ts",
);
const releaseContextScript = join(
    repositoryRoot,
    "scripts/validate-release-context.ts",
);

const SENTINEL = "pre-existing-output\n";

type SpawnOutcome = {
    readonly exitCode: number | null;
    readonly stderr: string;
    readonly stdout: string;
};

type PackageOverrides = {
    readonly name?: string;
    readonly version?: string;
};

const createPackageDirectory = async (
    overrides: PackageOverrides = {},
): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "ralphie-npm-context-"));
    await writeFile(
        join(root, "package.json"),
        JSON.stringify(
            { name: "@beremaran/ralphie", version: "1.2.3", ...overrides },
            null,
            2,
        ),
    );
    return root;
};

const runValidation = (
    script: string,
    cwd: string,
    outputsPath: string,
    overrides: Readonly<Record<string, string>>,
): SpawnOutcome => {
    const result = Bun.spawnSync([process.execPath, script], {
        cwd,
        env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: tmpdir(),
            GITHUB_REF_TYPE: "tag",
            GITHUB_REF: "refs/tags/v1.2.3",
            GITHUB_OUTPUT: outputsPath,
            TAG: "v1.2.3",
            ...overrides,
        },
        stderr: "pipe",
        stdout: "pipe",
    });
    return {
        exitCode: result.exitCode,
        stderr: result.stderr.toString(),
        stdout: result.stdout.toString(),
    };
};

const expectRejected = async (
    outcome: SpawnOutcome,
    expectedMessage: string,
    outputsPath: string,
): Promise<void> => {
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.stderr).toContain(expectedMessage);
    // A rejected context produces no publication output: the outputs file
    // keeps exactly its sentinel content, so no `version` value exists that a
    // publisher could consume.
    expect(await readFile(outputsPath, "utf8")).toBe(SENTINEL);
};

const expectAccepted = async (
    outcome: SpawnOutcome,
    expectedVersion: string,
    outputsPath: string,
): Promise<void> => {
    expect(outcome.exitCode).toBe(0);
    expect(await readFile(outputsPath, "utf8")).toBe(
        `${SENTINEL}version=${expectedVersion}\n`,
    );
};

describe("npm publication context validation (scripts/validate-npm-context.ts)", () => {
    let scratch: string;
    let outputsPath: string;

    beforeEach(async () => {
        scratch = await mkdtemp(join(tmpdir(), "ralphie-npm-context-scratch-"));
        outputsPath = join(scratch, "outputs");
        await writeFile(outputsPath, SENTINEL);
    });

    afterEach(async () => {
        await rm(scratch, { recursive: true, force: true });
    });

    test("accepts the stable tag path with a matching package version", async () => {
        const root = await createPackageDirectory();
        try {
            const outcome = runValidation(validationScript, root, outputsPath, {
                TAG: "v1.2.3",
            });

            await expectAccepted(outcome, "1.2.3", outputsPath);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("accepts the prerelease-capable package/tag path (1.2.3-rc.1)", async () => {
        const root = await createPackageDirectory({ version: "1.2.3-rc.1" });
        try {
            const outcome = runValidation(validationScript, root, outputsPath, {
                TAG: "v1.2.3-rc.1",
            });

            await expectAccepted(outcome, "1.2.3-rc.1", outputsPath);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("accepts valid build metadata on the npm path", async () => {
        const cases = [
            { tag: "v1.2.3+build.7", version: "1.2.3+build.7" },
            { tag: "v1.2.3-rc.1+build.5", version: "1.2.3-rc.1+build.5" },
        ];
        for (const testCase of cases) {
            const root = await createPackageDirectory({
                version: testCase.version,
            });
            try {
                await writeFile(outputsPath, SENTINEL);
                const outcome = runValidation(
                    validationScript,
                    root,
                    outputsPath,
                    { TAG: testCase.tag },
                );

                await expectAccepted(outcome, testCase.version, outputsPath);
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        }
    });

    test("rejects numeric leading zeroes in core and prerelease identifiers", async () => {
        for (const tag of [
            "v01.2.3",
            "v1.02.3",
            "v1.2.03",
            "v1.2.3-01",
            "v1.2.3-rc.01",
        ]) {
            const root = await createPackageDirectory();
            try {
                const outcome = runValidation(
                    validationScript,
                    root,
                    outputsPath,
                    { TAG: tag },
                );

                await expectRejected(
                    outcome,
                    `Malformed npm release tag '${tag}'`,
                    outputsPath,
                );
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        }
    });

    test("rejects surrounding and embedded whitespace", async () => {
        for (const tag of [" v1.2.3", "v1.2.3 ", "v1.2. 3", "v1.2.3\n"]) {
            const root = await createPackageDirectory();
            try {
                const outcome = runValidation(
                    validationScript,
                    root,
                    outputsPath,
                    { TAG: tag },
                );

                await expectRejected(
                    outcome,
                    `Malformed npm release tag '${tag}'`,
                    outputsPath,
                );
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        }
    });

    test("rejects missing major, minor, or patch components", async () => {
        for (const tag of ["v", "v1", "v1.2", "v1.2.", "v.1.2.3"]) {
            const root = await createPackageDirectory();
            try {
                const outcome = runValidation(
                    validationScript,
                    root,
                    outputsPath,
                    { TAG: tag },
                );

                await expectRejected(
                    outcome,
                    `Malformed npm release tag '${tag}'`,
                    outputsPath,
                );
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        }
    });

    test("rejects a tag without the v prefix", async () => {
        const root = await createPackageDirectory();
        try {
            const outcome = runValidation(validationScript, root, outputsPath, {
                TAG: "1.2.3",
            });

            await expectRejected(
                outcome,
                "Malformed npm release tag '1.2.3': expected a tag beginning with v",
                outputsPath,
            );
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("rejects empty or malformed prerelease identifiers", async () => {
        for (const tag of ["v1.2.3-", "v1.2.3-rc.", "v1.2.3-rc..1"]) {
            const root = await createPackageDirectory();
            try {
                const outcome = runValidation(
                    validationScript,
                    root,
                    outputsPath,
                    { TAG: tag },
                );

                await expectRejected(
                    outcome,
                    `Malformed npm release tag '${tag}'`,
                    outputsPath,
                );
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        }
    });

    test("rejects malformed or empty build metadata", async () => {
        for (const tag of ["v1.2.3+", "v1.2.3+build.", "v1.2.3+build..1"]) {
            const root = await createPackageDirectory();
            try {
                const outcome = runValidation(
                    validationScript,
                    root,
                    outputsPath,
                    { TAG: tag },
                );

                await expectRejected(
                    outcome,
                    `Malformed npm release tag '${tag}'`,
                    outputsPath,
                );
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        }
    });

    test("refuses publication when the run is not from a v* tag ref", async () => {
        const cases: ReadonlyArray<readonly [string, string]> = [
            ["branch", "refs/heads/main"],
            ["tag", "refs/tags/release-1.2.3"],
        ];
        for (const [refType, githubRef] of cases) {
            const root = await createPackageDirectory();
            try {
                const outcome = runValidation(
                    validationScript,
                    root,
                    outputsPath,
                    { GITHUB_REF_TYPE: refType, GITHUB_REF: githubRef },
                );

                await expectRejected(
                    outcome,
                    `Refusing npm publication: the workflow must run from a v* tag (got ${githubRef})`,
                    outputsPath,
                );
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        }
    });

    test("rejects a tag/package.json version mismatch", async () => {
        const root = await createPackageDirectory({ version: "1.2.4" });
        try {
            const outcome = runValidation(validationScript, root, outputsPath, {
                TAG: "v1.2.3",
            });

            await expectRejected(
                outcome,
                "npm release tag v1.2.3 resolves to 1.2.3, but package.json declares 1.2.4; normal and prerelease versions must match exactly",
                outputsPath,
            );
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("rejects an unscoped package name", async () => {
        const root = await createPackageDirectory({ name: "ralphie" });
        try {
            const outcome = runValidation(validationScript, root, outputsPath, {
                TAG: "v1.2.3",
            });

            await expectRejected(
                outcome,
                "Refusing npm publication for unscoped package ralphie",
                outputsPath,
            );
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("the prerelease tag accepted here is rejected by the stable-only release path", async () => {
        // Cross-policy guard: the two workflow grammars stay explicit, so the
        // release context and package publication cannot silently diverge.
        const root = await createPackageDirectory({ version: "1.2.3-rc.1" });
        try {
            const stableOutputs = join(scratch, "stable-outputs");
            await writeFile(stableOutputs, SENTINEL);
            const stableOutcome = runValidation(
                releaseContextScript,
                root,
                stableOutputs,
                {
                    GITHUB_REF: "refs/tags/v1.2.3-rc.1",
                    RELEASE_VERSION: "v1.2.3-rc.1",
                },
            );
            expect(stableOutcome.exitCode).not.toBe(0);
            expect(stableOutcome.stderr).toContain(
                "Unsupported release tag: v1.2.3-rc.1",
            );
            expect(await readFile(stableOutputs, "utf8")).toBe(SENTINEL);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("the publish-npm job invokes this production seam with the validated tag", async () => {
        const workflow = await readFile(
            join(repositoryRoot, ".github/workflows/release.yml"),
            "utf8",
        );
        const npmJobStart = workflow.indexOf("  publish-npm:");
        const npmJob = workflow.slice(
            npmJobStart,
            workflow.indexOf("  push-container:", npmJobStart),
        );

        expect(npmJob).toContain("id: npm-context");
        expect(npmJob).toContain("TAG: ${{ needs.validate.outputs.tag }}");
        expect(npmJob).toContain("bun scripts/validate-npm-context.ts");
        // The grammar must not be re-inlined into the workflow where it could
        // silently drift from the executable seam the tests exercise.
        expect(npmJob).not.toMatch(
            /SEMVER_REGEX=|TAG_VERSION=|\"\$\{TAG#v\}\"/,
        );
    });
});