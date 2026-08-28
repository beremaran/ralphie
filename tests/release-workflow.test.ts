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
        expect(dockerfile).toContain(
            'org.opencontainers.image.version="$RALPHIE_VERSION"',
        );
        expect(dockerfile).toContain(
            'org.opencontainers.image.revision="$RALPHIE_COMMIT_SHA"',
        );
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
});