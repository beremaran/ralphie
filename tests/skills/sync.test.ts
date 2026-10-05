import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
    VENDORED_SKILLS,
    VENDOR_DIRECTORY,
    digestVendored,
    readLock,
    syncSkills,
    verifyVendored,
} from "../../scripts/skills-sync.ts";
import { CommandRunnerLive } from "../../src/process/adapters/command-runner.ts";

describe("the vendored skills", () => {
    test("ship every skill and the upstream MIT license, matching the lock", async () => {
        await verifyVendored();
        const lock = await readLock();
        expect(lock.commit).toMatch(/^[0-9a-f]{40}$/);
        expect(Object.keys(lock.skills).sort()).toEqual(
            [...VENDORED_SKILLS].sort(),
        );
        expect(
            await readFile(join(VENDOR_DIRECTORY, "LICENSE"), "utf8"),
        ).toContain("MIT License");
        expect(
            (
                await stat(
                    join(
                        VENDOR_DIRECTORY,
                        "skills",
                        "triage",
                        "AGENT-BRIEF.md",
                    ),
                )
            ).isFile(),
        ).toBe(true);
    });

    test("fail verification when a vendored file is edited by hand", async () => {
        const scratch = await mkdtemp(join(tmpdir(), "ralphie-vendor-copy-"));
        try {
            const copy = join(scratch, "vendor");
            await Bun.$`cp -R ${VENDOR_DIRECTORY} ${copy}`.quiet();
            await verifyVendored(copy);
            await writeFile(
                join(copy, "skills", "tdd", "SKILL.md"),
                "patched\n",
            );
            await expect(verifyVendored(copy)).rejects.toThrow(
                "never edited by hand",
            );
        } finally {
            await rm(scratch, { recursive: true, force: true });
        }
    });
});

describe("skills sync", () => {
    let scratch: string;
    let upstream: string;
    let destination: string;

    const git = async (...args: string[]): Promise<string> => {
        const result = await CommandRunnerLive.run("git", args, {
            cwd: upstream,
            trimStdout: true,
        });
        if (result.exitCode !== 0) throw new Error(result.stderr);
        return result.stdout;
    };

    const put = async (path: string, content: string): Promise<void> => {
        await mkdir(dirname(join(upstream, path)), { recursive: true });
        await writeFile(join(upstream, path), content);
    };

    const commit = async (message: string): Promise<string> => {
        await git("add", "-A");
        await git("commit", "-q", "-m", message);
        return git("rev-parse", "HEAD");
    };

    beforeEach(async () => {
        scratch = await mkdtemp(join(tmpdir(), "ralphie-skills-upstream-"));
        upstream = join(scratch, "upstream");
        destination = join(scratch, "vendor");
        await mkdir(upstream);
        await git("init", "-q", "-b", "main");
        await git("config", "user.email", "test@example.test");
        await git("config", "user.name", "Test");
        await git("config", "commit.gpgsign", "false");
        await put("LICENSE", "MIT License\n\nCopyright (c) Upstream\n");
        for (const name of VENDORED_SKILLS) {
            await put(`skills/engineering/${name}/SKILL.md`, `# ${name} v1\n`);
        }
        await put("skills/productivity/other/SKILL.md", "# not vendored\n");
        await put("skills/engineering/tdd/tests.md", "tests v1\n");
    });
    afterEach(() => rm(scratch, { recursive: true, force: true }));

    test("copies only the Ralphie skills, the license and a lock", async () => {
        const first = await commit("v1");
        const lock = await syncSkills({
            repository: upstream,
            destination,
        });

        expect(lock.commit).toBe(first);
        expect(lock.skills.tdd).toBe("skills/engineering/tdd");
        expect(
            await readFile(
                join(destination, "skills", "tdd", "tests.md"),
                "utf8",
            ),
        ).toBe("tests v1\n");
        expect(
            await stat(join(destination, "skills", "other")).catch(() => null),
        ).toBeNull();
        expect(await readFile(join(destination, "LICENSE"), "utf8")).toContain(
            "MIT License",
        );
        await verifyVendored(destination);
        expect(await readLock(destination)).toEqual(lock);
    });

    test("is deterministic for the same ref", async () => {
        await commit("v1");
        const first = await syncSkills({ repository: upstream, destination });
        const digest = await digestVendored(destination);
        const second = await syncSkills({ repository: upstream, destination });
        expect(second).toEqual(first);
        expect(await digestVendored(destination)).toBe(digest);
    });

    test("moves to a requested ref and drops files upstream removed", async () => {
        const first = await commit("v1");
        await syncSkills({ repository: upstream, destination });

        await put("skills/engineering/tdd/SKILL.md", "# tdd v2\n");
        await git("rm", "-q", "skills/engineering/tdd/tests.md");
        const second = await commit("v2");

        const moved = await syncSkills({ repository: upstream, destination });
        expect(moved.commit).toBe(second);
        expect(
            await readFile(
                join(destination, "skills", "tdd", "SKILL.md"),
                "utf8",
            ),
        ).toBe("# tdd v2\n");
        expect(
            await stat(join(destination, "skills", "tdd", "tests.md")).catch(
                () => null,
            ),
        ).toBeNull();

        const pinned = await syncSkills({
            repository: upstream,
            ref: first,
            destination,
        });
        expect(pinned).toMatchObject({ commit: first, ref: first });
        expect(
            await readFile(
                join(destination, "skills", "tdd", "SKILL.md"),
                "utf8",
            ),
        ).toBe("# tdd v1\n");
        await verifyVendored(destination);
    });

    test("finds skills wherever upstream moves them", async () => {
        await commit("v1");
        await mkdir(join(upstream, "skills", "deep", "nested"), {
            recursive: true,
        });
        await git("mv", "skills/engineering/tdd", "skills/deep/nested/tdd");
        await commit("reorganize");
        const lock = await syncSkills({ repository: upstream, destination });
        expect(lock.skills.tdd).toBe("skills/deep/nested/tdd");
    });

    test("fails when an upstream skill disappears and leaves the copy untouched", async () => {
        await commit("v1");
        await syncSkills({ repository: upstream, destination });
        const before = await digestVendored(destination);
        await git("rm", "-rq", "skills/engineering/triage");
        await commit("drop triage");

        await expect(
            syncSkills({ repository: upstream, destination }),
        ).rejects.toThrow("exactly one upstream skill named triage");
        expect(await digestVendored(destination)).toBe(before);
    });
});