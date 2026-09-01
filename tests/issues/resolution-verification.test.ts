import { describe, expect, test } from "bun:test";
import type { Octokit } from "octokit";

import type { CodexClient } from "../../src/codex/client.ts";
import { makeCodexSessionDiagnostics } from "../../src/agent/task-session.ts";
import { makeResolutionVerificationService } from "../../src/issues/resolution-verification.ts";
import { IssueResolutionStatus } from "../../src/issues/decisions.ts";
import type { IssueExecutionContext } from "../../src/issues/execution.ts";
import {
    makeProgressRecorder,
    type ProgressUpdate,
} from "../../src/progress/progress.ts";

const assistantInfo = (structured: unknown) => ({
    id: "message-1",
    sessionID: "session-1",
    role: "assistant" as const,
    time: { created: 0, completed: 1 },
    parentID: "message-0",
    modelID: "test-model",
    providerID: "test-provider",
    mode: "test",
    agent: "reviewer",
    path: { cwd: "/workspace/repo", root: "/workspace/repo" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    structured,
});

describe("resolution verification", () => {
    test("uses a fresh read-only structured session with invariant and progress checks", async () => {
        const events: ProgressUpdate[] = [];
        const diagnostics = makeCodexSessionDiagnostics(() => "now");
        const controller = new AbortController();
        let createInput: unknown;
        let createOptions: unknown;
        let promptInput: unknown;
        let promptOptions: unknown;
        let verified: unknown;
        const client = {
            session: {
                create: async (input: unknown, options: unknown) => {
                    createInput = input;
                    createOptions = options;
                    return { data: { id: "session-1" } };
                },
                prompt: async (input: unknown, options: unknown) => {
                    promptInput = input;
                    promptOptions = options;
                    return {
                        data: {
                            info: assistantInfo({
                                status: IssueResolutionStatus.Resolved,
                                summary: "The checkout satisfies the issue.",
                                evidence: [
                                    "src/handler.ts implements the fix.",
                                ],
                            }),
                            parts: [],
                        },
                    };
                },
            },
        } as unknown as CodexClient;
        const context: IssueExecutionContext = {
            issue: {
                number: 42,
                title: "Fix the handler",
                url: "issue/42",
                body: "Fix the handler.",
                labels: [],
            },
            repository: "owner/repo",
            repositoryPath: "/workspace/repo",
            targetBranch: "main",
            workspace: "/workspace",
            runId: "run-1",
            octokit: {} as Octokit,
            codex: client,
            codexSelection: {
                agent: "reviewer",
                model: { providerID: "openai", modelID: "gpt-test" },
                variant: "low",
            },
            codexDiagnostics: diagnostics,
            repositoryInvariant: {
                capture: async () => ({ branch: "main", head: "abc123" }),
                verify: async (directory, invariant) => {
                    verified = { directory, invariant };
                },
            },
            signal: controller.signal,
        };

        const result = await makeResolutionVerificationService(
            makeProgressRecorder(events),
        ).verify(context);

        expect(result).toEqual({
            sessionID: "session-1",
            decision: {
                status: IssueResolutionStatus.Resolved,
                summary: "The checkout satisfies the issue.",
                evidence: ["src/handler.ts implements the fix."],
            },
        });
        expect(createInput).toMatchObject({
            directory: "/workspace/repo",
            title: "Verify resolution of issue #42",
        });
        expect(promptInput).toMatchObject({
            agent: "reviewer",
            model: { providerID: "openai", modelID: "gpt-test" },
            variant: "low",
        });
        expect(createOptions).toEqual({ signal: controller.signal });
        expect(promptOptions).toEqual({ signal: controller.signal });
        expect(diagnostics.list("run-1")).toHaveLength(1);
        expect(verified).toEqual({
            directory: "/workspace/repo",
            invariant: { branch: "main", head: "abc123" },
        });
        expect(events.map(({ stage, status }) => ({ stage, status }))).toEqual([
            { stage: "resolution-verification", status: "started" },
            { stage: "resolution-verification", status: "succeeded" },
        ]);
    });
});