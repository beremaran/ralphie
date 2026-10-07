import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { guardReadOnlySessions } from "../../src/harness/app/read-only-session-guard.ts";
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