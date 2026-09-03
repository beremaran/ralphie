#!/usr/bin/env bun

/**
 * Production release-context validation used by the `validate` job of
 * `.github/workflows/release.yml` (step "Validate and resolve release
 * context"). The step previously inlined this logic in bash; this script is
 * its executable seam, reading the same GitHub Actions context.
 *
 * It reads the GitHub Actions context entirely from the environment (the same
 * variables the workflow step provides), runs every check in the same order
 * and with the same failure strings as the workflow, and appends the canonical
 * validated outputs (`version`, `tag`, `source_ref`, `dry_run`) to
 * `$GITHUB_OUTPUT` only when the complete context is valid. Any rejected
 * context exits non-zero before writing anything, so a downstream publisher
 * can never consume a partial context.
 *
 * This is the deliberately narrow stable-only grammar: numeric components
 * cannot have leading zeroes, and prerelease/build suffixes are not release
 * versions. The prerelease-capable package path is a separate policy in
 * `scripts/validate-npm-context.ts`; the two grammars must not silently
 * converge.
 */

import { appendFile, readFile } from "node:fs/promises";

// Stable-only release tag: v<major>.<minor>.<patch> with no leading-zero
// numeric components and no prerelease/build suffix. The `(?![\s\S])` anchor
// rejects trailing line terminators exactly like the shell `$` anchor.
const STABLE_TAG_PATTERN =
    /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$(?![\s\S])/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$(?![\s\S])/;

type ValidatedReleaseContext = {
    readonly dryRun: string;
    readonly sourceRef: string;
    readonly tag: string;
    readonly version: string;
};

const fail = (message: string): never => {
    console.error(message);
    process.exit(1);
};

function assertDefined<T>(
    value: T | undefined,
    message: string,
): asserts value is T {
    if (value === undefined) {
        fail(message);
    }
}

const packageVersion = async (): Promise<string> => {
    let packageJson: unknown;
    try {
        packageJson = JSON.parse(await readFile("package.json", "utf8"));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fail(`could not read package.json: ${message}`);
    }
    if (
        typeof packageJson !== "object" ||
        packageJson === null ||
        Array.isArray(packageJson)
    ) {
        return fail("package.json must be a JSON object.");
    }
    const version = (packageJson as Record<string, unknown>).version;
    if (typeof version !== "string") {
        return fail("package.json field 'version' must be a string.");
    }
    return version;
};

const gitCommit = (ref: string): string | undefined => {
    const result = Bun.spawnSync(
        ["git", "rev-parse", "--verify", `${ref}^{commit}`],
        { cwd: process.cwd(), stderr: "pipe", stdout: "pipe" },
    );
    if (result.exitCode !== 0) return undefined;
    return result.stdout.toString().trim();
};

const appendOutputs = async (
    outputs: ValidatedReleaseContext,
): Promise<void> => {
    const lines = [
        `version=${outputs.version}`,
        `tag=${outputs.tag}`,
        `source_ref=${outputs.sourceRef}`,
        `dry_run=${outputs.dryRun}`,
    ];
    const outputPath = process.env.GITHUB_OUTPUT;
    if (outputPath === undefined || outputPath === "") {
        console.log(lines.join("\n"));
        return;
    }
    await appendFile(outputPath, `${lines.join("\n")}\n`);
};

const resolveReleaseContext = (): {
    dryRun: string;
    expectedVersion: string;
    releaseVersion: string;
} => {
    const releaseVersion = process.env.RELEASE_VERSION ?? "";
    if (!STABLE_TAG_PATTERN.test(releaseVersion)) {
        console.error(`Unsupported release tag: ${releaseVersion}`);
        console.error("Expected v<major>.<minor>.<patch>, for example v0.1.0.");
        process.exit(1);
    }
    const dryRun = process.env.RELEASE_DRY_RUN ?? "";
    if (dryRun !== "true" && dryRun !== "false") {
        fail("dry_run must resolve to true or false");
    }
    return {
        dryRun,
        expectedVersion: releaseVersion.slice(1),
        releaseVersion,
    };
};

const assertValidEventContext = (releaseVersion: string): void => {
    const eventName = process.env.GITHUB_EVENT_NAME ?? "";
    const githubRef = process.env.GITHUB_REF ?? "";
    const releaseRef = process.env.RELEASE_REF ?? "";
    const requiredRef = `refs/tags/${releaseVersion}`;
    if (eventName === "workflow_dispatch") {
        // A manual run must be started from the same protected tag it is
        // releasing; the input SHA is then checked against that tag below.
        if (githubRef !== requiredRef) {
            fail(
                `workflow_dispatch must be run from the version tag ${releaseVersion}`,
            );
        }
        if (!COMMIT_SHA_PATTERN.test(releaseRef)) {
            fail(
                "workflow_dispatch ref must be a 40-character lowercase commit SHA",
            );
        }
    } else if (githubRef !== requiredRef) {
        fail("The push ref is not the validated release tag");
    }
};

const releaseRefValue = (): string => process.env.RELEASE_REF ?? "";

const main = async (): Promise<void> => {
    const { dryRun, expectedVersion, releaseVersion } = resolveReleaseContext();
    assertValidEventContext(releaseVersion);

    // This is the invariant that makes the validated commit stable through
    // the build and publication jobs. A read-then-publish API check cannot
    // close the race with a tag update.
    const packageJsonVersion = await packageVersion();
    if (packageJsonVersion !== expectedVersion) {
        fail(
            `Release tag ${releaseVersion} does not match package.json version ${packageJsonVersion}`,
        );
    }

    if ((process.env.GITHUB_REF_PROTECTED ?? "") !== "true") {
        fail("The release tag must be protected against updates and deletions");
    }

    const tagCommit = gitCommit(`refs/tags/${releaseVersion}`);
    assertDefined(
        tagCommit,
        `Release tag ${releaseVersion} does not exist in the checkout`,
    );
    const sourceCommit = gitCommit(releaseRefValue());
    assertDefined(
        sourceCommit,
        `Release ref ${releaseRefValue()} is not a commit`,
    );
    if (sourceCommit !== tagCommit) {
        console.error(
            `Release ref ${releaseRefValue()} does not target ${releaseVersion} (${tagCommit})`,
        );
        process.exit(1);
    }

    // Downstream jobs consume only these canonical values: the package
    // version and the immutable commit targeted by the tag.
    await appendOutputs({
        dryRun,
        sourceRef: tagCommit,
        tag: releaseVersion,
        version: packageJsonVersion,
    });
};

await main();