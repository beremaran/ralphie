import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { Context, Effect, Layer } from "effect";

import { RalphieError } from "../shared/error.ts";
import type { OpenCodeModel, OpenCodeSelection } from "./model.ts";

export type OpenCodeTaskSessionRequest = {
  readonly directory: string;
  readonly title: string;
  readonly selection: OpenCodeSelection;
};

export type OpenCodeTaskSession = {
  readonly sessionID: string;
  readonly directory: string;
  readonly selection: OpenCodeSelection;
};

type OpenCodePromptParameters = Parameters<
  OpencodeClient["session"]["prompt"]
>[0];

export type OpenCodeTaskPromptInput = Omit<
  OpenCodePromptParameters,
  "sessionID" | "directory" | "agent" | "model" | "variant"
>;

const describeApiError = (error: unknown): string => {
  if (typeof error !== "object" || error === null) return String(error);

  const candidate = error as {
    readonly name?: unknown;
    readonly data?: { readonly message?: unknown };
  };
  const name = typeof candidate.name === "string" ? candidate.name : "OpenCodeError";
  const message =
    typeof candidate.data?.message === "string"
      ? candidate.data.message
      : JSON.stringify(error);

  return `${name}: ${message}`;
};

const createSessionModel = (model: OpenCodeModel) => ({
  providerID: model.providerID,
  id: model.modelID,
});

/**
 * Build prompt parameters for a task session.
 *
 * OpenCode's SDK accepts the model and agent on prompts as well as on session
 * creation. Repeating them here makes every turn explicit, and is required for
 * variants because the SDK accepts `variant` on prompt rather than create.
 */
export const taskSessionPromptParameters = (
  session: OpenCodeTaskSession,
  input: OpenCodeTaskPromptInput,
): OpenCodePromptParameters => ({
  ...input,
  sessionID: session.sessionID,
  directory: session.directory,
  agent: session.selection.agent,
  ...(session.selection.model === undefined
    ? {}
    : { model: session.selection.model }),
  ...(session.selection.variant === undefined
    ? {}
    : { variant: session.selection.variant }),
});

/**
 * Create an isolated task session rooted in a repository checkout.
 *
 * The returned metadata is intentionally small. Callers can use
 * `taskSessionPromptParameters` for either structured or ordinary prompts
 * without accidentally losing the configured agent/model/variant.
 */
export const createOpenCodeTaskSession = (
  client: OpencodeClient,
  request: OpenCodeTaskSessionRequest,
): Effect.Effect<OpenCodeTaskSession, RalphieError> =>
  Effect.tryPromise({
    try: async () => {
      const response = await client.session.create({
        directory: request.directory,
        title: request.title,
        agent: request.selection.agent,
        ...(request.selection.model === undefined
          ? {}
          : { model: createSessionModel(request.selection.model) }),
      });

      if (response.error !== undefined || response.data === undefined) {
        throw new Error(
          `Could not create OpenCode task session: ${describeApiError(response.error)}`,
        );
      }

      return {
        sessionID: response.data.id,
        directory: request.directory,
        selection: request.selection,
      };
    },
    catch: (cause) =>
      new RalphieError({
        message: "Failed to create an OpenCode task session.",
        cause,
      }),
  });

export type OpenCodeTaskSessionService = {
  readonly create: (
    request: OpenCodeTaskSessionRequest,
  ) => Effect.Effect<OpenCodeTaskSession, RalphieError>;
};

export const OpenCodeTaskSession = Context.GenericTag<OpenCodeTaskSessionService>(
  "ralphie/OpenCodeTaskSession",
);

export const makeOpenCodeTaskSessionLayer = (client: OpencodeClient) =>
  Layer.succeed(OpenCodeTaskSession, {
    create: (request: OpenCodeTaskSessionRequest) =>
      createOpenCodeTaskSession(client, request),
  });
