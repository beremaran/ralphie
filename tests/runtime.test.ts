import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
    IssueArtifactKind,
    makeIssueArtifactStore,
} from "../src/issues/app/artifacts.ts";
import type { HarnessService } from "../src/harness/ports.ts";
import { sessionsFor } from "./shared/agent-sessions.ts";
import { makeTestProgressRecorder } from "./shared/progress-recorder.ts";
import { makeLiveRuntime } from "../src/runtime.ts";
import { CommandRunnerLive } from "../src/process/adapters/command-runner.ts";
import type { CommandRunOptions } from "../src/process/ports.ts";
import { makeGitFixture } from "./shared/git-fixture.ts";
import { testLayout } from "./shared/test-values.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = originalFetch;
});

const jsonResponse = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });

describe("runtime factory", () => {
    test("assembles the issue-mode services without starting a session", () => {
        const runtime = makeLiveRuntime({
            progress: makeTestProgressRecorder([]),
            runEventLog: { append: () => {}, close: () => {} },
            layout: testLayout(),
        });

        expect(runtime.githubIssues).toBeDefined();
        expect(runtime.githubIssues.listOpen).toBeFunction();
        expect(runtime.issueExecutor).toBeDefined();
        expect(runtime.issueExecutor.execute).toBeFunction();
        expect(runtime.decompositionExecutor).toBeDefined();
        expect(runtime.decompositionExecutor.execute).toBeFunction();
        expect(runtime.implementationExecutor).toBeDefined();
        expect(runtime.implementationExecutor.execute).toBeFunction();
        expect(runtime.gitRepository).toBeDefined();
        expect(runtime.gitRepository.verifyInstalled).toBeFunction();
        expect(runtime.runStateStore).toBeDefined();
        expect(runtime.runStateStore.save).toBeFunction();
        expect(runtime.workspace).toBeDefined();
        expect(runtime.workspace.prepare).toBeFunction();
    });

    test("composes the Claude Code harness over the process port", async () => {
        const spawned: string[] = [];
        const runtime = makeLiveRuntime({
            progress: makeTestProgressRecorder([]),
            runEventLog: { append: () => {}, close: () => {} },
            layout: testLayout(),
            commandRunner: {
                run: async (command) => {
                    spawned.push(command);
                    return { exitCode: 1, stdout: "", stderr: "stub" };
                },
            },
        });

        const outcome = await runtime.harness.run({
            role: "implementer",
            harness: "claude",
            prompt: "p",
            directory: "/work/repo",
            access: "safe",
            timeoutMs: 1_000,
        });

        expect(spawned).toEqual(["claude"]);
        expect(outcome).toMatchObject({ ok: false, failure: { kind: "exit" } });
    });

    test("runs sessions isolated from credentials and guards read-only ones", async () => {
        const fixture = await makeGitFixture();
        const harnessCalls: CommandRunOptions[] = [];
        const runtime = makeLiveRuntime({
            progress: makeTestProgressRecorder([]),
            runEventLog: { append: () => {}, close: () => {} },
            layout: testLayout(),
            commandRunner: {
                run: async (command, args, options) => {
                    if (command !== "claude") {
                        return await CommandRunnerLive.run(
                            command,
                            args,
                            options,
                        );
                    }
                    harnessCalls.push(options ?? {});
                    // A misbehaving read-only session that edits the tree.
                    await writeFile(
                        join(fixture.repositoryPath, "stray.txt"),
                        "edited\n",
                    );
                    return { exitCode: 1, stdout: "", stderr: "stub" };
                },
            },
        });
        try {
            const outcome = await runtime.harness.run({
                role: "spec-reviewer",
                harness: "claude",
                prompt: "p",
                directory: fixture.repositoryPath,
                access: "read-only",
                timeoutMs: 1_000,
            });

            expect(outcome).toMatchObject({
                ok: false,
                failure: { kind: "access" },
            });
            expect(harnessCalls).toHaveLength(1);
            const env = harnessCalls[0]?.env ?? {};
            // An undefined entry removes the variable from the child.
            expect("GH_TOKEN" in env).toBe(true);
            expect(env["GH_TOKEN"]).toBeUndefined();
            expect(env["GH_CONFIG_DIR"]).toBeString();
            expect(env["GIT_SSH_COMMAND"]).toBe("false");
        } finally {
            await fixture.cleanup();
        }
    });

    test("publishes decomposition children with the configured ready-for-agent label", async () => {
        const created: Array<{ labels?: string[] }> = [];
        globalThis.fetch = (async (
            input: string | URL | Request,
            init?: RequestInit,
        ) => {
            const url = new URL(
                typeof input === "string" || input instanceof URL
                    ? input
                    : input.url,
            );
            const method = init?.method ?? "GET";
            if (
                method === "POST" &&
                url.pathname === "/repos/owner/repo/issues"
            ) {
                created.push(JSON.parse(String(init?.body)));
                return jsonResponse(201, {
                    id: 900,
                    number: 101,
                    title: "First slice",
                    html_url: "https://github.com/owner/repo/issues/101",
                    body: null,
                    labels: [],
                    state: "open",
                    updated_at: "2026-01-01T00:00:00Z",
                    comments: 0,
                });
            }
            return method === "GET"
                ? jsonResponse(200, [])
                : jsonResponse(500, { message: "stop after the first create" });
        }) as typeof fetch;
        const runtime = makeLiveRuntime({
            progress: makeTestProgressRecorder([]),
            runEventLog: { append: () => {}, close: () => {} },
            layout: testLayout(),
            skills: {
                directory: "/skills",
                labels: {
                    "needs-triage": "needs-triage",
                    "needs-info": "needs-info",
                    "ready-for-agent": "agent-ready-custom",
                    "ready-for-human": "ready-for-human",
                    wontfix: "wontfix",
                },
            },
            commandRunner: {
                run: async () => ({ exitCode: 0, stdout: "token", stderr: "" }),
            },
        });
        await runtime.githubConnection.connect();
        const store = await makeIssueArtifactStore(42);
        await store.write(IssueArtifactKind.IssueBreakdownDecision, {
            rationale: "One slice.",
            issues: [
                {
                    key: "first",
                    title: "First slice",
                    whatToBuild: "Build it.",
                    acceptanceCriteria: ["It works."],
                    dependsOn: [],
                },
            ],
        });
        const harness = {
            run: async () => ({ ok: false }),
        } as unknown as HarnessService;
        await runtime.decompositionExecutor
            .execute({
                artifacts: store,
                context: {
                    issue: {
                        number: 42,
                        title: "Parent",
                        url: "https://github.com/owner/repo/issues/42",
                        body: "Parent body.",
                        labels: [],
                        state: "open",
                        updatedAt: "2026-01-01T00:00:00Z",
                        comments: [],
                        commentCount: 0,
                        commentVersion: "2026-01-01T00:00:00Z",
                    },
                    repository: "owner/repo",
                    repositoryPath: "/work/repository",
                    targetBranch: "develop",
                    workspace: "/work/workspace",
                    runId: "test-run",
                    runLayout: testLayout("/work/workspace", "test-run"),
                    agent: sessionsFor(harness),
                    repositoryInvariant: {
                        capture: async () => ({
                            branch: "develop",
                            head: "a".repeat(40),
                        }),
                        verify: async () => {},
                    },
                },
            })
            .catch(() => undefined);
        expect(created[0]?.labels).toEqual(["agent-ready-custom"]);
    });
});