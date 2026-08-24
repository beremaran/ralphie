import { describe, expect, test } from "bun:test";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { Effect, Exit } from "effect";
import { z } from "zod";

import { requestStructuredOutput } from "./structured-output.ts";

const decisionSchema = z.object({
  decision: z.enum(["proceed", "stop"]),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
});

const assistantInfo = (structured: unknown) => ({
  id: "message-1",
  sessionID: "session-1",
  role: "assistant" as const,
  time: { created: 0, completed: 1 },
  parentID: "message-0",
  modelID: "test-model",
  providerID: "test-provider",
  mode: "test",
  agent: "test",
  path: { cwd: "/workspace", root: "/workspace" },
  cost: 0,
  tokens: {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  },
  structured,
});

describe("OpenCode structured output", () => {
  test("sends a JSON schema and validates the assistant decision", async () => {
    let promptParameters: unknown;
    const client = {
      session: {
        create: async () => ({ data: { id: "session-1" } }),
        prompt: async (parameters: unknown) => {
          promptParameters = parameters;
          return {
            data: {
              info: assistantInfo({
                decision: "proceed",
                confidence: 1,
                reason: "The condition is true.",
              }),
              parts: [],
            },
          };
        },
      },
    } as unknown as OpencodeClient;

    const result = await requestStructuredOutput(client, {
      directory: "/workspace",
      title: "Test decision",
      prompt: "Make a decision.",
      schema: decisionSchema,
    }).pipe(Effect.runPromise);

    expect(result).toEqual({
      sessionID: "session-1",
      output: {
        decision: "proceed",
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
      parts: [{ type: "text", text: "Make a decision." }],
    });
  });

  test("rejects structured output that does not match the schema", async () => {
    const client = {
      session: {
        create: async () => ({ data: { id: "session-1" } }),
        prompt: async () => ({
          data: {
            info: assistantInfo({ decision: "maybe", confidence: 4 }),
            parts: [],
          },
        }),
      },
    } as unknown as OpencodeClient;

    const exit = await requestStructuredOutput(client, {
      directory: "/workspace",
      title: "Test decision",
      prompt: "Make a decision.",
      schema: decisionSchema,
    }).pipe(Effect.runPromiseExit);

    expect(Exit.isFailure(exit)).toBe(true);
  });
});
