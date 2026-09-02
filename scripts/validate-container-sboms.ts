#!/usr/bin/env bun

/**
 * Container SBOM validation and release-identity binding used by the
 * `push-container` job of `.github/workflows/release.yml` (step "Validate and
 * pin container SBOMs to release identity").
 *
 * The immutable platform digests are consumed from the persisted
 * `container-attestation-subjects.v1` map (derived from the verified
 * `publication-subjects.v1` map after platform promotion). For every subject
 * the generated SPDX document must already exist at its recorded path, must
 * be a compliant SPDX 2.3 JSON document (checked-in schema), and must then be
 * pinned to the validated release identity through an explicit
 * `creationInfo.comment`. The annotated bytes are written back before any
 * attestation runs, so the SBOM predicate that `actions/attest-sbom` attaches
 * to the exact image digest carries the validated tag, version, commit,
 * platform, and digest. The script re-validates the annotated document
 * against the schema and records each final SBOM's SHA-256 and size back into
 * the subjects map, which the attestation verification step consumes.
 *
 * Any missing, malformed, mismatched, or non-conforming input fails closed
 * with a non-zero exit; there is deliberately no fallback or default branch.
 */

import Ajv from "ajv";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import spdxSchema from "../schemas/spdx-2.3.schema.json";

export const CONTAINER_SBOM_GENERATOR_NAME = "ralphie-container-sbom-generator";
export const CONTAINER_SBOM_GENERATOR_VERSION = "1.0.0";
export const CONTAINER_ATTESTATION_SUBJECTS_SCHEMA =
    "ralphie.container-attestation-subjects.v1";
export const CONTAINER_IMAGE = "ghcr.io/beremaran/ralphie";

const releaseVersionPattern =
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const commitShaPattern = /^[0-9a-f]{40}$/;
const registryDigestPattern = /^sha256:[0-9a-f]{64}$/;
const positiveIntegerPattern = /^[1-9][0-9]*$/;
const sbomFileNamePattern =
    /^ralphie-container-(amd64|arm64)\.sbom\.spdx\.json$/;

type ContainerSubject = {
    readonly digest: string;
    readonly name: string;
    readonly platform: "linux/amd64" | "linux/arm64";
    readonly reference: string;
    readonly sbom: string;
    readonly sbom_sha256?: string;
    readonly sbom_size?: number;
};

type ContainerAttestationSubjects = {
    readonly image: string;
    readonly run_attempt: string;
    readonly run_id: string;
    readonly schema: string;
    readonly source_ref: string;
    readonly subjects: ReadonlyArray<ContainerSubject>;
    readonly tag: string;
    readonly version: string;
    readonly workflow: string;
    readonly workflow_file: string;
    readonly workflow_ref: string;
};

const isContainerSubject = (
    value: Record<string, unknown>,
): value is ContainerSubject =>
    hasStringProperties(value, [
        "digest",
        "name",
        "platform",
        "reference",
        "sbom",
    ]) &&
    ((typeof value.sbom_sha256 === "string" &&
        /^[0-9a-f]{64}$/.test(value.sbom_sha256)) ||
        value.sbom_sha256 === undefined) &&
    ((typeof value.sbom_size === "number" &&
        Number.isSafeInteger(value.sbom_size) &&
        value.sbom_size > 0) ||
        value.sbom_size === undefined);

type ContainerSbomIdentity = {
    readonly commitSha: string;
    readonly digest: string;
    readonly image: string;
    readonly platform: string;
    readonly reference: string;
    readonly releaseTag: string;
    readonly releaseVersion: string;
    readonly runAttempt: string;
    readonly runId: string;
    readonly sbomGenerator: { readonly name: string; readonly version: string };
    readonly workflow: string;
    readonly workflowFile: string;
    readonly workflowRef: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;

const hasStringProperties = (
    value: Record<string, unknown>,
    names: ReadonlyArray<string>,
): boolean => names.every((name) => typeof value[name] === "string");

const spdxValidator = new Ajv({ allErrors: true, strict: true }).compile(
    spdxSchema,
);
const spdxIdentifierPattern = /^SPDXRef-[A-Za-z0-9.-]+$/;

const assertSpdxIdentifiers = (value: unknown): void => {
    if (Array.isArray(value)) {
        for (const child of value) assertSpdxIdentifiers(child);
        return;
    }
    if (!isRecord(value)) return;
    if (
        "SPDXID" in value &&
        (typeof value.SPDXID !== "string" ||
            !spdxIdentifierPattern.test(value.SPDXID))
    ) {
        throw new Error("Container SBOM contains an invalid SPDX identifier.");
    }
    for (const child of Object.values(value)) assertSpdxIdentifiers(child);
};

const assertSpdxSchema = (document: unknown): void => {
    if (!spdxValidator(document)) {
        const error = spdxValidator.errors?.[0];
        throw new Error(
            `Container SBOM does not conform to the SPDX 2.3 schema${error?.instancePath ?? ""}.`,
        );
    }
    assertSpdxIdentifiers(document);
};

const sha256 = async (path: string): Promise<string> =>
    createHash("sha256")
        .update(await readFile(path))
        .digest("hex");

const assertReleaseContext = (
    version: string,
    tag: string,
    commitSha: string,
): void => {
    if (!releaseVersionPattern.test(version) || tag !== `v${version}`) {
        throw new Error(
            `Release tag '${tag}' does not match version '${version}'.`,
        );
    }
    if (!commitShaPattern.test(commitSha)) {
        throw new Error(
            "Release commit SHA must be a 40-character lowercase SHA-1.",
        );
    }
};

const expectedSbomName = (platform: string): string => {
    const arch = platform.split("/")[1];
    if (arch !== "amd64" && arch !== "arm64") {
        throw new Error(`Unsupported container platform '${platform}'.`);
    }
    return `ralphie-container-${arch}.sbom.spdx.json`;
};

const parseSubjects = (raw: unknown): ContainerAttestationSubjects => {
    if (
        !isRecord(raw) ||
        raw.schema !== CONTAINER_ATTESTATION_SUBJECTS_SCHEMA ||
        !hasStringProperties(raw, [
            "image",
            "run_attempt",
            "run_id",
            "source_ref",
            "tag",
            "version",
            "workflow",
            "workflow_file",
            "workflow_ref",
        ]) ||
        !Array.isArray(raw.subjects)
    ) {
        throw new Error(
            "Container attestation subjects map is incomplete or invalid.",
        );
    }
    const subjects = raw.subjects;
    if (subjects.length !== 2) {
        throw new Error(
            "Container attestation subjects map must contain exactly two subjects.",
        );
    }
    for (const subject of subjects) {
        if (
            !isRecord(subject) ||
            !isContainerSubject(subject) ||
            (subject.platform !== "linux/amd64" &&
                subject.platform !== "linux/arm64") ||
            !registryDigestPattern.test(subject.digest) ||
            subject.name !== raw.image ||
            subject.reference !== `${raw.image as string}@${subject.digest}` ||
            subject.sbom !== expectedSbomName(subject.platform)
        ) {
            throw new Error(
                "Container attestation subject is missing, duplicate, unsupported, or mismatched.",
            );
        }
    }
    const platforms = subjects.map((subject) => subject.platform).sort();
    if (
        platforms[0] !== "linux/amd64" ||
        platforms[1] !== "linux/arm64" ||
        subjects[0].digest === subjects[1].digest
    ) {
        throw new Error(
            "Container attestation subjects must cover exactly linux/amd64 and linux/arm64 with unique digests.",
        );
    }
    return raw as unknown as ContainerAttestationSubjects;
};

const readSubjects = async (
    path: string,
    version: string,
    tag: string,
    commitSha: string,
): Promise<ContainerAttestationSubjects> => {
    const subjects = parseSubjects(JSON.parse(await readFile(path, "utf8")));
    const repository = process.env.GITHUB_REPOSITORY ?? "";
    if (repository === "") {
        throw new Error("GITHUB_REPOSITORY is not set.");
    }
    if (
        subjects.image !== CONTAINER_IMAGE ||
        subjects.version !== version ||
        subjects.tag !== tag ||
        subjects.source_ref !== commitSha ||
        subjects.workflow !== "Release" ||
        subjects.workflow_file !== ".github/workflows/release.yml" ||
        subjects.workflow_ref !==
            `${repository}/.github/workflows/release.yml@refs/tags/${tag}` ||
        !positiveIntegerPattern.test(subjects.run_id) ||
        !positiveIntegerPattern.test(subjects.run_attempt)
    ) {
        throw new Error(
            "Container attestation subjects are not bound to the validated release identity.",
        );
    }
    return subjects;
};

const readSbomDocument = async (
    path: string,
): Promise<Record<string, unknown>> => {
    let document: unknown;
    try {
        document = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
            `Container SBOM '${path}' is not valid JSON: ${message}`,
        );
    }
    assertSpdxSchema(document);
    if (!isRecord(document)) {
        throw new Error("Container SBOM is not a JSON object.");
    }
    if (document.spdxVersion !== "SPDX-2.3") {
        throw new Error("Container SBOM is not an SPDX 2.3 document.");
    }
    if (!isRecord(document.creationInfo)) {
        throw new Error("Container SBOM has no creationInfo.");
    }
    return document;
};

const pinSbomIdentity = async (
    subjects: ContainerAttestationSubjects,
    subject: ContainerSubject,
): Promise<{ readonly sha256: string; readonly size: number }> => {
    const path = resolve(subject.sbom);
    const document = await readSbomDocument(path);
    const creationInfo = document.creationInfo;
    if (!isRecord(creationInfo)) {
        throw new Error("Container SBOM has no creationInfo.");
    }
    const identity: ContainerSbomIdentity = {
        commitSha: subjects.source_ref,
        digest: subject.digest,
        image: subjects.image,
        platform: subject.platform,
        reference: subject.reference,
        releaseTag: subjects.tag,
        releaseVersion: subjects.version,
        runAttempt: subjects.run_attempt,
        runId: subjects.run_id,
        sbomGenerator: {
            name: CONTAINER_SBOM_GENERATOR_NAME,
            version: CONTAINER_SBOM_GENERATOR_VERSION,
        },
        workflow: subjects.workflow,
        workflowFile: subjects.workflow_file,
        workflowRef: subjects.workflow_ref,
    };
    creationInfo.comment = JSON.stringify(identity);
    assertSpdxSchema(document);
    await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    const fileStat = await stat(path);
    if (!fileStat.isFile() || fileStat.size === 0) {
        throw new Error(
            `Container SBOM '${subject.sbom}' is missing or empty.`,
        );
    }
    return { sha256: await sha256(path), size: fileStat.size };
};

export const validateContainerSboms = async ({
    commitSha,
    subjectsPath,
    tag,
    version,
}: {
    readonly commitSha: string;
    readonly subjectsPath: string;
    readonly tag: string;
    readonly version: string;
}): Promise<ReadonlyArray<string>> => {
    assertReleaseContext(version, tag, commitSha);
    const subjects = await readSubjects(subjectsPath, version, tag, commitSha);
    const updatedSubjects = [];
    for (const subject of subjects.subjects) {
        const pinned = await pinSbomIdentity(subjects, subject);
        console.log(
            `${subject.platform}: ${subject.digest} -> ${subject.sbom} (sha256:${pinned.sha256}, ${pinned.size} bytes)`,
        );
        updatedSubjects.push({
            ...subject,
            sbom_sha256: pinned.sha256,
            sbom_size: pinned.size,
        });
    }
    await writeFile(
        subjectsPath,
        `${JSON.stringify(
            {
                ...subjects,
                subjects: updatedSubjects,
            },
            null,
            2,
        )}\n`,
        "utf8",
    );
    return updatedSubjects.map((subject) => subject.sbom);
};

const optionValue = (args: ReadonlyArray<string>, option: string): string => {
    const index = args.indexOf(option);
    const value = args[index + 1];
    if (index === -1 || value === undefined || value.startsWith("--")) {
        throw new Error(`${option} requires a value.`);
    }
    return value;
};

const main = async (): Promise<void> => {
    const args = Bun.argv.slice(2);
    if (args.length !== 8) {
        throw new Error(
            "Usage: validate-container-sboms.ts --subjects <path> --version <version> --tag <tag> --commit-sha <sha>",
        );
    }
    await validateContainerSboms({
        commitSha: optionValue(args, "--commit-sha"),
        subjectsPath: optionValue(args, "--subjects"),
        tag: optionValue(args, "--tag"),
        version: optionValue(args, "--version"),
    });
};

if (import.meta.main) {
    try {
        await main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    }
}