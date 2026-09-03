#!/usr/bin/env bun

/**
 * Deterministic Homebrew tap branch/pull-request reconciliation (executable
 * seam).
 *
 * This is the Git/GitHub mutation layer around the guarded formula candidate
 * produced by `scripts/prepare-homebrew-formula.ts`. It consumes the verified
 * exact-tag asset manifest (`ralphie.homebrew-asset-manifest.v1`) plus the
 * validated release tag/version and a fresh clone of the tap repository, and
 * reconciles exactly one `automation/homebrew-v<version>` branch and one
 * `Update Homebrew formula for v<version>` pull request on the fixed `main`
 * base branch.
 *
 * Contract highlights (rel21-homebrew-branch-pr-reconciliation):
 * - The seam starts from a fresh `git fetch origin` and derives the guarded
 *   candidate from the fetched `main` formula through the exact generator; a
 *   `main` that already contains the desired verified metadata resolves to
 *   `main-current` with zero mutations.
 * - Every branch is built with plain plumbing (`hash-object`, `mktree`,
 *   `commit-tree`) so the working tree is never touched, reset, cleaned, or
 *   force-checked-out, and only `Formula/ralphie.rb` changes inside the
 *   generated marker region are ever allowed.
 * - Branch and pull-request reuse is exact: an existing branch is validated
 *   against fresh `main` (only `Formula/ralphie.rb`, only inside the marker
 *   region, based on the current `main`) and updated only through an
 *   ordinary non-force fast-forward push; a retry can therefore never replace
 *   a newer branch head. Zero matching pull requests permits creation only
 *   when the formula actually changes, one matching pull request is reused,
 *   and multiple matching pull requests fail instead of creating a duplicate.
 * - The pull-request title and body are deterministic: the body records the
 *   exact tag/version and the verified manifest checksums with no timestamps
 *   and no mutable `latest` reference.
 *
 * The injected `HomebrewUpdateApi` keeps every GitHub mutation in this
 * deterministic layer rather than in formula-generation code.
 */

import { appendFile, readFile } from "node:fs/promises";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { RalphieError } from "../src/shared/error.ts";
import {
    HOMEBREW_FORMULA_BEGIN_MARKER,
    HOMEBREW_FORMULA_END_MARKER,
    renderHomebrewFormula,
} from "./generate-homebrew-formula.ts";
import {
    RELEASE_TARGETS,
    type HomebrewAssetManifest,
    type HomebrewAssetManifestEntry,
    type HomebrewAssetTarget,
} from "./verify-homebrew-assets.ts";

export const HOMEBREW_ASSET_MANIFEST_SCHEMA =
    "ralphie.homebrew-asset-manifest.v1";
export const HOMEBREW_UPDATE_BASE_BRANCH = "main";

const errorPrefix = "Homebrew update reconciliation:";
const releaseTagPattern =
    /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const slugPattern = /^[A-Za-z0-9_.-]+$/;
const gitHubUrlPrefix = "https://github.com/";

const commitIdentity = Object.freeze({
    GIT_AUTHOR_NAME: "Ralphie Release Automation",
    GIT_AUTHOR_EMAIL: "ralphie@users.noreply.github.com",
    GIT_COMMITTER_NAME: "Ralphie Release Automation",
    GIT_COMMITTER_EMAIL: "ralphie@users.noreply.github.com",
});

/** The deterministic branch carrying the guarded formula update. */
export const homebrewUpdateBranchName = (version: string): string =>
    `automation/homebrew-v${version}`;

/** The deterministic pull-request title for a release version. */
export const homebrewUpdatePullRequestTitle = (version: string): string =>
    `Update Homebrew formula for v${version}`;

/** The deterministic commit message for the guarded formula update. */
export const homebrewUpdateCommitMessage = (version: string): string =>
    `Update Homebrew formula for v${version}`;

/** A GitHub pull request as consumed by the reconciliation layer. */
export type HomebrewPullRequest = {
    readonly number: number;
    readonly title: string;
    readonly url: string;
    readonly headRef: string;
    readonly baseRef: string;
    readonly state: "open" | "closed";
    readonly merged: boolean;
};

/**
 * The narrow injected GitHub surface the reconciler needs: exact open-pull-
 * request listing by head/base and deterministic pull-request creation. A
 * production implementation is `createHomebrewUpdateApi` (GitHub REST via
 * fetch); deterministic tests inject the in-memory fake.
 */
export type HomebrewUpdateApi = {
    listPullRequests(input: {
        readonly owner: string;
        readonly repo: string;
        readonly head: string;
        readonly base: string;
        readonly state: "open";
    }): Promise<ReadonlyArray<HomebrewPullRequest>>;
    createPullRequest(input: {
        readonly owner: string;
        readonly repo: string;
        readonly title: string;
        readonly body: string;
        readonly head: string;
        readonly base: string;
    }): Promise<HomebrewPullRequest>;
};

/** A GitHub-API create was rejected because a matching pull request exists. */
export class HomebrewPullRequestCreateConflictError extends RalphieError {}

/** The tag/version/manifest/checkout context is not reconciliable. */
export class HomebrewUpdatePreflightError extends RalphieError {}

/** Branch or pull-request state contradicts the exact-match contract. */
export class HomebrewUpdateStateError extends RalphieError {}

/** A concurrent head change or rejected conditional update. */
export class HomebrewUpdateConflictError extends RalphieError {}

export type HomebrewUpdateReconcileInput = {
    readonly owner: string;
    readonly repo: string;
    /** Release version, strict `<major>.<minor>.<patch>` without the v. */
    readonly version: string;
    /** Validated release tag; must be `v${version}`. */
    readonly tag: string;
    /** Verified `ralphie.homebrew-asset-manifest.v1` object. */
    readonly manifest: unknown;
    /** Fresh clone of the tap repository with an `origin` remote. */
    readonly checkoutDir: string;
};

export type HomebrewUpdateOutcome =
    | {
          readonly kind: "main-current";
          readonly baseSha: string;
      }
    | {
          readonly kind: "reconciled";
          readonly baseSha: string;
          readonly branch: string;
          readonly commitSha: string;
          readonly branchCreated: boolean;
          readonly branchUpdated: boolean;
          readonly pullRequestNumber: number;
          readonly pullRequestUrl: string;
          readonly pullRequestCreated: boolean;
      };

/** A deterministic PR body recording the exact tag/version and manifest. */
export const homebrewUpdatePullRequestBody = (
    version: string,
    manifest: HomebrewAssetManifest,
): string => {
    const assets = [...manifest.assets].sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    const rows = assets
        .map(
            (asset) =>
                `| ${asset.target} | \`${asset.name}\` | \`${asset.sha256}\` |`,
        )
        .join("\n");
    return [
        `## Homebrew formula update for v${version}`,
        "",
        `Updates \`Formula/ralphie.rb\` to the verified release \`v${version}\` (version \`${version}\`).`,
        "",
        "Generated from the verified exact-tag asset manifest `ralphie.homebrew-asset-manifest.v1`;",
        "every download URL is pinned to the exact `v${version}` tag, and no timestamps are recorded.",
        "",
        "Verified release assets:",
        "",
        "| Target | Asset | SHA-256 |",
        "| --- | --- | --- |",
        rows,
        "",
    ].join("\n");
};

type JsonRecord = Record<string, unknown>;

type GitRunOptions = {
    readonly env?: Readonly<Record<string, string>>;
    readonly stdin?: string;
};

type GitRunResult = {
    readonly exitCode: number;
    readonly stderr: string;
    readonly stdout: string;
};

const fail = (message: string): never => {
    throw new Error(`${errorPrefix} ${message}`);
};

const failPreflight = (message: string): never => {
    throw new HomebrewUpdatePreflightError({
        message: `${errorPrefix} ${message}`,
    });
};

const failState = (message: string): never => {
    throw new HomebrewUpdateStateError({
        message: `${errorPrefix} ${message}`,
    });
};

const failConflict = (message: string, cause?: unknown): never => {
    throw new HomebrewUpdateConflictError({
        message: `${errorPrefix} ${message}`,
        cause,
    });
};

const isRecord = (value: unknown): value is JsonRecord =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const stringFrom = (record: JsonRecord, key: string, label: string): string => {
    const value = record[key];
    if (typeof value !== "string" || value.length === 0) {
        return fail(`${label} must contain a non-empty '${key}'.`);
    }
    return value;
};

const expectedAssetName = (target: HomebrewAssetTarget): string =>
    `ralphie-${target}`;

const runGit = (
    checkoutDir: string,
    args: ReadonlyArray<string>,
    options: GitRunOptions = {},
): GitRunResult => {
    const result = Bun.spawnSync(["git", "-C", checkoutDir, ...args], {
        env: { ...process.env, ...(options.env ?? {}) },
        stderr: "pipe",
        stdin:
            options.stdin === undefined
                ? undefined
                : new TextEncoder().encode(options.stdin),
        stdout: "pipe",
    });
    return {
        exitCode: result.exitCode,
        stderr: result.stderr.toString(),
        stdout: result.stdout.toString(),
    };
};

const gitMust = (
    checkoutDir: string,
    args: ReadonlyArray<string>,
    failureMessage: string,
    options: GitRunOptions = {},
): string => {
    const result = runGit(checkoutDir, args, options);
    if (result.exitCode !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim();
        return fail(`${failureMessage}${detail ? `: ${detail}` : ""}`);
    }
    return result.stdout;
};

const ensureGitClone = (checkoutDir: string): void => {
    const result = runGit(checkoutDir, ["remote", "get-url", "origin"]);
    if (result.exitCode !== 0 || result.stdout.trim() === "") {
        return failPreflight(
            `checkout '${checkoutDir}' is not a git clone with an 'origin' remote.`,
        );
    }
};

/**
 * Non-forced fetch of every remote branch; a rewound or rewritten remote
 * fails closed instead of silently serving a stale head.
 */
const fetchFresh = (checkoutDir: string): void => {
    const result = runGit(checkoutDir, ["fetch", "origin"]);
    if (result.exitCode !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim();
        return failConflict(
            `could not refresh the target-branch checkout; the remote may have been rewritten or is unreachable${detail ? `: ${detail}` : ""}.`,
        );
    }
};

const remoteTrackingHead = (
    checkoutDir: string,
    branch: string,
): string | undefined => {
    const result = runGit(checkoutDir, [
        "rev-parse",
        "--verify",
        `refs/remotes/origin/${branch}`,
    ]);
    return result.exitCode === 0 ? result.stdout.trim() : undefined;
};

/** Live remote head of a branch, or undefined when the branch is absent. */
const remoteHeadOf = (
    checkoutDir: string,
    branch: string,
): string | undefined => {
    const result = runGit(checkoutDir, [
        "ls-remote",
        "origin",
        `refs/heads/${branch}`,
    ]);
    if (result.exitCode !== 0) {
        return failConflict(
            `could not read the remote '${branch}' head: ${result.stderr.trim() || result.stdout.trim()}`,
        );
    }
    const lines = result.stdout
        .trim()
        .split("\n")
        .filter((line) => line !== "");
    if (lines.length === 0) return undefined;
    if (lines.length > 1) {
        return failConflict(
            `remote reported multiple refs for refs/heads/${branch}.`,
        );
    }
    const line = lines[0] as string;
    const sha = line.split("\t")[0];
    if (sha === undefined || !/^[0-9a-f]{40}$/.test(sha)) {
        return failConflict(
            `remote reported a malformed head for refs/heads/${branch}.`,
        );
    }
    return sha;
};

/** Require exactly one ordered BEGIN/END marker pair; return outside text. */
const outsideRegionText = (formula: string, label: string): string => {
    const beginCount = formula.split(HOMEBREW_FORMULA_BEGIN_MARKER).length - 1;
    const endCount = formula.split(HOMEBREW_FORMULA_END_MARKER).length - 1;
    if (beginCount !== 1 || endCount !== 1) {
        return failState(
            `${label} must be marked with exactly one '${HOMEBREW_FORMULA_BEGIN_MARKER}' and one '${HOMEBREW_FORMULA_END_MARKER}' marker; found ${beginCount} begin and ${endCount} end markers.`,
        );
    }
    const start = formula.indexOf(HOMEBREW_FORMULA_BEGIN_MARKER);
    const end = formula.indexOf(HOMEBREW_FORMULA_END_MARKER);
    if (end <= start) {
        return failState(`${label} generated-region markers are out of order.`);
    }
    return (
        formula.slice(0, start) +
        formula.slice(end + HOMEBREW_FORMULA_END_MARKER.length)
    );
};

/**
 * Require a tree-to-tree difference restricted to `Formula/ralphie.rb` with
 * byte-for-byte identity outside the generated marker region.
 */
const assertRegionOnlyFormulaDiff = (
    checkoutDir: string,
    from: string,
    to: string,
    label: string,
): void => {
    const output = gitMust(
        checkoutDir,
        ["diff", "--name-only", from, to],
        `failed to compare ${label}`,
    );
    const paths = output
        .trim()
        .split("\n")
        .filter((line) => line !== "");
    const unrelated = paths.filter((path) => path !== "Formula/ralphie.rb");
    if (unrelated.length > 0) {
        return failState(
            `${label} changes '${unrelated[0]}' besides Formula/ralphie.rb; refusing to touch it.`,
        );
    }
    if (paths.length === 0) return;
    const fromFormula = gitMust(
        checkoutDir,
        ["show", `${from}:Formula/ralphie.rb`],
        `Formula/ralphie.rb is not in ${from}`,
    );
    const toFormula = gitMust(
        checkoutDir,
        ["show", `${to}:Formula/ralphie.rb`],
        `Formula/ralphie.rb is not in ${to}`,
    );
    if (
        outsideRegionText(fromFormula, label) !==
        outsideRegionText(toFormula, label)
    ) {
        return failState(
            `${label} edits Formula/ralphie.rb outside the generated marker region; refusing to apply it.`,
        );
    }
};

/** Rebuild a tree level, descending to replace the target blob entry. */
const replaceBlobInTree = (
    checkoutDir: string,
    treeSha: string,
    pathSegments: ReadonlyArray<string>,
    blobSha: string,
): string => {
    const entries = gitMust(
        checkoutDir,
        ["ls-tree", treeSha],
        "failed to read a tree level",
    )
        .trim()
        .split("\n")
        .filter((line) => line !== "");
    const rebuilt = entries.map((line) => {
        const tab = line.indexOf("\t");
        const meta = line.slice(0, tab);
        const path = line.slice(tab + 1);
        if (path !== pathSegments[0]) return line;
        const parts = meta.split(" ");
        if (pathSegments.length === 1) {
            return `${parts[0]} blob ${blobSha}\t${path}`;
        }
        if (parts[1] !== "tree") {
            return fail(
                `expected a tree for '${path}' while building the candidate tree.`,
            );
        }
        const rebuiltChild = replaceBlobInTree(
            checkoutDir,
            parts[2] as string,
            pathSegments.slice(1),
            blobSha,
        );
        return `${parts[0]} tree ${rebuiltChild}\t${path}`;
    });
    return gitMust(
        checkoutDir,
        ["mktree"],
        "failed to build the candidate tree",
        { stdin: rebuilt.join("\n") },
    ).trim();
};

/** Build a tree whose only difference from the base is the formula blob. */
const candidateTreeSha = (
    checkoutDir: string,
    baseSha: string,
    candidateFormula: string,
): string => {
    const blob = gitMust(
        checkoutDir,
        ["hash-object", "-w", "--stdin"],
        "failed to hash the candidate formula",
        { stdin: candidateFormula },
    ).trim();
    const baseTree = gitMust(
        checkoutDir,
        ["rev-parse", `${baseSha}^{tree}`],
        "failed to resolve the target tree",
    ).trim();
    return replaceBlobInTree(
        checkoutDir,
        baseTree,
        ["Formula", "ralphie.rb"],
        blob,
    );
};

const commitTree = (
    checkoutDir: string,
    tree: string,
    parent: string,
    version: string,
): string =>
    gitMust(
        checkoutDir,
        [
            "commit-tree",
            tree,
            "-p",
            parent,
            "-m",
            homebrewUpdateCommitMessage(version),
        ],
        "failed to create the formula commit",
        { env: commitIdentity },
    ).trim();

const pushBranch = (
    checkoutDir: string,
    commitSha: string,
    branch: string,
): void => {
    const result = runGit(checkoutDir, [
        "push",
        "origin",
        `${commitSha}:refs/heads/${branch}`,
    ]);
    if (result.exitCode !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim();
        return failConflict(
            `the conditional push of '${branch}' was rejected; the remote head may have changed concurrently${detail ? `: ${detail}` : ""}.`,
        );
    }
};

const validateInput = (
    input: HomebrewUpdateReconcileInput,
): { readonly owner: string; readonly repo: string } => {
    if (!slugPattern.test(input.owner) || input.owner === "") {
        failPreflight(`invalid repository owner '${input.owner}'.`);
    }
    if (!slugPattern.test(input.repo) || input.repo === "") {
        failPreflight(`invalid repository name '${input.repo}'.`);
    }
    if (!versionPattern.test(input.version)) {
        failPreflight(
            `invalid release version '${input.version}'; expected <major>.<minor>.<patch>.`,
        );
    }
    if (!releaseTagPattern.test(input.tag)) {
        failPreflight(
            `invalid release tag '${input.tag}'; expected v<major>.<minor>.<patch>.`,
        );
    }
    if (input.tag !== `v${input.version}`) {
        failPreflight(
            `release tag '${input.tag}' does not match the validated version '${input.version}'.`,
        );
    }
    if (input.checkoutDir === "") {
        failPreflight("the tap checkout path must not be empty.");
    }
    return { owner: input.owner, repo: input.repo };
};

const validateManifestEntry = (
    rawEntry: unknown,
    index: number,
    tag: string,
): HomebrewAssetManifestEntry => {
    const label = `manifest asset ${index + 1}`;
    if (!isRecord(rawEntry))
        return failPreflight(`${label} is not a JSON object.`);
    const name = stringFrom(rawEntry, "name", label);
    const target = stringFrom(rawEntry, "target", label);
    if (!RELEASE_TARGETS.some((candidate) => candidate === target)) {
        return failPreflight(`${label} has an unknown target '${target}'.`);
    }
    if (name !== expectedAssetName(target as HomebrewAssetTarget)) {
        return failPreflight(
            `${label} names '${name}' instead of the asset for target '${target}'.`,
        );
    }
    const url = stringFrom(rawEntry, "url", label);
    if (
        !url.startsWith(gitHubUrlPrefix) ||
        !url.endsWith(`/releases/download/${tag}/${name}`)
    ) {
        return failPreflight(
            `${label} does not point at the exact release download URL for tag '${tag}'.`,
        );
    }
    const sha256 = stringFrom(rawEntry, "sha256", label);
    if (!sha256Pattern.test(sha256) || /^0+$/.test(sha256)) {
        return failPreflight(`${label} has an invalid SHA-256.`);
    }
    return { target: target as HomebrewAssetTarget, name, url, sha256 };
};

const validateManifestAssets = (
    rawAssets: unknown,
    tag: string,
): HomebrewAssetManifestEntry[] => {
    if (!Array.isArray(rawAssets))
        return failPreflight("manifest has no assets.");
    if (rawAssets.length !== RELEASE_TARGETS.length) {
        return failPreflight(
            `manifest must contain exactly ${RELEASE_TARGETS.length} assets; found ${rawAssets.length}.`,
        );
    }
    const assets: HomebrewAssetManifestEntry[] = [];
    const names = new Set<string>();
    const checksums = new Set<string>();
    for (const [index, rawEntry] of rawAssets.entries()) {
        const entry = validateManifestEntry(rawEntry, index, tag);
        if (names.has(entry.name)) {
            return failPreflight(
                `manifest contains duplicate asset '${entry.name}'.`,
            );
        }
        if (checksums.has(entry.sha256)) {
            return failPreflight(
                "manifest contains the same SHA-256 for multiple assets.",
            );
        }
        names.add(entry.name);
        checksums.add(entry.sha256);
        assets.push(entry);
    }
    for (const target of RELEASE_TARGETS) {
        if (!assets.some((asset) => asset.name === expectedAssetName(target))) {
            return failPreflight(
                `manifest is missing asset '${expectedAssetName(target)}'.`,
            );
        }
    }
    return assets;
};

const validateManifest = (
    value: unknown,
    tag: string,
    version: string,
): HomebrewAssetManifest => {
    if (!isRecord(value))
        return failPreflight("manifest must be a JSON object.");
    if (value.schema !== HOMEBREW_ASSET_MANIFEST_SCHEMA) {
        return failPreflight(
            `unexpected manifest schema '${String(value.schema)}'; expected '${HOMEBREW_ASSET_MANIFEST_SCHEMA}'.`,
        );
    }
    if (value.tag !== tag) {
        return failPreflight(
            `manifest tag '${String(value.tag)}' does not match the validated release tag '${tag}'.`,
        );
    }
    if (value.version !== version) {
        return failPreflight(
            `manifest version '${String(value.version)}' does not match the validated release version '${version}'.`,
        );
    }
    return {
        schema: HOMEBREW_ASSET_MANIFEST_SCHEMA,
        tag,
        version,
        assets: validateManifestAssets(value.assets, tag),
    };
};

/** The canonical standalone target catalog, validated by the generator. */
const canonicalCatalogValue = (): unknown =>
    JSON.parse(
        readFileSync(
            resolve(import.meta.dir, "../targets/standalone-targets.json"),
            "utf8",
        ),
    ) as unknown;

/** Render the guarded candidate against a base formula, wrapping failures. */
const candidateFormulaFor = (
    baseFormula: string,
    manifest: HomebrewAssetManifest,
): string => {
    const metadata = {
        version: manifest.version,
        tag: manifest.tag,
        assets: manifest.assets.map((asset) => ({
            name: asset.name,
            sha256: asset.sha256,
        })),
    };
    try {
        return renderHomebrewFormula(
            baseFormula,
            metadata,
            canonicalCatalogValue(),
        );
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return failPreflight(
            `the target-branch formula cannot render a guarded candidate: ${detail}`,
        );
    }
};

const assertMatchingPullRequests = (
    matches: ReadonlyArray<HomebrewPullRequest>,
    branch: string,
): void => {
    if (matches.length > 1) {
        return failState(
            `found ${matches.length} open pull requests matching head '${branch}' on '${HOMEBREW_UPDATE_BASE_BRANCH}'; refusing to create or reuse any of them.`,
        );
    }
    for (const match of matches) {
        if (
            match.state !== "open" ||
            match.merged ||
            match.headRef !== branch ||
            match.baseRef !== HOMEBREW_UPDATE_BASE_BRANCH
        ) {
            return failState(
                `matching pull request #${match.number} has an unexpected state '${match.state}'/base '${match.baseRef}'/head '${match.headRef}'; refusing to reuse it.`,
            );
        }
    }
};

const createOrReusePullRequest = async (
    api: HomebrewUpdateApi,
    input: HomebrewUpdateReconcileInput,
    manifest: HomebrewAssetManifest,
    branch: string,
    matches: ReadonlyArray<HomebrewPullRequest>,
): Promise<{
    readonly created: boolean;
    readonly number: number;
    readonly url: string;
}> => {
    if (matches.length === 1) {
        const match = matches[0] as HomebrewPullRequest;
        return { created: false, number: match.number, url: match.url };
    }
    try {
        const created = await api.createPullRequest({
            body: homebrewUpdatePullRequestBody(input.version, manifest),
            title: homebrewUpdatePullRequestTitle(input.version),
            head: branch,
            base: HOMEBREW_UPDATE_BASE_BRANCH,
            owner: input.owner,
            repo: input.repo,
        });
        return { created: true, number: created.number, url: created.url };
    } catch (error) {
        if (!(error instanceof HomebrewPullRequestCreateConflictError)) {
            throw error;
        }
        const after = await api.listPullRequests({
            owner: input.owner,
            repo: input.repo,
            head: `${input.owner}:${branch}`,
            base: HOMEBREW_UPDATE_BASE_BRANCH,
            state: "open",
        });
        assertMatchingPullRequests(after, branch);
        if (after.length === 0) {
            return failConflict(
                "pull-request creation conflict resolved to zero matching pull requests; refusing further mutations.",
            );
        }
        const match = after[0] as HomebrewPullRequest;
        return { created: false, number: match.number, url: match.url };
    }
};

/**
 * Build, validate, and conditionally push the candidate commit on top of the
 * given parent, or with the given parent as the direct base. Returns the
 * plain plumbing commit; the push itself is an ordinary non-force
 * fast-forward update so a retry can never replace a newer remote head.
 */
const buildCandidateCommit = (
    checkoutDir: string,
    baseSha: string,
    parent: string,
    candidate: string,
    version: string,
): string => {
    const commitSha = commitTree(
        checkoutDir,
        candidateTreeSha(checkoutDir, baseSha, candidate),
        parent,
        version,
    );
    assertRegionOnlyFormulaDiff(
        checkoutDir,
        parent,
        commitSha,
        "the candidate branch",
    );
    return commitSha;
};

/** Verify fresh `main` still matches the fetched base before a push. */
const assertMainUnchanged = (
    checkoutDir: string,
    baseSha: string,
    branch: string,
): void => {
    if (remoteHeadOf(checkoutDir, HOMEBREW_UPDATE_BASE_BRANCH) !== baseSha) {
        return failConflict(
            `origin/${HOMEBREW_UPDATE_BASE_BRANCH} moved concurrently; refusing to touch '${branch}' against a stale candidate.`,
        );
    }
};

/**
 * Create or reuse/update the guarded branch. Existing branches are accepted
 * only when they are based on the fresh `main`, change only
 * `Formula/ralphie.rb` inside the generated region, and are updated only via
 * a non-force fast-forward; anything else fails closed and is left untouched.
 */
const resolveBranch = (
    checkoutDir: string,
    baseSha: string,
    candidate: string,
    branch: string,
    version: string,
): {
    readonly commitSha: string;
    readonly created: boolean;
    readonly updated: boolean;
} => {
    const branchSha = remoteTrackingHead(checkoutDir, branch);
    if (branchSha === undefined) {
        const commitSha = buildCandidateCommit(
            checkoutDir,
            baseSha,
            baseSha,
            candidate,
            version,
        );
        assertMainUnchanged(checkoutDir, baseSha, branch);
        if (remoteHeadOf(checkoutDir, branch) !== undefined) {
            return failConflict(
                `the remote branch '${branch}' appeared concurrently; refusing to overwrite it.`,
            );
        }
        pushBranch(checkoutDir, commitSha, branch);
        return { commitSha, created: true, updated: false };
    }

    const common = gitMust(
        checkoutDir,
        ["merge-base", baseSha, branchSha],
        "failed to compute the branch merge-base",
    ).trim();
    if (common !== baseSha) {
        return failState(
            `branch '${branch}' is not based on the current origin/${HOMEBREW_UPDATE_BASE_BRANCH}; refusing to update or repair it.`,
        );
    }
    assertRegionOnlyFormulaDiff(
        checkoutDir,
        baseSha,
        branchSha,
        `branch '${branch}'`,
    );
    const branchFormula = gitMust(
        checkoutDir,
        ["show", `${branchSha}:Formula/ralphie.rb`],
        `Formula/ralphie.rb is not in branch '${branch}'`,
    );
    if (branchFormula === candidate) {
        return { commitSha: branchSha, created: false, updated: false };
    }
    const commitSha = buildCandidateCommit(
        checkoutDir,
        baseSha,
        branchSha,
        candidate,
        version,
    );
    assertMainUnchanged(checkoutDir, baseSha, branch);
    if (remoteHeadOf(checkoutDir, branch) !== branchSha) {
        return failConflict(
            `the remote branch '${branch}' moved concurrently (expected ${branchSha}, got ${remoteHeadOf(checkoutDir, branch) ?? "<absent>"}); refusing to overwrite a newer head.`,
        );
    }
    pushBranch(checkoutDir, commitSha, branch);
    return { commitSha, created: false, updated: true };
};

/**
 * Reconcile exactly one guarded Homebrew formula branch and pull request per
 * release against the fresh `main` of the tap clone. All mutations are
 * conditional: branch creation/update uses a non-force push after an exact
 * remote-head read, and pull-request creation happens only after the branch
 * is verified. Never resets, force-pushes, deletes, or recreates a branch,
 * and never touches the working tree.
 */
export const reconcileHomebrewUpdate = async (
    api: HomebrewUpdateApi,
    input: HomebrewUpdateReconcileInput,
): Promise<HomebrewUpdateOutcome> => {
    const { owner, repo } = validateInput(input);
    const manifest = validateManifest(input.manifest, input.tag, input.version);
    const checkoutDir = input.checkoutDir;

    // Start from a fresh checkout/fetch of the fixed target branch.
    ensureGitClone(checkoutDir);
    fetchFresh(checkoutDir);
    const baseSha = gitMust(
        checkoutDir,
        [
            "rev-parse",
            "--verify",
            `refs/remotes/origin/${HOMEBREW_UPDATE_BASE_BRANCH}`,
        ],
        `origin/${HOMEBREW_UPDATE_BASE_BRANCH} does not exist in the fresh fetch`,
    ).trim();
    const mainFormula = gitMust(
        checkoutDir,
        [
            "show",
            `refs/remotes/origin/${HOMEBREW_UPDATE_BASE_BRANCH}:Formula/ralphie.rb`,
        ],
        `Formula/ralphie.rb is not tracked on origin/${HOMEBREW_UPDATE_BASE_BRANCH}`,
    );

    const candidate = candidateFormulaFor(mainFormula, manifest);
    if (candidate === mainFormula) {
        return { kind: "main-current", baseSha };
    }

    const branch = homebrewUpdateBranchName(input.version);
    const matches = await api.listPullRequests({
        owner,
        repo,
        head: `${owner}:${branch}`,
        base: HOMEBREW_UPDATE_BASE_BRANCH,
        state: "open",
    });
    assertMatchingPullRequests(matches, branch);
    if (
        matches.length === 1 &&
        remoteTrackingHead(checkoutDir, branch) === undefined
    ) {
        return failState(
            `pull request #${(matches[0] as HomebrewPullRequest).number} matches '${branch}' but the remote branch is absent; refusing to recreate it.`,
        );
    }

    const resolved = resolveBranch(
        checkoutDir,
        baseSha,
        candidate,
        branch,
        input.version,
    );
    if (remoteHeadOf(checkoutDir, branch) !== resolved.commitSha) {
        return failConflict(
            `the remote branch '${branch}' does not point at the reconciled commit; refusing further mutations.`,
        );
    }

    const pullRequest = await createOrReusePullRequest(
        api,
        input,
        manifest,
        branch,
        matches,
    );
    return {
        kind: "reconciled",
        baseSha,
        branch,
        commitSha: resolved.commitSha,
        branchCreated: resolved.created,
        branchUpdated: resolved.updated,
        pullRequestNumber: pullRequest.number,
        pullRequestUrl: pullRequest.url,
        pullRequestCreated: pullRequest.created,
    };
};

export type FetchImplementation = (
    input: string | URL | Request,
    init?: RequestInit,
) => Promise<Response>;

export type CreateHomebrewUpdateApiOptions = {
    readonly apiBaseUrl?: string;
    readonly fetchImpl?: FetchImplementation;
    readonly token?: string;
};

const pullRequestFrom = (item: unknown): HomebrewPullRequest => {
    if (!isRecord(item)) {
        return fail("pull-request lookup returned a malformed entry.");
    }
    const number = item.number;
    const title = item.title;
    const htmlUrl = item.html_url;
    const state = item.state;
    const head = item.head;
    const base = item.base;
    if (typeof number !== "number" || number <= 0) {
        return fail("pull-request entry has an invalid number.");
    }
    if (typeof title !== "string")
        return fail("pull-request entry has no title.");
    if (typeof htmlUrl !== "string") {
        return fail("pull-request entry has no html_url.");
    }
    if (state !== "open" && state !== "closed") {
        return fail("pull-request entry has an unexpected state.");
    }
    if (!isRecord(head) || typeof head.ref !== "string") {
        return fail("pull-request entry has no head ref.");
    }
    if (!isRecord(base) || typeof base.ref !== "string") {
        return fail("pull-request entry has no base ref.");
    }
    return {
        number,
        title,
        url: htmlUrl,
        headRef: head.ref,
        baseRef: base.ref,
        state,
        merged: item.merged === true || typeof item.merged_at === "string",
    };
};

/** GitHub REST adapter over fetch; mirrors `gh`/the workflow REST calls. */
export const createHomebrewUpdateApi = ({
    apiBaseUrl,
    fetchImpl,
    token,
}: CreateHomebrewUpdateApiOptions): HomebrewUpdateApi => {
    const base = (apiBaseUrl ?? "https://api.github.com").replace(/\/+$/, "");
    const fetchImplementation = fetchImpl ?? globalThis.fetch;
    const headers = new Headers({
        Accept: "application/vnd.github+json",
        "User-Agent": "ralphie-homebrew-update-reconcile",
        "X-GitHub-Api-Version": "2022-11-28",
    });
    if (token !== undefined && token !== "") {
        headers.set("Authorization", `Bearer ${token}`);
    }

    return {
        async listPullRequests(query) {
            const url = `${base}/repos/${query.owner}/${query.repo}/pulls?state=${query.state}&head=${encodeURIComponent(query.head)}&base=${encodeURIComponent(query.base)}&per_page=100`;
            const response = await fetchImplementation(url, {
                headers,
                redirect: "error",
            });
            if (!response.ok) {
                return failConflict(
                    `pull-request lookup returned HTTP ${response.status}.`,
                );
            }
            const parsed: unknown = await response.json();
            if (!Array.isArray(parsed)) {
                return failConflict(
                    "pull-request lookup returned a non-array body.",
                );
            }
            return parsed.map((item) => pullRequestFrom(item));
        },
        async createPullRequest(query) {
            const url = `${base}/repos/${query.owner}/${query.repo}/pulls`;
            const response = await fetchImplementation(url, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    title: query.title,
                    body: query.body,
                    head: query.head,
                    base: query.base,
                }),
                redirect: "error",
            });
            if (response.status === 422) {
                throw new HomebrewPullRequestCreateConflictError({
                    message: `GitHub rejected pull-request creation for '${query.head}' (HTTP 422).`,
                });
            }
            if (!response.ok) {
                return failConflict(
                    `pull-request creation returned HTTP ${response.status}.`,
                );
            }
            return pullRequestFrom(await response.json());
        },
    };
};

const optionValue = (args: ReadonlyArray<string>, option: string): string => {
    const index = args.indexOf(option);
    const value = args[index + 1];
    if (index === -1 || value === undefined || value.startsWith("--")) {
        throw new Error(`${option} requires a value.`);
    }
    return value;
};

const optionalOptionValue = (
    args: ReadonlyArray<string>,
    option: string,
): string | undefined => {
    const index = args.indexOf(option);
    if (index === -1) return undefined;
    return optionValue(args, option);
};

const main = async (): Promise<void> => {
    const args = Bun.argv.slice(2);
    if (args.includes("--help") || args.includes("-h")) {
        console.log(
            "Usage: reconcile-homebrew-update.ts --owner <owner> --repo <repo> --version <version> --tag <tag> --manifest <homebrew-asset-manifest.json> --checkout <tap-checkout> [--api-base-url <url>]",
        );
        return;
    }
    const manifestPath = optionValue(args, "--manifest");
    let manifest: unknown;
    try {
        manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
            `manifest '${manifestPath}' is not valid JSON: ${detail}`,
        );
    }
    const api = createHomebrewUpdateApi({
        token: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
        apiBaseUrl: optionalOptionValue(args, "--api-base-url"),
    });
    const outcome = await reconcileHomebrewUpdate(api, {
        owner: optionValue(args, "--owner"),
        repo: optionValue(args, "--repo"),
        version: optionValue(args, "--version"),
        tag: optionValue(args, "--tag"),
        manifest,
        checkoutDir: optionValue(args, "--checkout"),
    });
    const line = `homebrew_update_result=${outcome.kind}`;
    const outputPath = process.env.GITHUB_OUTPUT;
    if (outputPath === undefined || outputPath === "") {
        console.log(line);
        return;
    }
    await appendFile(outputPath, `${line}\n`);
};

if (import.meta.main) {
    try {
        await main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}