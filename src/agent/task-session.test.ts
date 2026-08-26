import { describe, expect, test } from "bun:test";
import type { PiAssistantMessage, PiClient, PiPart } from "../pi/client.ts";
import { Effect, Exit } from "effect";

import {
  createPiTaskSession,
  makePiTaskSessionLayer,
  PI_SESSION_RETENTION_POLICY,
  PiSessionRetentionPolicy,
  PiAssistantErrorKind,
  PiTaskSession,
  PiAssistantError,
  PI_TASK_PERMISSION_POLICY,
  makePiSessionDiagnostics,
  runPiTask,
  toPiAssistantError,
  taskSessionPromptParameters,
} from "./task-session.ts";

const selection = {
  agent: "build",
  model: {
    providerID: "openrouter",
    modelID: "anthropic/claude-sonnet",
  },
  variant: "high",
};

const assistantResponse = (
  error?: PiAssistantMessage["error"],
): PiAssistantMessage => ({
  id: "message-1",
  sessionID: "session-1",
  role: "assistant",
  time: {
    created: 1,
    completed: 2,
  },
  ...(error === undefined
    ? {}
    : {
        error,
      }),
  parentID: "message-0",
  modelID: "claude-sonnet",
  providerID: "openrouter",
  mode: "primary",
  agent: "build",
  path: {
    cwd: "/workspace/repository",
    root: "/workspace/repository",
  },
  cost: 0,
  tokens: {
    input: 1,
    output: 2,
    reasoning: 0,
    cache: {
      read: 0,
      write: 0,
    },
  },
});

const responseParts: ReadonlyArray<PiPart> = [
  {
    id: "part-1",
    sessionID: "session-1",
    messageID: "message-1",
    type: "text",
    text: "Implemented the requested change.",
  },
];

describe("Pi task sessions", () => {
  test("retains successful sessions for inspection", () => {
    expect(PI_SESSION_RETENTION_POLICY).toBe(PiSessionRetentionPolicy.Retain);
  });
  test("creates a fresh session in the checkout with agent and model", async () => {
    let createParameters: unknown;
    const client = {
      session: {
        create: async (parameters: unknown) => {
          createParameters = parameters;
          return {
            data: {
              id: "session-1",
            },
          };
        },
      },
    } as unknown as PiClient;

    const result = await createPiTaskSession(client, {
      directory: "/workspace/repository",
      title: "Implement issue #42",
      selection,
    }).pipe(Effect.runPromise);

    expect(result).toEqual({
      sessionID: "session-1",
      directory: "/workspace/repository",
      selection,
    });
    expect(createParameters).toMatchObject({
      directory: "/workspace/repository",
      title: "Implement issue #42",
      agent: "build",
      model: {
        providerID: "openrouter",
        id: "anthropic/claude-sonnet",
      },
      permission: PI_TASK_PERMISSION_POLICY,
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
        parts: [
          {
            type: "text",
            text: "Implement the issue.",
          },
        ],
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
      parts: [
        {
          type: "text",
          text: "Implement the issue.",
        },
      ],
    });
  });

  test("leaves optional model and variant out when not selected", () => {
    const session = {
      sessionID: "session-1",
      directory: "/workspace/repository",
      selection: {
        agent: "build",
      },
    };

    const parameters = taskSessionPromptParameters(session, {
      parts: [
        {
          type: "text",
          text: "Assess the issue.",
        },
      ],
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
            data: {
              message: "No auth",
            },
          },
        }),
      },
    } as unknown as PiClient;

    const exit = await createPiTaskSession(client, {
      directory: "/workspace/repository",
      title: "Implement issue #42",
      selection: {
        agent: "build",
      },
    }).pipe(Effect.runPromiseExit);

    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("provides the run's existing client through the session service", async () => {
    const client = {
      session: {
        create: async () => ({
          data: {
            id: "session-from-service",
          },
        }),
      },
    } as unknown as PiClient;

    const session = await Effect.gen(function* () {
      const sessions = yield* PiTaskSession;
      return yield* sessions.create({
        directory: "/workspace/repository",
        title: "Task",
        selection: {
          agent: "build",
        },
      });
    }).pipe(Effect.provide(makePiTaskSessionLayer(client)), Effect.runPromise);

    expect(session.sessionID).toBe("session-from-service");
  });

  test("records every created session under its run ID", async () => {
    const diagnostics = makePiSessionDiagnostics(
      () => "2026-08-24T00:00:00.000Z",
    );
    const client = {
      session: {
        create: async () => ({
          data: {
            id: "session-diagnostics",
          },
        }),
      },
    } as unknown as PiClient;

    await createPiTaskSession(client, {
      directory: "/workspace/repository",
      title: "Task",
      selection,
      runId: "run-1",
      diagnostics,
    }).pipe(Effect.runPromise);

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
        create: async () => ({
          data: {
            id: "session-1",
          },
        }),
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
    } as unknown as PiClient;

    const result = await runPiTask(client, {
      directory: "/workspace/repository",
      title: "Implement issue #42",
      prompt: "Implement the issue and explain the result.",
      selection,
    }).pipe(Effect.runPromise);

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

  test("verifies branch and HEAD after the agent session completes", async () => {
    let verified: unknown;
    const client = {
      session: {
        create: async () => ({
          data: {
            id: "session-1",
          },
        }),
        prompt: async () => ({
          data: {
            info: assistantResponse(),
            parts: responseParts,
          },
        }),
      },
    } as unknown as PiClient;

    await runPiTask(client, {
      directory: "/workspace/repository",
      title: "Implement issue #42",
      prompt: "Implement the issue.",
      selection: {
        agent: "build",
      },
      repositoryInvariant: {
        branch: "main",
        head: "abc123",
      },
      verifyRepositoryInvariant: (directory, expected) =>
        Effect.sync(() => {
          verified = {
            directory,
            expected,
          };
        }),
    }).pipe(Effect.runPromise);

    expect(verified).toEqual({
      directory: "/workspace/repository",
      expected: {
        branch: "main",
        head: "abc123",
      },
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
          return {
            data: {
              id: "session-1",
            },
          };
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
    } as unknown as PiClient;

    await runPiTask(client, {
      directory: "/workspace/repository",
      title: "Implement issue #42",
      prompt: "Implement the issue.",
      selection: {
        agent: "build",
      },
      signal: controller.signal,
    }).pipe(Effect.runPromise);

    expect(createOptions).toEqual({
      signal: controller.signal,
    });
    expect(promptOptions).toEqual({
      signal: controller.signal,
    });
  });

  test("emits a useful progress failure when the agent session fails", async () => {
    const events: unknown[] = [];
    const client = {
      session: {
        create: async () => ({
          data: {
            id: "session-1",
          },
        }),
        prompt: async () => ({
          data: {
            info: assistantResponse({
              name: "MessageAbortedError",
              data: {
                message: "The task was aborted.",
              },
            }),
            parts: [],
          },
        }),
      },
    } as unknown as PiClient;

    const exit = await runPiTask(client, {
      directory: "/workspace/repository",
      title: "Implement issue #42",
      prompt: "Implement the issue.",
      selection: {
        agent: "build",
      },
      progress: {
        emit: (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        stopPersisting: Effect.void,
      },
    }).pipe(Effect.runPromiseExit);

    expect(Exit.isFailure(exit)).toBe(true);
    expect(events).toEqual([
      {
        stage: "implementation",
        status: "failed",
        message: expect.stringContaining("Pi task failed"),
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
        create: async () => ({
          data: {
            id: "session-1",
          },
        }),
        prompt: async () => {
          throw new Error("connection reset");
        },
      },
    } as unknown as PiClient;

    const exit = await runPiTask(client, {
      directory: "/workspace/repository",
      title: "Implement issue #42",
      prompt: "Implement the issue.",
      selection: {
        agent: "build",
      },
    }).pipe(Effect.runPromiseExit);

    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("fails when the assistant returns an error", async () => {
    const client = {
      session: {
        create: async () => ({
          data: {
            id: "session-1",
          },
        }),
        prompt: async () => ({
          data: {
            info: assistantResponse({
              name: "MessageAbortedError",
              data: {
                message: "The task was aborted.",
              },
            }),
            parts: [],
          },
        }),
      },
    } as unknown as PiClient;

    const exit = await runPiTask(client, {
      directory: "/workspace/repository",
      title: "Implement issue #42",
      prompt: "Implement the issue.",
      selection: {
        agent: "build",
      },
    }).pipe(Effect.runPromiseExit);

    expect(Exit.isFailure(exit)).toBe(true);
  });

  test.each([
    [
      "MessageAbortedError",
      PiAssistantErrorKind.Aborted,
      {
        name: "MessageAbortedError",
        data: {
          message: "Aborted.",
        },
      },
    ],
    [
      "MessageOutputLengthError",
      PiAssistantErrorKind.OutputLengthExceeded,
      {
        name: "MessageOutputLengthError",
        data: {},
      },
    ],
    [
      "StructuredOutputError",
      PiAssistantErrorKind.StructuredOutputRetryExhausted,
      {
        name: "StructuredOutputError",
        data: {
          message: "Could not satisfy schema.",
          retries: 3,
        },
      },
    ],
  ])("classifies %s as %s", (_name, kind, sdkError) => {
    const typedError = toPiAssistantError(sdkError as never);

    expect(typedError).toBeInstanceOf(PiAssistantError);
    expect(typedError.kind).toBe(kind);
  });
});