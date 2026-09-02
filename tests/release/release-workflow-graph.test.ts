import { beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";

/**
 * Deterministic structural tests for the job graph and mutation ordering of
 * `.github/workflows/release.yml`.
 *
 * A small parser/section extractor (no YAML dependency, no network, no
 * credentials, no live Actions run) reads the checked-in workflow text and
 * asserts the release publication gates:
 *
 * - `aggregate-release-metadata` is downstream of successful validation and
 *   all four binary legs;
 * - `publish` is downstream of validation, binary staging, container staging,
 *   and metadata aggregation;
 * - `push-container` is downstream of validation, container staging, and
 *   metadata aggregation;
 * - `publish-npm` is downstream of validation and metadata aggregation;
 * - every mutating job requires successful prerequisite results, a
 *   non-dry-run, and the protected `v*` tag before any mutation;
 * - every mutating step sits after its validation/verification steps.
 *
 * Failure scenarios (failed preflight, missing/failed build leg, corrupted
 * checksum, incomplete/incorrect manifest, dry-run, non-`v*` ref) are modeled
 * against that graph, proving that none of them can reach release-asset
 * deletion/upload/publish, npm publication, image login/push/manifest
 * publication, or any formula mutation.
 */

const repositoryRoot = resolve(import.meta.dir, "..", "..");

type WorkflowStep = {
    readonly name: string | null;
    readonly raw: string;
};

type WorkflowJob = {
    readonly name: string;
    readonly raw: string;
    readonly needs: readonly string[];
    readonly ifText: string | null;
    readonly steps: readonly WorkflowStep[];
};

type MutationKind = "release-assets" | "npm" | "image" | "formula";

type ReleaseScenario = {
    readonly dryRun: boolean;
    readonly failed: ReadonlySet<string>;
    readonly refIsProtectedVTag: boolean;
};

const MUTATING_JOBS = ["publish", "push-container", "publish-npm"] as const;

const JOB_HEADER = /^  ([A-Za-z0-9_.-]+):\s*$/;
const STEP_HEADER = /^      - /;
const INLINE_IF = /^    if:\s+(.+?)\s*$/;

const readWorkflowFile = (path: string): Promise<string> =>
    Bun.file(resolve(repositoryRoot, ".github/workflows", path)).text();

const parseWorkflowJobs = (text: string): readonly WorkflowJob[] => {
    const lines = text.split("\n");
    const jobs: WorkflowJob[] = [];
    let cursor = lines.findIndex((line) => line === "jobs:");
    if (cursor < 0) return jobs;
    cursor += 1;
    while (cursor < lines.length) {
        const header = JOB_HEADER.exec(lines[cursor] ?? "");
        if (header === null) {
            cursor += 1;
            continue;
        }
        let end = cursor + 1;
        while (end < lines.length && !JOB_HEADER.test(lines[end] ?? "")) {
            end += 1;
        }
        jobs.push(parseJob(header[1] as string, lines, cursor, end));
        cursor = end;
    }
    return jobs;
};

const parseJob = (
    name: string,
    lines: readonly string[],
    start: number,
    end: number,
): WorkflowJob => ({
    name,
    raw: lines.slice(start, end).join("\n"),
    needs: parseNeeds(lines, start, end),
    ifText: parseIf(lines, start, end),
    steps: parseSteps(lines, start, end),
});

const NEEDS_INLINE = /^    needs:\s+(\S.*?)\s*$/;
const NEEDS_HEADER = /^    needs:\s*$/;
const NEEDS_LIST_ITEM = /^      - ([A-Za-z0-9_.-]+)$/;
const NEEDS_MAPPING_ITEM = /^      ([A-Za-z0-9_.-]+):\s*$/;
const INDENTED = /^(?: {6,}|\s*)$/;

const needsListItem = (line: string): string | null => {
    const listItem = NEEDS_LIST_ITEM.exec(line);
    if (listItem !== null) return listItem[1] as string;
    const mapItem = NEEDS_MAPPING_ITEM.exec(line);
    return mapItem === null ? null : (mapItem[1] as string);
};

const parseNeeds = (
    lines: readonly string[],
    start: number,
    end: number,
): readonly string[] => {
    const needs: string[] = [];
    let collecting = false;
    for (let index = start; index < end; index += 1) {
        const line = lines[index] ?? "";
        const inline = NEEDS_INLINE.exec(line);
        if (inline !== null) {
            needs.push(...(inline[1] as string).split(/\s+/));
            collecting = false;
            continue;
        }
        if (NEEDS_HEADER.test(line)) {
            collecting = true;
            continue;
        }
        if (!collecting) continue;
        const item = needsListItem(line);
        if (item !== null) {
            needs.push(item);
            continue;
        }
        if (!INDENTED.test(line)) collecting = false;
    }
    return needs;
};

const parseIf = (
    lines: readonly string[],
    start: number,
    end: number,
): string | null => {
    for (let index = start; index < end; index += 1) {
        const line = lines[index] ?? "";
        const marker = /^    if:\s*(?:[>|+-][>|+-]*)?\s*$/.test(line);
        const inline = INLINE_IF.exec(line);
        if (marker) {
            // Block scalar (e.g. `if: >-`): content follows on indented lines
            // until the next job-level key.
            const block: string[] = [];
            let cursor = index + 1;
            while (cursor < end && /^ {6,}/.test(lines[cursor] ?? "")) {
                block.push((lines[cursor] ?? "").trim());
                cursor += 1;
            }
            return block.join("\n");
        }
        if (inline !== null) return inline[1] as string;
    }
    return null;
};

const findStepsStart = (
    lines: readonly string[],
    start: number,
    end: number,
): number => {
    for (let index = start; index < end; index += 1) {
        if (/^    steps:\s*$/.test(lines[index] ?? "")) return index + 1;
    }
    return -1;
};

const parseSteps = (
    lines: readonly string[],
    start: number,
    end: number,
): readonly WorkflowStep[] => {
    const stepsStart = findStepsStart(lines, start, end);
    if (stepsStart < 0) return [];
    const steps: WorkflowStep[] = [];
    let blockStart = -1;
    for (let index = stepsStart; index < end; index += 1) {
        if (!STEP_HEADER.test(lines[index] ?? "")) continue;
        if (blockStart >= 0) steps.push(makeStep(lines, blockStart, index));
        blockStart = index;
    }
    if (blockStart >= 0) steps.push(makeStep(lines, blockStart, end));
    return steps;
};

const makeStep = (
    lines: readonly string[],
    start: number,
    end: number,
): WorkflowStep => {
    const raw = lines.slice(start, end).join("\n");
    // Only the step header itself is a `- name:` list item; `name:` keys under
    // `with:`/`env:` or inside embedded scripts must not be treated as the
    // step name.
    const nameLine = lines
        .slice(start, end)
        .map((line) => line.trimStart())
        .find((line) => line.startsWith("- name: "));
    return {
        name: nameLine === undefined ? null : nameLine.slice("- name: ".length),
        raw,
    };
};

const jobByName = (jobs: readonly WorkflowJob[], name: string): WorkflowJob => {
    const job = jobs.find((candidate) => candidate.name === name);
    if (job === undefined) {
        throw new Error(`Missing job '${name}' in release.yml`);
    }
    return job;
};

const stepByName = (job: WorkflowJob, name: string): WorkflowStep => {
    const step = job.steps.find((candidate) => (candidate.name ?? "") === name);
    if (step === undefined) {
        throw new Error(`Missing step '${name}' in job '${job.name}'`);
    }
    return step;
};

const stepNames = (job: WorkflowJob): readonly string[] =>
    job.steps.map((step) => step.name ?? "");

const explicitSuccessCheck = (job: WorkflowJob, need: string): boolean =>
    job.ifText?.includes(`needs.${need}.result == 'success'`) === true ||
    job.ifText?.includes(`needs['${need}'].result == 'success'`) === true;

const requiresNonDryRun = (job: WorkflowJob): boolean =>
    job.ifText?.includes("needs.validate.outputs.dry_run == 'false'") === true;

const requiresProtectedVTag = (job: WorkflowJob): boolean =>
    job.ifText?.includes("github.ref_type == 'tag'") === true &&
    job.ifText?.includes("startsWith(github.ref, 'refs/tags/v')") === true;

// Every job with `needs` inherits GitHub's "all needed jobs succeeded" rule
// unless its `if` uses `always()`, which then forces explicit result checks.
const coversAllPrerequisiteResults = (job: WorkflowJob): boolean =>
    job.needs.every(
        (need) =>
            explicitSuccessCheck(job, need) ||
            (job.ifText ?? "").includes("always()") !== true,
    );

const mutationKindOf = (step: WorkflowStep): MutationKind | null => {
    const raw = step.raw;
    const name = step.name ?? "";
    if (
        name === "Create or reuse draft release handle" ||
        name === "Upload assets and publish GitHub release" ||
        raw.includes("upload_endpoint") ||
        raw.includes("gh api --method PATCH")
    ) {
        return "release-assets";
    }
    if (raw.includes("npm publish")) return "npm";
    if (
        raw.includes("docker/login-action") ||
        raw.includes("skopeo copy") ||
        raw.includes("docker manifest push")
    ) {
        return "image";
    }
    return null;
};

const isFormulaMutation = (step: WorkflowStep): boolean =>
    /generate-homebrew-formula|Formula\/|homebrew/i.test(step.raw);

const mutationKinds = (job: WorkflowJob): readonly MutationKind[] => [
    ...new Set(
        job.steps
            .map(mutationKindOf)
            .filter((kind): kind is MutationKind => kind !== null),
    ),
];

const scenario = (overrides: Partial<ReleaseScenario>): ReleaseScenario => ({
    dryRun: false,
    failed: new Set(),
    refIsProtectedVTag: true,
    ...overrides,
});

// Reachability model over the parsed job graph: a job runs only when every
// prerequisite either succeeded (explicitly or via the default rule) and its
// own guard (non-dry-run, protected v* tag) passes. The preflight (`validate`)
// job is the sole root and rejects any non-`v*` ref.
const reachableMutations = (
    jobs: readonly WorkflowJob[],
    current: ReleaseScenario,
): readonly MutationKind[] => {
    const memo = new Map<string, boolean>();
    const canRun = (name: string): boolean => {
        const cached = memo.get(name);
        if (cached !== undefined) return cached;
        const job = jobByName(jobs, name);
        if (current.failed.has(name)) return false;
        if (name === "validate") return current.refIsProtectedVTag;
        const prerequisitesSucceeded = job.needs.every((need) => {
            if (!canRun(need)) return false;
            const usesAlways = (job.ifText ?? "").includes("always()");
            return explicitSuccessCheck(job, need) || !usesAlways;
        });
        const guardPasses =
            (!requiresNonDryRun(job) || !current.dryRun) &&
            (!requiresProtectedVTag(job) || current.refIsProtectedVTag);
        memo.set(name, prerequisitesSucceeded && guardPasses);
        return prerequisitesSucceeded && guardPasses;
    };
    const reachable = new Set<MutationKind>();
    for (const job of jobs) {
        if (!canRun(job.name)) continue;
        for (const kind of mutationKinds(job)) reachable.add(kind);
    }
    return [...reachable];
};

const expectMutationOrdering = (
    jobs: readonly WorkflowJob[],
    jobName: string,
    verifiers: readonly string[],
    mutations: readonly string[],
): void => {
    const job = jobByName(jobs, jobName);
    const names = stepNames(job);
    for (const verifier of verifiers) expect(names).toContain(verifier);
    for (const mutation of mutations) expect(names).toContain(mutation);
    const lastVerifier = Math.max(
        ...verifiers.map((name) => names.indexOf(name)),
    );
    const firstMutation = Math.min(
        ...mutations.map((name) => names.indexOf(name)),
    );
    expect(lastVerifier).toBeLessThan(firstMutation);
    // A shell verification step must fail closed so a checksum or manifest
    // mismatch aborts the job before any mutation step.
    for (const verifier of verifiers) {
        const step = stepByName(job, verifier);
        if (step.raw.includes("run: |")) {
            expect(step.raw).toContain("set -euo pipefail");
        }
    }
};

describe("release.yml job graph and publication gating", () => {
    let releaseJobs: readonly WorkflowJob[] = [];

    beforeAll(async () => {
        releaseJobs = parseWorkflowJobs(await readWorkflowFile("release.yml"));
    });

    test("aggregate-release-metadata is downstream of validation and every binary leg", () => {
        const aggregate = jobByName(releaseJobs, "aggregate-release-metadata");
        expect(aggregate.needs).toContain("validate");
        expect(aggregate.needs).toContain("build-binaries");
        expect(aggregate.ifText ?? "").toContain("always()");
        expect(explicitSuccessCheck(aggregate, "validate")).toBe(true);
        expect(explicitSuccessCheck(aggregate, "build-binaries")).toBe(true);
        // build-binaries is one matrix job whose legs are all four release
        // targets; the job fails when any leg fails, so a successful
        // aggregation result implies every binary leg succeeded.
        const build = jobByName(releaseJobs, "build-binaries");
        for (const target of [
            "darwin-arm64",
            "darwin-x64",
            "linux-arm64",
            "linux-x64",
        ]) {
            expect(build.raw).toContain(`target: ${target}`);
        }
        expect(build.raw).toContain("fail-fast: false");
        // Aggregation is the publisher's immutable metadata source: the
        // checksum-verified manifest and the exact artifact bundle.
        const aggregationStep = aggregate.steps.find((step) =>
            step.raw.includes("create-release-metadata.ts"),
        );
        expect(aggregationStep?.raw).toContain(
            "bun scripts/create-release-metadata.ts",
        );
        expect(aggregate.raw).toContain("upload-artifact");
    });

    test("publish is downstream of validation, binary staging, container staging, and aggregation", () => {
        const publish = jobByName(releaseJobs, "publish");
        for (const need of [
            "validate",
            "build-binaries",
            "stage-container",
            "aggregate-release-metadata",
        ]) {
            expect(publish.needs).toContain(need);
        }
        expect(publish.ifText ?? "").toContain("always()");
        for (const need of publish.needs) {
            expect(explicitSuccessCheck(publish, need)).toBe(true);
        }
        expect(requiresNonDryRun(publish)).toBe(true);
        expect(requiresProtectedVTag(publish)).toBe(true);
    });

    test("push-container is downstream of validation, container staging, and aggregation", () => {
        const push = jobByName(releaseJobs, "push-container");
        for (const need of [
            "validate",
            "stage-container",
            "aggregate-release-metadata",
        ]) {
            expect(push.needs).toContain(need);
        }
        expect(push.ifText ?? "").toContain("always()");
        for (const need of push.needs) {
            expect(explicitSuccessCheck(push, need)).toBe(true);
        }
        expect(requiresNonDryRun(push)).toBe(true);
    });

    test("publish-npm is downstream of validation and metadata aggregation", () => {
        const npm = jobByName(releaseJobs, "publish-npm");
        expect(npm.needs).toContain("validate");
        expect(npm.needs).toContain("aggregate-release-metadata");
        // No always(): GitHub's default "all needed jobs succeeded" rule is
        // the aggregation gate, with the two explicit result checks for the
        // staged package and the aggregated metadata bundle.
        expect(npm.ifText ?? "").not.toContain("always()");
        expect(explicitSuccessCheck(npm, "stage-package")).toBe(true);
        expect(explicitSuccessCheck(npm, "aggregate-release-metadata")).toBe(
            true,
        );
        expect(requiresNonDryRun(npm)).toBe(true);
        expect(requiresProtectedVTag(npm)).toBe(true);
    });

    test("every mutating job gates on successful prerequisite results", () => {
        for (const name of MUTATING_JOBS) {
            expect(
                coversAllPrerequisiteResults(jobByName(releaseJobs, name)),
            ).toBe(true);
        }
    });

    test("mutating jobs require a non-dry-run and the protected v* tag", async () => {
        for (const name of MUTATING_JOBS) {
            expect(requiresNonDryRun(jobByName(releaseJobs, name))).toBe(true);
        }
        // publish and publish-npm re-assert the protected v* ref inline so
        // they can never run from a branch or an unsupported tag.
        expect(requiresProtectedVTag(jobByName(releaseJobs, "publish"))).toBe(
            true,
        );
        expect(
            requiresProtectedVTag(jobByName(releaseJobs, "publish-npm")),
        ).toBe(true);
        // push-container keeps the ref guard in the shared preflight instead
        // of re-inlining it: the validate job's executable seam rejects any
        // tag that is not a protected v<major>.<minor>.<patch>.
        expect(
            requiresProtectedVTag(jobByName(releaseJobs, "push-container")),
        ).toBe(false);
        const validate = jobByName(releaseJobs, "validate");
        const preflight = stepByName(
            validate,
            "Validate and resolve release context",
        );
        expect(preflight.raw).toContain(
            "bun scripts/validate-release-context.ts",
        );
        const seam = await Bun.file(
            resolve(repositoryRoot, "scripts/validate-release-context.ts"),
        ).text();
        expect(seam).toContain(
            "The release tag must be protected against updates and deletions",
        );
        for (const name of MUTATING_JOBS) {
            expect(jobByName(releaseJobs, name).needs).toContain("validate");
        }
    });

    test("a failed preflight blocks every publication channel", () => {
        expect(
            reachableMutations(
                releaseJobs,
                scenario({ failed: new Set(["validate"]) }),
            ),
        ).toEqual([]);
    });

    test("a missing or failed build leg blocks every publication channel", () => {
        expect(
            reachableMutations(
                releaseJobs,
                scenario({ failed: new Set(["build-binaries"]) }),
            ),
        ).toEqual([]);
    });

    test("a corrupted checksum fails aggregation and blocks every publication channel", async () => {
        // create-release-metadata.ts recomputes each staged binary digest and
        // fails the aggregation job on mismatch, so a corrupted checksum
        // surfaces exactly as a failed aggregate-release-metadata result.
        const aggregation = jobByName(
            releaseJobs,
            "aggregate-release-metadata",
        );
        expect(
            aggregation.steps.some((step) =>
                step.raw.includes("create-release-metadata.ts"),
            ),
        ).toBe(true);
        const metadataScript = await Bun.file(
            resolve(repositoryRoot, "scripts/create-release-metadata.ts"),
        ).text();
        expect(metadataScript).toContain("Release asset checksum for");
        expect(
            reachableMutations(
                releaseJobs,
                scenario({ failed: new Set(["aggregate-release-metadata"]) }),
            ),
        ).toEqual([]);
    });

    test("an incomplete or incorrect manifest fails aggregation and blocks every publication channel", async () => {
        // The aggregation script emits a strict manifest from the verified
        // assets, and publish re-verifies the manifest and exact bytes in
        // "Verify release metadata and exact assets" before its mutation
        // steps (ordering covered in the next test).
        const aggregation = jobByName(
            releaseJobs,
            "aggregate-release-metadata",
        );
        const aggregationStep = aggregation.steps.find((step) =>
            step.raw.includes("create-release-metadata.ts"),
        );
        expect(aggregationStep?.raw).toContain("--output-dir release-bundle");
        const publish = jobByName(releaseJobs, "publish");
        expect(publish.raw).toContain('(type == "array" and length == 4');
        expect(publish.raw).toContain("sha256sum --check SHA256SUMS");
        expect(
            reachableMutations(
                releaseJobs,
                scenario({ failed: new Set(["aggregate-release-metadata"]) }),
            ),
        ).toEqual([]);
    });

    test("a dry-run or a non-v* ref reaches no mutation", () => {
        expect(
            reachableMutations(releaseJobs, scenario({ dryRun: true })),
        ).toEqual([]);
        expect(
            reachableMutations(
                releaseJobs,
                scenario({ refIsProtectedVTag: false }),
            ),
        ).toEqual([]);
    });

    test("a container staging failure blocks release assets and images but not npm", () => {
        // Faithfulness check: npm publication is deliberately independent of
        // the container leg, so the model must not be vacuously empty.
        expect(
            reachableMutations(
                releaseJobs,
                scenario({ failed: new Set(["stage-container"]) }),
            ),
        ).toEqual(["npm"]);
    });

    test("every mutating step is downstream of its verification steps", () => {
        expectMutationOrdering(
            releaseJobs,
            "publish",
            [
                "Verify release metadata and exact assets",
                "Collect binaries and create SHA256SUMS",
                "Generate and validate deterministic SPDX SBOMs",
                "Verify all binary attestations exist",
                "Verify final SBOMs and build provenance",
                "Sign and verify SHA256SUMS with Sigstore",
            ],
            [
                "Create or reuse draft release handle",
                "Upload assets and publish GitHub release",
            ],
        );
        expectMutationOrdering(
            releaseJobs,
            "push-container",
            [
                "Verify candidate metadata",
                "Inspect OCI metadata before promotion",
            ],
            [
                "Log in to GitHub Container Registry",
                "Promote platform images and persist publication subjects",
                "Create manifest aliases from immutable digests",
            ],
        );
        expectMutationOrdering(
            releaseJobs,
            "publish-npm",
            [
                "Verify scoped package and release tag version",
                "Build and smoke-test packed package",
            ],
            ["Publish scoped package with npm provenance"],
        );
    });

    test("the release workflow has no deletion path and no formula mutation", async () => {
        const workflowText = await readWorkflowFile("release.yml");
        const jobs = parseWorkflowJobs(workflowText);
        // Release assets are immutable: the upload step refuses to delete,
        // overwrite, or ignore conflicting assets, and no deletion API call
        // exists anywhere in the workflow.
        for (const marker of [
            "gh api --method DELETE",
            "deleteRelease",
            "--clobber",
        ]) {
            expect(workflowText).not.toContain(marker);
        }
        expect(workflowText).toContain(
            "refusing to delete, overwrite, ignore, or publish",
        );
        // No formula mutator exists in the release workflow, gated or
        // ungated; the same holds for the other workflow files.
        const formulaMutators = jobs
            .flatMap((job) => job.steps)
            .filter(isFormulaMutation);
        expect(formulaMutators).toEqual([]);
        expect(workflowText).not.toMatch(
            /generate-homebrew-formula|Formula\/|homebrew/,
        );
        for (const name of ["ci.yml", "public-distribution.yml"]) {
            const text = await readWorkflowFile(name);
            expect(text).not.toMatch(
                /generate-homebrew-formula|Formula\/|homebrew/,
            );
        }
    });
});