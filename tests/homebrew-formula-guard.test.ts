import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
    HOMEBREW_FORMULA_BEGIN_MARKER,
    HOMEBREW_FORMULA_END_MARKER,
    renderHomebrewFormula,
    type HomebrewReleaseMetadata,
} from "../scripts/generate-homebrew-formula.ts";
import {
    prepareHomebrewFormula,
    type HomebrewFormulaChangeResult,
} from "../scripts/prepare-homebrew-formula.ts";
import { RELEASE_TARGETS } from "../scripts/verify-homebrew-assets.ts";

/**
 * Deterministic tests for the fail-closed Homebrew formula change guard
 * (`scripts/prepare-homebrew-formula.ts`), exercising the production entry
 * point against temporary git repositories with real commits, exact-tag
 * manifests, and no GitHub, registry, network, or credentials.
 *
 * A rejected update must throw with the rejected safety condition and leave
 * the checkout untouched; an accepted update must change only the generated
 * region of `Formula/ralphie.rb` and report an explicit `changed`/`unchanged`
 * result.
 */

const repositoryRoot = resolve(import.meta.dir, "..");
const formulaTemplatePath = join(repositoryRoot, "Formula", "ralphie.rb");

type Checkout = {
    readonly formulaPath: string;
    readonly root: string;
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

const checksumFor = (version: string, target: string): string =>
    createHash("sha256").update(`${version}|${target}`).digest("hex");

const metadataFor = (version: string): HomebrewReleaseMetadata => ({
    version,
    tag: `v${version}`,
    assets: RELEASE_TARGETS.map((target) => ({
        name: `ralphie-${target}`,
        sha256: checksumFor(version, target),
    })),
});

const formulaAt = (template: string, version: string): string =>
    renderHomebrewFormula(template, metadataFor(version));

const manifestFor = (
    version: string,
    overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
    schema: "ralphie.homebrew-asset-manifest.v1",
    tag: `v${version}`,
    version,
    assets: RELEASE_TARGETS.map((target) => ({
        target,
        name: `ralphie-${target}`,
        url: `https://github.com/beremaran/ralphie/releases/download/v${version}/ralphie-${target}`,
        sha256: checksumFor(version, target),
    })),
    ...overrides,
});

const createCheckout = async (formulaContent: string): Promise<Checkout> => {
    const root = await mkdtemp(join(tmpdir(), "ralphie-homebrew-guard-"));
    git(root, ["init", "-b", "main"]);
    git(root, ["config", "user.name", "Ralphie Homebrew Guard Tests"]);
    git(root, ["config", "user.email", "ralphie-homebrew-guard@example.com"]);
    await mkdir(join(root, "Formula"), { recursive: true });
    await writeFile(join(root, "Formula", "ralphie.rb"), formulaContent);
    await writeFile(join(root, "README.md"), "ralphie test fixture\n");
    git(root, ["add", "--all"]);
    git(root, ["commit", "-m", "initial checkout"]);
    return { formulaPath: join(root, "Formula", "ralphie.rb"), root };
};

const formulaRegion = (content: string): string => {
    const start = content.indexOf(HOMEBREW_FORMULA_BEGIN_MARKER);
    const end = content.indexOf(HOMEBREW_FORMULA_END_MARKER);
    if (start === -1 || end === -1 || end <= start) {
        throw new Error("fixture formula markers are not an ordered pair");
    }
    return (
        content.slice(0, start) +
        content.slice(end + HOMEBREW_FORMULA_END_MARKER.length)
    );
};

const runGuard = (
    checkout: Checkout,
    manifestPath: string,
    version: string,
): Promise<HomebrewFormulaChangeResult> =>
    prepareHomebrewFormula({
        checkoutPath: checkout.root,
        formulaPath: checkout.formulaPath,
        manifestPath,
        tag: `v${version}`,
        version,
    });

describe("Homebrew formula change guard (scripts/prepare-homebrew-formula.ts)", () => {
    let template: string;
    let checkout: Checkout;
    let scratch: string;

    beforeEach(async () => {
        template = await readFile(formulaTemplatePath, "utf8");
        checkout = await createCheckout(formulaAt(template, "0.1.2"));
        scratch = await mkdtemp(
            join(tmpdir(), "ralphie-homebrew-guard-scratch-"),
        );
    });

    afterEach(async () => {
        await rm(checkout.root, { recursive: true, force: true });
        await rm(scratch, { recursive: true, force: true });
    });

    const writeManifest = async (
        manifest: Record<string, unknown>,
    ): Promise<string> => {
        const path = join(scratch, "homebrew-assets.json");
        await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
        return path;
    };

    const readFormula = (): Promise<string> =>
        readFile(checkout.formulaPath, "utf8");

    const cliScript = join(
        repositoryRoot,
        "scripts",
        "prepare-homebrew-formula.ts",
    );

    test("CLI seam reports an explicit changed/unchanged result", async () => {
        const manifestPath = await writeManifest(manifestFor("1.2.3"));
        const runCli = (
            outputsPath: string | undefined,
        ): Bun.ReadableSyncSubprocess =>
            Bun.spawnSync(
                [
                    process.execPath,
                    cliScript,
                    "--manifest",
                    manifestPath,
                    "--tag",
                    "v1.2.3",
                    "--version",
                    "1.2.3",
                    "--formula",
                    checkout.formulaPath,
                    "--checkout",
                    checkout.root,
                ],
                {
                    env: {
                        ...process.env,
                        GITHUB_OUTPUT: outputsPath ?? "",
                    },
                    stderr: "pipe",
                    stdout: "pipe",
                },
            );

        const changed = runCli(undefined);
        expect(changed.exitCode).toBe(0);
        expect(changed.stdout.toString().trim()).toBe(
            "homebrew_formula_result=changed",
        );

        // A re-run with the desired metadata already present must resolve to
        // unchanged so callers can skip the commit.
        const unchanged = runCli(undefined);
        expect(unchanged.exitCode).toBe(0);
        expect(unchanged.stdout.toString().trim()).toBe(
            "homebrew_formula_result=unchanged",
        );

        const outputsPath = join(scratch, "github-outputs");
        await writeFile(outputsPath, "existing\n");
        const viaOutputs = runCli(outputsPath);
        expect(viaOutputs.exitCode).toBe(0);
        expect(await readFile(outputsPath, "utf8")).toBe(
            "existing\nhomebrew_formula_result=unchanged\n",
        );
    });

    test("applies an exact generated-region update and reports changed", async () => {
        const manifestPath = await writeManifest(manifestFor("1.2.3"));

        const result = await runGuard(checkout, manifestPath, "1.2.3");

        expect(result.result).toBe("changed");
        expect(result.changed).toBe(true);
        expect(result.tag).toBe("v1.2.3");
        expect(result.version).toBe("1.2.3");
        expect(result.formulaPath).toBe(checkout.formulaPath);

        const updated = await readFormula();
        expect(updated).toContain('version "1.2.3"');
        for (const target of RELEASE_TARGETS) {
            expect(updated).toContain(
                `sha256 "${checksumFor("1.2.3", target)}"`,
            );
        }
        // Outside the generated region the update must be byte-for-byte
        // identical to the committed formula.
        expect(formulaRegion(updated)).toBe(
            formulaRegion(formulaAt(template, "0.1.2")),
        );
        // The description, homepage, install implementation, and smoke test
        // are preserved by the region-only update.
        expect(updated).toContain(
            'desc "Turn a GitHub issue queue into reviewed commits with Pi"',
        );
        expect(updated).toContain(
            'homepage "https://github.com/beremaran/ralphie"',
        );
        expect(updated).toContain(
            'bin.install Dir["ralphie-*"].first => "ralphie"',
        );
        expect(updated).toContain('system "#{bin}/ralphie", "--version"');

        const status = git(checkout.root, ["status", "--porcelain"]);
        expect(status.trim()).toBe("M Formula/ralphie.rb");
    });

    test("reports unchanged for an already-current formula and writes nothing", async () => {
        const manifestPath = await writeManifest(manifestFor("0.1.2"));
        const committed = await readFormula();

        // The committed formula already carries the desired metadata; the
        // checkout is clean, so the guard must not touch anything.
        const result = await runGuard(checkout, manifestPath, "0.1.2");

        expect(result.result).toBe("unchanged");
        expect(result.changed).toBe(false);
        expect(await readFormula()).toBe(committed);
        expect(git(checkout.root, ["status", "--porcelain"]).trim()).toBe("");

        // Re-running after a prior apply (worktree edit confined to the
        // generated region) must also resolve to unchanged, letting callers
        // skip a commit when the desired metadata is already present.
        const updatePath = await writeManifest(manifestFor("1.2.3"));
        expect((await runGuard(checkout, updatePath, "1.2.3")).result).toBe(
            "changed",
        );
        expect((await runGuard(checkout, updatePath, "1.2.3")).result).toBe(
            "unchanged",
        );
        expect(git(checkout.root, ["status", "--porcelain"]).trim()).toBe(
            "M Formula/ralphie.rb",
        );
    });

    test("rejects missing, duplicate, and out-of-order generated-region markers", async () => {
        const manifestPath = await writeManifest(manifestFor("1.2.3"));
        const committed = formulaAt(template, "0.1.2");

        const cases = [
            {
                content: committed.replace(HOMEBREW_FORMULA_BEGIN_MARKER, ""),
                message: "must be marked with exactly one",
            },
            {
                content: committed.replace(
                    HOMEBREW_FORMULA_END_MARKER,
                    `${HOMEBREW_FORMULA_END_MARKER}\n${HOMEBREW_FORMULA_END_MARKER}`,
                ),
                message: "must be marked with exactly one",
            },
            {
                content: committed
                    .replace(
                        HOMEBREW_FORMULA_BEGIN_MARKER,
                        "MARKER_PLACEHOLDER",
                    )
                    .replace(
                        HOMEBREW_FORMULA_END_MARKER,
                        HOMEBREW_FORMULA_BEGIN_MARKER,
                    )
                    .replace("MARKER_PLACEHOLDER", HOMEBREW_FORMULA_END_MARKER),
                message: "out of order",
            },
        ];

        for (const { content, message } of cases) {
            await writeFile(checkout.formulaPath, content);
            await expect(
                runGuard(checkout, manifestPath, "1.2.3"),
            ).rejects.toThrow(message);
            expect(await readFormula()).toBe(content);
            expect(git(checkout.root, ["status", "--porcelain"]).trim()).toBe(
                "M Formula/ralphie.rb",
            );
        }
    });

    test("rejects unrelated file changes in the target-branch checkout", async () => {
        const manifestPath = await writeManifest(manifestFor("1.2.3"));
        const committedFormula = await readFormula();
        await writeFile(join(checkout.root, "README.md"), "modified readme\n");
        await writeFile(join(checkout.root, "notes.txt"), "untracked\n");

        await expect(runGuard(checkout, manifestPath, "1.2.3")).rejects.toThrow(
            "is not clean",
        );
        await expect(runGuard(checkout, manifestPath, "1.2.3")).rejects.toThrow(
            "Formula/ralphie.rb",
        );

        // The guard must never rewrite or clean anything in a dirty checkout.
        expect(await readFormula()).toBe(committedFormula);
        expect(git(checkout.root, ["status", "--porcelain"]).trim()).toContain(
            "README.md",
        );
    });

    test("rejects edits outside the generated region in the working tree", async () => {
        const manifestPath = await writeManifest(manifestFor("1.2.3"));
        const committed = formulaAt(template, "0.1.2");
        const tampered = committed.replace(
            'desc "Turn a GitHub issue queue into reviewed commits with Pi"',
            'desc "tampered description outside the generated region"',
        );
        await writeFile(checkout.formulaPath, tampered);

        await expect(runGuard(checkout, manifestPath, "1.2.3")).rejects.toThrow(
            "uncommitted changes outside the generated region",
        );
        expect(await readFormula()).toBe(tampered);
    });

    test("rejects a tag/version mismatch and an unexpected manifest", async () => {
        const committed = await readFormula();

        const tagMismatch = await writeManifest(
            manifestFor("1.2.3", { tag: "v1.2.4" }),
        );
        await expect(runGuard(checkout, tagMismatch, "1.2.3")).rejects.toThrow(
            "manifest tag 'v1.2.4' does not match",
        );

        const versionMismatch = await writeManifest(
            manifestFor("1.2.3", { version: "1.2.4" }),
        );
        await expect(
            runGuard(checkout, versionMismatch, "1.2.3"),
        ).rejects.toThrow("manifest version '1.2.4' does not match");

        const unexpectedSchema = await writeManifest(
            manifestFor("1.2.3", {
                schema: "ralphie.homebrew-asset-manifest.v2",
            }),
        );
        await expect(
            runGuard(checkout, unexpectedSchema, "1.2.3"),
        ).rejects.toThrow("unexpected manifest schema");

        const invalidJson = join(scratch, "malformed.json");
        await writeFile(invalidJson, "{ not json\n");
        await expect(runGuard(checkout, invalidJson, "1.2.3")).rejects.toThrow(
            "is not valid JSON",
        );

        const misnamedAsset = manifestFor("1.2.3");
        (misnamedAsset.assets as Array<Record<string, unknown>>)[0] = {
            ...(misnamedAsset.assets as Array<Record<string, unknown>>)[0],
            name: "ralphie-darwin-ppc",
        };
        const unexpectedAsset = await writeManifest(misnamedAsset);
        await expect(
            runGuard(checkout, unexpectedAsset, "1.2.3"),
        ).rejects.toThrow("unexpected asset 'ralphie-darwin-ppc'");

        await expect(
            prepareHomebrewFormula({
                checkoutPath: checkout.root,
                formulaPath: checkout.formulaPath,
                manifestPath: await writeManifest(manifestFor("1.2.3")),
                tag: "v1.2.4",
                version: "1.2.3",
            }),
        ).rejects.toThrow("does not match the validated version");

        // Rejected updates never touch the checkout.
        expect(await readFormula()).toBe(committed);
        expect(git(checkout.root, ["status", "--porcelain"]).trim()).toBe("");
    });
});