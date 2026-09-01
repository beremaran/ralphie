import { describe, expect, test } from "bun:test";
import type {
    CodexAssistantMessage,
    CodexClient,
    CodexPart,
} from "../../src/codex/client.ts";

import {
    createCodexTaskSession,
    makeCodexTaskSessionService,
    CODEX_SESSION_RETENTION_POLICY,
    CodexSessionRetentionPolicy,
    type CodexAssistantErrorKind,
    CodexAssistantError,
    CODEX_TASK_PERMISSION_POLICY,
    makeCodexSessionDiagnostics,
    runCodexTask,
    toCodexAssistantError,
    taskSessionPromptParameters,
} from "../../src/agent/task-session.ts";

const selection = {
    agent: "build",
    model: {
        providerID: "openrouter",
        modelID: "anthropic/claude-sonnet",
    },
    variant: "high",
};

const assistantResponse = (
    error?: CodexAssistantMessage["error"],
): CodexAssistantMessage => ({
    id: "message-1",
    sessionID: "session-1",
    role: "assistant",
    time: { created: 1, completed: 2 },
    ...(error === undefined ? {} : { error }),
    parentID: "message-0",
    modelID: "claude-sonnet",
    providerID: "openrouter",
    mode: "primary",
    agent: "build",
    path: { cwd: "/workspace/repository", root: "/workspace/repository" },
    cost: 0,
    tokens: {
        input: 1,
        output: 2,
        reasoning: 0,
        cache: { read: 0, write: 0 },
    },
});

const responseParts: ReadonlyArray<CodexPart> = [
    {
        id: "part-1",
        sessionID: "session-1",
        messageID: "message-1",
        type: "text",
        text: "Implemented the requested change.",
    },
];

describe("Codex task sessions", () => {
    test("retains successful sessions for inspection", () => {
        expect(CODEX_SESSION_RETENTION_POLICY).toBe(
            CodexSessionRetentionPolicy,
        );
    });

    test("creates a fresh session in the checkout with agent and model", async () => {
        let createParameters: unknown;
        const client = {
            session: {
                create: async (parameters: unknown) => {
                    createParameters = parameters;
                    return { data: { id: "session-1" } };
                },
            },
        } as unknown as CodexClient;

        const result = await createCodexTaskSession(client, {
            directory: "/workspace/repository",
            title: "Implement issue #42",
            selection,
        });

        expect(result).toEqual({
            sessionID: "session-1",
            directory: "/workspace/repository",
            selection,
        });
        expect(createParameters).toMatchObject({
            directory: "/workspace/repository",
            title: "Implement issue #42",
            agent: "build",
            model: { providerID: "openrouter", id: "anthropic/claude-sonnet" },
            permission: CODEX_TASK_PERMISSION_POLICY,
        });
        expect(createParameters).not.toHaveProperty("variant");
    });

    test("propagates agent, model, and variant to each prompt", () => {
        const session = {
            sessionID: "session-1",
            directory: "/workspace/repository",
            selection,
        };

        expect(
            taskSessionPromptParameters(session, {
                parts: [{ type: "text", text: "Implement the issue." }],
            }),
        ).toEqual({
            sessionID: "session-1",
            directory: "/workspace/repository",
            agent: "build",
            model: {
                providerID: "openrouter",
                modelID: "anthropic/claude-sonnet",
            },
            variant: "high",
            parts: [{ type: "text", text: "Implement the issue." }],
        });
    });

    test("leaves optional model and variant out when not selected", () => {
        const session = {
            sessionID: "session-1",
            directory: "/workspace/repository",
            selection: { agent: "build" },
        };
        const parameters = taskSessionPromptParameters(session, {
            parts: [{ type: "text", text: "Assess the issue." }],
        });

        expect(parameters).toMatchObject({
            sessionID: "session-1",
            directory: "/workspace/repository",
            agent: "build",
        });
        expect(parameters).not.toHaveProperty("model");
        expect(parameters).not.toHaveProperty("variant");
    });

    test("returns a typed failure when session creation fails", async () => {
        const client = {
            session: {
                create: async () => ({
                    error: {
                        name: "UnauthorizedError",
                        data: { message: "No auth" },
                    },
                }),
            },
        } as unknown as CodexClient;

        await expect(
            createCodexTaskSession(client, {
                directory: "/workspace/repository",
                title: "Implement issue #42",
                selection: { agent: "build" },
            }),
        ).rejects.toThrow("Failed to create an Codex task session.");
    });

    test("provides the run's existing client through the session service", async () => {
        const client = {
            session: {
                create: async () => ({ data: { id: "session-from-service" } }),
            },
        } as unknown as CodexClient;

        const sessions = makeCodexTaskSessionService(client);
        const session = await sessions.create({
            directory: "/workspace/repository",
            title: "Task",
            selection: { agent: "build" },
        });

        expect(session.sessionID).toBe("session-from-service");
    });

    test("records every created session under its run ID", async () => {
        const diagnostics = makeCodexSessionDiagnostics(
            () => "2026-08-24T00:00:00.000Z",
        );
        const client = {
            session: {
                create: async () => ({ data: { id: "session-diagnostics" } }),
            },
        } as unknown as CodexClient;

        await createCodexTaskSession(client, {
            directory: "/workspace/repository",
            title: "Task",
            selection,
            runId: "run-1",
            diagnostics,
        });

        expect(diagnostics.list("run-1")).toEqual([
            {
                runId: "run-1",
                sessionID: "session-diagnostics",
                directory: "/workspace/repository",
                agent: "build",
                model: selection.model,
                variant: "high",
                recordedAt: "2026-08-24T00:00:00.000Z",
            },
        ]);
    });

    test("runs a fresh text task and returns response metadata and parts", async () => {
        let promptParameters: unknown;
        const client = {
            session: {
                create: async () => ({ data: { id: "session-1" } }),
                prompt: async (parameters: unknown) => {
                    promptParameters = parameters;
                    return {
                        data: {
                            info: assistantResponse(),
                            parts: responseParts,
                        },
                    };
                },
            },
        } as unknown as CodexClient;

        const result = await runCodexTask(client, {
            directory: "/workspace/repository",
            title: "Implement issue #42",
            prompt: "Implement the issue and explain the result.",
            selection,
        });

        expect(result).toEqual({
            session: {
                sessionID: "session-1",
                directory: "/workspace/repository",
                selection,
            },
            response: assistantResponse(),
            parts: responseParts,
        });
        expect(promptParameters).toEqual({
            sessionID: "session-1",
            directory: "/workspace/repository",
            agent: "build",
            model: {
                providerID: "openrouter",
                modelID: "anthropic/claude-sonnet",
            },
            variant: "high",
            parts: [
                {
                    type: "text",
                    text: "Implement the issue and explain the result.",
                },
            ],
        });
    });

    test("returns a valid needs-attention request separately from the task result", async () => {
        const needsAttention = {
            reason: "missing_information",
            message: "The target runtime is not specified.",
        } as const;
        const client = {
            session: {
                create: async () => ({ data: { id: "session-1" } }),
                prompt: async () => ({
                    data: {
                        info: assistantResponse(),
                        parts: responseParts,
                        needsAttention,
                    },
                }),
            },
        } as unknown as CodexClient;

        const result = await runCodexTask(client, {
            directory: "/workspace/repository",
            title: "Implement issue #42",
            prompt: "Implement the issue.",
            selection: { agent: "build" },
        });

        expect(result.needsAttention).toEqual(needsAttention);
        expect(result.response).toEqual(assistantResponse());
    });

    test("ignores malformed or oversized needs-attention requests", async () => {
        const invalidRequests: ReadonlyArray<unknown> = [
            { reason: "not-a-repository-blocker" },
            {
                reason: "missing_information",
                message: " ",
            },
            {
                reason: "missing_information",
                message: "x".repeat(2_001),
            },
            {
                reason: "missing_information",
                message: "valid message",
                disposition: "needs_attention",
            },
        ];

        for (const needsAttention of invalidRequests) {
            const client = {
                session: {
                    create: async () => ({ data: { id: "session-1" } }),
                    prompt: async () => ({
                        data: {
                            info: assistantResponse(),
                            parts: responseParts,
                            needsAttention,
                        },
                    }),
                },
            } as unknown as CodexClient;

            const result = await runCodexTask(client, {
                directory: "/workspace/repository",
                title: "Implement issue #42",
                prompt: "Implement the issue.",
                selection: { agent: "build" },
            });

            expect(result).not.toHaveProperty("needsAttention");
        }
    });

    test("verifies branch and HEAD after the agent session completes", async () => {
        let verified: unknown;
        const client = {
            session: {
                create: async () => ({ data: { id: "session-1" } }),
                prompt: async () => ({
                    data: { info: assistantResponse(), parts: responseParts },
                }),
            },
        } as unknown as CodexClient;

        await runCodexTask(client, {
            directory: "/workspace/repository",
            title: "Implement issue #42",
            prompt: "Implement the issue.",
            selection: { agent: "build" },
            repositoryInvariant: { branch: "main", head: "abc123" },
            verifyRepositoryInvariant: async (directory, expected) => {
                verified = { directory, expected };
            },
        });

        expect(verified).toEqual({
            directory: "/workspace/repository",
            expected: { branch: "main", head: "abc123" },
        });
    });

    test("threads an AbortSignal to session creation and prompt", async () => {
        const controller = new AbortController();
        let createOptions: unknown;
        let promptOptions: unknown;
        const client = {
            session: {
                create: async (_parameters: unknown, options: unknown) => {
                    createOptions = options;
                    return { data: { id: "session-1" } };
                },
                prompt: async (_parameters: unknown, options: unknown) => {
                    promptOptions = options;
                    return {
                        data: {
                            info: assistantResponse(),
                            parts: responseParts,
                        },
                    };
                },
            },
        } as unknown as CodexClient;

        await runCodexTask(client, {
            directory: "/workspace/repository",
            title: "Implement issue #42",
            prompt: "Implement the issue.",
            selection: { agent: "build" },
            signal: controller.signal,
        });

        expect(createOptions).toEqual({ signal: controller.signal });
        expect(promptOptions).toEqual({ signal: controller.signal });
    });

    test("emits a useful progress failure when the agent session fails", async () => {
        const events: unknown[] = [];
        const client = {
            session: {
                create: async () => ({ data: { id: "session-1" } }),
                prompt: async () => ({
                    data: {
                        info: assistantResponse({
                            name: "MessageAbortedError",
                            data: { message: "The task was aborted." },
                        }),
                        parts: [],
                    },
                }),
            },
        } as unknown as CodexClient;

        await expect(
            runCodexTask(client, {
                directory: "/workspace/repository",
                title: "Implement issue #42",
                prompt: "Implement the issue.",
                selection: { agent: "build" },
                progress: {
                    emit: async (event) => {
                        events.push(event);
                    },
                    stopPersisting: async () => {},
                },
            }),
        ).rejects.toThrow("Codex assistant failed");

        expect(events).toEqual([
            {
                stage: "implementation",
                status: "failed",
                message: expect.stringContaining("Codex task failed"),
                details: {
                    directory: "/workspace/repository",
                    title: "Implement issue #42",
                    assistantError: "aborted",
                    sessionError: "MessageAbortedError",
                    cause: "MessageAbortedError: The task was aborted.",
                },
            },
        ]);
    });

    test("fails when the task prompt transport fails", async () => {
        const client = {
            session: {
                create: async () => ({ data: { id: "session-1" } }),
                prompt: async () => {
                    throw new Error("connection reset");
                },
            },
        } as unknown as CodexClient;

        await expect(
            runCodexTask(client, {
                directory: "/workspace/repository",
                title: "Implement issue #42",
                prompt: "Implement the issue.",
                selection,
            }),
        ).rejects.toThrow("Failed to run an Codex task.");
    });

    test("fails when the assistant returns an error", async () => {
        const client = {
            session: {
                create: async () => ({ data: { id: "session-1" } }),
                prompt: async () => ({
                    data: {
                        info: assistantResponse({
                            name: "MessageAbortedError",
                            data: { message: "The task was aborted." },
                        }),
                        parts: [],
                    },
                }),
            },
        } as unknown as CodexClient;

        await expect(
            runCodexTask(client, {
                directory: "/workspace/repository",
                title: "Implement issue #42",
                prompt: "Implement the issue.",
                selection,
            }),
        ).rejects.toThrow("Codex assistant failed");
    });

    test.each([
        [
            "MessageAbortedError",
            "aborted",
            { name: "MessageAbortedError", data: { message: "Aborted." } },
        ],
        [
            "MessageOutputLengthError",
            "output-length-exceeded",
            { name: "MessageOutputLengthError", data: {} },
        ],
        [
            "StructuredOutputError",
            "structured-output-retry-exhausted",
            {
                name: "StructuredOutputError",
                data: { message: "Could not satisfy schema.", retries: 3 },
            },
        ],
    ])("classifies %s as %s", (_name, kind, sdkError) => {
        const typedError = toCodexAssistantError(sdkError as never);
        expect(typedError).toBeInstanceOf(CodexAssistantError);
        expect(typedError.kind).toBe(kind as CodexAssistantErrorKind);
    });
});