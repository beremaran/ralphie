import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Deterministic tests for the container SBOM validation seam used by the
 * `push-container` job of `.github/workflows/release.yml` (step "Validate and
 * pin container SBOMs to release identity"). The script runs against a
 * temporary directory with a synthetic SPDX 2.3 document per subject and the
 * persisted `ralphie.container-attestation-subjects.v1` map; no GitHub,
 * registry, network, or credentials are involved.
 *
 * An accepted run must pin every SBOM's `creationInfo.comment` to the
 * validated release identity (tag, version, commit, platform, digest, and
 * workflow ref), keep the annotated document schema-valid, and record each
 * final SBOM's SHA-256 and size in the subjects map. Any missing, malformed,
 * mismatched, or non-conforming input must fail closed with a non-zero exit
 * and leave the inputs unchanged.
 */

const repositoryRoot = resolve(import.meta.dir, "..", "..");
const validationScript = join(
    repositoryRoot,
    "scripts/validate-container-sboms.ts",
);

const REPOSITORY = "beremaran/ralphie";
const IMAGE = "ghcr.io/beremaran/ralphie";
const VERSION = "0.1.2";
const TAG = "v0.1.2";
const COMMIT = "a7c098f20ef212c6f6940825143396680c054bba";
const WORKFLOW_REF = `${REPOSITORY}/.github/workflows/release.yml@refs/tags/${TAG}`;
const AMD64_DIGEST =
    "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const ARM64_DIGEST =
    "sha256:2222222222222222222222222222222222222222222222222222222222222222";

const spdxDocument = (reference: string): string =>
    JSON.stringify(
        {
            SPDXID: "SPDXRef-DOCUMENT",
            spdxVersion: "SPDX-2.3",
            creationInfo: {
                created: "2026-09-03T00:00:00Z",
                creators: ["Tool: syft-test-1.0.0"],
            },
            name: reference,
            dataLicense: "CC0-1.0",
            documentNamespace:
                "https://anchore.com/syft/image/test-00000000-0000-0000-0000-000000000000",
            packages: [],
            relationships: [],
        },
        null,
        2,
    );

type SubjectsFile = {
    readonly [key: string]: unknown;
};

const subjectsMap = (overrides: SubjectsFile = {}): SubjectsFile => ({
    schema: "ralphie.container-attestation-subjects.v1",
    image: IMAGE,
    tag: TAG,
    version: VERSION,
    source_ref: COMMIT,
    workflow: "Release",
    workflow_file: ".github/workflows/release.yml",
    workflow_ref: WORKFLOW_REF,
    run_id: "12345",
    run_attempt: "1",
    subjects: [
        {
            platform: "linux/amd64",
            digest: AMD64_DIGEST,
            reference: `${IMAGE}@${AMD64_DIGEST}`,
            name: IMAGE,
            sbom: "ralphie-container-amd64.sbom.spdx.json",
        },
        {
            platform: "linux/arm64",
            digest: ARM64_DIGEST,
            reference: `${IMAGE}@${ARM64_DIGEST}`,
            name: IMAGE,
            sbom: "ralphie-container-arm64.sbom.spdx.json",
        },
    ],
    ...overrides,
});

type Fixture = {
    readonly root: string;
};

const createFixture = async (
    map: SubjectsFile = subjectsMap(),
    sboms: Record<string, string> = {
        "ralphie-container-amd64.sbom.spdx.json": spdxDocument(
            `${IMAGE}@${AMD64_DIGEST}`,
        ),
        "ralphie-container-arm64.sbom.spdx.json": spdxDocument(
            `${IMAGE}@${ARM64_DIGEST}`,
        ),
    },
): Promise<Fixture> => {
    const root = await mkdtemp(join(tmpdir(), "ralphie-container-sboms-"));
    await writeFile(
        join(root, "container-attestation-subjects.json"),
        JSON.stringify(map),
    );
    for (const [name, content] of Object.entries(sboms)) {
        await writeFile(join(root, name), content);
    }
    return { root };
};

const runValidator = (
    root: string,
    env: Record<string, string> = {},
): { readonly exitCode: number | null; readonly stderr: string } => {
    const result = Bun.spawnSync(
        [
            "bun",
            validationScript,
            "--subjects",
            "container-attestation-subjects.json",
            "--version",
            VERSION,
            "--tag",
            TAG,
            "--commit-sha",
            COMMIT,
        ],
        {
            cwd: root,
            env: {
                GITHUB_REPOSITORY: REPOSITORY,
                PATH: process.env.PATH ?? "",
                ...env,
            },
            stderr: "pipe",
            stdout: "pipe",
        },
    );
    return {
        exitCode: result.exitCode,
        stderr: result.stderr.toString(),
    };
};

describe("validate-container-sboms", () => {
    test("pins each SBOM to the validated release identity and records its digest", async () => {
        const { root } = await createFixture();
        const result = runValidator(root);
        expect(result.stderr).toBe("");
        expect(result.exitCode).toBe(0);

        const map = JSON.parse(
            await readFile(
                join(root, "container-attestation-subjects.json"),
                "utf8",
            ),
        ) as Record<string, unknown>;
        const subjects = map.subjects as ReadonlyArray<Record<string, unknown>>;
        expect(subjects).toHaveLength(2);
        for (const subject of subjects) {
            expect(subject.platform).toMatch(/^linux\/(amd64|arm64)$/);
            expect(subject.sbom_sha256).toMatch(/^[0-9a-f]{64}$/);
            expect(subject.sbom_size).toBeGreaterThan(0);

            const document = JSON.parse(
                await readFile(join(root, subject.sbom as string), "utf8"),
            ) as { readonly creationInfo: { readonly comment: string } };
            const identity = JSON.parse(
                document.creationInfo.comment,
            ) as Record<string, unknown>;
            expect(identity.platform).toBe(subject.platform);
            expect(identity.digest).toBe(subject.digest);
            expect(identity.reference).toBe(subject.reference);
            expect(identity.releaseTag).toBe(TAG);
            expect(identity.releaseVersion).toBe(VERSION);
            expect(identity.commitSha).toBe(COMMIT);
            expect(identity.workflowRef).toBe(WORKFLOW_REF);
            expect(identity.workflowFile).toBe(".github/workflows/release.yml");
        }
    });

    test("rejects a tag that does not match the version", async () => {
        const { root } = await createFixture();
        const result = Bun.spawnSync(
            [
                "bun",
                validationScript,
                "--subjects",
                "container-attestation-subjects.json",
                "--version",
                VERSION,
                "--tag",
                "v9.9.9",
                "--commit-sha",
                COMMIT,
            ],
            {
                cwd: root,
                env: {
                    GITHUB_REPOSITORY: REPOSITORY,
                    PATH: process.env.PATH ?? "",
                },
                stderr: "pipe",
                stdout: "pipe",
            },
        );
        expect(result.exitCode).toBe(1);
        expect(result.stderr.toString()).toContain("does not match version");
    });

    test("rejects a subject map bound to another release identity", async () => {
        const { root } = await createFixture(
            subjectsMap({ source_ref: "c".repeat(40) }),
        );
        const result = runValidator(root);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("not bound to the validated release");
    });

    test("rejects a malformed or missing SBOM without changing it", async () => {
        const missing = await createFixture(subjectsMap(), {
            "ralphie-container-amd64.sbom.spdx.json": "not json",
        });
        const missingResult = runValidator(missing.root);
        expect(missingResult.exitCode).toBe(1);
        expect(missingResult.stderr).toContain("not valid JSON");

        const malformed = await createFixture(subjectsMap(), {
            "ralphie-container-arm64.sbom.spdx.json": "not json",
        });
        const malformedResult = runValidator(malformed.root);
        expect(malformedResult.exitCode).toBe(1);
        expect(malformedResult.stderr).toContain("not valid JSON");
    });

    test("rejects a missing SBOM file for a recorded subject", async () => {
        const { root } = await createFixture(subjectsMap(), {});
        const result = runValidator(root);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("Container SBOM");
    });

    test("rejects a non-SPDX-2.3 document", async () => {
        const { root } = await createFixture(subjectsMap(), {
            "ralphie-container-amd64.sbom.spdx.json": JSON.stringify({
                SPDXID: "SPDXRef-DOCUMENT",
                spdxVersion: "SPDX-2.2",
                creationInfo: {
                    created: "2026-09-03T00:00:00Z",
                    creators: ["Tool: test"],
                },
                name: `${IMAGE}@${AMD64_DIGEST}`,
                dataLicense: "CC0-1.0",
                documentNamespace: "https://example.org/sbom",
            }),
        });
        const result = runValidator(root);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("SPDX 2.3 document");
    });
});