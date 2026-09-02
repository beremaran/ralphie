import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Deterministic tests for the production release-context validation used by
 * the `validate` job of `.github/workflows/release.yml`. The validation runs
 * through the executable seam `scripts/validate-release-context.ts` (the same
 * entry point the workflow step invokes), against a temporary Git repository
 * with real commits and tags, with controlled event/ref/protection inputs and
 * no GitHub, registry, network, or credentials.
 *
 * A rejected context must exit non-zero, write nothing to `GITHUB_OUTPUT`
 * (asserted against the sentinel), and therefore never reach a publisher; an
 * accepted context must emit exactly the canonical outputs.
 */

const repositoryRoot = resolve(import.meta.dir, "..", "..");
const validationScript = join(
    repositoryRoot,
    "scripts/validate-release-context.ts",
);
const npmScript = join(repositoryRoot, "scripts/validate-npm-context.ts");

const SENTINEL = "pre-existing-output\n";

type RepositoryFixture = {
    readonly commitSha: string;
    readonly root: string;
    readonly version: string;
};

type SpawnOutcome = {
    readonly exitCode: number | null;
    readonly stderr: string;
    readonly stdout: string;
};

const git = (root: string, args: ReadonlyArray<string>): string => {
    const result = Bun.spawnSync(["git", ...args], {
        cwd: root,
        stderr: "pipe",
        stdout: "pipe",
    });
    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();
    if (result.exitCode !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${stderr || stdout}`);
    }
    return stdout;
};

const createRepository = async (
    version = "1.2.3",
): Promise<RepositoryFixture> => {
    const root = await mkdtemp(join(tmpdir(), "ralphie-release-context-"));
    git(root, ["init", "-b", "main"]);
    git(root, ["config", "user.name", "Ralphie Release Tests"]);
    git(root, ["config", "user.email", "ralphie-release-tests@example.com"]);
    await writeFile(
        join(root, "package.json"),
        JSON.stringify({ name: "@beremaran/ralphie", version }, null, 2),
    );
    git(root, ["add", "--all"]);
    git(root, ["commit", "-m", "initial"]);
    const commitSha = git(root, ["rev-parse", "HEAD"]).trim();
    git(root, ["tag", "-a", `v${version}`, "-m", `v${version}`]);
    return { commitSha, root, version };
};

const addCommit = async (root: string): Promise<string> => {
    await writeFile(join(root, "second.txt"), "second");
    git(root, ["add", "--all"]);
    git(root, ["commit", "-m", "second"]);
    return git(root, ["rev-parse", "HEAD"]).trim();
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
            GITHUB_EVENT_NAME: "push",
            GITHUB_REF: "refs/tags/v1.2.3",
            GITHUB_REF_PROTECTED: "true",
            GITHUB_OUTPUT: outputsPath,
            RELEASE_DRY_RUN: "false",
            RELEASE_REF: "",
            RELEASE_VERSION: "v1.2.3",
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
    // A rejected context produces no validated release outputs: the outputs
    // file keeps exactly its sentinel content, so no publisher can consume a
    // partial version/tag/source_ref context.
    expect(await readFile(outputsPath, "utf8")).toBe(SENTINEL);
};

const expectAccepted = async (
    outcome: SpawnOutcome,
    expectedOutputs: ReadonlyArray<string>,
    outputsPath: string,
): Promise<void> => {
    expect(outcome.exitCode).toBe(0);
    expect(await readFile(outputsPath, "utf8")).toBe(
        `${SENTINEL}${expectedOutputs.join("\n")}\n`,
    );
};

const canonicalOutputs = (fixture: RepositoryFixture, dryRun = "false") => [
    `version=${fixture.version}`,
    `tag=v${fixture.version}`,
    `source_ref=${fixture.commitSha}`,
    `dry_run=${dryRun}`,
];

describe("release context validation (scripts/validate-release-context.ts)", () => {
    let fixture: RepositoryFixture;
    let scratch: string;
    let outputsPath: string;

    beforeEach(async () => {
        fixture = await createRepository();
        scratch = await mkdtemp(
            join(tmpdir(), "ralphie-release-context-scratch-"),
        );
        outputsPath = join(scratch, "outputs");
        await writeFile(outputsPath, SENTINEL);
    });

    afterEach(async () => {
        await rm(fixture.root, { recursive: true, force: true });
        await rm(scratch, { recursive: true, force: true });
    });

    const run = (overrides: Readonly<Record<string, string>>): SpawnOutcome =>
        runValidation(validationScript, fixture.root, outputsPath, overrides);

    test("accepts a valid stable tag push and emits only canonical outputs", async () => {
        const outcome = run({ RELEASE_REF: fixture.commitSha });

        await expectAccepted(outcome, canonicalOutputs(fixture), outputsPath);
    });

    test("accepts a valid manual dispatch from the matching protected tag", async () => {
        const outcome = run({
            GITHUB_EVENT_NAME: "workflow_dispatch",
            GITHUB_REF: "refs/tags/v1.2.3",
            RELEASE_REF: fixture.commitSha,
            RELEASE_DRY_RUN: "true",
        });

        await expectAccepted(
            outcome,
            canonicalOutputs(fixture, "true"),
            outputsPath,
        );
    });

    test("accepts the v0.x.y grammar (numeric zero is valid in the major position)", async () => {
        const zeroFixture = await createRepository("0.1.0");
        try {
            const outcome = runValidation(
                validationScript,
                zeroFixture.root,
                outputsPath,
                {
                    GITHUB_REF: "refs/tags/v0.1.0",
                    RELEASE_REF: zeroFixture.commitSha,
                    RELEASE_VERSION: "v0.1.0",
                },
            );

            await expectAccepted(
                outcome,
                canonicalOutputs(zeroFixture),
                outputsPath,
            );
        } finally {
            await rm(zeroFixture.root, { recursive: true, force: true });
        }
    });

    test("rejects prerelease and build suffixes (stable-only release path)", async () => {
        for (const suffix of ["v1.2.3-rc.1", "v1.2.3+build.7"]) {
            const outcome = run({ RELEASE_VERSION: suffix });

            await expectRejected(
                outcome,
                `Unsupported release tag: ${suffix}`,
                outputsPath,
            );
            expect(outcome.stderr).toContain(
                "Expected v<major>.<minor>.<patch>, for example v0.1.0.",
            );
        }
    });

    test("rejects numeric leading zeroes in major, minor, and patch", async () => {
        for (const version of ["v01.2.3", "v1.02.3", "v1.2.03"]) {
            const outcome = run({ RELEASE_VERSION: version });

            await expectRejected(
                outcome,
                `Unsupported release tag: ${version}`,
                outputsPath,
            );
        }
    });

    test("rejects surrounding and embedded whitespace", async () => {
        for (const version of [" v1.2.3", "v1.2.3 ", "v1.2. 3", "v1.2.3\n"]) {
            const outcome = run({ RELEASE_VERSION: version });

            await expectRejected(
                outcome,
                `Unsupported release tag: ${version}`,
                outputsPath,
            );
        }
    });

    test("rejects missing major, minor, or patch components and a missing v prefix", async () => {
        for (const version of ["v", "v1", "v1.2", "v1.2.", "1.2.3"]) {
            const outcome = run({ RELEASE_VERSION: version });

            await expectRejected(
                outcome,
                `Unsupported release tag: ${version}`,
                outputsPath,
            );
        }
    });

    test("rejects an invalid dry_run value", async () => {
        const outcome = run({ RELEASE_DRY_RUN: "yes" });

        await expectRejected(
            outcome,
            "dry_run must resolve to true or false",
            outputsPath,
        );
    });

    test("rejects a push whose ref is not the validated release tag", async () => {
        const outcome = run({ GITHUB_REF: "refs/heads/main" });

        await expectRejected(
            outcome,
            "The push ref is not the validated release tag",
            outputsPath,
        );
    });

    test("rejects a manual dispatch started from the wrong tag or a branch", async () => {
        for (const githubRef of ["refs/tags/v2.0.0", "refs/heads/main"]) {
            const outcome = run({
                GITHUB_EVENT_NAME: "workflow_dispatch",
                GITHUB_REF: githubRef,
                RELEASE_REF: fixture.commitSha,
            });

            await expectRejected(
                outcome,
                "workflow_dispatch must be run from the version tag v1.2.3",
                outputsPath,
            );
        }
    });

    test("rejects an invalid manual SHA ref", async () => {
        for (const releaseRef of [
            "abc",
            "a".repeat(39),
            "aaaaBBBB".repeat(5),
        ]) {
            const outcome = run({
                GITHUB_EVENT_NAME: "workflow_dispatch",
                GITHUB_REF: "refs/tags/v1.2.3",
                RELEASE_REF: releaseRef,
            });

            await expectRejected(
                outcome,
                "workflow_dispatch ref must be a 40-character lowercase commit SHA",
                outputsPath,
            );
        }
    });

    test("rejects a package.json/tag version mismatch", async () => {
        await writeFile(
            join(fixture.root, "package.json"),
            JSON.stringify(
                { name: "@beremaran/ralphie", version: "0.1.0" },
                null,
                2,
            ),
        );
        const outcome = run({ RELEASE_REF: fixture.commitSha });

        await expectRejected(
            outcome,
            "Release tag v1.2.3 does not match package.json version 0.1.0",
            outputsPath,
        );
    });

    test("rejects an unprotected release tag", async () => {
        const outcome = run({
            GITHUB_REF_PROTECTED: "false",
            RELEASE_REF: fixture.commitSha,
        });

        await expectRejected(
            outcome,
            "The release tag must be protected against updates and deletions",
            outputsPath,
        );
    });

    test("rejects a missing tag", async () => {
        git(fixture.root, ["tag", "-d", "v1.2.3"]);
        const outcome = run({ RELEASE_REF: fixture.commitSha });

        await expectRejected(
            outcome,
            "Release tag v1.2.3 does not exist in the checkout",
            outputsPath,
        );
    });

    test("rejects a release ref that is not a commit", async () => {
        const outcome = run({ RELEASE_REF: "missing-sha" });

        await expectRejected(
            outcome,
            "Release ref missing-sha is not a commit",
            outputsPath,
        );
    });

    test("rejects a tag and ref that resolve to different commits", async () => {
        const secondCommit = await addCommit(fixture.root);
        const outcome = run({ RELEASE_REF: secondCommit });

        await expectRejected(
            outcome,
            `Release ref ${secondCommit} does not target v1.2.3 (${fixture.commitSha})`,
            outputsPath,
        );
    });

    test("keeps the stable-only policy separate from the prerelease-capable npm policy", async () => {
        // The same tag value is a valid npm-published version but not a
        // release version; the two workflow policies must stay explicit and
        // cannot silently converge.
        const packageDir = await mkdtemp(join(tmpdir(), "ralphie-policy-"));
        try {
            await writeFile(
                join(packageDir, "package.json"),
                JSON.stringify(
                    { name: "@beremaran/ralphie", version: "1.2.3-rc.1" },
                    null,
                    2,
                ),
            );
            const npmOutputs = join(scratch, "npm-outputs");
            await writeFile(npmOutputs, SENTINEL);
            const npmOutcome = runValidation(
                npmScript,
                packageDir,
                npmOutputs,
                {
                    GITHUB_REF: "refs/tags/v1.2.3-rc.1",
                    GITHUB_REF_TYPE: "tag",
                    TAG: "v1.2.3-rc.1",
                },
            );
            expect(npmOutcome.exitCode).toBe(0);
            expect(await readFile(npmOutputs, "utf8")).toBe(
                `${SENTINEL}version=1.2.3-rc.1\n`,
            );

            const stableOutcome = runValidation(
                validationScript,
                packageDir,
                outputsPath,
                {
                    GITHUB_REF: "refs/tags/v1.2.3-rc.1",
                    RELEASE_VERSION: "v1.2.3-rc.1",
                },
            );
            await expectRejected(
                stableOutcome,
                "Unsupported release tag: v1.2.3-rc.1",
                outputsPath,
            );
        } finally {
            await rm(packageDir, { recursive: true, force: true });
        }
    });

    test("the workflow validate step invokes this production seam", async () => {
        const workflow = await readFile(
            join(repositoryRoot, ".github/workflows/release.yml"),
            "utf8",
        );
        const validateJob = workflow.slice(
            workflow.indexOf("  validate:"),
            workflow.indexOf("  stage-package:"),
        );

        expect(validateJob).toContain("id: release-context");
        expect(validateJob).toContain(
            "run: bun scripts/validate-release-context.ts",
        );
        expect(validateJob).toContain("RELEASE_VERSION:");
        expect(validateJob).toContain("RELEASE_REF:");
        expect(validateJob).toContain("RELEASE_DRY_RUN:");
    });
});