import type {
  PiAssistantMessage,
  PiClient,
  PiPart,
  PiPermissionRuleset,
} from "../pi/client.ts";
import { Context, Data, Effect, Layer } from "effect";

import {
  ProgressStage,
  ProgressStatus,
  type ProgressIssue,
  type ProgressReporterService,
} from "../progress/progress.ts";
import { RalphieError } from "../shared/error.ts";
import type { PiModel, PiSelection } from "./model.ts";
import { withPiAgentPermit } from "./concurrency.ts";

export type PiTaskSessionRequest = {
  readonly directory: string;
  readonly title: string;
  readonly selection: PiSelection;
  readonly runId?: string;
  readonly diagnostics?: PiSessionDiagnostics;
  readonly signal?: AbortSignal;
};

export type PiTaskSession = {
  readonly sessionID: string;
  readonly directory: string;
  readonly selection: PiSelection;
};

export type PiTaskRequest = PiTaskSessionRequest & {
  readonly prompt: string;
  readonly repositoryInvariant?: PiRepositoryInvariant;
  readonly verifyRepositoryInvariant?: PiRepositoryInvariantVerifier;
  readonly verifyAfter?: () => Effect.Effect<void, RalphieError>;
  readonly progress?: ProgressReporterService;
  readonly progressStage?: ProgressStage;
  readonly progressIssue?: ProgressIssue;
};

export type PiTaskResult = {
  readonly session: PiTaskSession;
  readonly response: PiAssistantMessage;
  readonly parts: ReadonlyArray<PiPart>;
};

export enum PiAssistantErrorKind {
  Aborted = "aborted",
  OutputLengthExceeded = "output-length-exceeded",
  StructuredOutputRetryExhausted = "structured-output-retry-exhausted",
  Other = "other",
}

export class PiAssistantError extends Data.TaggedError("PiAssistantError")<{
  readonly kind: PiAssistantErrorKind;
  readonly message: string;
  readonly errorName: string;
  readonly retries?: number;
  readonly sdkError: NonNullable<PiAssistantMessage["error"]>;
}> {}

export type PiRepositoryInvariant = {
  readonly branch: string;
  readonly head: string;
};

export type PiRepositoryInvariantVerifier = (
  repositoryPath: string,
  expected: PiRepositoryInvariant,
) => Effect.Effect<void, RalphieError>;

export type PiSessionDiagnostic = {
  readonly runId: string;
  readonly sessionID: string;
  readonly directory: string;
  readonly agent?: string;
  readonly model?: PiModel;
  readonly variant?: string;
  readonly recordedAt: string;
};

export type PiSessionDiagnosticInput = Omit<
  PiSessionDiagnostic,
  "runId" | "recordedAt"
>;

/** Successful sessions remain available for post-run inspection. */
export enum PiSessionRetentionPolicy {
  Retain = "retain",
}

export const PI_SESSION_RETENTION_POLICY = PiSessionRetentionPolicy.Retain;

export type PiSessionDiagnostics = {
  readonly record: (runId: string, session: PiSessionDiagnosticInput) => void;
  readonly list: (runId: string) => ReadonlyArray<PiSessionDiagnostic>;
};

export const makePiSessionDiagnostics = (
  now: () => string = () => new Date().toISOString(),
): PiSessionDiagnostics => {
  const sessions = new Map<string, PiSessionDiagnostic[]>();

  return {
    record: (runId, session) => {
      const runSessions = sessions.get(runId) ?? [];
      runSessions.push({
        ...session,
        runId,
        recordedAt: now(),
      });
      sessions.set(runId, runSessions);
    },
    list: (runId) => [...(sessions.get(runId) ?? [])],
  };
};

/**
 * Pi permission rules for task agents. The agent may inspect and edit
 * files, but deterministic Ralphie steps retain ownership of commits, pushes,
 * branch changes, worktrees, resets/cleanups, and GitHub mutations.
 */
export const PI_TASK_PERMISSION_POLICY: PiPermissionRuleset = [
  {
    permission: "bash",
    pattern: "git commit*",
    action: "deny",
  },
  {
    permission: "bash",
    pattern: "git push*",
    action: "deny",
  },
  {
    permission: "bash",
    pattern: "git branch*",
    action: "deny",
  },
  {
    permission: "bash",
    pattern: "git checkout*",
    action: "deny",
  },
  {
    permission: "bash",
    pattern: "git switch*",
    action: "deny",
  },
  {
    permission: "bash",
    pattern: "git worktree*",
    action: "deny",
  },
  {
    permission: "bash",
    pattern: "git reset*",
    action: "deny",
  },
  {
    permission: "bash",
    pattern: "git clean*",
    action: "deny",
  },
  {
    permission: "bash",
    pattern: "gh *",
    action: "deny",
  },
];

/**
 * Structured decision sessions may inspect repository files and read Git state,
 * but cannot mutate the checkout. Pi permission rules use the last
 * matching rule, so the narrow read-only allowances must follow the catch-all
 * Bash denial.
 */
export const PI_DECISION_PERMISSION_POLICY: PiPermissionRuleset = [
  {
    permission: "edit",
    pattern: "*",
    action: "deny",
  },
  {
    permission: "write",
    pattern: "*",
    action: "deny",
  },
  {
    permission: "bash",
    pattern: "*",
    action: "deny",
  },
  ...PI_TASK_PERMISSION_POLICY,
  {
    permission: "bash",
    pattern: "git status*",
    action: "allow",
  },
  {
    permission: "bash",
    pattern: "git diff*",
    action: "allow",
  },
  {
    permission: "bash",
    pattern: "git ls-files*",
    action: "allow",
  },
];

type PiPromptParameters = Parameters<PiClient["session"]["prompt"]>[0];

export type PiTaskPromptInput = Omit<
  PiPromptParameters,
  "sessionID" | "directory" | "agent" | "model" | "variant"
>;

const describeApiError = (error: unknown): string => {
  if (typeof error !== "object" || error === null) return String(error);

  const candidate = error as {
    readonly name?: unknown;
    readonly data?: {
      readonly message?: unknown;
    };
  };
  const name = typeof candidate.name === "string" ? candidate.name : "PiError";
  const message =
    typeof candidate.data?.message === "string"
      ? candidate.data.message
      : JSON.stringify(error);

  return `${name}: ${message}`;
};

export const toPiAssistantError = (
  error: NonNullable<PiAssistantMessage["error"]>,
): PiAssistantError => {
  const kind =
    error.name === "MessageAbortedError"
      ? PiAssistantErrorKind.Aborted
      : error.name === "MessageOutputLengthError"
        ? PiAssistantErrorKind.OutputLengthExceeded
        : error.name === "StructuredOutputError"
          ? PiAssistantErrorKind.StructuredOutputRetryExhausted
          : PiAssistantErrorKind.Other;

  return new PiAssistantError({
    kind,
    message: describeApiError(error),
    errorName: error.name,
    ...(error.name === "StructuredOutputError" &&
    error.data?.retries !== undefined
      ? {
          retries: error.data.retries,
        }
      : {}),
    sdkError: error,
  });
};

const assistantFailure = (
  prefix: string,
  error: NonNullable<PiAssistantMessage["error"]>,
): RalphieError => {
  const typedError = toPiAssistantError(error);
  return new RalphieError({
    message: `${prefix} (${typedError.kind}): ${typedError.message}`,
    cause: typedError,
  });
};

export const reportPiFailure = (
  request: {
    readonly directory: string;
    readonly title: string;
    readonly progress?: ProgressReporterService;
    readonly progressStage?: ProgressStage;
    readonly progressIssue?: ProgressIssue;
  },
  error: RalphieError,
): Effect.Effect<void> => {
  if (request.progress === undefined) return Effect.void;

  const assistantError =
    error.cause instanceof PiAssistantError ? error.cause : undefined;
  const causeMessage = (() => {
    let cause: unknown = error.cause;
    for (let depth = 0; depth < 4 && cause !== undefined; depth += 1) {
      if (cause instanceof Error && cause.message !== error.message)
        return cause.message;
      if (typeof cause !== "object" || cause === null || !("cause" in cause))
        break;
      cause = (
        cause as {
          readonly cause?: unknown;
        }
      ).cause;
    }
    return undefined;
  })();
  return request.progress
    .emit({
      stage: request.progressStage ?? ProgressStage.Implementation,
      status: ProgressStatus.Failed,
      ...(request.progressIssue === undefined
        ? {}
        : {
            issue: request.progressIssue,
          }),
      message: `Pi task failed: ${error.message}`,
      details: {
        directory: request.directory,
        title: request.title,
        ...(causeMessage === undefined
          ? {}
          : {
              cause: causeMessage,
            }),
        ...(assistantError === undefined
          ? {}
          : {
              assistantError: assistantError.kind,
              sessionError: assistantError.errorName,
              ...(assistantError.retries === undefined
                ? {}
                : {
                    retries: assistantError.retries,
                  }),
            }),
      },
    })
    .pipe(Effect.catchAll(() => Effect.void));
};

const createSessionModel = (model: PiModel) => ({
  providerID: model.providerID,
  id: model.modelID,
});

/**
 * Build prompt parameters for a task session.
 *
 * Pi's SDK accepts the model and agent on prompts as well as on session
 * creation. Repeating them here makes every turn explicit, and is required for
 * variants because the SDK accepts `variant` on prompt rather than create.
 */
export const taskSessionPromptParameters = (
  session: PiTaskSession,
  input: PiTaskPromptInput,
): PiPromptParameters => ({
  ...input,
  sessionID: session.sessionID,
  directory: session.directory,
  agent: session.selection.agent,
  ...(session.selection.model === undefined
    ? {}
    : {
        model: session.selection.model,
      }),
  ...(session.selection.variant === undefined
    ? {}
    : {
        variant: session.selection.variant,
      }),
});

/**
 * Create an isolated task session rooted in a repository checkout.
 *
 * The returned metadata is intentionally small. Callers can use
 * `taskSessionPromptParameters` for either structured or ordinary prompts
 * without accidentally losing the configured agent/model/variant.
 */
export const createPiTaskSession = (
  client: PiClient,
  request: PiTaskSessionRequest,
): Effect.Effect<PiTaskSession, RalphieError> =>
  Effect.tryPromise({
    try: async () => {
      const response = await client.session.create(
        {
          directory: request.directory,
          title: request.title,
          agent: request.selection.agent,
          permission: PI_TASK_PERMISSION_POLICY,
          ...(request.selection.model === undefined
            ? {}
            : {
                model: createSessionModel(request.selection.model),
              }),
        },
        request.signal === undefined
          ? undefined
          : {
              signal: request.signal,
            },
      );

      if (response.error !== undefined || response.data === undefined) {
        throw new Error(
          `Could not create Pi task session: ${describeApiError(response.error)}`,
        );
      }

      const session = {
        sessionID: response.data.id,
        directory: request.directory,
        selection: request.selection,
      };

      if (request.runId !== undefined && request.diagnostics !== undefined) {
        request.diagnostics.record(request.runId, {
          sessionID: session.sessionID,
          directory: session.directory,
          agent: session.selection.agent,
          model: session.selection.model,
          variant: session.selection.variant,
        });
      }

      return session;
    },
    catch: (cause) =>
      new RalphieError({
        message: "Failed to create an Pi task session.",
        cause,
      }),
  });

/**
 * Run an ordinary text task in a new session and return the final assistant
 * message together with all response parts.
 *
 * Structured-output callers should continue to use `requestStructuredOutput`,
 * while implementation and review agents can use this helper for free-form
 * text responses and repository edits.
 */
export const runPiTask = (
  client: PiClient,
  request: PiTaskRequest,
): Effect.Effect<PiTaskResult, RalphieError> =>
  withPiAgentPermit(
    client,
    Effect.gen(function* () {
      const session = yield* createPiTaskSession(client, request);

      const response = yield* Effect.tryPromise({
        try: async () => {
          const response = await client.session.prompt(
            taskSessionPromptParameters(session, {
              parts: [
                {
                  type: "text",
                  text: request.prompt,
                },
              ],
            }),
            request.signal === undefined
              ? undefined
              : {
                  signal: request.signal,
                },
          );

          if (response.error !== undefined || response.data === undefined) {
            throw new Error(
              `Pi task prompt failed: ${describeApiError(response.error)}`,
            );
          }

          return response.data;
        },
        catch: (cause) =>
          new RalphieError({
            message: "Failed to run an Pi task.",
            cause,
          }),
      });

      if (response.info.error !== undefined) {
        return yield* Effect.fail(
          assistantFailure("Pi assistant failed", response.info.error),
        );
      }

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

      return {
        session,
        response: response.info,
        parts: response.parts,
      };
    }).pipe(Effect.tapError((error) => reportPiFailure(request, error))),
  );

export type PiTaskSessionService = {
  readonly create: (
    request: PiTaskSessionRequest,
  ) => Effect.Effect<PiTaskSession, RalphieError>;
  readonly run: (
    request: PiTaskRequest,
  ) => Effect.Effect<PiTaskResult, RalphieError>;
  readonly diagnostics: PiSessionDiagnostics;
};

export const PiTaskSession = Context.GenericTag<PiTaskSessionService>(
  "ralphie/PiTaskSession",
);

export const makePiTaskSessionLayer = (client: PiClient) =>
  Layer.sync(PiTaskSession, () => {
    const diagnostics = makePiSessionDiagnostics();
    const withDiagnostics = <Request extends PiTaskSessionRequest>(
      request: Request,
    ): Request =>
      request.diagnostics === undefined
        ? {
            ...request,
            diagnostics,
          }
        : request;

    return {
      diagnostics,
      create: (request: PiTaskSessionRequest) =>
        createPiTaskSession(client, withDiagnostics(request)),
      run: (request: PiTaskRequest) =>
        runPiTask(client, withDiagnostics(request)),
    };
  });