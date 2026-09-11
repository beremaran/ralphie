import { describe, expect, test } from "bun:test";

import { makeTestProgressRecorder } from "./shared/progress-recorder.ts";
import { makeLiveRuntime } from "../src/runtime.ts";

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
});