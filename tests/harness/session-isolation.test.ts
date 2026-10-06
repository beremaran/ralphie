import { describe, expect, test } from "bun:test";
import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeTemporaryScratchDirectories } from "../../src/harness/adapters/scratch-directory.ts";
import {
    guardReadOnlySessions,
    isolateSessions,
} from "../../src/harness/app/session-isolation.ts";
import type {
    HarnessService,
    SessionRequest,
} from "../../src/harness/ports.ts";
import { makeGitWorkingTreeService } from "../../src/git/adapters/working-tree.ts";
import { CommandRunnerLive } from "../../src/process/adapters/command-runner.ts";
import { makeFakeHarness } from "../shared/fake-harness.ts";

const request = (overrides: Partial<SessionRequest> = {}): SessionRequest => ({
    role: "implementer",
    harness: "claude",
    prompt: "work",
    directory: "/work/repo",
    access: "safe",
    timeoutMs: 1000,
    ...overrides,
});

const exists = (path: string) =>
    access(path).then(
        () => true,
        () => false,
    );

describe("session environment isolation", () => {
    test("removes GitHub tokens and points GH_CONFIG_DIR at an empty directory that is removed afterwards", async () => {
        const fake = makeFakeHarness({
            roles: { implementer: { text: "ok" } },
        });
        const listed: string[][] = [];
        const probe: HarnessService = {
            run: (async (req: SessionRequest) => {
                listed.push(await readdir(req.env?.GH_CONFIG_DIR ?? ""));
                return await fake.service.run(req);
            }) as HarnessService["run"],
        };
        const service = isolateSessions(
            probe,
            makeTemporaryScratchDirectories(),
        );
        await service.run(
            request({
                env: {
                    GH_TOKEN: "secret",
                    KEEP: "1",
                    GH_CONFIG_DIR: "/home/me/.config/gh",
                },
            }),
        );
        const env = fake.requests[0]?.env ?? {};
        expect("GH_TOKEN" in env && env.GH_TOKEN === undefined).toBe(true);
        expect("GITHUB_TOKEN" in env && env.GITHUB_TOKEN === undefined).toBe(
            true,
        );
        expect(env.KEEP).toBe("1");
        expect(env.GH_CONFIG_DIR).toContain("ralphie-session-");
        expect(listed).toEqual([[]]);
        expect(await exists(env.GH_CONFIG_DIR ?? "")).toBe(false);
    });

    test("a spawned process sees no token and the empty config directory", async () => {
        const probe: HarnessService = {
            run: (async (req: SessionRequest) => {
                const result = await CommandRunnerLive.run(
                    "sh",
                    ["-c", 'echo "[${GH_TOKEN-unset}][${GH_CONFIG_DIR}]"'],
                    { env: req.env ?? {} },
                );
                return {
                    ok: true,
                    harnessSessionID: "x",
                    text: result.stdout.trim(),
                    value: undefined,
                };
            }) as HarnessService["run"],
        };
        const previous = process.env.GH_TOKEN;
        process.env.GH_TOKEN = "secret";
        try {
            const outcome = await isolateSessions(
                probe,
                makeTemporaryScratchDirectories(),
            ).run(request());
            expect(outcome.ok && outcome.text).toMatch(
                /^\[unset\]\[.*ralphie-session-.*\]$/,
            );
        } finally {
            if (previous === undefined) delete process.env.GH_TOKEN;
            else process.env.GH_TOKEN = previous;
        }
    });
});

describe("session git and ssh isolation", () => {
    test("a spawned git sees no credential helper, no ssh agent and a failing ssh command", async () => {
        const repository = await mkdtemp(join(tmpdir(), "ralphie-ssh-"));
        const probe: HarnessService = {
            run: (async (req: SessionRequest) => {
                await CommandRunnerLive.run("git", [
                    "-C",
                    repository,
                    "init",
                    "-q",
                ]);
                await CommandRunnerLive.run("git", [
                    "-C",
                    repository,
                    "config",
                    "credential.helper",
                    "store",
                ]);
                const helper = await CommandRunnerLive.run(
                    "git",
                    ["-C", repository, "config", "--get", "credential.helper"],
                    { env: req.env ?? {} },
                );
                const env = await CommandRunnerLive.run(
                    "sh",
                    [
                        "-c",
                        'echo "[${SSH_AUTH_SOCK-unset}][$GIT_TERMINAL_PROMPT]"; $GIT_SSH_COMMAND || echo failed',
                    ],
                    { env: req.env ?? {} },
                );
                return {
                    ok: true,
                    harnessSessionID: "x",
                    text: `${helper.stdout.trim()}|${env.stdout.trim()}`,
                    value: undefined,
                };
            }) as HarnessService["run"],
        };
        const previous = process.env.SSH_AUTH_SOCK;
        process.env.SSH_AUTH_SOCK = "/tmp/agent.sock";
        try {
            const outcome = await isolateSessions(
                probe,
                makeTemporaryScratchDirectories(),
            ).run(request());
            expect(outcome.ok && outcome.text).toBe("|[unset][0]\nfailed");
        } finally {
            await rm(repository, { recursive: true, force: true });
            if (previous === undefined) delete process.env.SSH_AUTH_SOCK;
            else process.env.SSH_AUTH_SOCK = previous;
        }
    });
});

describe("read-only session guard", () => {
    const withRepository = async (
        body: (path: string) => Promise<void>,
    ): Promise<void> => {
        const path = await mkdtemp(join(tmpdir(), "ralphie-guard-"));
        const git = async (...args: string[]) => {
            const result = await CommandRunnerLive.run("git", [
                "-C",
                path,
                ...args,
            ]);
            if (result.exitCode !== 0) throw new Error(result.stderr);
        };
        try {
            await git("init", "-q");
            await git("config", "user.email", "t@test.local");
            await git("config", "user.name", "T");
            await writeFile(join(path, "a.txt"), "a\n");
            await git("add", ".");
            await git("commit", "-q", "-m", "base");
            await body(path);
        } finally {
            await rm(path, { recursive: true, force: true });
        }
    };
    const guarded = (
        mutate: (path: string) => Promise<void>,
        sessionAccess: SessionRequest["access"] = "read-only",
    ) => {
        const fake = makeFakeHarness({
            roles: { "standards-reviewer": { text: "ok" } },
        });
        const inner: HarnessService = {
            run: (async (req: SessionRequest) => {
                await mutate(req.directory);
                return await fake.service.run(req);
            }) as HarnessService["run"],
        };
        const service = guardReadOnlySessions(
            inner,
            makeGitWorkingTreeService(CommandRunnerLive).fingerprint,
        );
        return (path: string) =>
            service.run(
                request({
                    role: "standards-reviewer",
                    directory: path,
                    access: sessionAccess,
                }),
            );
    };

    test("passes a session that leaves the tree alone", async () => {
        await withRepository(async (path) => {
            expect((await guarded(async () => {})(path)).ok).toBe(true);
        });
    });

    for (const [name, mutate] of [
        [
            "edits a tracked file",
            (p: string) => writeFile(join(p, "a.txt"), "changed\n"),
        ],
        [
            "adds an untracked file",
            (p: string) => writeFile(join(p, "new.txt"), "x\n"),
        ],
    ] as const) {
        test(`fails closed when the session ${name}`, async () => {
            await withRepository(async (path) => {
                const outcome = await guarded(mutate)(path);
                expect(outcome.ok).toBe(false);
                if (!outcome.ok) expect(outcome.failure.kind).toBe("access");
            });
        });
    }

    test("fails closed when an untracked file is edited in place", async () => {
        await withRepository(async (path) => {
            await writeFile(join(path, "u.txt"), "one\n");
            const outcome = await guarded((p) =>
                writeFile(join(p, "u.txt"), "two\n"),
            )(path);
            expect(outcome.ok).toBe(false);
        });
    });

    test("fails closed when the session stages a change", async () => {
        await withRepository(async (path) => {
            await writeFile(join(path, "a.txt"), "changed\n");
            const outcome = await guarded(async (p) => {
                await CommandRunnerLive.run("git", ["-C", p, "add", "a.txt"]);
            })(path);
            expect(outcome.ok).toBe(false);
        });
    });

    test("does not inspect editing sessions", async () => {
        await withRepository(async (path) => {
            const outcome = await guarded(
                (p) => writeFile(join(p, "a.txt"), "changed\n"),
                "safe",
            )(path);
            expect(outcome.ok).toBe(true);
        });
    });
});