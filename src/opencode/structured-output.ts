import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { Effect } from "effect";
import { z } from "zod";
import { withOpenCodeAgentPermit } from "./concurrency.ts";

import { RalphieError } from "../shared/error.ts";
import type { OpenCodeModel } from "./model.ts";
import {
  OPEN_CODE_DECISION_PERMISSION_POLICY,
  type OpenCodeRepositoryInvariant,
  type OpenCodeSessionDiagnostics,
  reportOpenCodeFailure,
  toOpenCodeAssistantError,
} from "./task-session.ts";
import {
  ProgressStage,
  type ProgressIssue,
  type ProgressReporterService,
} from "../progress/progress.ts";

export type StructuredOutputRequest<Output> = {
  readonly directory: string;
  readonly title: string;
  readonly prompt: string;
  readonly schema: z.ZodType<Output>;
  readonly retryCount?: number;
  readonly agent?: string;
  readonly model?: OpenCodeModel;
  readonly variant?: string;
  readonly runId?: string;
  readonly diagnostics?: OpenCodeSessionDiagnostics;
  readonly signal?: AbortSignal;
  readonly repositoryInvariant?: OpenCodeRepositoryInvariant;
  readonly verifyRepositoryInvariant?: (
    repositoryPath: string,
    expected: OpenCodeRepositoryInvariant,
  ) => Effect.Effect<void, RalphieError>;
  readonly verifyAfter?: () => Effect.Effect<void, RalphieError>;
  readonly progress?: ProgressReporterService;
  readonly progressStage?: ProgressStage;
  readonly progressIssue?: ProgressIssue;
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

export function requestStructuredOutput<Output>(
  client: OpencodeClient,
  request: StructuredOutputRequest<Output>,
): Effect.Effect<StructuredOutputResult<Output>, RalphieError> {
  return withOpenCodeAgentPermit(
    client,
    Effect.gen(function* () {
      const result = yield* Effect.tryPromise({
        try: async () => {
          const session = await client.session.create(
            {
              directory: request.directory,
              title: request.title,
              ...(request.agent === undefined ? {} : { agent: request.agent }),
              permission: OPEN_CODE_DECISION_PERMISSION_POLICY,
            },
            request.signal === undefined ? undefined : { signal: request.signal },
          );

          if (session.error !== undefined || session.data === undefined) {
            throw new Error(
              `Could not create OpenCode session: ${describeApiError(session.error)}`,
            );
          }

          if (request.runId !== undefined && request.diagnostics !== undefined) {
            request.diagnostics.record(request.runId, {
              sessionID: session.data.id,
              directory: request.directory,
              ...(request.agent === undefined ? {} : { agent: request.agent }),
              ...(request.model === undefined ? {} : { model: request.model }),
              ...(request.variant === undefined ? {} : { variant: request.variant }),
            });
          }

          const response = await client.session.prompt(
            {
              sessionID: session.data.id,
              directory: request.directory,
              ...(request.agent === undefined ? {} : { agent: request.agent }),
              ...(request.model === undefined ? {} : { model: request.model }),
              ...(request.variant === undefined ? {} : { variant: request.variant }),
              format: {
                type: "json_schema",
                schema: z.toJSONSchema(request.schema),
                retryCount: request.retryCount ?? 2,
              },
              parts: [{ type: "text", text: request.prompt }],
            },
            request.signal === undefined ? undefined : { signal: request.signal },
          );

          if (response.error !== undefined || response.data === undefined) {
            throw new Error(
              `OpenCode prompt failed: ${describeApiError(response.error)}`,
            );
          }

          if (response.data.info.error !== undefined) {
            const assistantError = toOpenCodeAssistantError(response.data.info.error);
            throw new RalphieError({
              message: `OpenCode assistant failed (${assistantError.kind}): ${assistantError.message}`,
              cause: assistantError,
            });
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
          cause instanceof RalphieError
            ? cause
            : new RalphieError({
                message: "Failed to get structured output from OpenCode.",
                cause,
              }),
      }).pipe(Effect.tapError((error) => reportOpenCodeFailure(request, error)));

      if (
        request.repositoryInvariant !== undefined &&
        request.verifyRepositoryInvariant !== undefined
      ) {
        yield* request.verifyRepositoryInvariant(
          request.directory,
          request.repositoryInvariant,
        );
      }
      if (request.verifyAfter !== undefined) {
        yield* request.verifyAfter();
      }

      return result;
    }),
  );
}
