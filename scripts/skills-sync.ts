#!/usr/bin/env bun

import {
    chmod,
    lstat,
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    rename,
    rm,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { parseArgs } from "node:util";

import { z } from "zod";

/**
 * `bun run skills:sync [ref]`: replaces the vendored copy of Matt Pocock's
 * skills with the given upstream ref and rewrites its lock file (ADR-0002).
 * This script is the only writer of the vendored directory; nothing there is
 * edited by hand.
 *
 * Upstream keeps each skill at `skills/<bucket>/<name>/`. The copy is
 * flattened to `<name>/` beside the upstream `LICENSE`, so the directory is
 * itself a skills directory. The lock records the upstream repository and
 * commit, where each skill came from, and the git blob id of every vendored
 * file, so the copy can be verified offline and compared with
 * `git ls-tree <commit>` upstream. Nothing in the output depends on the ref
 * spelling, the clock or the machine: syncing the same commit twice yields
 * byte-identical files.
 */

export const UPSTREAM_REPOSITORY = "https://github.com/mattpocock/skills";

/** The vendored copy, relative to the repository (and package) root. */
export const VENDOR_DIRECTORY = "vendor/mattpocock-skills";

export const VENDORED_SKILLS = [
    "code-review",
    "codebase-design",
    "diagnosing-bugs",
    "implement",
    "tdd",
    "to-tickets",
    "triage",
] as const;

export const LOCK_FILE = "lock.json";

export type UpstreamEntry = {
    readonly path: string;
    readonly mode: string;
};

export type UpstreamSnapshot = {
    readonly commit: string;
    readonly entries: ReadonlyArray<UpstreamEntry>;
    readonly read: (path: string) => Promise<Uint8Array>;
    readonly dispose: () => Promise<void>;
};

export type UpstreamSource = {
    readonly repository: string;
    readonly fetch: (ref: string) => Promise<UpstreamSnapshot>;
};

export type SyncOptions = {
    readonly directory: string;
    readonly ref: string;
    readonly upstream: UpstreamSource;
};

export type SyncResult = {
    readonly previousCommit: string | undefined;
    readonly commit: string;
    readonly changedFiles: ReadonlyArray<string>;
};

type VendoredFile = {
    readonly source: string;
    readonly path: string;
    readonly executable: boolean;
};

const FULL_COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REGULAR_FILE_MODES = new Set(["100644", "100755"]);

const lockSchema = z.object({
    repository: z.string(),
    commit: z.string().regex(FULL_COMMIT_ID),
    skills: z.record(z.string(), z.string()),
    files: z.record(z.string(), z.string()),
});

type Lock = z.infer<typeof lockSchema>;

/** The id `git hash-object` gives this content. */
export const gitBlobId = (content: Uint8Array): string => {
    const hasher = new Bun.CryptoHasher("sha1");
    hasher.update(`blob ${content.byteLength}\0`);
    hasher.update(content);
    return hasher.digest("hex");
};

const byPath = (left: { path: string }, right: { path: string }): number =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0;

const vendoredFile = (entry: UpstreamEntry, path: string): VendoredFile => {
    if (!REGULAR_FILE_MODES.has(entry.mode)) {
        throw new Error(
            `Upstream ${entry.path} is not a regular file (mode ${entry.mode}).`,
        );
    }
    return { source: entry.path, path, executable: entry.mode === "100755" };
};

/** The upstream directory, `skills/<bucket>/<name>`, that holds a skill. */
const skillSource = (
    entries: ReadonlyArray<UpstreamEntry>,
    name: string,
): string => {
    const sources = entries.flatMap(({ path }) => {
        const [root, bucket, skill, file, ...rest] = path.split("/");
        return root === "skills" &&
            skill === name &&
            file === "SKILL.md" &&
            rest.length === 0
            ? [`skills/${bucket}/${name}`]
            : [];
    });
    const [source, ...others] = sources.sort();
    if (source === undefined) {
        throw new Error(`Upstream has no skill named ${name}.`);
    }
    if (others.length > 0) {
        throw new Error(
            `Upstream has skill ${name} in more than one place: ${sources.join(", ")}.`,
        );
    }
    return source;
};

const skillFiles = (
    entries: ReadonlyArray<UpstreamEntry>,
    name: string,
    source: string,
): ReadonlyArray<VendoredFile> =>
    entries
        .filter(({ path }) => path.startsWith(`${source}/`))
        .map((entry) =>
            vendoredFile(
                entry,
                `${name}/${entry.path.slice(source.length + 1)}`,
            ),
        );

const licenseFile = (entries: ReadonlyArray<UpstreamEntry>): VendoredFile => {
    const entry = entries.find(({ path }) => path === "LICENSE");
    if (entry === undefined) {
        throw new Error("Upstream has no LICENSE file at its root.");
    }
    return vendoredFile(entry, "LICENSE");
};

const vendoredFiles = (
    entries: ReadonlyArray<UpstreamEntry>,
    skills: Readonly<Record<string, string>>,
): ReadonlyArray<VendoredFile> =>
    [
        licenseFile(entries),
        ...VENDORED_SKILLS.flatMap((name) =>
            skillFiles(entries, name, skills[name] ?? ""),
        ),
    ].sort(byPath);

const readLock = async (directory: string): Promise<Lock | undefined> =>
    readFile(join(directory, LOCK_FILE), "utf8")
        .then((text) => lockSchema.parse(JSON.parse(text)))
        .catch(() => undefined);

const renderLock = (lock: Lock): string => `${JSON.stringify(lock, null, 4)}\n`;

const changedFiles = (
    before: Readonly<Record<string, string>>,
    after: Readonly<Record<string, string>>,
): ReadonlyArray<string> =>
    [...new Set([...Object.keys(before), ...Object.keys(after)])]
        .filter((path) => before[path] !== after[path])
        .sort();

/** Writes the vendored files and their lock into an empty directory. */
const writeCopy = async (
    snapshot: UpstreamSnapshot,
    repository: string,
    directory: string,
): Promise<Lock> => {
    if (!FULL_COMMIT_ID.test(snapshot.commit)) {
        throw new Error(
            `Upstream resolved the ref to something that is not a full commit id: ${snapshot.commit}.`,
        );
    }
    const skills = Object.fromEntries(
        VENDORED_SKILLS.map((name) => [
            name,
            skillSource(snapshot.entries, name),
        ]),
    );
    const files: Record<string, string> = {};
    for (const file of vendoredFiles(snapshot.entries, skills)) {
        const target = join(directory, file.path);
        const content = await snapshot.read(file.source);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content);
        await chmod(target, file.executable ? 0o755 : 0o644);
        files[file.path] = gitBlobId(content);
    }
    const lock = { repository, commit: snapshot.commit, skills, files };
    await writeFile(join(directory, LOCK_FILE), renderLock(lock));
    return lock;
};

/** Builds the new copy beside `directory`, then swaps it in. */
const replaceCopy = async <T>(
    directory: string,
    build: (staging: string) => Promise<T>,
): Promise<T> => {
    const parent = dirname(directory);
    await mkdir(parent, { recursive: true });
    const staging = await mkdtemp(join(parent, `.${basename(directory)}-`));
    try {
        const built = await build(staging);
        // mkdtemp creates the directory owner-only; the copy is not private.
        await chmod(staging, 0o755);
        await rm(directory, { recursive: true, force: true });
        await rename(staging, directory);
        return built;
    } finally {
        await rm(staging, { recursive: true, force: true });
    }
};

export const syncSkills = async (options: SyncOptions): Promise<SyncResult> => {
    const previous = await readLock(options.directory);
    const snapshot = await options.upstream.fetch(options.ref);
    try {
        const lock = await replaceCopy(options.directory, (staging) =>
            writeCopy(snapshot, options.upstream.repository, staging),
        );
        return {
            previousCommit: previous?.commit,
            commit: lock.commit,
            changedFiles: changedFiles(previous?.files ?? {}, lock.files),
        };
    } finally {
        await snapshot.dispose();
    }
};

const runGit = async (
    cwd: string,
    args: ReadonlyArray<string>,
): Promise<Uint8Array> => {
    const child = Bun.spawn(["git", ...args], {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).arrayBuffer(),
        new Response(child.stderr).text(),
        child.exited,
    ]);
    if (exitCode !== 0) {
        throw new Error(
            `git ${args.join(" ")} failed with exit ${exitCode}: ${stderr.trim()}`,
        );
    }
    return new Uint8Array(stdout);
};

const gitText = async (
    cwd: string,
    args: ReadonlyArray<string>,
): Promise<string> => new TextDecoder().decode(await runGit(cwd, args));

/** Parses `git ls-tree -r -z` records: `<mode> <type> <id>\t<path>`. */
const parseTree = (output: string): ReadonlyArray<UpstreamEntry> =>
    output
        .split("\0")
        .filter((record) => record.length > 0)
        .map((record) => {
            const tab = record.indexOf("\t");
            const [mode = ""] = record.slice(0, tab).split(" ");
            return { path: record.slice(tab + 1), mode };
        });

/**
 * Reads upstream with plain, read-only git: a shallow fetch of `ref` into a
 * scratch repository, which `dispose` removes.
 */
export const gitUpstream = (repository: string): UpstreamSource => ({
    repository,
    fetch: async (ref) => {
        const scratch = await mkdtemp(join(tmpdir(), "ralphie-skills-sync-"));
        const dispose = () => rm(scratch, { recursive: true, force: true });
        try {
            await runGit(scratch, ["init", "-q", "--bare"]);
            await runGit(scratch, [
                "fetch",
                "-q",
                "--depth=1",
                "--no-tags",
                "--",
                repository,
                ref,
            ]);
            const commit = (
                await gitText(scratch, [
                    "rev-parse",
                    "--verify",
                    "FETCH_HEAD^{commit}",
                ])
            ).trim();
            const entries = parseTree(
                await gitText(scratch, ["ls-tree", "-r", "-z", commit]),
            );
            const read = (path: string) =>
                runGit(scratch, ["cat-file", "blob", `${commit}:${path}`]);
            return { commit, entries, read, dispose };
        } catch (error) {
            await dispose();
            throw error;
        }
    },
});

/** Every file under `directory` except the lock, as sorted `/` paths. */
const copiedFiles = async (
    directory: string,
): Promise<ReadonlyArray<string>> => {
    const files: string[] = [];
    for (const path of await readdir(directory, { recursive: true })) {
        if ((await lstat(join(directory, path))).isDirectory()) continue;
        const relative = path.split(sep).join("/");
        if (relative !== LOCK_FILE) files.push(relative);
    }
    return files.sort();
};

const skillSetProblems = (lock: Lock): ReadonlyArray<string> => {
    const locked = Object.keys(lock.skills).sort();
    return locked.join(",") === VENDORED_SKILLS.join(",")
        ? []
        : [
              `${LOCK_FILE} locks the skills ${locked.join(", ")}; expected ${VENDORED_SKILLS.join(", ")}.`,
          ];
};

const fileProblem = async (
    directory: string,
    lock: Lock,
    path: string,
    present: ReadonlySet<string>,
): Promise<string | undefined> => {
    const locked = lock.files[path];
    if (locked === undefined) return `${path} is not in the lock.`;
    if (!present.has(path)) return `${path} is in the lock but missing.`;
    const actual = gitBlobId(await readFile(join(directory, path)));
    return actual === locked
        ? undefined
        : `${path} differs from the locked upstream content.`;
};

/**
 * Checks a vendored copy against its lock: the lock covers exactly the
 * driven skills, and the files on disk are exactly the locked upstream
 * blobs. Returns one sentence per problem; an empty list means the copy is
 * an untouched sync.
 */
export const verifyVendoredCopy = async (
    directory: string,
): Promise<ReadonlyArray<string>> => {
    const lock = await readLock(directory);
    if (lock === undefined) {
        return [`${LOCK_FILE} is missing or is not a valid lock.`];
    }
    const present = new Set(await copiedFiles(directory));
    const paths = [...new Set([...present, ...Object.keys(lock.files)])].sort();
    const problems = await Promise.all(
        paths.map((path) => fileProblem(directory, lock, path, present)),
    );
    return [
        ...skillSetProblems(lock),
        ...problems.filter((problem) => problem !== undefined),
    ];
};

const usage = `Usage: bun run skills:sync [ref]

Replaces ${VENDOR_DIRECTORY} with the driven skills at <ref> (a branch, tag
or commit; default: the upstream default branch) of ${UPSTREAM_REPOSITORY},
and rewrites ${VENDOR_DIRECTORY}/${LOCK_FILE}.`;

const summary = (result: SyncResult): string => {
    const previous =
        result.previousCommit === undefined
            ? ""
            : ` (previously ${result.previousCommit})`;
    const changed =
        result.changedFiles.length === 0
            ? "no vendored file changed."
            : `${result.changedFiles.length} vendored file(s) changed:\n${result.changedFiles.map((path) => `  ${path}`).join("\n")}`;
    return `Vendored ${UPSTREAM_REPOSITORY} at ${result.commit}${previous}; ${changed}`;
};

const main = async (): Promise<void> => {
    const { values, positionals } = parseArgs({
        args: Bun.argv.slice(2),
        options: { help: { type: "boolean", short: "h", default: false } },
        allowPositionals: true,
    });
    if (values.help) {
        console.log(usage);
        return;
    }
    if (positionals.length > 1) {
        throw new Error(`Expected at most one ref.\n\n${usage}`);
    }
    const result = await syncSkills({
        directory: join(import.meta.dir, "..", VENDOR_DIRECTORY),
        ref: positionals[0] ?? "HEAD",
        upstream: gitUpstream(UPSTREAM_REPOSITORY),
    });
    console.log(summary(result));
};

if (import.meta.main) {
    try {
        await main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}