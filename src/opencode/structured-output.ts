import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { Effect } from "effect";
import { z } from "zod";

import { RalphieError } from "../shared/error.ts";
import type { OpenCodeModel } from "./model.ts";

export type StructuredOutputRequest<Output> = {
  readonly directory: string;
  readonly title: string;
  readonly prompt: string;
  readonly schema: z.ZodType<Output>;
  readonly retryCount?: number;
  readonly model?: OpenCodeModel;
  readonly variant?: string;
};

export type StructuredOutputResult<Output> = {
  readonly sessionID: string;
  readonly output: Output;
};

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

export const requestStructuredOutput = <Output>(
  client: OpencodeClient,
  request: StructuredOutputRequest<Output>,
): Effect.Effect<StructuredOutputResult<Output>, RalphieError> =>
  Effect.tryPromise({
    try: async () => {
      const session = await client.session.create({
        directory: request.directory,
        title: request.title,
      });

      if (session.error !== undefined || session.data === undefined) {
        throw new Error(
          `Could not create OpenCode session: ${describeApiError(session.error)}`,
        );
      }

      const response = await client.session.prompt({
        sessionID: session.data.id,
        directory: request.directory,
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(request.variant === undefined ? {} : { variant: request.variant }),
        format: {
          type: "json_schema",
          schema: z.toJSONSchema(request.schema),
          retryCount: request.retryCount ?? 2,
        },
        parts: [{ type: "text", text: request.prompt }],
      });

      if (response.error !== undefined || response.data === undefined) {
        throw new Error(
          `OpenCode prompt failed: ${describeApiError(response.error)}`,
        );
      }

      if (response.data.info.error !== undefined) {
        throw new Error(
          `OpenCode assistant failed: ${describeApiError(response.data.info.error)}`,
        );
      }

      const parsed = request.schema.safeParse(response.data.info.structured);
      if (!parsed.success) {
        throw new Error(
          `OpenCode returned invalid structured output: ${z.prettifyError(parsed.error)}`,
        );
      }

      return {
        sessionID: session.data.id,
        output: parsed.data,
      };
    },
    catch: (cause) =>
      new RalphieError({
        message: "Failed to get structured output from OpenCode.",
        cause,
      }),
  });
