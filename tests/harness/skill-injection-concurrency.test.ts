import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    rm,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { nodeSkillFileSystem } from "../../src/harness/adapters/skill-file-system.ts";
import {
    makeSessionPreparation,
    type SkillFileSystem,
} from "../../src/harness/app/skill-injection.ts";

const LABELS = {
    "needs-triage": "triage-me",
    "needs-info": "needs-info",
    "ready-for-agent": "agent-ok",
    "ready-for-human": "ready-for-human",
    wontfix: "wontfix",
};

const enotempty = (): Error =>
    Object.assign(new Error("ENOTEMPTY: directory not empty"), {
        code: "ENOTEMPTY",
    });

type Fake = {
    readonly fileSystem: SkillFileSystem;
    readonly files: Map<string, string>;
    readonly directories: Set<string>;
    readonly control: { failNextCopy: boolean };
};

const under = (path: string, root: string): boolean =>
    path === root || path.startsWith(`${root}/`);

/** In-memory file system; a move onto a non-empty directory fails like rename. */
const makeFake = (): Fake => {
    const files = new Map<string, string>();
    const directories = new Set<string>();
    const control = { failNextCopy: false };
    const makeDirectory = (path: string): void => {
        const parts = path.split("/");
        for (let i = 2; i <= parts.length; i++) {
            directories.add(parts.slice(0, i).join("/"));
        }
    };
    const hasEntries = (path: string): boolean =>
        [...files.keys(), ...directories].some(
            (entry) => entry !== path && under(entry, path),
        );
    const relocate = (from: string, to: string, keep: boolean): void => {
        makeDirectory(to);
        const rebase = (path: string): string => to + path.slice(from.length);
        for (const [file, text] of [...files].filter(([f]) => under(f, from))) {
            files.set(rebase(file), text);
            if (!keep) files.delete(file);
        }
        for (const dir of [...directories].filter((d) => under(d, from))) {
            directories.add(rebase(dir));
            if (!keep) directories.delete(dir);
        }
    };
    const fileSystem: SkillFileSystem = {
        exists: async (path) => files.has(path) || directories.has(path),
        listDirectories: async (path) =>
            [...directories]
                .filter(
                    (dir) =>
                        dir.startsWith(`${path}/`) &&
                        !dir.slice(path.length + 1).includes("/"),
                )
                .map((dir) => dir.slice(path.length + 1)),
        copyTree: async (from, to) => {
            if (control.failNextCopy) {
                control.failNextCopy = false;
                throw new Error("disk full");
            }
            relocate(from, to, true);
        },
        move: async (from, to) => {
            if (directories.has(to) && hasEntries(to)) throw enotempty();
            relocate(from, to, false);
        },
        remove: async (path) => {
            for (const file of [...files.keys()]) {
                if (under(file, path)) files.delete(file);
            }
            for (const dir of [...directories]) {
                if (under(dir, path)) directories.delete(dir);
            }
        },
        makeDirectory: async (path) => makeDirectory(path),
        writeText: async (path, contents) => {
            makeDirectory(path.slice(0, path.lastIndexOf("/")));
            files.set(path, contents);
        },
        readText: async (path) => files.get(path),
    };
    return { fileSystem, files, directories, control };
};

type Fixture = {
    readonly checkout: string;
    readonly skills: string;
    readonly fileSystem: SkillFileSystem;
    readonly seed: (path: string, contents: string) => Promise<void>;
    readonly snapshot: () => Promise<Record<string, string>>;
    readonly failNextCopy: () => void;
    readonly git?: (...args: string[]) => Promise<string>;
    readonly cleanup: () => Promise<void>;
};

const fakeFixture = async (): Promise<Fixture> => {
    const fake = makeFake();
    const checkout = "/repo";
    const skills = "/skills";
    await fake.fileSystem.writeText(`${skills}/tdd/SKILL.md`, "ralphie tdd");
    await fake.fileSystem.writeText(`${skills}/code-review/SKILL.md`, "rr");
    await fake.fileSystem.makeDirectory(`${checkout}/.git`);
    return {
        checkout,
        skills,
        fileSystem: fake.fileSystem,
        seed: async (path, contents) => {
            await fake.fileSystem.writeText(`${checkout}/${path}`, contents);
        },
        snapshot: async () => {
            const tree: Record<string, string> = {};
            for (const dir of fake.directories) {
                if (dir.startsWith(`${checkout}/`) && !dir.includes("/.git")) {
                    tree[dir.slice(checkout.length)] = "<dir>";
                }
            }
            for (const [file, text] of fake.files) {
                if (
                    file.startsWith(`${checkout}/`) &&
                    !file.includes("/.git")
                ) {
                    tree[file.slice(checkout.length)] = text;
                }
            }
            return tree;
        },
        failNextCopy: () => {
            fake.control.failNextCopy = true;
        },
        cleanup: async () => {},
    };
};

const walk = async (
    base: string,
    path: string,
    tree: Record<string, string>,
): Promise<void> => {
    const entries = await readdir(join(base, path), { withFileTypes: true });
    for (const entry of entries) {
        const relative = `${path}/${entry.name}`;
        if (relative === "/.git") continue;
        if (entry.isDirectory()) {
            tree[relative] = "<dir>";
            await walk(base, relative, tree);
        } else {
            tree[relative] = await readFile(join(base, relative), "utf8");
        }
    }
};

const git = async (checkout: string, ...args: string[]): Promise<string> => {
    const process = Bun.spawn(
        [
            "git",
            "-C",
            checkout,
            "-c",
            "user.email=a@b.c",
            "-c",
            "user.name=n",
            ...args,
        ],
        { stdout: "pipe", stderr: "pipe" },
    );
    const [out] = await Promise.all([
        new Response(process.stdout).text(),
        process.exited,
    ]);
    return out;
};

const realFixture = async (): Promise<Fixture> => {
    const root = await mkdtemp(join(tmpdir(), "ralphie-skills-par-"));
    const skills = join(root, "skills");
    const checkout = join(root, "repo");
    await mkdir(join(skills, "tdd"), { recursive: true });
    await writeFile(join(skills, "tdd", "SKILL.md"), "ralphie tdd");
    await mkdir(join(skills, "code-review"), { recursive: true });
    await writeFile(join(skills, "code-review", "SKILL.md"), "rr");
    await mkdir(checkout, { recursive: true });
    await git(checkout, "init", "-q");
    const control = { failNextCopy: false };
    const fileSystem: SkillFileSystem = {
        ...nodeSkillFileSystem,
        copyTree: async (from, to) => {
            if (control.failNextCopy) {
                control.failNextCopy = false;
                throw new Error("disk full");
            }
            await nodeSkillFileSystem.copyTree(from, to);
        },
    };
    return {
        checkout,
        skills,
        fileSystem,
        seed: async (path, contents) => {
            const file = join(checkout, path);
            await mkdir(join(file, ".."), { recursive: true });
            await writeFile(file, contents);
        },
        snapshot: async () => {
            const tree: Record<string, string> = {};
            await walk(checkout, "", tree);
            return tree;
        },
        failNextCopy: () => {
            control.failNextCopy = true;
        },
        git: async (...args) => await git(checkout, ...args),
        cleanup: async () => await rm(root, { recursive: true, force: true }),
    };
};

const suites: ReadonlyArray<readonly [string, () => Promise<Fixture>]> = [
    ["fake file system", fakeFixture],
    ["node file system", realFixture],
];

for (const [label, makeFixture] of suites) {
    describe(`parallel sessions in one directory (${label})`, () => {
        let fixture: Fixture;
        let before: Record<string, string>;
        let prepare: ReturnType<typeof makeSessionPreparation>;

        beforeEach(async () => {
            fixture = await makeFixture();
            await fixture.seed(".agents/skills/code-review/SKILL.md", "repo");
            await fixture.seed(".agents/skills/own/SKILL.md", "own");
            if (fixture.git !== undefined) {
                await fixture.git("add", "-A");
                await fixture.git("commit", "-q", "-m", "seed");
            }
            before = await fixture.snapshot();
            prepare = makeSessionPreparation({
                fileSystem: fixture.fileSystem,
                skillsDirectory: fixture.skills,
                labels: LABELS,
            });
        });

        afterEach(async () => await fixture.cleanup());

        const open = async () =>
            await prepare({ directory: fixture.checkout, harness: "codex" });

        const skillText = async (name: string) =>
            await fixture.fileSystem.readText(
                `${fixture.checkout}/.agents/skills/${name}/SKILL.md`,
            );

        const expectRestored = async () => {
            expect(await fixture.snapshot()).toEqual(before);
            if (fixture.git !== undefined) {
                expect(await fixture.git("status", "--porcelain")).toBe("");
            }
        };

        const expectInjected = async () => {
            expect(await skillText("code-review")).toBe("rr");
            expect(await skillText("tdd")).toBe("ralphie tdd");
        };

        for (const order of ["first-then-second", "second-then-first"]) {
            test(`overlapping sessions share one preparation (${order})`, async () => {
                const [a, b] = await Promise.all([open(), open()]);
                await expectInjected();
                const [early, late] =
                    order === "first-then-second" ? [a, b] : [b, a];
                await early();
                await expectInjected();
                await late();
                expect(await skillText("code-review")).toBe("repo");
                expect(await skillText("own")).toBe("own");
                await expectRestored();
            });
        }

        test("a session that starts later joins the live preparation", async () => {
            const a = await open();
            const b = await open();
            await a();
            await expectInjected();
            await b();
            await expectRestored();
        });

        test("releasing twice does not drop another session's hold", async () => {
            const [a, b] = await Promise.all([open(), open()]);
            await a();
            await a();
            await expectInjected();
            await b();
            await expectRestored();
        });

        test("a failed preparation is undone and does not block the next", async () => {
            fixture.failNextCopy();
            const results = await Promise.allSettled([open(), open()]);
            expect(results.map((result) => result.status)).toEqual([
                "rejected",
                "fulfilled",
            ]);
            const survivor = results[1];
            if (survivor?.status !== "fulfilled")
                throw new Error("unreachable");
            await expectInjected();
            await survivor.value();
            await expectRestored();
        });

        test("a failed lone preparation restores the checkout", async () => {
            fixture.failNextCopy();
            await expect(open()).rejects.toThrow("disk full");
            await expectRestored();
        });

        test("a stale shadow from an interrupted run does not collide", async () => {
            await fixture.seed(
                ".agents/.ralphie-shadowed/code-review/SKILL.md",
                "repo",
            );
            await fixture.seed(
                ".agents/skills/code-review/SKILL.md",
                "stale injected",
            );
            const [a, b] = await Promise.all([open(), open()]);
            await expectInjected();
            await a();
            await b();
            expect(await skillText("code-review")).toBe("repo");
            expect(
                await fixture.fileSystem.exists(
                    `${fixture.checkout}/.agents/.ralphie-shadowed`,
                ),
            ).toBe(false);
        });
    });
}