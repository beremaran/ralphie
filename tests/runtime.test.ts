import { describe, expect, test } from "bun:test";

import { makeTestProgressRecorder } from "./shared/progress-recorder.ts";
import { makeLiveRuntime } from "../src/runtime.ts";
import { testLayout } from "./shared/test-values.ts";

describe("runtime factory", () => {
    test("assembles the issue-mode services without starting the agent", () => {
        const runtime = makeLiveRuntime({
            agentRuntime: {
                start: async () => {
                    throw new Error(
                        "The agent must not start while assembling runtime",
                    );
                },
            },
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
            agentRuntime: { start: async () => ({}) as never },
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
});