import type { AssistantMessage, OpencodeClient, Part } from "@opencode-ai/sdk/v2";
import { Context, Data, Effect, Layer } from "effect";
import type { PermissionRuleset } from "@opencode-ai/sdk/v2";

import {
  ProgressStage,
  ProgressStatus,
  type ProgressIssue,
  type ProgressReporterService,
} from "../progress/progress.ts";
import { RalphieError } from "../shared/error.ts";
import type { OpenCodeModel, OpenCodeSelection } from "./model.ts";

export type OpenCodeTaskSessionRequest = {
  readonly directory: string;
  readonly title: string;
  readonly selection: OpenCodeSelection;
  readonly runId?: string;
  readonly diagnostics?: OpenCodeSessionDiagnostics;
  readonly signal?: AbortSignal;
};

export type OpenCodeTaskSession = {
  readonly sessionID: string;
  readonly directory: string;
  readonly selection: OpenCodeSelection;
};

export type OpenCodeTaskRequest = OpenCodeTaskSessionRequest & {
  readonly prompt: string;
  readonly repositoryInvariant?: OpenCodeRepositoryInvariant;
  readonly verifyRepositoryInvariant?: OpenCodeRepositoryInvariantVerifier;
  readonly verifyAfter?: () => Effect.Effect<void, RalphieError>;
  readonly progress?: ProgressReporterService;
  readonly progressStage?: ProgressStage;
  readonly progressIssue?: ProgressIssue;
};

export type OpenCodeTaskResult = {
  readonly session: OpenCodeTaskSession;
  readonly response: AssistantMessage;
  readonly parts: ReadonlyArray<Part>;
};

export enum OpenCodeAssistantErrorKind {
  Aborted = "aborted",
  OutputLengthExceeded = "output-length-exceeded",
  StructuredOutputRetryExhausted = "structured-output-retry-exhausted",
  Other = "other",
}

export class OpenCodeAssistantError extends Data.TaggedError("OpenCodeAssistantError")<{
  readonly kind: OpenCodeAssistantErrorKind;
  readonly message: string;
  readonly errorName: string;
  readonly retries?: number;
  readonly sdkError: NonNullable<AssistantMessage["error"]>;
}> {}

export type OpenCodeRepositoryInvariant = {
  readonly branch: string;
  readonly head: string;
};

export type OpenCodeRepositoryInvariantVerifier = (
  repositoryPath: string,
  expected: OpenCodeRepositoryInvariant,
) => Effect.Effect<void, RalphieError>;

export type OpenCodeSessionDiagnostic = {
  readonly runId: string;
  readonly sessionID: string;
  readonly directory: string;
  readonly agent?: string;
  readonly model?: OpenCodeModel;
  readonly variant?: string;
  readonly recordedAt: string;
};

export type OpenCodeSessionDiagnosticInput = Omit<
  OpenCodeSessionDiagnostic,
  "runId" | "recordedAt"
>;

/** Successful sessions remain available for post-run inspection. */
export enum OpenCodeSessionRetentionPolicy {
  Retain = "retain",
}

export const OPEN_CODE_SESSION_RETENTION_POLICY = OpenCodeSessionRetentionPolicy.Retain;

export type OpenCodeSessionDiagnostics = {
  readonly record: (runId: string, session: OpenCodeSessionDiagnosticInput) => void;
  readonly list: (runId: string) => ReadonlyArray<OpenCodeSessionDiagnostic>;
};

export const makeOpenCodeSessionDiagnostics = (
  now: () => string = () => new Date().toISOString(),
): OpenCodeSessionDiagnostics => {
  const sessions = new Map<string, OpenCodeSessionDiagnostic[]>();

  return {
    record: (runId, session) => {
      const runSessions = sessions.get(runId) ?? [];
      runSessions.push({ ...session, runId, recordedAt: now() });
      sessions.set(runId, runSessions);
    },
    list: (runId) => [...(sessions.get(runId) ?? [])],
  };
};

/**
 * OpenCode permission rules for task agents. The agent may inspect and edit
 * files, but deterministic Ralphie steps retain ownership of commits, pushes,
 * branch changes, worktrees, resets/cleanups, and GitHub mutations.
 */
export const OPEN_CODE_TASK_PERMISSION_POLICY: PermissionRuleset = [
  { permission: "bash", pattern: "git commit*", action: "deny" },
  { permission: "bash", pattern: "git push*", action: "deny" },
  { permission: "bash", pattern: "git branch*", action: "deny" },
  { permission: "bash", pattern: "git checkout*", action: "deny" },
  { permission: "bash", pattern: "git switch*", action: "deny" },
  { permission: "bash", pattern: "git worktree*", action: "deny" },
  { permission: "bash", pattern: "git reset*", action: "deny" },
  { permission: "bash", pattern: "git clean*", action: "deny" },
  { permission: "bash", pattern: "gh *", action: "deny" },
];

/** Structured decision sessions may inspect repository files but cannot mutate them. */
export const OPEN_CODE_DECISION_PERMISSION_POLICY: PermissionRuleset = [
  { permission: "edit", pattern: "*", action: "deny" },
  { permission: "write", pattern: "*", action: "deny" },
  { permission: "bash", pattern: "*", action: "deny" },
  ...OPEN_CODE_TASK_PERMISSION_POLICY,
];

type OpenCodePromptParameters = Parameters<OpencodeClient["session"]["prompt"]>[0];

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

export const toOpenCodeAssistantError = (
  error: NonNullable<AssistantMessage["error"]>,
): OpenCodeAssistantError => {
  const kind =
    error.name === "MessageAbortedError"
      ? OpenCodeAssistantErrorKind.Aborted
      : error.name === "MessageOutputLengthError"
        ? OpenCodeAssistantErrorKind.OutputLengthExceeded
        : error.name === "StructuredOutputError"
          ? OpenCodeAssistantErrorKind.StructuredOutputRetryExhausted
          : OpenCodeAssistantErrorKind.Other;

  return new OpenCodeAssistantError({
    kind,
    message: describeApiError(error),
    errorName: error.name,
    ...(error.name === "StructuredOutputError" ? { retries: error.data.retries } : {}),
    sdkError: error,
  });
};

const assistantFailure = (
  prefix: string,
  error: NonNullable<AssistantMessage["error"]>,
): RalphieError => {
  const typedError = toOpenCodeAssistantError(error);
  return new RalphieError({
    message: `${prefix} (${typedError.kind}): ${typedError.message}`,
    cause: typedError,
  });
};

export const reportOpenCodeFailure = (
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
    error.cause instanceof OpenCodeAssistantError ? error.cause : undefined;
  return request.progress
    .emit({
      stage: request.progressStage ?? ProgressStage.Implementation,
      status: ProgressStatus.Failed,
      issue: request.progressIssue,
      message: `OpenCode task failed: ${error.message}`,
      details: {
        directory: request.directory,
        title: request.title,
        ...(assistantError === undefined
          ? {}
          : {
              assistantError: assistantError.kind,
              sessionError: assistantError.errorName,
              ...(assistantError.retries === undefined
                ? {}
                : { retries: assistantError.retries }),
            }),
      },
    })
    .pipe(Effect.catchAll(() => Effect.void));
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
  ...(session.selection.model === undefined ? {} : { model: session.selection.model }),
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
      const response = await client.session.create(
        {
          directory: request.directory,
          title: request.title,
          agent: request.selection.agent,
          permission: OPEN_CODE_TASK_PERMISSION_POLICY,
          ...(request.selection.model === undefined
            ? {}
            : { model: createSessionModel(request.selection.model) }),
        },
        request.signal === undefined ? undefined : { signal: request.signal },
      );

      if (response.error !== undefined || response.data === undefined) {
        throw new Error(
          `Could not create OpenCode task session: ${describeApiError(response.error)}`,
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
        message: "Failed to create an OpenCode task session.",
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
export const runOpenCodeTask = (
  client: OpencodeClient,
  request: OpenCodeTaskRequest,
): Effect.Effect<OpenCodeTaskResult, RalphieError> =>
  Effect.gen(function* () {
    const session = yield* createOpenCodeTaskSession(client, request);

    const response = yield* Effect.tryPromise({
      try: async () => {
        const response = await client.session.prompt(
          taskSessionPromptParameters(session, {
            parts: [{ type: "text", text: request.prompt }],
          }),
          request.signal === undefined ? undefined : { signal: request.signal },
        );

        if (response.error !== undefined || response.data === undefined) {
          throw new Error(
            `OpenCode task prompt failed: ${describeApiError(response.error)}`,
          );
        }

        return response.data;
      },
      catch: (cause) =>
        new RalphieError({
          message: "Failed to run an OpenCode task.",
          cause,
        }),
    });

    if (response.info.error !== undefined) {
      return yield* Effect.fail(
        assistantFailure("OpenCode assistant failed", response.info.error),
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
  }).pipe(Effect.tapError((error) => reportOpenCodeFailure(request, error)));

export type OpenCodeTaskSessionService = {
  readonly create: (
    request: OpenCodeTaskSessionRequest,
  ) => Effect.Effect<OpenCodeTaskSession, RalphieError>;
  readonly run: (
    request: OpenCodeTaskRequest,
  ) => Effect.Effect<OpenCodeTaskResult, RalphieError>;
  readonly diagnostics: OpenCodeSessionDiagnostics;
};

export const OpenCodeTaskSession = Context.GenericTag<OpenCodeTaskSessionService>(
  "ralphie/OpenCodeTaskSession",
);

export const makeOpenCodeTaskSessionLayer = (client: OpencodeClient) =>
  Layer.sync(OpenCodeTaskSession, () => {
    const diagnostics = makeOpenCodeSessionDiagnostics();
    const withDiagnostics = <Request extends OpenCodeTaskSessionRequest>(
      request: Request,
    ): Request =>
      request.diagnostics === undefined ? { ...request, diagnostics } : request;

    return {
      diagnostics,
      create: (request: OpenCodeTaskSessionRequest) =>
        createOpenCodeTaskSession(client, withDiagnostics(request)),
      run: (request: OpenCodeTaskRequest) =>
        runOpenCodeTask(client, withDiagnostics(request)),
    };
  });
