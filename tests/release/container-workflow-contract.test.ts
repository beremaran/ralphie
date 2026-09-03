import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Structural regression guard for the container publication boundary in
 * `.github/workflows/release.yml`: the uncredentialed `stage-container`
 * staging job must never hold registry credentials, log in, or write a
 * registry tag, and the protected `publish` job must run every candidate
 * validation and local assembly step before the GHCR login and before any
 * platform promotion or release-index alias write. This complements the
 * behavioral coverage in `container-registry-regression.test.ts` and the
 * create-only reconciler tests: a reordering or credential lift is caught
 * here even when the fake-registry behavior still passes.
 */

const WORKFLOW_PATH = join(
    import.meta.dir,
    "..",
    "..",
    ".github",
    "workflows",
    "release.yml",
);

type JobSection = {
    readonly lines: ReadonlyArray<string>;
};

const JOB_HEADER_PATTERN = /^  [a-z][a-z0-9-]*:$/;

const jobSections = (
    lines: ReadonlyArray<string>,
): ReadonlyArray<JobSection> => {
    const sections: JobSection[] = [];
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        if (!JOB_HEADER_PATTERN.test(line)) continue;
        let end = lines.length;
        for (let next = index + 1; next < lines.length; next += 1) {
            if (JOB_HEADER_PATTERN.test(lines[next] ?? "")) {
                end = next;
                break;
            }
        }
        sections.push({ lines: lines.slice(index, end) });
    }
    return sections;
};

const sectionOf = (
    sections: ReadonlyArray<JobSection>,
    job: string,
): JobSection => {
    const section = sections.find(
        (candidate) => (candidate.lines[0] ?? "") === `${"  "}${job}:`,
    );
    if (section === undefined) {
        throw new Error(`Workflow section for job '${job}' was not found.`);
    }
    return section;
};

/** Job-relative index of the first `- name: <title>` step line. */
const stepIndex = (section: JobSection, title: string): number => {
    const titleLine = `      - name: ${title}`;
    const index = section.lines.findIndex((line) => line === titleLine);
    if (index === -1) {
        throw new Error(`Workflow step '${title}' was not found.`);
    }
    return index;
};

describe("release workflow container publication boundary", () => {
    test("stage-container keeps no registry credentials and no write permissions", async () => {
        const workflow = await readFile(WORKFLOW_PATH, "utf8");
        const sections = jobSections(workflow.split("\n"));
        const stage = sectionOf(sections, "stage-container");
        const text = stage.lines.join("\n");
        expect(text).toContain("permissions:");
        expect(text).toContain("contents: read");
        // The staging job must never hold registry credentials, log in, or
        // request package-write permission.
        expect(text).not.toMatch(/GHCR_USERNAME|GHCR_PASSWORD/);
        expect(text).not.toMatch(/docker\/login-action/);
        expect(text).not.toMatch(/^ +\w+:\s*write$/m);
        // The container build is the exact non-publishing output: no tag or
        // manifest write of any kind.
        expect(text).toMatch(/push:\s*false/);
    });

    test("publish runs every candidate validation and assembly step before registry authentication", async () => {
        const workflow = await readFile(WORKFLOW_PATH, "utf8");
        const sections = jobSections(workflow.split("\n"));
        const publish = sectionOf(sections, "publish");
        const titles = [
            "Inventory exact staged container candidate artifacts",
            "Validate exact staged container candidate set",
            "Inspect OCI metadata before promotion",
            "Derive container tag plan",
            "Assemble deterministic container index and reconcile plan",
            "Log in to GitHub Container Registry",
            "Promote platform images with create-only reconciliation",
            "Reconcile release-index aliases from immutable digests",
        ];
        const indices = titles.map((title) => stepIndex(publish, title));
        for (let index = 1; index < indices.length; index += 1) {
            expect(indices[index] as number).toBeGreaterThan(
                indices[index - 1] as number,
            );
        }
        // Before the login step nothing may authenticate to GHCR or carry
        // registry credentials: validation and assembly are credential-free.
        const beforeLogin = publish.lines.slice(0, indices[5]);
        const preLoginText = beforeLogin.join("\n");
        expect(preLoginText).not.toMatch(/GHCR_USERNAME|GHCR_PASSWORD/);
        expect(preLoginText).not.toMatch(/docker\/login-action/);
        // Only the two production reconcile steps carry the registry
        // credentials, and both appear after the login step.
        const afterLogin = publish.lines.slice(indices[5]);
        expect(afterLogin.join("\n")).toMatch(/GHCR_USERNAME/);
        expect(afterLogin.join("\n")).toMatch(/GHCR_PASSWORD/);
    });

    test("stage-container performs no registry writes and no registry credential references", async () => {
        const workflow = await readFile(WORKFLOW_PATH, "utf8");
        const sections = jobSections(workflow.split("\n"));
        const stage = sectionOf(sections, "stage-container");
        const text = stage.lines.join("\n");
        // The build-push-action exporter writes only local archives.
        expect(text).toMatch(/type=docker,dest=/);
        expect(text).toMatch(/type=oci,dest=ralphie-container-/);
    });
});