import { describe, expect, test } from "bun:test";
import type { CodexClient } from "../../src/codex/client.ts";
import type { Octokit } from "octokit";

import {
    makeProgressRecorder,
    type ProgressUpdate,
    type ProgressStage,
    type ProgressStatus,
} from "../../src/progress/progress.ts";
import { makeComplexityAssessmentService } from "../../src/issues/complexity.ts";
import { ComplexityLevel } from "../../src/issues/decisions.ts";
import type { IssueExecutionContext } from "../../src/issues/execution.ts";
import { makeCodexSessionDiagnostics } from "../../src/agent/task-session.ts";

const assistantInfo = (structured: unknown) => ({
    id: "message-1",
    sessionID: "session-1",
    role: "assistant" as const,
    time: { created: 0, completed: 1 },
    parentID: "message-0",
    modelID: "test-model",
    providerID: "test-provider",
    mode: "test",
    agent: "build",
    path: { cwd: "/workspace/repo", root: "/workspace/repo" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    structured,
});

const context = (
    client: CodexClient,
    overrides: Partial<
        Pick<IssueExecutionContext, "codexDiagnostics" | "repositoryInvariant">
    > = {},
): IssueExecutionContext => ({
    issue: {
        number: 42,
        title: "Fix token refresh",
        url: "issue/42",
        body: "Refresh expired tokens.",
        labels: ["bug"],
    },
    repository: "owner/repository",
    repositoryPath: "/workspace/repo",
    targetBranch: "main",
    workspace: "/workspace",
    runId: "run-1",
    octokit: {} as Octokit,
    codex: client,
    codexSelection: { agent: "build" },
    codexDiagnostics:
        overrides.codexDiagnostics ?? makeCodexSessionDiagnostics(() => "now"),
    repositoryInvariant: overrides.repositoryInvariant ?? {
        capture: async () => ({ branch: "main", head: "abc123" }),
        verify: async () => {},
    },
});

describe("complexity assessment", () => {
    test("gets a schema-validated decision and reports progress", async () => {
        const events: ProgressUpdate[] = [];
        const client = {
            session: {
                create: async () => ({ data: { id: "session-1" } }),
                prompt: async () => ({
                    data: {
                        info: assistantInfo({
                            complexity: ComplexityLevel.Level2,
                            rationale: "The change is localized.",
                        }),
                        parts: [],
                    },
                }),
            },
        } as unknown as CodexClient;
        const result = await makeComplexityAssessmentService(
            makeProgressRecorder(events),
        ).assess(context(client));
        expect(result).toEqual({
            sessionID: "session-1",
            decision: {
                complexity: ComplexityLevel.Level2,
                rationale: "The change is localized.",
            },
        });
        expect(events.map(({ stage, status }) => ({ stage, status }))).toEqual([
            {
                stage: "complexity-assessment",
                status: "started",
            },
            {
                stage: "complexity-assessment",
                status: "succeeded",
            },
        ]);
    });

    test("fails without mutation when structured output is invalid", async () => {
        const events: ProgressUpdate[] = [];
        const client = {
            session: {
                create: async () => ({ data: { id: "session-1" } }),
                prompt: async () => ({
                    data: {
                        info: assistantInfo({
                            complexity: 9,
                            rationale: "Invalid",
                        }),
                        parts: [],
                    },
                }),
            },
        } as unknown as CodexClient;
        await expect(
            makeComplexityAssessmentService(
                makeProgressRecorder(events),
            ).assess(context(client)),
        ).rejects.toThrow("structured output");
        expect(events.at(-1)?.status).toBe("failed");
    });

    test("records the assessment session and verifies its checkout invariant", async () => {
        const diagnostics = makeCodexSessionDiagnostics(() => "now");
        let verified: unknown;
        const client = {
            session: {
                create: async () => ({ data: { id: "session-1" } }),
                prompt: async () => ({
                    data: {
                        info: assistantInfo({
                            complexity: ComplexityLevel.Level2,
                            rationale: "The change is localized.",
                        }),
                        parts: [],
                    },
                }),
            },
        } as unknown as CodexClient;
        const result = await makeComplexityAssessmentService(
            makeProgressRecorder([]),
        ).assess(
            context(client, {
                codexDiagnostics: diagnostics,
                repositoryInvariant: {
                    capture: async () => ({ branch: "main", head: "abc123" }),
                    verify: async (directory, invariant) => {
                        verified = { directory, invariant };
                    },
                },
            }),
        );
        expect(result.sessionID).toBe("session-1");
        expect(diagnostics.list("run-1")).toHaveLength(1);
        expect(verified).toEqual({
            directory: "/workspace/repo",
            invariant: { branch: "main", head: "abc123" },
        });
    });
});