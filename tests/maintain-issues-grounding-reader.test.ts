import { describe, expect, test } from "bun:test";
import {
    chmod,
    mkdir,
    mkdtemp,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    GroundingReadAbortedError,
    GroundingFileSystemLive,
    type GroundingFileSystemService,
    type GuidanceFile,
    makeMaintainIssuesGroundingReader,
} from "../src/maintain-issues-grounding-reader.ts";
import {
    CommandAbortedError,
    CommandRunnerLive,
    type CommandResult,
    type CommandRunOptions,
    type CommandRunnerService,
} from "../src/process/command-runner.ts";

const REPOSITORY = "/work/repository";
const BRANCH = "prepare";
const HEAD = "a".repeat(40);

const result = (stdout: string): CommandResult => ({
    exitCode: 0,
    stdout,
    stderr: "",
});

type RecordedCall = {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly options: CommandRunOptions | undefined;
};

const makeRecordingRunner = (
    stdoutFor: (args: ReadonlyArray<string>) => string,
): {
    readonly runner: CommandRunnerService;
    readonly calls: RecordedCall[];
} => {
    const calls: RecordedCall[] = [];
    const runner: CommandRunnerService = {
        run: async (command, args, options) => {
            calls.push({ command, args: [...args], options });
            return result(stdoutFor(args));
        },
    };
    return { runner, calls };
};

const defaultResponder = (args: ReadonlyArray<string>): string => {
    if (args.includes("symbolic-ref")) return BRANCH;
    if (args.includes("rev-parse")) return HEAD;
    return "";
};

const failingRunner: CommandRunnerService = {
    run: async () => ({
        exitCode: 128,
        stdout: "",
        stderr: "fatal: not a git repository",
    }),
};

const makeFakeFileSystem = (overrides: {
    readonly realpath?: (path: string) => Promise<string>;
    readonly readdir?: (path: string) => Promise<ReadonlyArray<string>>;
    readonly readFileBounded?: (
        path: string,
        maxBytes: number,
    ) => Promise<Buffer>;
}): GroundingFileSystemService => ({
    realpath: async (path) =>
        overrides.realpath === undefined ? path : overrides.realpath(path),
    readdir: async (path) =>
        overrides.readdir === undefined ? [] : overrides.readdir(path),
    readFileBounded: async (path, maxBytes) => {
        if (overrides.readFileBounded !== undefined) {
            return overrides.readFileBounded(path, maxBytes);
        }
        throw new Error(`unexpected read: ${path}`);
    },
});

/** A throwaway git repository on branch `prepare` with committed files. */
const makeCleanRepository = async (
    files: Readonly<Record<string, string>>,
    symlinks: Readonly<Record<string, string>> = {},
): Promise<{
    readonly repositoryPath: string;
    readonly head: string;
    readonly cleanup: () => Promise<void>;
}> => {
    const repositoryPath = await mkdtemp(join(tmpdir(), "ralphie-grounding-"));
    const run = async (args: ReadonlyArray<string>): Promise<string> => {
        const outcome = await CommandRunnerLive.run("git", [
            "-C",
            repositoryPath,
            ...args,
        ]);
        if (outcome.exitCode !== 0) {
            throw new Error(`git ${args.join(" ")} failed: ${outcome.stderr}`);
        }
        return outcome.stdout;
    };
    try {
        await run(["init", "-q", "-b", BRANCH]);
        await run(["config", "user.email", "ralphie@test.local"]);
        await run(["config", "user.name", "Ralphie Test"]);
        await run(["config", "commit.gpgsign", "false"]);
        for (const [path, content] of Object.entries(files)) {
            const parts = path.split("/");
            if (parts.length > 1) {
                await mkdir(join(repositoryPath, ...parts.slice(0, -1)), {
                    recursive: true,
                });
            }
            await writeFile(join(repositoryPath, ...parts), content);
        }
        for (const [path, target] of Object.entries(symlinks)) {
            const parts = path.split("/");
            if (parts.length > 1) {
                await mkdir(join(repositoryPath, ...parts.slice(0, -1)), {
                    recursive: true,
                });
            }
            await symlink(target, join(repositoryPath, ...parts));
        }
        await run(["add", "-A"]);
        await run(["commit", "-q", "-m", "guidance"]);
        const head = (await run(["rev-parse", "HEAD"])).trim();
        return {
            repositoryPath,
            head,
            cleanup: () => rm(repositoryPath, { recursive: true, force: true }),
        };
    } catch (cause) {
        await rm(repositoryPath, { recursive: true, force: true });
        throw cause;
    }
};

const makeUnbornRepository = async (): Promise<{
    readonly repositoryPath: string;
    readonly cleanup: () => Promise<void>;
}> => {
    const repositoryPath = await mkdtemp(join(tmpdir(), "ralphie-unborn-"));
    const outcome = await CommandRunnerLive.run("git", [
        "-C",
        repositoryPath,
        "init",
        "-q",
        "-b",
        BRANCH,
    ]);
    if (outcome.exitCode !== 0) {
        await rm(repositoryPath, { recursive: true, force: true });
        throw new Error(`git init failed: ${outcome.stderr}`);
    }
    return {
        repositoryPath,
        cleanup: () => rm(repositoryPath, { recursive: true, force: true }),
    };
};

const fileByPath = (
    outcome: {
        readonly guidance: { readonly files: ReadonlyArray<GuidanceFile> };
    },
    path: string,
): GuidanceFile | undefined =>
    outcome.guidance.files.find((file) => file.path === path);

describe("grounding capture at the live boundary", () => {
    test("grounds a clean checkout and exposes the selected branch HEAD", async () => {
        const fixture = await makeCleanRepository({
            "README.md": "readme\n",
        });
        try {
            const outcome = await makeMaintainIssuesGroundingReader().read({
                repositoryPath: fixture.repositoryPath,
                branch: BRANCH,
            });

            expect(outcome.status).toBe("grounded");
            if (outcome.status !== "grounded") return;
            expect(outcome.grounding).toEqual({
                branch: BRANCH,
                head: fixture.head,
                clean: true,
                readOnly: true,
            });
            expect(outcome.grounding.head.toLowerCase()).toBe(
                fixture.head.toLowerCase(),
            );
            expect(
                outcome.guidance.files.some(
                    (file) =>
                        file.path === "README.md" && file.state === "available",
                ),
            ).toBe(true);
        } finally {
            await fixture.cleanup();
        }
    });

    test("skips a dirty checkout with a diagnostic", async () => {
        const fixture = await makeCleanRepository({ "tracker.txt": "x\n" });
        try {
            await writeFile(
                join(fixture.repositoryPath, "dirty.txt"),
                "dirty\n",
            );
            const outcome = await makeMaintainIssuesGroundingReader().read({
                repositoryPath: fixture.repositoryPath,
                branch: BRANCH,
            });

            expect(outcome.status).toBe("skipped");
            if (outcome.status !== "skipped") return;
            expect(outcome.skip.reason).toBe("dirty-checkout");
            expect(outcome.skip.detail).toContain("uncommitted changes");
        } finally {
            await fixture.cleanup();
        }
    });

    test("skips on a branch mismatch naming both branches", async () => {
        const fixture = await makeCleanRepository({ "tracker.txt": "x\n" });
        try {
            const outcome = await makeMaintainIssuesGroundingReader().read({
                repositoryPath: fixture.repositoryPath,
                branch: "main",
            });

            expect(outcome.status).toBe("skipped");
            if (outcome.status !== "skipped") return;
            expect(outcome.skip.reason).toBe("branch-mismatch");
            expect(outcome.skip.detail).toContain("main");
            expect(outcome.skip.detail).toContain(BRANCH);
        } finally {
            await fixture.cleanup();
        }
    });

    test("skips a missing HEAD on an unborn repository", async () => {
        const fixture = await makeUnbornRepository();
        try {
            const outcome = await makeMaintainIssuesGroundingReader().read({
                repositoryPath: fixture.repositoryPath,
                branch: BRANCH,
            });

            expect(outcome.status).toBe("skipped");
            if (outcome.status !== "skipped") return;
            expect(outcome.skip.reason).toBe("missing-head");
        } finally {
            await fixture.cleanup();
        }
    });

    test("skips a directory that is not a git repository", async () => {
        const directory = await mkdtemp(join(tmpdir(), "ralphie-plain-"));
        try {
            const outcome = await makeMaintainIssuesGroundingReader().read({
                repositoryPath: directory,
                branch: BRANCH,
            });

            expect(outcome.status).toBe("skipped");
            if (outcome.status !== "skipped") return;
            expect(outcome.skip.reason).toBe("unreadable-repository");
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test("skips when git commands fail outright", async () => {
        const outcome = await makeMaintainIssuesGroundingReader(
            failingRunner,
        ).read({ repositoryPath: REPOSITORY, branch: BRANCH });

        expect(outcome.status).toBe("skipped");
        if (outcome.status !== "skipped") return;
        expect(outcome.skip.reason).toBe("unreadable-repository");
    });

    test("skips as unreadable when git returns an invalid HEAD", async () => {
        const { runner } = makeRecordingRunner((args) =>
            args.includes("rev-parse")
                ? "not-a-sha"
                : args.includes("symbolic-ref")
                  ? BRANCH
                  : "",
        );
        const outcome = await makeMaintainIssuesGroundingReader(runner).read({
            repositoryPath: REPOSITORY,
            branch: BRANCH,
        });

        expect(outcome.status).toBe("skipped");
        if (outcome.status !== "skipped") return;
        expect(outcome.skip.reason).toBe("unreadable-repository");
    });

    test("skips before guidance when the repository root cannot be resolved", async () => {
        const { runner } = makeRecordingRunner(defaultResponder);
        const fileSystem = makeFakeFileSystem({
            realpath: async () => {
                throw Object.assign(new Error("no such directory"), {
                    code: "ENOENT",
                });
            },
        });
        const outcome = await makeMaintainIssuesGroundingReader(
            runner,
            fileSystem,
        ).read({ repositoryPath: REPOSITORY, branch: BRANCH });

        expect(outcome.status).toBe("skipped");
        if (outcome.status !== "skipped") return;
        expect(outcome.skip.reason).toBe("unreadable-repository");
    });
});

describe("read-only grounding behavior", () => {
    test("emits exactly three read-only git commands and never repairs", async () => {
        const { runner, calls } = makeRecordingRunner(defaultResponder);
        const reader = makeMaintainIssuesGroundingReader(runner);
        const directory = await mkdtemp(join(tmpdir(), "ralphie-readonly-"));
        try {
            const outcome = await reader.read({
                repositoryPath: directory,
                branch: BRANCH,
            });
            expect(outcome.status).toBe("grounded");
        } finally {
            await rm(directory, { recursive: true, force: true });
        }

        expect(
            calls.map(({ command, args }) => ({
                command,
                args: args.slice(2),
            })),
        ).toEqual([
            { command: "git", args: ["symbolic-ref", "--short", "HEAD"] },
            { command: "git", args: ["rev-parse", "HEAD"] },
            { command: "git", args: ["status", "--porcelain=v1"] },
        ]);
        expect(
            calls.every(
                ({ command, args }) =>
                    command === "git" &&
                    args[0] === "-C" &&
                    args[1] === directory,
            ),
        ).toBe(true);
        const writeCapableVerbs = new Set([
            "add",
            "am",
            "apply",
            "branch",
            "cherry-pick",
            "checkout",
            "clean",
            "clone",
            "commit",
            "fetch",
            "init",
            "merge",
            "mv",
            "pull",
            "push",
            "rebase",
            "reset",
            "restore",
            "revert",
            "rm",
            "stash",
            "submodule",
            "switch",
            "tag",
            "update-ref",
            "worktree",
        ]);
        for (const { args } of calls) {
            expect(writeCapableVerbs.has(args[2] ?? "")).toBe(false);
        }
    });

    test("returns deeply frozen primitive-only values that retain no mutable objects", async () => {
        const fixture = await makeCleanRepository({ "README.md": "hi\n" });
        try {
            const outcome = await makeMaintainIssuesGroundingReader().read({
                repositoryPath: fixture.repositoryPath,
                branch: BRANCH,
            });

            expect(outcome.status).toBe("grounded");
            if (outcome.status !== "grounded") return;
            expect(Object.isFrozen(outcome)).toBe(true);
            expect(Object.isFrozen(outcome.grounding)).toBe(true);
            expect(Object.isFrozen(outcome.guidance)).toBe(true);
            expect(Object.isFrozen(outcome.guidance.files)).toBe(true);
            for (const file of outcome.guidance.files) {
                expect(Object.isFrozen(file)).toBe(true);
                expect(typeof file.content).toBe("string");
                expect(typeof file.path).toBe("string");
            }
            // A serialized result proves no Buffer or other mutable object
            // leaked into the value boundary.
            expect(JSON.stringify(outcome)).not.toContain("Buffer");
        } finally {
            await fixture.cleanup();
        }
    });

    test("uses only the read-only filesystem surface", async () => {
        const calls: string[] = [];
        const fileSystem: GroundingFileSystemService = {
            realpath: async (path) => {
                calls.push(`realpath:${path}`);
                return path;
            },
            readdir: async (path) => {
                calls.push(`readdir:${path}`);
                return [];
            },
            readFileBounded: async (path, _maxBytes) => {
                calls.push(`read:${path}`);
                return Buffer.from("");
            },
        };
        const { runner } = makeRecordingRunner(defaultResponder);
        const directory = await mkdtemp(join(tmpdir(), "ralphie-fs-"));
        try {
            const outcome = await makeMaintainIssuesGroundingReader(
                runner,
                fileSystem,
            ).read({ repositoryPath: directory, branch: BRANCH });
            expect(outcome.status).toBe("grounded");
        } finally {
            await rm(directory, { recursive: true, force: true });
        }

        expect(
            calls.every(
                (call) =>
                    call.startsWith("realpath:") ||
                    call.startsWith("readdir:") ||
                    call.startsWith("read:"),
            ),
        ).toBe(true);
    });
});

describe("grounding abort handling", () => {
    test("propagates an in-flight abort during a git read", async () => {
        const controller = new AbortController();
        const runner: CommandRunnerService = {
            run: (_command, _args, options) =>
                new Promise((_resolve, reject) => {
                    options?.signal?.addEventListener(
                        "abort",
                        () =>
                            reject(
                                new CommandAbortedError({
                                    command: "git symbolic-ref",
                                }),
                            ),
                        { once: true },
                    );
                }),
        };
        const reader = makeMaintainIssuesGroundingReader(runner);

        const pending = reader
            .read({
                repositoryPath: REPOSITORY,
                branch: BRANCH,
                signal: controller.signal,
            })
            .catch((error: unknown) => error);
        controller.abort();
        const outcome = await pending;

        expect(outcome).toBeInstanceOf(CommandAbortedError);
    });

    test("fails fast on a pre-aborted signal", async () => {
        const controller = new AbortController();
        controller.abort();

        const outcome = await makeMaintainIssuesGroundingReader()
            .read({
                repositoryPath: REPOSITORY,
                branch: BRANCH,
                signal: controller.signal,
            })
            .catch((error: unknown) => error);

        expect(outcome).toBeInstanceOf(GroundingReadAbortedError);
    });

    test("aborts between guidance reads once the signal fires", async () => {
        const controller = new AbortController();
        const { runner } = makeRecordingRunner(defaultResponder);
        const fileSystem = makeFakeFileSystem({
            readdir: async () => {
                controller.abort();
                return [];
            },
        });
        const reader = makeMaintainIssuesGroundingReader(runner, fileSystem);

        const outcome = await reader
            .read({
                repositoryPath: REPOSITORY,
                branch: BRANCH,
                signal: controller.signal,
            })
            .catch((error: unknown) => error);

        expect(outcome).toBeInstanceOf(GroundingReadAbortedError);
    });
});

describe("bounded guidance bundle", () => {
    test("loads only allowlisted files in deterministic order", async () => {
        const fixture = await makeCleanRepository({
            "tracker.txt": "x\n",
            "README.md": "readme\n",
            "SECURITY.md": "security\n",
            ".github/ISSUE_TEMPLATE/z.yml": "z\n",
            ".github/ISSUE_TEMPLATE/a.md": "a\n",
            ".github/ISSUE_TEMPLATE.md": "explicit\n",
            ".github/ISSUE_TEMPLATE/ignored.txt": "no\n",
            ".github/ISSUE_TEMPLATE/nested/also.md": "no\n",
            "CODE_OF_CONDUCT.md": "coc\n",
            "CONTRIBUTING.md": "contributing\n",
        });
        try {
            const outcome = await makeMaintainIssuesGroundingReader().read({
                repositoryPath: fixture.repositoryPath,
                branch: BRANCH,
            });

            expect(outcome.status).toBe("grounded");
            if (outcome.status !== "grounded") return;
            const paths = outcome.guidance.files.map((file) => file.path);
            expect(paths).toEqual([
                ".github/ISSUE_TEMPLATE.md",
                ".github/ISSUE_TEMPLATE/a.md",
                ".github/ISSUE_TEMPLATE/z.yml",
                "CODE_OF_CONDUCT.md",
                "CONTRIBUTING.md",
                "README.md",
                "SECURITY.md",
            ]);
            expect(
                outcome.guidance.files
                    .filter((file) => file.state === "available")
                    .map((file) => file.path),
            ).toEqual(paths);
            expect(paths).not.toContain(".github/ISSUE_TEMPLATE/ignored.txt");
            expect(paths).not.toContain(
                ".github/ISSUE_TEMPLATE/nested/also.md",
            );
            expect(paths).not.toContain("tracker.txt");
        } finally {
            await fixture.cleanup();
        }
    });

    test("treats absent optional files as metadata rather than errors", async () => {
        const fixture = await makeCleanRepository({ "tracker.txt": "x\n" });
        try {
            const outcome = await makeMaintainIssuesGroundingReader().read({
                repositoryPath: fixture.repositoryPath,
                branch: BRANCH,
            });

            expect(outcome.status).toBe("grounded");
            if (outcome.status !== "grounded") return;
            expect(outcome.guidance.files).toHaveLength(5);
            for (const file of outcome.guidance.files) {
                expect(file.state).toBe("absent");
                expect(file.content).toBe("");
                expect(file.marker).toBeNull();
                expect(outcome.guidance.truncated).toBe(false);
                expect(outcome.guidance.omitted).toBe(false);
            }
        } finally {
            await fixture.cleanup();
        }
    });

    test("rejects a guidance symlink that escapes the repository", async () => {
        const secretDirectory = await mkdtemp(
            join(tmpdir(), "ralphie-secret-"),
        );
        const secret = join(secretDirectory, "secret.txt");
        await writeFile(secret, "do not read\n");
        const fixture = await makeCleanRepository(
            { "tracker.txt": "x\n" },
            { "README.md": secret },
        );
        try {
            const outcome = await makeMaintainIssuesGroundingReader().read({
                repositoryPath: fixture.repositoryPath,
                branch: BRANCH,
            });

            expect(outcome.status).toBe("grounded");
            if (outcome.status !== "grounded") return;
            const readme = fileByPath(outcome, "README.md");
            expect(readme?.state).toBe("unavailable");
            expect(readme?.detail).toContain("outside the repository");
            expect(readme?.content).toBe("");
        } finally {
            await fixture.cleanup();
            await rm(secretDirectory, { recursive: true, force: true });
        }
    });

    test("allows a symlink that resolves inside the repository", async () => {
        const fixture = await makeCleanRepository(
            { "README.md": "readme content\n" },
            { ".github/ISSUE_TEMPLATE/alias.md": "../../README.md" },
        );
        try {
            const outcome = await makeMaintainIssuesGroundingReader().read({
                repositoryPath: fixture.repositoryPath,
                branch: BRANCH,
            });

            expect(outcome.status).toBe("grounded");
            if (outcome.status !== "grounded") return;
            const alias = fileByPath(
                outcome,
                ".github/ISSUE_TEMPLATE/alias.md",
            );
            expect(alias?.state).toBe("available");
            expect(alias?.content).toBe("readme content\n");
        } finally {
            await fixture.cleanup();
        }
    });

    test("rejects path traversal candidates", async () => {
        const { runner } = makeRecordingRunner(defaultResponder);
        const fileSystem = makeFakeFileSystem({
            realpath: async (path) => path,
            readdir: async () => ["../../../evil.md"],
        });
        const outcome = await makeMaintainIssuesGroundingReader(
            runner,
            fileSystem,
        ).read({ repositoryPath: REPOSITORY, branch: BRANCH });

        expect(outcome.status).toBe("grounded");
        if (outcome.status !== "grounded") return;
        const evil = fileByPath(
            outcome,
            ".github/ISSUE_TEMPLATE/../../../evil.md",
        );
        expect(evil?.state).toBe("unavailable");
        expect(evil?.detail).toContain("escapes the repository root");
    });

    test("marks an unreadable guidance file unavailable with a diagnostic", async () => {
        const fixture = await makeCleanRepository(
            {
                ".gitignore": "secret.txt\n",
                "tracker.txt": "x\n",
            },
            {
                // A committed symlink whose target is gitignored, so the
                // checkout stays clean even though the target (created after
                // the commit) is unreadable.
                ".github/ISSUE_TEMPLATE/unreadable.md": "../../secret.txt",
            },
        );
        try {
            const target = join(fixture.repositoryPath, "secret.txt");
            await writeFile(target, "secret\n");
            await chmod(target, 0o000);
            let unreadable = false;
            try {
                await GroundingFileSystemLive.readFileBounded(target, 1);
            } catch {
                unreadable = true;
            }
            if (!unreadable) return; // root bypasses file permissions

            const outcome = await makeMaintainIssuesGroundingReader().read({
                repositoryPath: fixture.repositoryPath,
                branch: BRANCH,
            });

            expect(outcome.status).toBe("grounded");
            if (outcome.status !== "grounded") return;
            const unreadableFile = fileByPath(
                outcome,
                ".github/ISSUE_TEMPLATE/unreadable.md",
            );
            expect(unreadableFile?.state).toBe("unavailable");
            expect(unreadableFile?.detail).toContain(
                "could not read the guidance file",
            );
        } finally {
            await fixture.cleanup();
        }
    });
});

describe("guidance limits", () => {
    test("truncates an over-budget file with an explicit marker", async () => {
        const fixture = await makeCleanRepository({
            "tracker.txt": "x\n",
            "README.md": "x".repeat(100),
        });
        try {
            const outcome = await makeMaintainIssuesGroundingReader().read(
                {
                    repositoryPath: fixture.repositoryPath,
                    branch: BRANCH,
                },
                {
                    perFileByteLimit: 40,
                    aggregateByteLimit: 100_000,
                },
            );

            expect(outcome.status).toBe("grounded");
            if (outcome.status !== "grounded") return;
            const readme = fileByPath(outcome, "README.md");
            expect(readme?.state).toBe("available");
            expect(readme?.truncated).toBe(true);
            expect(readme?.marker).toBe("[truncated]");
            expect(readme?.content.endsWith("[truncated]")).toBe(true);
            expect(readme?.byteLength).toBe(40);
            expect(outcome.guidance.truncated).toBe(true);
            expect(readme?.originalByteLength).toBeNull();
        } finally {
            await fixture.cleanup();
        }
    });

    test("never splits a UTF-8 code point when truncating", async () => {
        const fixture = await makeCleanRepository({
            "tracker.txt": "x\n",
            "README.md": "é".repeat(30),
        });
        try {
            const outcome = await makeMaintainIssuesGroundingReader().read(
                {
                    repositoryPath: fixture.repositoryPath,
                    branch: BRANCH,
                },
                {
                    perFileByteLimit: 40,
                    aggregateByteLimit: 100_000,
                },
            );

            expect(outcome.status).toBe("grounded");
            if (outcome.status !== "grounded") return;
            const readme = fileByPath(outcome, "README.md");
            expect(readme?.content).not.toContain("\uFFFD");
            expect(readme?.content).toBe("é".repeat(14) + "[truncated]");
            expect(readme?.byteLength).toBe(39);
        } finally {
            await fixture.cleanup();
        }
    });

    test("keeps the truncation marker intact across three-byte code points", async () => {
        const fixture = await makeCleanRepository({
            "tracker.txt": "x\n",
            "README.md": "€".repeat(20),
        });
        try {
            const outcome = await makeMaintainIssuesGroundingReader().read(
                {
                    repositoryPath: fixture.repositoryPath,
                    branch: BRANCH,
                },
                {
                    perFileByteLimit: 50,
                    aggregateByteLimit: 100_000,
                },
            );

            expect(outcome.status).toBe("grounded");
            if (outcome.status !== "grounded") return;
            const readme = fileByPath(outcome, "README.md");
            expect(readme?.content).not.toContain("\uFFFD");
            expect(readme?.content).toBe("€".repeat(13) + "[truncated]");
            expect(readme?.byteLength).toBe(50);
        } finally {
            await fixture.cleanup();
        }
    });

    test("omits an over-budget file when the limit cannot carry a marker", async () => {
        const fixture = await makeCleanRepository({
            "tracker.txt": "x\n",
            "README.md": "abcdefghij",
        });
        try {
            const tight = await makeMaintainIssuesGroundingReader().read(
                {
                    repositoryPath: fixture.repositoryPath,
                    branch: BRANCH,
                },
                { perFileByteLimit: 5, aggregateByteLimit: 100_000 },
            );
            expect(tight.status).toBe("grounded");
            if (tight.status !== "grounded") return;
            const tightReadme = fileByPath(tight, "README.md");
            expect(tightReadme?.state).toBe("omitted");
            expect(tightReadme?.marker).toBe("[omitted]");
            expect(tightReadme?.content).toBe("");
            expect(tightReadme?.detail).toContain(
                "per-file guidance byte limit",
            );
            expect(tight.guidance.omitted).toBe(true);

            const markerFits = await makeMaintainIssuesGroundingReader().read(
                {
                    repositoryPath: fixture.repositoryPath,
                    branch: BRANCH,
                },
                { perFileByteLimit: 9, aggregateByteLimit: 100_000 },
            );
            expect(markerFits.status).toBe("grounded");
            if (markerFits.status !== "grounded") return;
            const markerFitReadme = fileByPath(markerFits, "README.md");
            expect(markerFitReadme?.state).toBe("omitted");
            expect(markerFitReadme?.content).toBe("[omitted]");
        } finally {
            await fixture.cleanup();
        }
    });

    test("keeps zero and tiny limits deterministic", async () => {
        const fixture = await makeCleanRepository({
            "tracker.txt": "x\n",
            "README.md": "abc",
            "SECURITY.md": "",
        });
        try {
            const outcome = await makeMaintainIssuesGroundingReader().read(
                {
                    repositoryPath: fixture.repositoryPath,
                    branch: BRANCH,
                },
                { perFileByteLimit: 0, aggregateByteLimit: 0 },
            );

            expect(outcome.status).toBe("grounded");
            if (outcome.status !== "grounded") return;
            const readme = fileByPath(outcome, "README.md");
            expect(readme?.state).toBe("omitted");
            expect(readme?.marker).toBe("[omitted]");
            expect(readme?.content).toBe("");
            expect(outcome.guidance.totalByteLength).toBe(0);
        } finally {
            await fixture.cleanup();
        }
    });

    test("accepts an empty file as available without truncation", async () => {
        const fixture = await makeCleanRepository({
            "tracker.txt": "x\n",
            "SECURITY.md": "",
        });
        try {
            const outcome = await makeMaintainIssuesGroundingReader().read({
                repositoryPath: fixture.repositoryPath,
                branch: BRANCH,
            });

            expect(outcome.status).toBe("grounded");
            if (outcome.status !== "grounded") return;
            const security = fileByPath(outcome, "SECURITY.md");
            expect(security?.state).toBe("available");
            expect(security?.content).toBe("");
            expect(security?.truncated).toBe(false);
            expect(security?.omitted).toBe(false);
        } finally {
            await fixture.cleanup();
        }
    });

    test("enforces the aggregate byte limit and marks exhausted files", async () => {
        const fixture = await makeCleanRepository({
            "tracker.txt": "x\n",
            "README.md": "r".repeat(10),
            "CONTRIBUTING.md": "c".repeat(20),
        });
        try {
            const outcome = await makeMaintainIssuesGroundingReader().read(
                {
                    repositoryPath: fixture.repositoryPath,
                    branch: BRANCH,
                },
                {
                    perFileByteLimit: 1_000,
                    aggregateByteLimit: 15,
                },
            );

            expect(outcome.status).toBe("grounded");
            if (outcome.status !== "grounded") return;
            expect(outcome.guidance.totalByteLength).toBe(10);
            expect(outcome.guidance.omitted).toBe(true);
            const readme = fileByPath(outcome, "README.md");
            expect(readme?.state).toBe("available");
            const contributing = fileByPath(outcome, "CONTRIBUTING.md");
            expect(contributing?.state).toBe("omitted");
            expect(contributing?.marker).toBe("[omitted]");
            expect(contributing?.detail).toContain("aggregate");
            expect(contributing?.content).toBe("");
        } finally {
            await fixture.cleanup();
        }
    });

    test("rejects invalid limits", async () => {
        const reader = makeMaintainIssuesGroundingReader();
        const invalid: Array<["per-file" | "aggregate", number]> = [
            ["per-file", -1],
            ["per-file", 1.5],
            ["per-file", Number.NaN],
            ["per-file", Number.POSITIVE_INFINITY],
            ["aggregate", -4],
            ["aggregate", 0.5],
        ];
        for (const [kind, value] of invalid) {
            // Limits are rejected eagerly: the error surfaces without any
            // git or filesystem interaction.
            const pending = reader.read(
                { repositoryPath: REPOSITORY, branch: BRANCH },
                kind === "per-file"
                    ? { perFileByteLimit: value }
                    : { aggregateByteLimit: value },
            );
            await expect(pending).rejects.toBeInstanceOf(RangeError);
        }
    });
});