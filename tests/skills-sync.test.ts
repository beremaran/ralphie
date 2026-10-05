import { afterEach, describe, expect, test } from "bun:test";
import {
    mkdtemp,
    readdir,
    readFile,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    gitUpstream,
    syncSkills,
    type UpstreamSource,
    VENDOR_DIRECTORY,
    verifyVendoredCopy,
} from "../scripts/skills-sync.ts";

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((path) => rm(path, { recursive: true, force: true })),
    );
});

const temporaryDirectory = async (): Promise<string> => {
    const path = await mkdtemp(join(tmpdir(), "ralphie-skills-sync-test-"));
    temporaryDirectories.push(path);
    return path;
};

/** Every file under `directory` with its content, keyed by relative path. */
const snapshotOf = async (
    directory: string,
): Promise<Record<string, string>> => {
    const paths = (await readdir(directory, { recursive: true })).sort();
    const files: Record<string, string> = {};
    for (const path of paths) {
        const file = Bun.file(join(directory, path));
        if ((await stat(join(directory, path))).isFile()) {
            files[path] = await file.text();
        }
    }
    return files;
};

type FakeFile = {
    readonly content: string;
    readonly mode?: string;
};

type FakeCommit = Readonly<Record<string, string | FakeFile>>;

const SKILL_NAMES = [
    "code-review",
    "codebase-design",
    "diagnosing-bugs",
    "implement",
    "tdd",
    "to-tickets",
    "triage",
];

/** An upstream tree shaped like mattpocock/skills. */
const upstreamTree = (): Record<string, string | FakeFile> => {
    const files: Record<string, string | FakeFile> = {
        LICENSE: "MIT License\n\nCopyright (c) Upstream\n",
        "README.md": "upstream readme\n",
        "skills/productivity/grilling/SKILL.md": "# grilling\n",
        "skills/engineering/wayfinder/SKILL.md": "# wayfinder\n",
        "skills/engineering/triage/AGENT-BRIEF.md": "agent brief\n",
        "skills/engineering/triage/OUT-OF-SCOPE.md": "out of scope\n",
        "skills/engineering/tdd/agents/openai.yaml": "interface: {}\n",
    };
    for (const name of SKILL_NAMES) {
        files[`skills/engineering/${name}/SKILL.md`] = `# ${name}\n`;
    }
    return files;
};

/** An in-memory upstream: refs resolve to commits, commits to trees. */
const fakeUpstream = (
    commits: Readonly<Record<string, FakeCommit>>,
    refs: Readonly<Record<string, string>> = {},
): UpstreamSource & {
    readonly fetchedRefs: string[];
    readonly disposed: string[];
} => {
    const fetchedRefs: string[] = [];
    const disposed: string[] = [];
    return {
        repository: "https://example.test/skills",
        fetchedRefs,
        disposed,
        fetch: async (ref) => {
            fetchedRefs.push(ref);
            const commit = refs[ref] ?? ref;
            const tree = commits[commit];
            if (tree === undefined) {
                throw new Error(`fake upstream has no ref ${ref}`);
            }
            const file = (path: string): FakeFile => {
                const entry = tree[path];
                if (entry === undefined) {
                    throw new Error(`fake upstream cannot read ${path}`);
                }
                return typeof entry === "string" ? { content: entry } : entry;
            };
            return {
                commit,
                entries: Object.keys(tree).map((path) => ({
                    path,
                    mode: file(path).mode ?? "100644",
                })),
                read: async (path) =>
                    new TextEncoder().encode(file(path).content),
                dispose: async () => {
                    disposed.push(commit);
                },
            };
        },
    };
};

describe("skills:sync", () => {
    test("vendors the driven skills flattened, with the license, and locks the upstream commit", async () => {
        const directory = join(await temporaryDirectory(), "skills");
        const upstream = fakeUpstream({ [COMMIT_A]: upstreamTree() });

        const result = await syncSkills({
            directory,
            ref: COMMIT_A,
            upstream,
        });

        expect(result.commit).toBe(COMMIT_A);
        expect(await readFile(join(directory, "LICENSE"), "utf8")).toBe(
            "MIT License\n\nCopyright (c) Upstream\n",
        );
        expect(await readFile(join(directory, "triage/SKILL.md"), "utf8")).toBe(
            "# triage\n",
        );
        expect(
            await readFile(join(directory, "triage/AGENT-BRIEF.md"), "utf8"),
        ).toBe("agent brief\n");
        expect(
            await readFile(join(directory, "tdd/agents/openai.yaml"), "utf8"),
        ).toBe("interface: {}\n");
        const lock = JSON.parse(
            await readFile(join(directory, "lock.json"), "utf8"),
        );
        expect(lock.repository).toBe("https://example.test/skills");
        expect(lock.commit).toBe(COMMIT_A);
        expect(lock.skills.triage).toBe("skills/engineering/triage");
    });

    test("locks the git blob id of every vendored file and nothing else", async () => {
        const directory = join(await temporaryDirectory(), "skills");
        const upstream = fakeUpstream({ [COMMIT_A]: upstreamTree() });

        await syncSkills({ directory, ref: COMMIT_A, upstream });

        const lock = JSON.parse(
            await readFile(join(directory, "lock.json"), "utf8"),
        );
        // Ids from `git hash-object`, so the lock can be compared with
        // `git ls-tree <commit>` upstream.
        expect(lock.files.LICENSE).toBe(
            "c8735a0b9bb7b09fc9b6cafdabfc1f2917dbee45",
        );
        expect(lock.files["triage/SKILL.md"]).toBe(
            "7a1dbb2dab909d00ba22f72cc416c889249c2afd",
        );
        expect(lock.files["triage/AGENT-BRIEF.md"]).toBe(
            "6574a71481a02dd8524d387b8fbee75db1469010",
        );
        expect(Object.keys(lock.files)).toEqual([
            "LICENSE",
            "code-review/SKILL.md",
            "codebase-design/SKILL.md",
            "diagnosing-bugs/SKILL.md",
            "implement/SKILL.md",
            "tdd/SKILL.md",
            "tdd/agents/openai.yaml",
            "to-tickets/SKILL.md",
            "triage/AGENT-BRIEF.md",
            "triage/OUT-OF-SCOPE.md",
            "triage/SKILL.md",
        ]);
        expect(
            await Bun.file(join(directory, "grilling/SKILL.md")).exists(),
        ).toBe(false);
        expect(await Bun.file(join(directory, "README.md")).exists()).toBe(
            false,
        );
    });

    test("syncing a moved upstream replaces the copy and rewrites the lock", async () => {
        const directory = join(await temporaryDirectory(), "skills");
        const moved: Record<string, string | FakeFile> = {
            ...upstreamTree(),
            "skills/engineering/triage/SKILL.md": "# triage v2\n",
            "skills/engineering/triage/NEW.md": "new reference\n",
        };
        delete moved["skills/engineering/triage/OUT-OF-SCOPE.md"];
        const upstream = fakeUpstream({
            [COMMIT_A]: upstreamTree(),
            [COMMIT_B]: moved,
        });
        await syncSkills({ directory, ref: COMMIT_A, upstream });

        const result = await syncSkills({ directory, ref: COMMIT_B, upstream });

        expect(result).toEqual({
            previousCommit: COMMIT_A,
            commit: COMMIT_B,
            changedFiles: [
                "triage/NEW.md",
                "triage/OUT-OF-SCOPE.md",
                "triage/SKILL.md",
            ],
        });
        const triage = join(directory, "triage");
        expect(await readFile(join(triage, "SKILL.md"), "utf8")).toBe(
            "# triage v2\n",
        );
        expect(await readFile(join(triage, "NEW.md"), "utf8")).toBe(
            "new reference\n",
        );
        expect(await Bun.file(join(triage, "OUT-OF-SCOPE.md")).exists()).toBe(
            false,
        );
        const lock = JSON.parse(
            await readFile(join(directory, "lock.json"), "utf8"),
        );
        expect(lock.commit).toBe(COMMIT_B);
        expect(Object.keys(lock.files)).toContain("triage/NEW.md");
        expect(Object.keys(lock.files)).not.toContain("triage/OUT-OF-SCOPE.md");
    });

    test("is deterministic: the same upstream commit yields byte-identical output", async () => {
        const directory = join(await temporaryDirectory(), "skills");
        const upstream = fakeUpstream(
            { [COMMIT_A]: upstreamTree() },
            { main: COMMIT_A },
        );
        const first = await syncSkills({ directory, ref: "main", upstream });
        const before = await snapshotOf(directory);

        const second = await syncSkills({
            directory,
            ref: COMMIT_A,
            upstream,
        });

        expect(upstream.fetchedRefs).toEqual(["main", COMMIT_A]);
        expect(first.changedFiles).toContain("triage/SKILL.md");
        expect(first.previousCommit).toBeUndefined();
        expect(second).toEqual({
            previousCommit: COMMIT_A,
            commit: COMMIT_A,
            changedFiles: [],
        });
        expect(await snapshotOf(directory)).toEqual(before);
    });

    test("a resync discards hand edits and stray files in the copy", async () => {
        const directory = join(await temporaryDirectory(), "skills");
        const upstream = fakeUpstream({ [COMMIT_A]: upstreamTree() });
        await syncSkills({ directory, ref: COMMIT_A, upstream });
        await writeFile(join(directory, "tdd/SKILL.md"), "hand edited\n");
        await writeFile(join(directory, "tdd/stray.md"), "stray\n");

        await syncSkills({ directory, ref: COMMIT_A, upstream });

        expect(await readFile(join(directory, "tdd/SKILL.md"), "utf8")).toBe(
            "# tdd\n",
        );
        expect(await Bun.file(join(directory, "tdd/stray.md")).exists()).toBe(
            false,
        );
    });

    test("keeps the executable bit of upstream scripts", async () => {
        const directory = join(await temporaryDirectory(), "skills");
        const upstream = fakeUpstream({
            [COMMIT_A]: {
                ...upstreamTree(),
                "skills/engineering/diagnosing-bugs/scripts/run.sh": {
                    content: "#!/bin/sh\n",
                    mode: "100755",
                },
            },
        });

        await syncSkills({ directory, ref: COMMIT_A, upstream });

        const mode = async (path: string): Promise<number> =>
            (await stat(join(directory, path))).mode & 0o777;
        expect(await mode("diagnosing-bugs/scripts/run.sh")).toBe(0o755);
        expect(await mode("diagnosing-bugs/SKILL.md")).toBe(0o644);
        expect(await mode(".")).toBe(0o755);
    });

    describe("verifying a copy against its lock", () => {
        test("a synced copy verifies clean", async () => {
            const directory = join(await temporaryDirectory(), "skills");
            const upstream = fakeUpstream({ [COMMIT_A]: upstreamTree() });
            await syncSkills({ directory, ref: COMMIT_A, upstream });

            expect(await verifyVendoredCopy(directory)).toEqual([]);
        });

        test("reports hand edits, stray files and missing files", async () => {
            const directory = join(await temporaryDirectory(), "skills");
            const upstream = fakeUpstream({ [COMMIT_A]: upstreamTree() });
            await syncSkills({ directory, ref: COMMIT_A, upstream });
            await writeFile(join(directory, "tdd/SKILL.md"), "hand edited\n");
            await writeFile(join(directory, "tdd/stray.md"), "stray\n");
            await rm(join(directory, "triage/AGENT-BRIEF.md"));

            expect(await verifyVendoredCopy(directory)).toEqual([
                "tdd/SKILL.md differs from the locked upstream content.",
                "tdd/stray.md is not in the lock.",
                "triage/AGENT-BRIEF.md is in the lock but missing.",
            ]);
        });

        test("reports a lock that does not cover exactly the driven skills", async () => {
            const directory = join(await temporaryDirectory(), "skills");
            const upstream = fakeUpstream({ [COMMIT_A]: upstreamTree() });
            await syncSkills({ directory, ref: COMMIT_A, upstream });
            const lockPath = join(directory, "lock.json");
            const lock = JSON.parse(await readFile(lockPath, "utf8"));
            delete lock.skills.tdd;
            await writeFile(lockPath, JSON.stringify(lock));

            expect(await verifyVendoredCopy(directory)).toEqual([
                "lock.json locks the skills code-review, codebase-design, diagnosing-bugs, implement, to-tickets, triage; expected code-review, codebase-design, diagnosing-bugs, implement, tdd, to-tickets, triage.",
            ]);
        });

        test("reports a missing lock", async () => {
            const directory = await temporaryDirectory();

            expect(await verifyVendoredCopy(directory)).toEqual([
                "lock.json is missing or is not a valid lock.",
            ]);
        });
    });

    describe("a failed sync leaves the existing copy and lock untouched", () => {
        const expectFailureKeepsCopy = async (
            broken: FakeCommit,
            message: RegExp,
            brokenCommit = COMMIT_B,
        ): Promise<void> => {
            const parent = await temporaryDirectory();
            const directory = join(parent, "skills");
            const upstream = fakeUpstream({
                [COMMIT_A]: upstreamTree(),
                [brokenCommit]: broken,
            });
            await syncSkills({ directory, ref: COMMIT_A, upstream });
            const before = await snapshotOf(parent);

            await expect(
                syncSkills({ directory, ref: brokenCommit, upstream }),
            ).rejects.toThrow(message);

            expect(await snapshotOf(parent)).toEqual(before);
            expect(upstream.disposed).toEqual([COMMIT_A, brokenCommit]);
        };

        const without = (path: string): FakeCommit => {
            const tree = upstreamTree();
            delete tree[path];
            return tree;
        };

        test("an unknown ref", async () => {
            const parent = await temporaryDirectory();
            const directory = join(parent, "skills");
            const upstream = fakeUpstream({ [COMMIT_A]: upstreamTree() });
            await syncSkills({ directory, ref: COMMIT_A, upstream });
            const before = await snapshotOf(parent);

            await expect(
                syncSkills({ directory, ref: "no-such-ref", upstream }),
            ).rejects.toThrow(/no-such-ref/);

            expect(await snapshotOf(parent)).toEqual(before);
        });

        test("an upstream that dropped a driven skill", async () => {
            await expectFailureKeepsCopy(
                without("skills/engineering/code-review/SKILL.md"),
                /no skill named code-review/,
            );
        });

        test("an upstream that has a driven skill in two buckets", async () => {
            await expectFailureKeepsCopy(
                {
                    ...upstreamTree(),
                    "skills/deprecated/tdd/SKILL.md": "# old tdd\n",
                },
                /tdd in more than one place: skills\/deprecated\/tdd, skills\/engineering\/tdd/,
            );
        });

        test("an upstream without a license", async () => {
            await expectFailureKeepsCopy(without("LICENSE"), /no LICENSE/);
        });

        test("a symlink inside a driven skill", async () => {
            await expectFailureKeepsCopy(
                {
                    ...upstreamTree(),
                    "skills/engineering/tdd/link.md": {
                        content: "../../README.md",
                        mode: "120000",
                    },
                },
                /skills\/engineering\/tdd\/link\.md is not a regular file/,
            );
        });

        test("an abbreviated commit id", async () => {
            await expectFailureKeepsCopy(
                upstreamTree(),
                /not a full commit id: abc1234/,
                "abc1234",
            );
        });
    });
});

describe("the vendored copy in this checkout", () => {
    const directory = join(import.meta.dir, "..", VENDOR_DIRECTORY);

    test("is an untouched sync of the locked upstream commit", async () => {
        expect(await verifyVendoredCopy(directory)).toEqual([]);
    });

    test("pins mattpocock/skills with its MIT license and the driven skills", async () => {
        const lock = JSON.parse(
            await readFile(join(directory, "lock.json"), "utf8"),
        );
        expect(lock.repository).toBe("https://github.com/mattpocock/skills");
        expect(await readFile(join(directory, "LICENSE"), "utf8")).toStartWith(
            "MIT License",
        );
        for (const name of SKILL_NAMES) {
            expect(
                await Bun.file(join(directory, name, "SKILL.md")).exists(),
            ).toBe(true);
        }
        for (const reference of ["AGENT-BRIEF.md", "OUT-OF-SCOPE.md"]) {
            expect(
                await Bun.file(join(directory, "triage", reference)).exists(),
            ).toBe(true);
        }
    });
});

const runGit = (cwd: string, args: ReadonlyArray<string>): string => {
    const result = Bun.spawnSync(
        [
            "git",
            "-c",
            "user.name=Upstream",
            "-c",
            "user.email=upstream@test.local",
            "-c",
            "commit.gpgsign=false",
            ...args,
        ],
        { cwd, stdout: "pipe", stderr: "pipe" },
    );
    if (result.exitCode !== 0) {
        throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
    }
    return result.stdout.toString().trim();
};

/** A local repository standing in for GitHub; returns its path. */
const localUpstream = async (
    tree: Readonly<Record<string, string | FakeFile>>,
): Promise<string> => {
    const path = await temporaryDirectory();
    runGit(path, ["init", "-q", "--initial-branch=main"]);
    for (const [file, entry] of Object.entries(tree)) {
        const { content, mode } =
            typeof entry === "string" ? { content: entry } : entry;
        await Bun.write(join(path, file), content);
        runGit(path, ["add", "--", file]);
        if (mode === "100755") {
            runGit(path, ["update-index", "--chmod=+x", "--", file]);
        }
    }
    runGit(path, ["commit", "-q", "-m", "upstream"]);
    return path;
};

describe("the git upstream", () => {
    test("resolves a branch to its commit and reads that commit's tree", async () => {
        const repository = await localUpstream({
            LICENSE: "MIT\n",
            "skills/engineering/tdd/SKILL.md": "# tdd\n",
            "skills/engineering/tdd/run.sh": {
                content: "#!/bin/sh\n",
                mode: "100755",
            },
        });
        const commit = runGit(repository, ["rev-parse", "HEAD"]);

        const snapshot = await gitUpstream(repository).fetch("main");
        try {
            expect(snapshot.commit).toBe(commit);
            expect(snapshot.entries).toEqual([
                { path: "LICENSE", mode: "100644" },
                { path: "skills/engineering/tdd/SKILL.md", mode: "100644" },
                { path: "skills/engineering/tdd/run.sh", mode: "100755" },
            ]);
            expect(
                new TextDecoder().decode(
                    await snapshot.read("skills/engineering/tdd/SKILL.md"),
                ),
            ).toBe("# tdd\n");
        } finally {
            await snapshot.dispose();
        }
    });

    test("syncs from a full commit id, locking the upstream blob ids", async () => {
        const repository = await localUpstream(upstreamTree());
        const commit = runGit(repository, ["rev-parse", "HEAD"]);
        const directory = join(await temporaryDirectory(), "skills");

        await syncSkills({
            directory,
            ref: commit,
            upstream: gitUpstream(repository),
        });

        const lock = JSON.parse(
            await readFile(join(directory, "lock.json"), "utf8"),
        );
        expect(lock.commit).toBe(commit);
        expect(lock.files["triage/OUT-OF-SCOPE.md"]).toBe(
            runGit(repository, [
                "rev-parse",
                `${commit}:skills/engineering/triage/OUT-OF-SCOPE.md`,
            ]),
        );
        expect(await verifyVendoredCopy(directory)).toEqual([]);
    });

    test("rejects an unknown ref", async () => {
        const repository = await localUpstream({ LICENSE: "MIT\n" });

        await expect(
            gitUpstream(repository).fetch("no-such-ref"),
        ).rejects.toThrow(/no-such-ref/);
    });
});