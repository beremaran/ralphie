import { describe, expect, test } from "bun:test";
import type { PiClient } from "../pi/client.ts";
import { Effect, Exit } from "effect";
import { z } from "zod";

import { requestStructuredOutput } from "./structured-output.ts";
import {
  PI_DECISION_PERMISSION_POLICY,
  PiAssistantErrorKind,
  makePiSessionDiagnostics,
  toPiAssistantError,
} from "./task-session.ts";

enum ProbeDecision {
  Proceed = "proceed",
  Stop = "stop",
}

const decisionSchema = z.object({
  decision: z.enum(ProbeDecision),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
});

const assistantInfo = (
  structured: unknown,
  error?: Record<string, unknown>,
) => ({
  id: "message-1",
  sessionID: "session-1",
  role: "assistant" as const,
  time: {
    created: 0,
    completed: 1,
  },
  parentID: "message-0",
  modelID: "test-model",
  providerID: "test-provider",
  mode: "test",
  agent: "test",
  path: {
    cwd: "/workspace",
    root: "/workspace",
  },
  cost: 0,
  tokens: {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: {
      read: 0,
      write: 0,
    },
  },
  structured,
  ...(error === undefined
    ? {}
    : {
        error,
      }),
});

describe("Pi structured output", () => {
  test("sends a JSON schema and validates the assistant decision", async () => {
    let createParameters: unknown;
    let promptParameters: unknown;
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
        prompt: async (parameters: unknown) => {
          promptParameters = parameters;
          return {
            data: {
              info: assistantInfo({
                decision: ProbeDecision.Proceed,
                confidence: 1,
                reason: "The condition is true.",
              }),
              parts: [],
            },
          };
        },
      },
    } as unknown as PiClient;

    const result = await requestStructuredOutput(client, {
      directory: "/workspace",
      title: "Test decision",
      prompt: "Make a decision.",
      schema: decisionSchema,
    }).pipe(Effect.runPromise);

    expect(result).toEqual({
      sessionID: "session-1",
      output: {
        decision: ProbeDecision.Proceed,
        confidence: 1,
        reason: "The condition is true.",
      },
    });
    expect(promptParameters).toMatchObject({
      sessionID: "session-1",
      directory: "/workspace",
      format: {
        type: "json_schema",
        retryCount: 2,
        schema: {
          type: "object",
          required: ["decision", "confidence", "reason"],
        },
      },
      parts: [
        {
          type: "text",
          text: "Make a decision.",
        },
      ],
    });
    expect(promptParameters).not.toHaveProperty("model");
    expect(promptParameters).not.toHaveProperty("variant");
    expect(createParameters).toMatchObject({
      permission: PI_DECISION_PERMISSION_POLICY,
    });
    expect(PI_DECISION_PERMISSION_POLICY).toContainEqual({
      permission: "bash",
      pattern: "git ls-files*",
      action: "allow",
    });
    expect(PI_DECISION_PERMISSION_POLICY.at(-1)).toEqual({
      permission: "bash",
      pattern: "git ls-files*",
      action: "allow",
    });
  });

  test("forwards explicit model and variant overrides", async () => {
    let createParameters: unknown;
    let promptParameters: unknown;
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
        prompt: async (parameters: unknown) => {
          promptParameters = parameters;
          return {
            data: {
              info: assistantInfo({
                decision: ProbeDecision.Proceed,
                confidence: 1,
                reason: "The condition is true.",
              }),
              parts: [],
            },
          };
        },
      },
    } as unknown as PiClient;

    await requestStructuredOutput(client, {
      directory: "/workspace",
      title: "Test decision",
      prompt: "Make a decision.",
      schema: decisionSchema,
      agent: "reviewer",
      model: {
        providerID: "openrouter",
        modelID: "anthropic/claude-sonnet",
      },
      variant: "high",
    }).pipe(Effect.runPromise);

    expect(createParameters).toMatchObject({
      directory: "/workspace",
      title: "Test decision",
      agent: "reviewer",
    });
    expect(promptParameters).toMatchObject({
      agent: "reviewer",
      model: {
        providerID: "openrouter",
        modelID: "anthropic/claude-sonnet",
      },
      variant: "high",
    });
  });

  test("records the session and verifies repository invariants", async () => {
    const diagnostics = makePiSessionDiagnostics(
      () => "2026-08-24T00:00:00.000Z",
    );
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
            info: assistantInfo({
              decision: ProbeDecision.Proceed,
              confidence: 1,
              reason: "The condition is true.",
            }),
            parts: [],
          },
        }),
      },
    } as unknown as PiClient;

    await requestStructuredOutput(client, {
      directory: "/workspace",
      title: "Test decision",
      prompt: "Make a decision.",
      schema: decisionSchema,
      agent: "build",
      runId: "run-1",
      diagnostics,
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

    expect(diagnostics.list("run-1")).toHaveLength(1);
    expect(diagnostics.list("run-1")[0]).toMatchObject({
      sessionID: "session-1",
      directory: "/workspace",
      agent: "build",
    });
    expect(verified).toEqual({
      directory: "/workspace",
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
              info: assistantInfo({
                decision: ProbeDecision.Proceed,
                confidence: 1,
                reason: "The condition is true.",
              }),
              parts: [],
            },
          };
        },
      },
    } as unknown as PiClient;

    await requestStructuredOutput(client, {
      directory: "/workspace",
      title: "Test decision",
      prompt: "Make a decision.",
      schema: decisionSchema,
      signal: controller.signal,
    }).pipe(Effect.runPromise);

    expect(createOptions).toEqual({
      signal: controller.signal,
    });
    expect(promptOptions).toEqual({
      signal: controller.signal,
    });
  });

  test("rejects structured output that does not match the schema", async () => {
    const client = {
      session: {
        create: async () => ({
          data: {
            id: "session-1",
          },
        }),
        prompt: async () => ({
          data: {
            info: assistantInfo({
              decision: "maybe",
              confidence: 4,
            }),
            parts: [],
          },
        }),
      },
    } as unknown as PiClient;

    const exit = await requestStructuredOutput(client, {
      directory: "/workspace",
      title: "Test decision",
      prompt: "Make a decision.",
      schema: decisionSchema,
    }).pipe(Effect.runPromiseExit);

    expect(Exit.isFailure(exit)).toBe(true);
  });

  test.each([
    [
      PiAssistantErrorKind.Aborted,
      {
        name: "MessageAbortedError",
        data: {
          message: "Aborted.",
        },
      },
    ],
    [
      PiAssistantErrorKind.OutputLengthExceeded,
      {
        name: "MessageOutputLengthError",
        data: {},
      },
    ],
    [
      PiAssistantErrorKind.StructuredOutputRetryExhausted,
      {
        name: "StructuredOutputError",
        data: {
          message: "Schema retries exhausted.",
          retries: 2,
        },
      },
    ],
  ])("returns typed assistant failure for %s", async (kind, error) => {
    const client = {
      session: {
        create: async () => ({
          data: {
            id: "session-1",
          },
        }),
        prompt: async () => ({
          data: {
            info: assistantInfo(undefined, error),
            parts: [],
          },
        }),
      },
    } as unknown as PiClient;

    const exit = await requestStructuredOutput(client, {
      directory: "/workspace",
      title: "Test decision",
      prompt: "Make a decision.",
      schema: decisionSchema,
    }).pipe(Effect.runPromiseExit);

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = exit.cause;
      expect(String(failure)).toContain("Pi assistant failed");
      const cause = failure as unknown as {
        error?: {
          cause?: unknown;
        };
      };
      expect(cause).toBeDefined();
    }

    const typed = toPiAssistantError(error as never);
    expect(typed.kind).toBe(kind);
    if (kind === PiAssistantErrorKind.StructuredOutputRetryExhausted) {
      expect(typed.retries).toBe(2);
    }
  });
});