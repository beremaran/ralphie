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
    createHomebrewUpdateApi,
    homebrewUpdateBranchName,
    homebrewUpdatePullRequestBody,
    homebrewUpdatePullRequestTitle,
    HomebrewPullRequestCreateConflictError,
    reconcileHomebrewUpdate,
    type HomebrewPullRequest,
    type HomebrewUpdateApi,
    type HomebrewUpdateOutcome,
} from "../scripts/reconcile-homebrew-update.ts";
import { RELEASE_TARGETS } from "../scripts/verify-homebrew-assets.ts";

/**
 * Deterministic integration tests for the Homebrew tap branch/pull-request
 * reconciliation layer (`scripts/reconcile-homebrew-update.ts`), exercising
 * the production entry point against temporary git repositories (a local
 * `origin` tap and a fresh clone) with an in-memory fake GitHub API and no
 * network, registry, or credentials.
 *
 * Coverage: branch creation, one-PR creation, no-op reruns, reuse/update of
 * one matching PR, multiple matches, unrelated edits, unexpected bases,
 * concurrent/conflicting heads, and main-current no-ops.
 */

const OWNER = "beremaran";
const REPO = "ralphie";
const repositoryRoot = resolve(import.meta.dir, "..");
const formulaTemplatePath = join(repositoryRoot, "Formula", "ralphie.rb");

const git = (dir: string, args: ReadonlyArray<string>): string => {
    const result = Bun.spawnSync(["git", "-C", dir, ...args], {
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

const sneakyChecksum = (): string =>
    createHash("sha256").update("sneaky region content").digest("hex");

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
        url: `https://github.com/${OWNER}/${REPO}/releases/download/v${version}/ralphie-${target}`,
        sha256: checksumFor(version, target),
    })),
    ...overrides,
});

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

type FakePullRequest = {
    readonly number: number;
    readonly title: string;
    readonly url: string;
    readonly headRef: string;
    readonly baseRef: string;
    readonly state: "open" | "closed";
    readonly merged: boolean;
};

/**
 * In-memory fake for the GitHub pull-request surface. Records every read and
 * mutation so tests can prove zero-mutation outcomes, and supports hooks that
 * run during the first list so tests can inject concurrent remote changes
 * between the seam's fetch and its conditional push.
 */
class FakeHomebrewUpdateApi {
    private readonly prs: FakePullRequest[] = [];
    private readonly log: string[] = [];
    private nextNumber = 1;
    private listHooks: Array<() => Promise<void> | void> = [];

    seedPullRequest(headRef: string, baseRef = "main"): FakePullRequest {
        const pr = {
            number: this.nextNumber,
            title: homebrewUpdatePullRequestTitle(headRef),
            url: `https://github.com/${OWNER}/${REPO}/pull/${this.nextNumber}`,
            headRef,
            baseRef,
            state: "open" as const,
            merged: false,
        };
        this.nextNumber += 1;
        this.prs.push(pr);
        return pr;
    }

    removeAllPullRequests(): void {
        this.prs.length = 0;
    }

    onceBeforeList(hook: () => Promise<void> | void): void {
        this.listHooks.push(hook);
    }

    observations(): readonly string[] {
        return [...this.log];
    }

    pullRequestCount(): number {
        return this.prs.length;
    }

    private distinctHead(head: string): string {
        return head.includes(":") ? head.slice(head.indexOf(":") + 1) : head;
    }

    async listPullRequests(input: {
        readonly owner: string;
        readonly repo: string;
        readonly head: string;
        readonly base: string;
        readonly state: "open";
    }): Promise<ReadonlyArray<HomebrewPullRequest>> {
        this.log.push(`read:list head=${input.head} base=${input.base}`);
        const hooks = this.listHooks;
        this.listHooks = [];
        for (const hook of hooks) {
            await hook();
        }
        return this.prs.filter(
            (pr) =>
                pr.headRef === this.distinctHead(input.head) &&
                pr.baseRef === input.base &&
                pr.state === input.state,
        );
    }

    async createPullRequest(input: {
        readonly owner: string;
        readonly repo: string;
        readonly title: string;
        readonly body: string;
        readonly head: string;
        readonly base: string;
    }): Promise<HomebrewPullRequest> {
        this.log.push(
            `mutation:create head=${input.head} title=${input.title}`,
        );
        const existing = this.prs.find(
            (pr) => pr.headRef === input.head && pr.baseRef === input.base,
        );
        if (existing !== undefined) {
            throw new HomebrewPullRequestCreateConflictError({
                message: `A pull request already exists for ${input.head}`,
            });
        }
        const pr = {
            number: this.nextNumber,
            title: input.title,
            url: `https://github.com/${OWNER}/${REPO}/pull/${this.nextNumber}`,
            headRef: input.head,
            baseRef: input.base,
            state: "open" as const,
            merged: false,
        };
        this.nextNumber += 1;
        this.prs.push(pr);
        return pr;
    }
}

describe("Homebrew update reconciliation (scripts/reconcile-homebrew-update.ts)", () => {
    let template: string;
    let origin: string;
    let checkout: string;
    const cleanup: string[] = [];

    beforeEach(async () => {
        template = await readFile(formulaTemplatePath, "utf8");
        origin = await mkdtemp(join(tmpdir(), "ralphie-reconcile-origin-"));
        cleanup.push(origin);
        git(origin, ["init", "-b", "main"]);
        git(origin, ["config", "user.name", "Ralphie Reconcile Fixture"]);
        git(origin, ["config", "user.email", "reconcile-fixture@example.com"]);
        await mkdir(join(origin, "Formula"), { recursive: true });
        await writeFile(
            join(origin, "Formula", "ralphie.rb"),
            formulaAt(template, "0.1.2"),
        );
        await writeFile(join(origin, "README.md"), "tap fixture\n");
        git(origin, ["add", "--all"]);
        git(origin, ["commit", "-qm", "initial tap content"]);
        checkout = await cloneOf(origin, "ralphie-reconcile-checkout-");
    });

    afterEach(async () => {
        for (const dir of cleanup) {
            await rm(dir, { recursive: true, force: true });
        }
        cleanup.length = 0;
    });

    const cloneOf = async (source: string, prefix: string): Promise<string> => {
        const target = await mkdtemp(join(tmpdir(), prefix));
        const gitTarget = await mkdtemp(
            join(tmpdir(), "ralphie-reconcile-git-"),
        );
        cleanup.push(target);
        cleanup.push(gitTarget);
        git(gitTarget, ["clone", "-q", source, target]);
        return target;
    };

    const runReconcile = (
        api: HomebrewUpdateApi,
        version: string,
        overrides: Record<string, unknown> = {},
    ): Promise<HomebrewUpdateOutcome> =>
        reconcileHomebrewUpdate(api, {
            owner: OWNER,
            repo: REPO,
            version,
            tag: `v${version}`,
            manifest: manifestFor(version),
            checkoutDir: checkout,
            ...overrides,
        });

    const mainSha = (): string => git(origin, ["rev-parse", "HEAD"]).trim();

    const branchSha = (branch: string): string | undefined => {
        const output = git(origin, [
            "for-each-ref",
            `refs/heads/${branch}`,
        ]).trim();
        return output === "" ? undefined : output.split(" ")[0];
    };

    const commitCount = (branch: string): number =>
        Number(
            git(origin, [
                "rev-list",
                "--count",
                `refs/heads/main..refs/heads/${branch}`,
            ]).trim(),
        );

    /**
     * Seed a remote branch with one commit produced by an independent clone
     * (like a prior/rogue automation run), returning its head sha.
     */
    const seedBranchCommit = async (
        branch: string,
        mutate: (dir: string) => Promise<void> | void,
        message: string,
    ): Promise<string> => {
        const seeder = await mkdtemp(join(tmpdir(), "ralphie-reconcile-seed-"));
        cleanup.push(seeder);
        const parent = await mkdtemp(
            join(tmpdir(), "ralphie-reconcile-seedgit-"),
        );
        cleanup.push(parent);
        git(parent, ["clone", "-q", origin, seeder]);
        // Build on the existing remote branch head when present, otherwise on
        // fresh main, so repeated seeding stacks like real branch history.
        const hasBranch =
            git(seeder, [
                "ls-remote",
                "origin",
                `refs/heads/${branch}`,
            ]).trim() !== "";
        git(seeder, [
            "checkout",
            "-q",
            "-B",
            branch,
            hasBranch ? `refs/remotes/origin/${branch}` : "origin/main",
        ]);
        git(seeder, ["config", "user.name", "Ralphie Reconcile Seeder"]);
        git(seeder, ["config", "user.email", "reconcile-seeder@example.com"]);
        await mutate(seeder);
        git(seeder, ["add", "--all"]);
        git(seeder, ["commit", "-qm", message]);
        git(seeder, ["push", "-q", "origin", `HEAD:refs/heads/${branch}`]);
        return git(seeder, ["rev-parse", "HEAD"]).trim();
    };

    const writeFormula = (dir: string, content: string): Promise<void> =>
        writeFile(join(dir, "Formula", "ralphie.rb"), content, "utf8");

    test("creates exactly one branch and one pull request from a clean tap", async () => {
        const baseSha = mainSha();
        const api = new FakeHomebrewUpdateApi();

        const outcome = await runReconcile(api, "1.2.3");

        expect(outcome.kind).toBe("reconciled");
        if (outcome.kind !== "reconciled") return;
        expect(outcome.branch).toBe("automation/homebrew-v1.2.3");
        expect(outcome.baseSha).toBe(baseSha);
        expect(outcome.branchCreated).toBe(true);
        expect(outcome.branchUpdated).toBe(false);
        expect(outcome.pullRequestCreated).toBe(true);
        expect(outcome.pullRequestNumber).toBe(1);
        expect(outcome.commitSha).toMatch(/^[0-9a-f]{40}$/);

        // The remote branch exists and points at the reconciled commit, whose
        // parent is the fresh main head.
        const remote = git(checkout, [
            "ls-remote",
            "origin",
            "refs/heads/automation/homebrew-v1.2.3",
        ]).trim();
        expect(remote).toBe(
            `${outcome.commitSha}\trefs/heads/automation/homebrew-v1.2.3`,
        );
        expect(
            git(checkout, ["rev-parse", `${outcome.commitSha}^`]).trim(),
        ).toBe(baseSha);
        expect(commitCount(outcome.branch)).toBe(1);
        expect(mainSha()).toBe(baseSha);

        // The branch diff vs main is exactly the guarded formula region.
        const diff = git(checkout, [
            "diff",
            "--name-only",
            baseSha,
            outcome.commitSha,
        ]).trim();
        expect(diff).toBe("Formula/ralphie.rb");
        const branchFormula = git(checkout, [
            "show",
            `${outcome.commitSha}:Formula/ralphie.rb`,
        ]);
        for (const target of RELEASE_TARGETS) {
            expect(branchFormula).toContain(
                `sha256 "${checksumFor("1.2.3", target)}"`,
            );
        }
        expect(formulaRegion(branchFormula)).toBe(
            formulaRegion(formulaAt(template, "0.1.2")),
        );

        // Exactly one PR with the deterministic title and body.
        expect(api.pullRequestCount()).toBe(1);
        expect(
            api.observations().filter((line) => line.startsWith("mutation:")),
        ).toEqual([
            `mutation:create head=automation/homebrew-v1.2.3 title=${homebrewUpdatePullRequestTitle("1.2.3")}`,
        ]);
        const pr = (
            await api.listPullRequests({
                owner: OWNER,
                repo: REPO,
                head: `${OWNER}:automation/homebrew-v1.2.3`,
                base: "main",
                state: "open",
            })
        )[0] as HomebrewPullRequest;
        expect(pr.title).toBe("Update Homebrew formula for v1.2.3");
        const body = homebrewUpdatePullRequestBody("1.2.3", {
            schema: "ralphie.homebrew-asset-manifest.v1",
            tag: "v1.2.3",
            version: "1.2.3",
            assets: RELEASE_TARGETS.map((target) => ({
                target,
                name: `ralphie-${target}`,
                url: `https://github.com/${OWNER}/${REPO}/releases/download/v1.2.3/ralphie-${target}`,
                sha256: checksumFor("1.2.3", target),
            })),
        });
        expect(pr.title).toBe(homebrewUpdatePullRequestTitle("1.2.3"));
        expect(body).toContain("v1.2.3");
        expect(body).toContain("1.2.3");
        for (const target of RELEASE_TARGETS) {
            expect(body).toContain(checksumFor("1.2.3", target));
        }
        expect(body).not.toContain("latest");
        expect(body).not.toMatch(/20\d\d-\d\d-\d\d/);
    });

    test("reuses an existing branch and creates exactly one pull request when only the PR is missing", async () => {
        const api = new FakeHomebrewUpdateApi();
        const first = await runReconcile(api, "1.2.3");
        if (first.kind !== "reconciled") throw new Error("first run failed");
        const existingSha = branchSha(first.branch) as string;

        // The branch survived but the PR record is gone (interrupted run).
        api.removeAllPullRequests();
        const outcome = await runReconcile(api, "1.2.3");

        expect(outcome.kind).toBe("reconciled");
        if (outcome.kind !== "reconciled") return;
        expect(outcome.branchCreated).toBe(false);
        expect(outcome.branchUpdated).toBe(false);
        expect(outcome.pullRequestCreated).toBe(true);
        // The fake reuses its sequential numbering; only the count matters.
        expect(api.pullRequestCount()).toBe(1);
        expect(outcome.commitSha).toBe(existingSha);
        expect(branchSha(outcome.branch)).toBe(existingSha);
        expect(commitCount(outcome.branch)).toBe(1);
        expect(api.pullRequestCount()).toBe(1);
    });

    test("no-op rerun reuses the branch and pull request with zero mutations", async () => {
        const api = new FakeHomebrewUpdateApi();
        const first = await runReconcile(api, "1.2.3");
        if (first.kind !== "reconciled") throw new Error("first run failed");
        const observationsAfterFirst = api
            .observations()
            .filter((line) => line.startsWith("mutation:"));

        const outcome = await runReconcile(api, "1.2.3");

        expect(outcome.kind).toBe("reconciled");
        if (outcome.kind !== "reconciled") return;
        expect(outcome.branchCreated).toBe(false);
        expect(outcome.branchUpdated).toBe(false);
        expect(outcome.pullRequestCreated).toBe(false);
        expect(outcome.commitSha).toBe(first.commitSha);
        expect(branchSha(outcome.branch)).toBe(first.commitSha);
        expect(commitCount(outcome.branch)).toBe(1);
        expect(api.pullRequestCount()).toBe(1);
        expect(
            api.observations().filter((line) => line.startsWith("mutation:")),
        ).toEqual(observationsAfterFirst);
    });

    test("reuses one matching PR and fast-forwards the branch when the guarded content differs", async () => {
        const branch = homebrewUpdateBranchName("1.2.3");
        // A prior run left a region-valid but different formula on the branch.
        const seeded = await seedBranchCommit(
            branch,
            async (dir) => {
                const tampered = formulaAt(template, "1.2.3").replace(
                    checksumFor("1.2.3", "linux-x64"),
                    sneakyChecksum(),
                );
                await writeFormula(dir, tampered);
            },
            "previous guarded update",
        );
        const api = new FakeHomebrewUpdateApi();
        api.seedPullRequest(branch);

        const outcome = await runReconcile(api, "1.2.3");

        expect(outcome.kind).toBe("reconciled");
        if (outcome.kind !== "reconciled") return;
        expect(outcome.branchUpdated).toBe(true);
        expect(outcome.branchCreated).toBe(false);
        expect(outcome.pullRequestCreated).toBe(false);
        expect(outcome.commitSha).not.toBe(seeded);
        expect(branchSha(branch)).toBe(outcome.commitSha);
        expect(commitCount(branch)).toBe(2);
        const formula = git(origin, [
            "show",
            `${outcome.commitSha}:Formula/ralphie.rb`,
        ]);
        for (const target of RELEASE_TARGETS) {
            expect(formula).toContain(
                `sha256 "${checksumFor("1.2.3", target)}"`,
            );
        }
        expect(api.pullRequestCount()).toBe(1);
        expect(
            api.observations().filter((line) => line.startsWith("mutation:")),
        ).toEqual([]);
    });

    test("fails on multiple matching pull requests without touching anything", async () => {
        const branch = homebrewUpdateBranchName("1.2.3");
        const api = new FakeHomebrewUpdateApi();
        const first = await runReconcile(api, "1.2.3");
        if (first.kind !== "reconciled") throw new Error("first run failed");
        const api2 = new FakeHomebrewUpdateApi();
        api2.seedPullRequest(branch);
        api2.seedPullRequest(branch);
        const before = branchSha(first.branch) as string;

        await expect(runReconcile(api2, "1.2.3")).rejects.toThrow(
            "found 2 open pull requests matching",
        );
        expect(branchSha(first.branch)).toBe(before);
        expect(api2.pullRequestCount()).toBe(2);
        expect(
            api2.observations().filter((line) => line.startsWith("mutation:")),
        ).toEqual([]);
    });

    test("fails on an existing branch with an unrelated file", async () => {
        const branch = homebrewUpdateBranchName("1.2.3");
        const api1 = new FakeHomebrewUpdateApi();
        const first = await runReconcile(api1, "1.2.3");
        if (first.kind !== "reconciled") throw new Error("first run failed");

        // Another file appears on the branch (rogue commit).
        await seedBranchCommit(
            branch,
            async (dir) => {
                await writeFile(join(dir, "notes.txt"), "unrelated\n");
            },
            "unrelated notes",
        );
        const before = branchSha(first.branch) as string;

        const api2 = new FakeHomebrewUpdateApi();
        api2.seedPullRequest(branch);
        await expect(runReconcile(api2, "1.2.3")).rejects.toThrow(
            "besides Formula/ralphie.rb",
        );
        expect(branchSha(branch)).toBe(before);
        expect(
            api2.observations().filter((line) => line.startsWith("mutation:")),
        ).toEqual([]);
    });

    test("fails on an existing branch with an outside-region formula edit", async () => {
        const branch = homebrewUpdateBranchName("1.2.3");
        const api1 = new FakeHomebrewUpdateApi();
        const first = await runReconcile(api1, "1.2.3");
        if (first.kind !== "reconciled") throw new Error("first run failed");

        // An outside-region formula edit lands on the branch.
        await seedBranchCommit(
            branch,
            async (dir) => {
                const current = await readFile(
                    join(dir, "Formula", "ralphie.rb"),
                    "utf8",
                );
                await writeFormula(
                    dir,
                    current.replace(
                        'desc "Turn a GitHub issue queue into reviewed commits with Pi"',
                        'desc "tampered description"',
                    ),
                );
            },
            "tampered description",
        );
        const before = branchSha(first.branch) as string;

        const api2 = new FakeHomebrewUpdateApi();
        api2.seedPullRequest(branch);
        await expect(runReconcile(api2, "1.2.3")).rejects.toThrow(
            "outside the generated marker region",
        );
        expect(branchSha(branch)).toBe(before);
        expect(
            api2.observations().filter((line) => line.startsWith("mutation:")),
        ).toEqual([]);
    });
    test("fails when the remote branch head moves concurrently before the conditional push", async () => {
        const branch = homebrewUpdateBranchName("1.2.3");
        const seeded = await seedBranchCommit(
            branch,
            async (dir) => {
                const tampered = formulaAt(template, "1.2.3").replace(
                    checksumFor("1.2.3", "linux-x64"),
                    sneakyChecksum(),
                );
                await writeFormula(dir, tampered);
            },
            "previous guarded update",
        );
        // A concurrent force-push lands between the fresh fetch and the
        // conditional push, replacing the branch head with an unrelated commit.
        const racer = await mkdtemp(join(tmpdir(), "ralphie-reconcile-racer-"));
        cleanup.push(racer);
        const racerParent = await mkdtemp(
            join(tmpdir(), "ralphie-reconcile-racergit-"),
        );
        cleanup.push(racerParent);
        git(racerParent, ["clone", "-q", origin, racer]);
        git(racer, ["checkout", "-q", "-B", branch, "origin/main"]);
        git(racer, ["config", "user.name", "Ralphie Reconcile Racer"]);
        git(racer, ["config", "user.email", "reconcile-racer@example.com"]);
        await writeFile(join(racer, "sneaky.txt"), "concurrent\n");
        git(racer, ["add", "--all"]);
        git(racer, ["commit", "-qm", "concurrent replacement"]);

        const api = new FakeHomebrewUpdateApi();
        api.seedPullRequest(branch);
        api.onceBeforeList(async () => {
            git(racer, [
                "push",
                "-q",
                "--force",
                "origin",
                `HEAD:refs/heads/${branch}`,
            ]);
        });

        await expect(runReconcile(api, "1.2.3")).rejects.toThrow(
            "moved concurrently",
        );
        // The conflicting head is untouched, and no PR was created.
        const raceSha = git(racer, ["rev-parse", "HEAD"]).trim();
        expect(branchSha(branch)).toBe(raceSha);
        expect(branchSha(branch)).not.toBe(seeded);
        expect(api.pullRequestCount()).toBe(1);
        expect(
            api.observations().filter((line) => line.startsWith("mutation:")),
        ).toEqual([]);
    });

    test("fails when a branch appears concurrently during creation, without overwriting it", async () => {
        const branch = homebrewUpdateBranchName("1.2.3");
        const racer = await mkdtemp(
            join(tmpdir(), "ralphie-reconcile-racer2-"),
        );
        cleanup.push(racer);
        const racerParent = await mkdtemp(
            join(tmpdir(), "ralphie-reconcile-racergit2-"),
        );
        cleanup.push(racerParent);
        git(racerParent, ["clone", "-q", origin, racer]);
        git(racer, ["checkout", "-q", "-B", branch, "origin/main"]);
        git(racer, ["config", "user.name", "Ralphie Reconcile Racer"]);
        git(racer, ["config", "user.email", "reconcile-racer@example.com"]);
        await writeFile(join(racer, "sneaky.txt"), "concurrent\n");
        git(racer, ["add", "--all"]);
        git(racer, ["commit", "-qm", "concurrent branch"]);

        const api = new FakeHomebrewUpdateApi();
        api.onceBeforeList(async () => {
            git(racer, ["push", "-q", "origin", `HEAD:refs/heads/${branch}`]);
        });

        await expect(runReconcile(api, "1.2.3")).rejects.toThrow(
            "appeared concurrently",
        );
        const concurrentSha = git(racer, ["rev-parse", "HEAD"]).trim();
        expect(branchSha(branch)).toBe(concurrentSha);
        expect(api.pullRequestCount()).toBe(0);
        expect(
            api.observations().filter((line) => line.startsWith("mutation:")),
        ).toEqual([]);
    });

    test("fails when the branch is based on an older main (unexpected base)", async () => {
        const branch = homebrewUpdateBranchName("1.2.3");
        const api1 = new FakeHomebrewUpdateApi();
        const first = await runReconcile(api1, "1.2.3");
        if (first.kind !== "reconciled") throw new Error("first run failed");
        const before = branchSha(first.branch) as string;

        // main advances after the branch was created.
        await writeFile(join(origin, "README.md"), "tap fixture v2\n");
        git(origin, ["add", "--all"]);
        git(origin, ["commit", "-qm", "advance main"]);

        const api2 = new FakeHomebrewUpdateApi();
        api2.seedPullRequest(branch);
        await expect(runReconcile(api2, "1.2.3")).rejects.toThrow(
            "not based on the current origin/main",
        );
        expect(branchSha(branch)).toBe(before);
        expect(
            api2.observations().filter((line) => line.startsWith("mutation:")),
        ).toEqual([]);
    });

    test("main-current: main already has the desired verified metadata so no branch or PR is created", async () => {
        const api = new FakeHomebrewUpdateApi();

        const outcome = await runReconcile(api, "0.1.2");

        expect(outcome.kind).toBe("main-current");
        expect(outcome.baseSha).toBe(mainSha());
        expect(branchSha(homebrewUpdateBranchName("0.1.2"))).toBeUndefined();
        expect(api.observations()).toEqual([]);
        expect(api.pullRequestCount()).toBe(0);
    });

    test("main-current: an existing branch and PR are left untouched when main already has the metadata", async () => {
        const branch = homebrewUpdateBranchName("0.1.2");
        const api = new FakeHomebrewUpdateApi();
        api.seedPullRequest(branch);
        // An existing branch for this tag carries unrelated history; main
        // already has the metadata so it must be left untouched.
        const seeded = await seedBranchCommit(
            branch,
            async (dir) => {
                await writeFile(join(dir, "README.md"), "readme v2\n");
            },
            "no-op branch",
        );

        const outcome = await runReconcile(api, "0.1.2");

        expect(outcome.kind).toBe("main-current");
        expect(branchSha(branch)).toBe(seeded);
        expect(api.pullRequestCount()).toBe(1);
        expect(
            api.observations().filter((line) => line.startsWith("mutation:")),
        ).toEqual([]);
    });

    test("fails on a matching PR without a remote branch", async () => {
        const branch = homebrewUpdateBranchName("1.2.3");
        const api = new FakeHomebrewUpdateApi();
        api.seedPullRequest(branch);

        await expect(runReconcile(api, "1.2.3")).rejects.toThrow(
            "remote branch is absent",
        );
        expect(branchSha(branch)).toBeUndefined();
        expect(
            api.observations().filter((line) => line.startsWith("mutation:")),
        ).toEqual([]);
    });

    test("rejects preflight failures without any git or API mutation", async () => {
        const api = new FakeHomebrewUpdateApi();

        await expect(
            runReconcile(api, "1.2.3", { tag: "v1.2.4" }),
        ).rejects.toThrow("does not match the validated version");

        await expect(
            runReconcile(api, "1.2.3", {
                manifest: manifestFor("1.2.3", {
                    schema: "ralphie.homebrew-asset-manifest.v2",
                }),
            }),
        ).rejects.toThrow("unexpected manifest schema");

        const missingAsset = manifestFor("1.2.3");
        (missingAsset.assets as Array<Record<string, unknown>>).pop();
        await expect(
            runReconcile(api, "1.2.3", { manifest: missingAsset }),
        ).rejects.toThrow("must contain exactly 4 assets");

        const empty = await mkdtemp(join(tmpdir(), "ralphie-reconcile-empty-"));
        cleanup.push(empty);
        await expect(
            runReconcile(api, "1.2.3", { checkoutDir: empty }),
        ).rejects.toThrow("not a git clone");

        const noOrigin = await mkdtemp(
            join(tmpdir(), "ralphie-reconcile-noorigin-"),
        );
        cleanup.push(noOrigin);
        git(noOrigin, ["init", "-q", "-b", "main"]);
        await expect(
            runReconcile(api, "1.2.3", { checkoutDir: noOrigin }),
        ).rejects.toThrow("not a git clone");

        expect(api.observations()).toEqual([]);
        expect(branchSha(homebrewUpdateBranchName("1.2.3"))).toBeUndefined();
    });

    test("rejects a target-branch formula without a valid generated-region marker pair", async () => {
        const template = await readFile(formulaTemplatePath, "utf8");
        const unmarked = template.replace(
            HOMEBREW_FORMULA_BEGIN_MARKER,
            "no begin marker",
        );
        const second = await mkdtemp(
            join(tmpdir(), "ralphie-reconcile-unmarked-"),
        );
        cleanup.push(second);
        git(second, ["init", "-q", "-b", "main"]);
        git(second, ["config", "user.name", "Ralphie Reconcile Fixture"]);
        git(second, ["config", "user.email", "reconcile-fixture@example.com"]);
        await mkdir(join(second, "Formula"), { recursive: true });
        await writeFile(
            join(second, "Formula", "ralphie.rb"),
            unmarked,
            "utf8",
        );
        git(second, ["add", "--all"]);
        git(second, ["commit", "-qm", "unmarked formula"]);

        const checkout2 = await cloneOf(second, "ralphie-reconcile-checkout2-");
        const api = new FakeHomebrewUpdateApi();
        await expect(
            reconcileHomebrewUpdate(api, {
                owner: OWNER,
                repo: REPO,
                version: "1.2.3",
                tag: "v1.2.3",
                manifest: manifestFor("1.2.3"),
                checkoutDir: checkout2,
            }),
        ).rejects.toThrow("cannot render a guarded candidate");
        expect(api.observations()).toEqual([]);
    });

    test("REST adapter lists and creates pull requests through the GitHub API shape", async () => {
        const calls: Array<{ url: string; init?: RequestInit }> = [];
        const responses = [
            {
                status: 200,
                body: [
                    {
                        number: 42,
                        title: "Update Homebrew formula for v1.2.3",
                        html_url:
                            "https://github.com/beremaran/ralphie/pull/42",
                        state: "open",
                        head: { ref: "automation/homebrew-v1.2.3" },
                        base: { ref: "main" },
                        merged: false,
                    },
                ],
            },
            {
                status: 422,
                body: { message: "A pull request already exists" },
            },
            {
                status: 500,
                body: {},
            },
            {
                status: 200,
                body: {
                    number: 43,
                    title: "Update Homebrew formula for v1.2.3",
                    html_url: "https://github.com/beremaran/ralphie/pull/43",
                    state: "open",
                    head: { ref: "automation/homebrew-v1.2.3" },
                    base: { ref: "main" },
                    merged: false,
                },
            },
        ];
        const fetchImpl = async (
            input: string | URL | Request,
            init?: RequestInit,
        ): Promise<Response> => {
            const next = responses.shift();
            const { url: inputUrl } =
                input instanceof Request ? input : { url: String(input) };
            calls.push({ url: inputUrl, init });
            const body = next === undefined ? {} : next.body;
            const status = next?.status ?? 200;
            return new Response(JSON.stringify(body), {
                status,
                headers: { "content-type": "application/json" },
            });
        };
        const api = createHomebrewUpdateApi({
            apiBaseUrl: "https://api.example.test",
            fetchImpl,
            token: "token-123",
        });

        const listed = await api.listPullRequests({
            owner: OWNER,
            repo: REPO,
            head: `${OWNER}:automation/homebrew-v1.2.3`,
            base: "main",
            state: "open",
        });
        expect(listed).toHaveLength(1);
        expect(listed[0]).toMatchObject({
            number: 42,
            headRef: "automation/homebrew-v1.2.3",
            baseRef: "main",
            state: "open",
        });
        expect(calls[0]?.url).toBe(
            "https://api.example.test/repos/beremaran/ralphie/pulls?state=open&head=beremaran%3Aautomation%2Fhomebrew-v1.2.3&base=main&per_page=100",
        );
        expect(calls[0]?.init?.headers).toBeDefined();

        // A 422 create conflict surfaces as the dedicated error.
        await expect(
            api.createPullRequest({
                owner: OWNER,
                repo: REPO,
                title: "t",
                body: "b",
                head: "automation/homebrew-v1.2.3",
                base: "main",
            }),
        ).rejects.toBeInstanceOf(HomebrewPullRequestCreateConflictError);
        const createCall = calls[1]?.init as RequestInit & { body: string };
        expect(JSON.parse(createCall.body)).toEqual({
            title: "t",
            body: "b",
            head: "automation/homebrew-v1.2.3",
            base: "main",
        });

        // Non-2xx lookup responses fail closed.
        await expect(
            api.listPullRequests({
                owner: OWNER,
                repo: REPO,
                head: `${OWNER}:automation/homebrew-v1.2.3`,
                base: "main",
                state: "open",
            }),
        ).rejects.toThrow("HTTP 500");

        const created = await api.createPullRequest({
            owner: OWNER,
            repo: REPO,
            title: "t2",
            body: "b2",
            head: "automation/homebrew-v1.2.3",
            base: "main",
        });
        expect(created.number).toBe(43);
    });
});