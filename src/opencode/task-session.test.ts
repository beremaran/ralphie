import { describe, expect, test } from "bun:test";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { Effect, Exit } from "effect";

import {
  createOpenCodeTaskSession,
  makeOpenCodeTaskSessionLayer,
  OpenCodeTaskSession,
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

describe("OpenCode task sessions", () => {
  test("creates a fresh session in the checkout with agent and model", async () => {
    let createParameters: unknown;
    const client = {
      session: {
        create: async (parameters: unknown) => {
          createParameters = parameters;
          return { data: { id: "session-1" } };
        },
      },
    } as unknown as OpencodeClient;

    const result = await createOpenCodeTaskSession(client, {
      directory: "/workspace/repository",
      title: "Implement issue #42",
      selection,
    }).pipe(Effect.runPromise);

    expect(result).toEqual({
      sessionID: "session-1",
      directory: "/workspace/repository",
      selection,
    });
    expect(createParameters).toEqual({
      directory: "/workspace/repository",
      title: "Implement issue #42",
      agent: "build",
      model: {
        providerID: "openrouter",
        id: "anthropic/claude-sonnet",
      },
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
          error: { name: "UnauthorizedError", data: { message: "No auth" } },
        }),
      },
    } as unknown as OpencodeClient;

    const exit = await createOpenCodeTaskSession(client, {
      directory: "/workspace/repository",
      title: "Implement issue #42",
      selection: { agent: "build" },
    }).pipe(Effect.runPromiseExit);

    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("provides the run's existing client through the session service", async () => {
    const client = {
      session: {
        create: async () => ({ data: { id: "session-from-service" } }),
      },
    } as unknown as OpencodeClient;

    const session = await Effect.gen(function* () {
      const sessions = yield* OpenCodeTaskSession;
      return yield* sessions.create({
        directory: "/workspace/repository",
        title: "Task",
        selection: { agent: "build" },
      });
    }).pipe(
      Effect.provide(makeOpenCodeTaskSessionLayer(client)),
      Effect.runPromise,
    );

    expect(session.sessionID).toBe("session-from-service");
  });
});
