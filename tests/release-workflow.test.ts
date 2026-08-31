import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");

const readRepositoryFile = (path: string): Promise<string> =>
    Bun.file(resolve(repositoryRoot, path)).text();

describe("npm release publication contract", () => {
    test("guards the scoped tag/version and uses trusted publishing only", async () => {
        const workflow = await readRepositoryFile(
            ".github/workflows/release.yml",
        );
        const npmJobStart = workflow.indexOf("  publish-npm:");
        const npmJobEnd = workflow.indexOf("  push-container:", npmJobStart);
        const npmJob = workflow.slice(npmJobStart, npmJobEnd);
        const publishStep = npmJob.indexOf(
            "name: Publish scoped package with npm provenance",
        );
        const localSmokeStep = npmJob.indexOf("run: bun run package:check");
        const registrySmokeStep = npmJob.indexOf(
            "name: Verify exact package from npm registry",
        );

        expect(npmJob).toContain(
            "if: needs.validate.outputs.dry_run == 'false' && github.ref_type == 'tag' && startsWith(github.ref, 'refs/tags/v')",
        );
        expect(npmJob).toContain('TAG_VERSION="${TAG#v}"');
        expect(npmJob).toContain("Malformed npm release tag");
        expect(npmJob).toContain("optional prerelease/build metadata");
        expect(npmJob).toContain('PACKAGE_NAME="$(jq -er');
        expect(npmJob).toContain('PACKAGE_VERSION="$(jq -er');
        expect(npmJob).toContain(
            'if [[ "$TAG_VERSION" != "$PACKAGE_VERSION" ]]; then',
        );
        expect(npmJob).toContain("contents: read");
        expect(npmJob).toContain("id-token: write");
        expect(npmJob).not.toContain("contents: write");
        expect(npmJob).not.toContain("packages: write");
        expect(npmJob).toContain("npm publish --provenance --access public");
        expect(npmJob).not.toContain("NPM_TOKEN");
        expect(npmJob).not.toContain("NODE_AUTH_TOKEN");
        expect(npmJob).not.toContain("registry-url");
        expect(localSmokeStep).toBeGreaterThan(-1);
        expect(publishStep).toBeGreaterThan(localSmokeStep);
        expect(registrySmokeStep).toBeGreaterThan(publishStep);
        expect(npmJob).toContain('PACKAGE_SPEC="@beremaran/ralphie@$VERSION"');
        expect(npmJob).toContain(
            'bun run package:check -- --registry --package-spec "$PACKAGE_SPEC"',
        );
        expect(npmJob).toContain(
            'npm view "$PACKAGE_SPEC" name version --json',
        );
        expect(npmJob).toContain("sleep 10");
        expect(npmJob).toContain("E404");
        expect(npmJob).not.toContain("continue-on-error");

        const smokeScript = await readRepositoryFile(
            "scripts/package-smoke.ts",
        );
        expect(smokeScript).toContain('[installed.executable, "--version"]');
        expect(smokeScript).toContain("mkdtemp(join(tmpdir(),");
        expect(smokeScript).toContain('cache: join(root, "npm-cache")');
        expect(smokeScript).toContain("expectedOutput");
    });

    test("accepts normal and prerelease versions but rejects malformed tags", async () => {
        const workflow = await readRepositoryFile(
            ".github/workflows/release.yml",
        );
        const npmJobStart = workflow.indexOf("  publish-npm:");
        const npmJobEnd = workflow.indexOf("  push-container:", npmJobStart);
        const npmJob = workflow.slice(npmJobStart, npmJobEnd);
        const semverRegex = npmJob.match(/SEMVER_REGEX='([^']+)'/)?.[1];
        if (semverRegex === undefined) {
            throw new Error("npm release SemVer regex is missing");
        }

        const acceptsVersion = (version: string): boolean =>
            Bun.spawnSync(["bash", "-c", '[[ "$VERSION" =~ $SEMVER_REGEX ]]'], {
                env: {
                    PATH: process.env.PATH ?? "/usr/bin:/bin",
                    SEMVER_REGEX: semverRegex,
                    VERSION: version,
                },
                stderr: "pipe",
                stdout: "pipe",
            }).exitCode === 0;

        expect(acceptsVersion("1.2.3")).toBe(true);
        expect(acceptsVersion("1.2.3-rc.1")).toBe(true);
        expect(acceptsVersion("1.2.3+build.7")).toBe(true);
        for (const malformedVersion of [
            "1.2.3-01",
            "1.2.3-foo..bar",
            "1.2.3-",
            "1.2.3-rc.",
            "01.2.3",
        ]) {
            expect(acceptsVersion(malformedVersion)).toBe(false);
        }
    });

    test("documents the one-time npm trusted publisher binding", async () => {
        const releases = await readRepositoryFile("docs/releases.md");

        expect(releases).toContain("Trusted\nPublishers");
        expect(releases).toContain("workflow filename `release.yml`");
        expect(releases).toContain("environment `release`");
        expect(releases).toContain("npm publish --provenance --access public");
    });
});

describe("release container metadata contract", () => {
    test("Dockerfile declares and applies explicit release inputs", async () => {
        const dockerfile = await readRepositoryFile("Dockerfile");

        expect(dockerfile).toContain("ARG RALPHIE_VERSION=local");
        expect(dockerfile).toContain("ARG RALPHIE_COMMIT_SHA=local");
        expect(dockerfile).toContain('org.opencontainers.image.licenses="MIT"');
        expect(dockerfile).toContain(
            'org.opencontainers.image.version="$RALPHIE_VERSION"',
        );
        expect(dockerfile).toContain(
            'org.opencontainers.image.revision="$RALPHIE_COMMIT_SHA"',
        );
        expect(dockerfile).toContain("FROM debian:bookworm-slim");
        expect(dockerfile).toContain("ENV HOME=/home/nonroot");
        expect(dockerfile).toContain("WORKDIR /home/nonroot");
        expect(dockerfile).toContain("USER 65532:65532");
        for (const command of [
            "bash",
            "ca-certificates",
            "fd-find",
            "gh",
            "git",
            "openssh-client",
            "ripgrep",
        ]) {
            expect(dockerfile).toContain(command);
        }
        expect(dockerfile).not.toContain("/root/.ralphie");
    });

    test("validated release outputs are the container build inputs and labels", async () => {
        const workflow = await readRepositoryFile(
            ".github/workflows/release.yml",
        );

        expect(workflow).toContain(
            "RALPHIE_VERSION=${{ needs.validate.outputs.version }}",
        );
        expect(workflow).toContain(
            "RALPHIE_COMMIT_SHA=${{ needs.validate.outputs.source_ref }}",
        );
        expect(workflow).toContain("id: build");
        expect(workflow).toContain(
            "BUILD_DIGEST: ${{ steps.build.outputs.digest }}",
        );
        expect(workflow).not.toContain("metadata-file:");
        for (const field of [
            "schema",
            "artifact",
            "version",
            "source_ref",
            "platform",
            "digest",
            "format",
            "archive",
            "archive_sha256",
            "image_license",
            "image_version",
            "image_revision",
        ]) {
            expect(workflow).toContain(`${field}: $${field}`);
        }
        expect(workflow).toContain("org.opencontainers.image.licenses=MIT");
        expect(workflow).toContain(
            "org.opencontainers.image.version=${{ needs.validate.outputs.version }}",
        );
        expect(workflow).toContain(
            "org.opencontainers.image.revision=${{ needs.validate.outputs.source_ref }}",
        );
    });

    test("uses a deny-by-default Docker context with explicit secret exclusions", async () => {
        const dockerignore = await readRepositoryFile(".dockerignore");
        const rules = dockerignore
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line !== "" && !line.startsWith("#"));
        const allowRules = rules.filter((rule) => rule.startsWith("!"));

        expect(rules).toContain("*");
        expect(allowRules).toEqual([
            "!package.json",
            "!bun.lock",
            "!index.ts",
            "!src/",
            "!src/**",
            "!scripts/",
            "!scripts/build.ts",
        ]);
        for (const rule of [
            ".git",
            ".github",
            ".env",
            ".env.*",
            "**/.npmrc",
            "**/.ssh",
            "**/.config",
            "node_modules",
            "dist",
            "out",
            "*.log",
            "tests/**",
            "coverage",
            "**/*credentials*",
            "**/*token*",
            "**/*secret*",
            "**/*.pem",
            "**/*.key",
        ]) {
            expect(rules).toContain(rule);
        }
    });

    test("keeps private values out of Docker instructions and stage-container", async () => {
        const [dockerfile, workflow] = await Promise.all([
            readRepositoryFile("Dockerfile"),
            readRepositoryFile(".github/workflows/release.yml"),
        ]);
        const stageStart = workflow.indexOf("  stage-container:");
        const nextJob = workflow.indexOf("  publish-npm:", stageStart);
        const stageJob = workflow.slice(stageStart, nextJob);
        const argNames = [...dockerfile.matchAll(/^ARG\s+([A-Z0-9_]+)/gm)].map(
            (match) => match[1],
        );
        const envNames = [...dockerfile.matchAll(/^ENV\s+([A-Z0-9_]+)=/gm)].map(
            (match) => match[1],
        );

        expect(new Set(argNames)).toEqual(
            new Set(["RALPHIE_VERSION", "RALPHIE_COMMIT_SHA"]),
        );
        expect(envNames).toEqual(["HOME"]);
        expect(dockerfile).not.toContain("COPY . .");
        for (const copy of [
            "COPY index.ts ./index.ts",
            "COPY src ./src",
            "COPY scripts/build.ts ./scripts/build.ts",
        ]) {
            expect(dockerfile).toContain(copy);
        }
        for (const forbidden of [
            "GITHUB_TOKEN",
            "GH_TOKEN",
            "ACTIONS_ID_TOKEN",
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
            "PI_CREDENTIAL",
            "--mount=type=secret",
        ]) {
            expect(dockerfile).not.toContain(forbidden);
            expect(stageJob).not.toContain(forbidden);
        }
        expect(stageJob).toContain("context: .");
        expect(stageJob).toContain(
            "RALPHIE_VERSION=${{ needs.validate.outputs.version }}",
        );
        expect(stageJob).toContain(
            "RALPHIE_COMMIT_SHA=${{ needs.validate.outputs.source_ref }}",
        );
        expect(stageJob).not.toContain("secrets.");
        expect(stageJob).not.toContain("github.token");
        expect(stageJob).not.toContain("sbom: true");
        expect(stageJob).not.toContain("provenance: true");
    });

    test("builds each native asset on a matching host architecture", async () => {
        const workflow = await readRepositoryFile(
            ".github/workflows/release.yml",
        );
        const buildJob = workflow.slice(
            workflow.indexOf("  build-binaries:"),
            workflow.indexOf(
                "  # This job deliberately has no registry credentials",
            ),
        );

        expect(buildJob).toContain("Verify native target architecture");
        expect(buildJob).toContain(
            "Verify native binary format and architecture",
        );
        expect(buildJob).toContain('description="$(file -b "$binary")"');
        expect(buildJob).toContain('lipo -archs "$binary"');
        expect(buildJob).toContain('test -s "$binary"');
        expect(buildJob).toContain('./dist/cli --version > "$version_output"');
        expect(buildJob).toContain('test -s "$version_output"');
        expect(buildJob).toContain("')\" = 1");
        for (const assertion of [
            '"Mach-O 64-bit executable arm64"',
            '"Mach-O 64-bit executable x86_64"',
            '"LC_BUILD_VERSION"',
            '"platform"',
            '"ARM aarch64"',
            '"x86-64"',
            '"GNU/Linux"',
        ]) {
            expect(buildJob).toContain(assertion);
        }
        expect(buildJob).toContain('asset="ralphie-${TARGET}"');
        expect(buildJob).toContain("overwrite: false");
        expect(buildJob).toContain(
            "path: |\n            ralphie-${{ matrix.target }}\n            ralphie-${{ matrix.target }}.sha256",
        );
        for (const [target, runner] of [
            ["darwin-arm64", "macos-14"],
            ["darwin-x64", "macos-15-intel"],
            ["linux-arm64", "ubuntu-24.04-arm"],
            ["linux-x64", "ubuntu-24.04"],
        ]) {
            expect(buildJob).toContain(`target: ${target}`);
            expect(buildJob).toContain(`runner: ${runner}`);
        }
    });

    test("publishes only explicit normalized-version tags and safe aliases", async () => {
        const workflow = await readRepositoryFile(
            ".github/workflows/release.yml",
        );

        expect(workflow).toContain("latest=false");
        expect(workflow).toContain(
            "type=raw,value=${{ needs.validate.outputs.version }}",
        );
        expect(workflow).toContain(
            "type=semver,pattern={{major}}.{{minor}},value=v${{ needs.validate.outputs.version }}",
        );
        expect(workflow).toContain(
            "type=raw,value=latest,enable=${{ !contains(needs.validate.outputs.tag, '-') }}",
        );
        expect(workflow).toContain(
            "type=raw,value=sha-${{ needs.validate.outputs.source_ref }}",
        );
    });

    test("push waits for candidate inspection and verifies its contract first", async () => {
        const workflow = await readRepositoryFile(
            ".github/workflows/release.yml",
        );
        const pushJobStart = workflow.indexOf("  push-container:");
        const publishJobStart = workflow.indexOf("  publish:", pushJobStart);
        const pushJob = workflow.slice(pushJobStart, publishJobStart);

        expect(pushJob).toContain("stage-container");
        expect(pushJob).toContain("name: Verify candidate metadata");
        expect(pushJob).toContain(
            "name: Inspect OCI metadata before promotion",
        );
        expect(pushJob).toContain('test "$actual_sha256" = "$expected_sha256"');
        expect(pushJob).toContain('test "$license_label" = "MIT"');
        expect(
            pushJob.indexOf("name: Inspect OCI metadata before promotion"),
        ).toBeLessThan(
            pushJob.indexOf("name: Push inspected container images"),
        );
        expect(
            workflow.indexOf(
                "name: Smoke-test entrypoint and inspect release metadata",
            ),
        ).toBeLessThan(pushJobStart);
    });

    test("gates the sole release publisher on every successful prerequisite", async () => {
        const workflow = await readRepositoryFile(
            ".github/workflows/release.yml",
        );
        const publishJob = workflow.slice(workflow.indexOf("  publish:"));

        expect(publishJob).toContain("always()");
        for (const prerequisite of [
            "validate",
            "build-binaries",
            "stage-container",
        ]) {
            expect(publishJob).toContain(
                `needs.${prerequisite}.result == 'success'`,
            );
        }
        expect(publishJob).toContain(
            "needs.validate.outputs.dry_run == 'false'",
        );
        expect(publishJob).toContain("github.ref_type == 'tag'");
        expect(publishJob).toContain("startsWith(github.ref, 'refs/tags/v')");
        expect(publishJob).toContain("name: release");
        expect(publishJob).toContain("contents: write");
        expect(publishJob).toContain("id-token: write");
    });

    test("creates and validates an idempotent REST release handle after validation", async () => {
        const workflow = await readRepositoryFile(
            ".github/workflows/release.yml",
        );
        const publishJob = workflow.slice(workflow.indexOf("  publish:"));
        const handleStart = publishJob.indexOf(
            "name: Create or reuse draft release handle",
        );
        const checkoutStart = publishJob.indexOf("uses: actions/checkout@v4");
        const handle = publishJob.slice(
            handleStart,
            publishJob.indexOf(
                "name: Upload assets and publish GitHub release",
                handleStart,
            ),
        );

        expect(handleStart).toBeGreaterThan(-1);
        expect(checkoutStart).toBeLessThan(handleStart);
        expect(handle).toContain("actions/github-script@v7");
        expect(handle).toContain("getReleaseByTag");
        expect(handle).toContain("createRelease");
        expect(handle).toContain("tag_name: tag");
        expect(handle).toContain("target_commitish: sourceRef");
        expect(handle).toContain("draft: true");
        expect(handle).toContain("release.tag_name !== tag");
        expect(handle).toContain("release.target_commitish !== sourceRef");
        expect(handle).toContain('typeof release.draft !== "boolean"');
        expect(handle).toContain("Number.isSafeInteger(release.id)");
        expect(handle).toContain('typeof release.upload_url !== "string"');
        expect(handle).toContain("uploadUrlPattern");
        expect(handle).toContain(
            "release.draft && release.published_at !== null",
        );
        expect(handle).toContain(
            '!release.draft && typeof release.published_at !== "string"',
        );
        expect(handle).toContain("error.status !== 422");
        expect(handle).toContain('core.setOutput("release_id"');
        expect(handle).toContain('core.setOutput("upload_url"');
        expect(handle).toContain('core.setOutput("state"');
        expect(publishJob).not.toContain("github.event.repo.upload_url");
    });

    test("reuses draft handles, repairs assets, and treats published handles as terminal", async () => {
        const workflow = await readRepositoryFile(
            ".github/workflows/release.yml",
        );
        const publishJob = workflow.slice(workflow.indexOf("  publish:"));
        const collectStep = publishJob.slice(
            publishJob.indexOf("name: Collect binaries and create SHA256SUMS"),
            publishJob.indexOf(
                "name: Sign and verify SHA256SUMS with Sigstore",
            ),
        );
        const releaseStep = publishJob.slice(
            publishJob.indexOf(
                "name: Upload assets and publish GitHub release",
            ),
        );

        expect(publishJob).toContain("merge-multiple: false");
        expect(collectStep).toContain("scripts/create-sha256sums.ts");
        expect(collectStep).toContain('test "$TAG" = "v$VERSION"');
        expect(releaseStep).toContain(
            "RELEASE_ID: ${{ steps.release-handle.outputs.release_id }}",
        );
        expect(releaseStep).toContain(
            "UPLOAD_URL: ${{ steps.release-handle.outputs.upload_url }}",
        );
        expect(releaseStep).toContain(
            "RELEASE_TERMINAL: ${{ steps.release-handle.outputs.terminal }}",
        );
        expect(releaseStep).toContain('[[ "$RELEASE_TERMINAL" == true ]]');
        expect(releaseStep).toContain("gh api --method DELETE");
        expect(releaseStep).toContain("curl --fail");
        expect(releaseStep).toContain("gh api --method PATCH");
        expect(releaseStep).toContain("-F draft=false");
        expect(releaseStep).not.toContain("gh release create");
        expect(releaseStep).not.toContain("gh release view");
        expect(releaseStep).not.toContain("github.event.repo.upload_url");
        for (const target of [
            "darwin-arm64",
            "darwin-x64",
            "linux-arm64",
            "linux-x64",
        ]) {
            expect(releaseStep).toContain(`release-assets/ralphie-${target}`);
        }
        expect(releaseStep).toContain("release-assets/SHA256SUMS");
        expect(
            publishJob.indexOf("name: Create or reuse draft release handle"),
        ).toBeLessThan(
            publishJob.indexOf(
                "name: Upload assets and publish GitHub release",
            ),
        );
    });

    test("signs and verifies the exact manifest before publishing its bundle", async () => {
        const workflow = await readRepositoryFile(
            ".github/workflows/release.yml",
        );
        const publishJob = workflow.slice(workflow.indexOf("  publish:"));
        const signStepStart = publishJob.indexOf(
            "name: Sign and verify SHA256SUMS with Sigstore",
        );
        const releaseStepStart = publishJob.indexOf(
            "name: Upload assets and publish GitHub release",
        );
        const signStep = publishJob.slice(signStepStart, releaseStepStart);

        expect(publishJob).toContain("contents: write");
        expect(publishJob).toContain("id-token: write");
        expect(signStep).toContain("sigstore/gh-action-sigstore-python@");
        expect(signStep).toContain("inputs: release-assets/SHA256SUMS");
        expect(signStep).toContain("verify: true");
        expect(signStep).toContain(
            "https://github.com/beremaran/ralphie/.github/workflows/release.yml@refs/tags/${{ needs.validate.outputs.tag }}",
        );
        expect(signStep).toContain(
            "verify-oidc-issuer: https://token.actions.githubusercontent.com",
        );
        expect(signStep).toContain("release-signing-artifacts: false");
        expect(releaseStepStart).toBeGreaterThan(signStepStart);
        expect(publishJob).toContain("release-assets/SHA256SUMS.sigstore.json");
    });

    test("generates and publishes one SBOM for each final native asset", async () => {
        const workflow = await readRepositoryFile(
            ".github/workflows/release.yml",
        );
        const publishJob = workflow.slice(workflow.indexOf("  publish:"));
        const collectStart = publishJob.indexOf(
            "name: Collect binaries and create SHA256SUMS",
        );
        const sbomStart = publishJob.indexOf(
            "name: Generate and validate deterministic SPDX SBOMs",
        );
        const signStart = publishJob.indexOf(
            "name: Sign and verify SHA256SUMS with Sigstore",
        );

        expect(sbomStart).toBeGreaterThan(collectStart);
        expect(signStart).toBeGreaterThan(sbomStart);
        expect(publishJob).toContain("bun scripts/create-sboms.ts");
        expect(publishJob).toContain("--assets-dir release-assets");
        expect(publishJob).toContain("--output-dir release-assets");
        expect(publishJob).toContain("--source-dir .");
        expect(publishJob).toContain("--commit-sha $SOURCE_REF");
        expect(publishJob).toContain('bun_version="$(bun --version)"');
        expect(publishJob).toContain('test "$bun_version" = 1.3.14');
        expect(publishJob).toContain(
            "name: Install dependencies for SBOM validation",
        );
        expect(publishJob).toContain("bun install --frozen-lockfile");
        expect(publishJob).toContain('--build-tool-version "$bun_version"');
        expect(publishJob).toContain('--bun-version "$bun_version"');
        expect(publishJob.indexOf("uses: actions/checkout@v4")).toBeLessThan(
            publishJob.indexOf(
                "name: Download verified release metadata bundle",
            ),
        );
        for (const target of [
            "darwin-arm64",
            "darwin-x64",
            "linux-arm64",
            "linux-x64",
        ]) {
            expect(publishJob).toContain(
                `release-assets/ralphie-${target}.sbom.spdx.json`,
            );
        }
    });

    test("attests each exact final binary with least privilege and digest evidence", async () => {
        const workflow = await readRepositoryFile(
            ".github/workflows/release.yml",
        );
        const publishJobStart = workflow.indexOf("  publish:");
        const publishJob = workflow.slice(publishJobStart);
        const attestationPin =
            "actions/attest-build-provenance@bd77c077858b8d561b7a36cbe48ef4cc642ca39d";
        const collectStart = publishJob.indexOf(
            "name: Collect binaries and create SHA256SUMS",
        );
        const attestStart = publishJob.indexOf(attestationPin);
        const releaseCreateStart = publishJob.indexOf(
            "name: Create or reuse draft release handle",
        );

        expect(publishJob).toContain("contents: write");
        expect(publishJob).toContain("id-token: write");
        expect(publishJob).toContain("attestations: write");
        expect(publishJob).not.toContain("packages: write");
        expect(workflow.slice(0, publishJobStart)).not.toContain(
            "attestations: write",
        );
        expect(publishJob.match(new RegExp(attestationPin, "g"))).toHaveLength(
            4,
        );
        expect(attestStart).toBeGreaterThan(collectStart);
        expect(releaseCreateStart).toBeGreaterThan(attestStart);
        expect(publishJob).toContain(
            "name: Record final attestation subject digests",
        );
        expect(publishJob).toContain("ralphie.release-attestation-subjects.v1");
        expect(publishJob).toContain(
            "release-assets/attestation-subjects.json",
        );
        expect(publishJob).toContain("GITHUB_WORKFLOW_REF");
        expect(publishJob).toContain("bun_version");
        expect(publishJob).toContain("build_tool_version");
        expect(publishJob).toContain("build_command");

        const subjectPaths = [
            ...publishJob.matchAll(/subject-path: (\S+)/g),
        ].map((match) => match[1] as string);
        expect(subjectPaths).toEqual([
            "release-assets/ralphie-darwin-arm64",
            "release-assets/ralphie-darwin-x64",
            "release-assets/ralphie-linux-arm64",
            "release-assets/ralphie-linux-x64",
        ]);
        expect(
            subjectPaths.some((path) =>
                /dist\/cli|upload-artifact|(^|\/)src\//.test(path),
            ),
        ).toBe(false);
    });

    test("fails closed on exact final SBOM and provenance mappings before release creation", async () => {
        const workflow = await readRepositoryFile(
            ".github/workflows/release.yml",
        );
        const publishJob = workflow.slice(workflow.indexOf("  publish:"));
        const gateStart = publishJob.indexOf(
            "name: Verify final SBOMs and build provenance",
        );
        const signStart = publishJob.indexOf(
            "name: Sign and verify SHA256SUMS with Sigstore",
        );
        const releaseCreateStart = publishJob.indexOf(
            "name: Create or reuse draft release handle",
        );

        expect(gateStart).toBeGreaterThan(-1);
        expect(gateStart).toBeLessThan(signStart);
        expect(signStart).toBeLessThan(releaseCreateStart);
        expect(publishJob).toContain("find release-assets -maxdepth 1");
        expect(publishJob).toContain("expected_binaries=");
        expect(publishJob).toContain("expected_sboms=");
        expect(publishJob).toContain('sha256sum "$binary"');
        expect(publishJob).toContain("$metadata.finalBinarySha256 == $digest");
        expect(publishJob).toContain("$metadata.releaseTag == $tag");
        expect(publishJob).toContain("$metadata.releaseVersion == $version");
        expect(publishJob).toContain("$metadata.commitSha == $commit");
        expect(publishJob).toContain("$metadata.target == $target");
        expect(publishJob).toContain("$statement.subject[0].name == $binary");
        expect(publishJob).not.toContain("$predicate.runDetails.builder.id");
        expect(publishJob).toContain("gh api");
        expect(publishJob).toContain("/attestations/sha256:$digest");
        expect(publishJob).toContain("attestations[]] | length == 1");
        expect(publishJob).toContain('gh attestation verify "$binary"');
        expect(publishJob).toContain(
            '--signer-workflow "$GH_REPO/.github/workflows/release.yml"',
        );
        expect(publishJob).toContain('--source-ref "refs/tags/$TAG"');
        expect(publishJob).not.toContain("--source-digest");
        expect(publishJob).toContain(
            "--predicate-type https://slsa.dev/provenance/v1",
        );
        expect(publishJob).toContain("--format json");
        expect(publishJob).toContain("runDetails.metadata.invocationId");
        expect(publishJob).toContain("resolvedDependencies");
        expect(publishJob).toContain(
            "--cert-oidc-issuer https://token.actions.githubusercontent.com",
        );
        expect(publishJob).toContain("sort -u | wc -l");
        for (const target of [
            "darwin-arm64",
            "darwin-x64",
            "linux-arm64",
            "linux-x64",
        ]) {
            expect(publishJob).toContain(`ralphie-${target}.sbom.spdx.json`);
            expect(publishJob).toContain(`ralphie-${target}`);
        }
    });

    test("documents runnable Sigstore GitHub source selectors", async () => {
        const readme = await readRepositoryFile("README.md");
        const commandStart = readme.indexOf(
            "sigstore verify github SHA256SUMS",
        );
        const commandEnd = readme.indexOf(
            "sha256sum --check SHA256SUMS",
            commandStart,
        );
        const command = readme.slice(commandStart, commandEnd);

        expect(command).toContain("--name Release");
        expect(command).toContain('--sha "$SOURCE_REF"');
        expect(command).toContain('--ref "refs/tags/$TAG"');
        expect(command).toContain("--trigger push");
        expect(command).not.toContain("--workflow release.yml");
        expect(command).not.toContain("--cert-oidc-issuer");
        expect(command).not.toMatch(/--source-(?:event|sha|tag)(?:\s|=)/);
    });
});