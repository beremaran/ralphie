#!/usr/bin/env bun

/**
 * Production package-publication context validation used by the tag-triggered
 * publish workflow `.github/workflows/npm-publish.yml` (step "Validate tag and
 * package version"). The step previously inlined this logic in bash; this
 * script is its executable seam.
 *
 * It accepts the full SemVer 2.0.0 grammar (prerelease and build metadata),
 * pins the scoped package name, and requires the exact tag/package version
 * match. It reads the GitHub Actions context from the environment and appends
 * the canonical `version` output to `$GITHUB_OUTPUT` only when the context is
 * valid. A rejected context exits non-zero before writing anything, so the
 * publication step of the same job cannot run.
 */

import { appendFile, readFile } from "node:fs/promises";

const PACKAGE_NAME = "@beremaran/ralphie";

// SemVer 2.0.0 as accepted by the npm publication path: numeric identifiers
// (including prerelease identifiers) cannot have leading zeroes, and every
// dot-separated identifier must be non-empty. This is the same grammar the
// workflow step previously inlined as SEMVER_REGEX. The `(?![\s\S])` anchor
// rejects trailing line terminators exactly like the shell `$` anchor.
const NPM_VERSION_PATTERN =
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*)|([0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))(\.((0|[1-9][0-9]*)|([0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)))*)?(\+([0-9A-Za-z-]+)(\.[0-9A-Za-z-]+)*)?$(?![\s\S])/;

const fail = (message: string): never => {
    console.error(message);
    process.exit(1);
};

const packageField = async (field: string): Promise<string> => {
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
    const value = (packageJson as Record<string, unknown>)[field];
    if (typeof value !== "string") {
        return fail(`package.json field '${field}' must be a string.`);
    }
    return value;
};

const appendOutput = async (name: string, value: string): Promise<void> => {
    const outputPath = process.env.GITHUB_OUTPUT;
    const line = `${name}=${value}`;
    if (outputPath === undefined || outputPath === "") {
        console.log(line);
        return;
    }
    await appendFile(outputPath, `${line}\n`);
};

const main = async (): Promise<void> => {
    const githubRefType = process.env.GITHUB_REF_TYPE ?? "";
    const githubRef = process.env.GITHUB_REF ?? "";
    const tag = process.env.TAG ?? "";
    if (githubRefType !== "tag" || !githubRef.startsWith("refs/tags/v")) {
        fail(
            `Refusing npm publication: the workflow must run from a v* tag (got ${githubRef})`,
        );
    }
    if (!tag.startsWith("v")) {
        fail(
            `Malformed npm release tag '${tag}': expected a tag beginning with v`,
        );
    }

    const tagVersion = tag.slice(1);
    if (!NPM_VERSION_PATTERN.test(tagVersion)) {
        fail(
            `Malformed npm release tag '${tag}': expected a valid SemVer v<major>.<minor>.<patch> with optional prerelease/build metadata`,
        );
    }

    const packageName = await packageField("name");
    if (packageName !== PACKAGE_NAME) {
        fail(`Refusing npm publication for unscoped package ${packageName}`);
    }
    const packageVersion = await packageField("version");
    if (packageVersion !== tagVersion) {
        fail(
            `npm release tag ${tag} resolves to ${tagVersion}, but package.json declares ${packageVersion}; normal and prerelease versions must match exactly`,
        );
    }

    await appendOutput("version", tagVersion);
};

await main();