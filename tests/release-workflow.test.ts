import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");

const readRepositoryFile = (path: string): Promise<string> =>
    Bun.file(resolve(repositoryRoot, path)).text();

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
        expect(workflow).toContain("org.opencontainers.image.licenses=MIT");
        expect(workflow).toContain(
            "org.opencontainers.image.version=${{ needs.validate.outputs.version }}",
        );
        expect(workflow).toContain(
            "org.opencontainers.image.revision=${{ needs.validate.outputs.source_ref }}",
        );
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

    test("collects and hashes the four release binaries before one upload", async () => {
        const workflow = await readRepositoryFile(
            ".github/workflows/release.yml",
        );
        const publishJob = workflow.slice(workflow.indexOf("  publish:"));
        const collectStep = publishJob.slice(
            publishJob.indexOf("name: Collect binaries and create SHA256SUMS"),
            publishJob.indexOf("name: Create GitHub release"),
        );
        const releaseStep = publishJob.slice(
            publishJob.indexOf("name: Create GitHub release"),
        );

        expect(publishJob).toContain("merge-multiple: false");
        expect(collectStep).toContain("scripts/create-sha256sums.ts");
        expect(collectStep).toContain('test "$TAG" = "v$VERSION"');
        for (const target of [
            "darwin-arm64",
            "darwin-x64",
            "linux-arm64",
            "linux-x64",
        ]) {
            expect(releaseStep).toContain(`release-assets/ralphie-${target}`);
        }
        expect(releaseStep).toContain("release-assets/SHA256SUMS");
        expect(releaseStep).toContain(
            'gh release create "$TAG" "${assets[@]}"',
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
            "name: Create GitHub release",
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

        expect(command).toContain("--workflow release.yml");
        expect(command).toContain('--source-sha "$SOURCE_REF"');
        expect(command).toContain('--source-tag "$TAG"');
        expect(command).toContain(
            "--cert-oidc-issuer https://token.actions.githubusercontent.com",
        );
        expect(command).toContain("--source-event push");
        expect(command).not.toContain("--trigger");
        expect(command).not.toMatch(/--(?:name|sha|ref)(?:\s|=)/);
    });
});