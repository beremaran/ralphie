#!/usr/bin/env bun

/**
 * Sync the vendored copy of mattpocock/skills (ADR-0002).
 *
 *   bun run skills:sync [ref] [--repo <url-or-path>] [--check]
 *
 * Replaces `vendor/mattpocock-skills` with the Ralphie skill set at `ref`
 * (default: the upstream default branch) and rewrites the lock file. `--check`
 * only verifies, offline, that the vendored files still match the lock.
 * Vendored files are never edited by hand; departures from a skill's text
 * belong in a skill overlay.
 */

import { createHash } from "node:crypto";
import {
    cp,
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

import { CommandRunnerLive } from "../src/process/adapters/command-runner.ts";
import type { CommandRunnerService } from "../src/process/ports.ts";

export const UPSTREAM_REPOSITORY = "https://github.com/mattpocock/skills";

/** The skills Ralphie drives, by directory name. */
export const VENDORED_SKILLS = [
    "triage",
    "to-tickets",
    "implement",
    "tdd",
    "code-review",
    "codebase-design",
    "diagnosing-bugs",
] as const;

export const VENDOR_DIRECTORY = resolve(
    import.meta.dir,
    "..",
    "vendor",
    "mattpocock-skills",
);

const LOCK_FILE = "UPSTREAM.lock.json";
const LICENSE_FILE = "LICENSE";
const SKILLS_DIRECTORY = "skills";

export type SkillsLock = {
    readonly repository: string;
    /** The ref that was requested; `HEAD` when none was given. */
    readonly ref: string;
    /** The exact upstream commit the vendored files were taken from. */
    readonly commit: string;
    /** Upstream path of each vendored skill at `commit`. */
    readonly skills: Readonly<Record<string, string>>;
    /** SHA-256 over every vendored file path and content. */
    readonly digest: string;
};

const listFiles = async (
    directory: string,
    base = directory,
): Promise<string[]> => {
    const files: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) files.push(...(await listFiles(path, base)));
        else files.push(relative(base, path).split("\\").join("/"));
    }
    return files.sort();
};

/** A digest of the vendored files that does not depend on the lock itself. */
export const digestVendored = async (directory: string): Promise<string> => {
    const hash = createHash("sha256");
    const files = (await listFiles(directory)).filter(
        (file) => file !== LOCK_FILE,
    );
    for (const file of files) {
        const content = await readFile(join(directory, file));
        hash.update(
            `${file}\0${createHash("sha256").update(content).digest("hex")}\n`,
        );
    }
    return hash.digest("hex");
};

export const readLock = async (
    directory: string = VENDOR_DIRECTORY,
): Promise<SkillsLock> =>
    JSON.parse(await readFile(join(directory, LOCK_FILE), "utf8"));

/** Offline: every skill, the license and the lock agree with the files. */
export const verifyVendored = async (
    directory: string = VENDOR_DIRECTORY,
): Promise<void> => {
    const lock = await readLock(directory);
    const problems: string[] = [];
    for (const name of VENDORED_SKILLS) {
        const present = await stat(
            join(directory, SKILLS_DIRECTORY, name, "SKILL.md"),
        ).then(
            () => true,
            () => false,
        );
        if (!present) problems.push(`missing skill ${name}`);
    }
    const licensed = await readFile(join(directory, LICENSE_FILE), "utf8").then(
        (text) => /MIT License/.test(text),
        () => false,
    );
    if (!licensed) problems.push("missing upstream MIT license");
    if ((await digestVendored(directory)) !== lock.digest) {
        problems.push(
            `files differ from ${LOCK_FILE}; vendored files are never edited by hand, run bun run skills:sync`,
        );
    }
    if (problems.length > 0) {
        throw new Error(
            `Vendored skills are inconsistent: ${problems.join("; ")}.`,
        );
    }
};

const git = async (
    runner: CommandRunnerService,
    cwd: string,
    args: ReadonlyArray<string>,
): Promise<string> => {
    const result = await runner.run("git", args, { cwd, trimStdout: true });
    if (result.exitCode !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
    return result.stdout;
};

/** Find each wanted skill's directory anywhere under the upstream `skills/` tree. */
const locateSkills = async (
    checkout: string,
): Promise<Record<string, string>> => {
    const found = new Map<string, string[]>();
    for (const file of await listFiles(join(checkout, SKILLS_DIRECTORY))) {
        if (basename(file) !== "SKILL.md") continue;
        const directory = dirname(file);
        const name = basename(directory);
        found.set(name, [...(found.get(name) ?? []), directory]);
    }
    const located: Record<string, string> = {};
    for (const name of VENDORED_SKILLS) {
        const paths = found.get(name) ?? [];
        if (paths.length !== 1) {
            throw new Error(
                `Expected exactly one upstream skill named ${name}, found ${paths.length}.`,
            );
        }
        located[name] = `${SKILLS_DIRECTORY}/${paths[0]}`;
    }
    return located;
};

export type SyncOptions = {
    readonly repository?: string;
    readonly ref?: string;
    readonly destination?: string;
    readonly runner?: CommandRunnerService;
};

/** Replace the vendored copy with upstream at `ref` and rewrite the lock. */
export const syncSkills = async ({
    repository = UPSTREAM_REPOSITORY,
    ref,
    destination = VENDOR_DIRECTORY,
    runner = CommandRunnerLive,
}: SyncOptions = {}): Promise<SkillsLock> => {
    const scratch = await mkdtemp(join(tmpdir(), "ralphie-skills-sync-"));
    try {
        const checkout = join(scratch, "upstream");
        await git(runner, scratch, [
            "clone",
            "--quiet",
            "--no-checkout",
            repository,
            checkout,
        ]);
        await git(runner, checkout, [
            "checkout",
            "--quiet",
            "--detach",
            ref ?? "HEAD",
        ]);
        const commit = await git(runner, checkout, ["rev-parse", "HEAD"]);
        const located = await locateSkills(checkout);

        const next = join(scratch, "next");
        await mkdir(join(next, SKILLS_DIRECTORY), { recursive: true });
        for (const [name, path] of Object.entries(located)) {
            await cp(join(checkout, path), join(next, SKILLS_DIRECTORY, name), {
                recursive: true,
            });
        }
        await cp(join(checkout, "LICENSE"), join(next, LICENSE_FILE));

        const lock: SkillsLock = {
            repository,
            ref: ref ?? "HEAD",
            commit,
            skills: located,
            digest: await digestVendored(next),
        };
        await writeFile(
            join(next, LOCK_FILE),
            `${JSON.stringify(lock, null, 2)}\n`,
        );

        await mkdir(dirname(destination), { recursive: true });
        await rm(destination, { recursive: true, force: true });
        await cp(next, destination, { recursive: true });
        return lock;
    } finally {
        await rm(scratch, { recursive: true, force: true });
    }
};

const optionValue = (
    args: ReadonlyArray<string>,
    option: string,
): string | undefined => {
    const index = args.indexOf(option);
    if (index === -1) return undefined;
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
        throw new Error(`${option} requires a value.`);
    }
    return value;
};

const main = async (): Promise<void> => {
    const args = Bun.argv.slice(2);
    if (args.includes("--check")) {
        await verifyVendored();
        console.log("Vendored skills match their lock file.");
        return;
    }
    const repository = optionValue(args, "--repo");
    const positional = args.filter(
        (arg, index) => !arg.startsWith("--") && args[index - 1] !== "--repo",
    );
    if (positional.length > 1) {
        throw new Error(`Unexpected argument: ${positional[1]}`);
    }
    const lock = await syncSkills({
        ...(repository === undefined ? {} : { repository }),
        ...(positional[0] === undefined ? {} : { ref: positional[0] }),
    });
    console.log(`Vendored skills synced to ${lock.repository}@${lock.commit}.`);
};

if (import.meta.main) await main();