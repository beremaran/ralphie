import type {
    CodexAssistantMessage,
    CodexClient,
    CodexPart,
    CodexPermissionRuleset,
} from "../codex/client.ts";
import { z } from "zod";

import {
    type ProgressStage,
    type ProgressStatus,
    type ProgressIssue,
    type ProgressReporterService,
} from "../progress/progress.ts";
import { RalphieError } from "../shared/error.ts";
import type { CodexModel, CodexSelection } from "./model.ts";

export type CodexTaskSessionRequest = {
    readonly directory: string;
    readonly title: string;
    readonly selection: CodexSelection;
    readonly runId?: string;
    readonly diagnostics?: CodexSessionDiagnostics;
    readonly signal?: AbortSignal;
};

export type CodexTaskSession = {
    readonly sessionID: string;
    readonly directory: string;
    readonly selection: CodexSelection;
};

export type CodexTaskRequest = CodexTaskSessionRequest & {
    readonly prompt: string;
    readonly repositoryInvariant?: CodexRepositoryInvariant;
    readonly verifyRepositoryInvariant?: CodexRepositoryInvariantVerifier;
    readonly verifyAfter?: () => Promise<void>;
    readonly progress?: ProgressReporterService;
    readonly progressStage?: ProgressStage;
    readonly progressIssue?: ProgressIssue;
};

export const CODEX_NEEDS_ATTENTION_REASONS = [
    "outdated_premise",
    "conflicting_requirements",
    "missing_information",
    "external_dependency",
    "cannot_reproduce",
] as const;

export type CodexNeedsAttentionReason =
    (typeof CODEX_NEEDS_ATTENTION_REASONS)[number];

export const CODEX_NEEDS_ATTENTION_MESSAGE_LIMIT = 2_000;

/** A bounded request to defer work; this is not a final workflow decision. */
export const codexNeedsAttentionRequestSchema = z
    .object({
        reason: z.enum(CODEX_NEEDS_ATTENTION_REASONS),
        message: z
            .string()
            .min(1)
            .max(CODEX_NEEDS_ATTENTION_MESSAGE_LIMIT)
            .refine((value) => value.trim().length > 0, {
                message: "Expected a non-blank message.",
            })
            .optional(),
    })
    .strict();

export type CodexNeedsAttentionRequest = z.infer<
    typeof codexNeedsAttentionRequestSchema
>;

export type NeedsAttentionRequest = CodexNeedsAttentionRequest;

/** Parse only the structured Codex side channel; invalid values are ignored. */
export const parseCodexNeedsAttentionRequest = (
    value: unknown,
): CodexNeedsAttentionRequest | undefined => {
    const parsed = codexNeedsAttentionRequestSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
};

export type CodexTaskResult = {
    readonly session: CodexTaskSession;
    readonly response: CodexAssistantMessage;
    readonly parts: ReadonlyArray<CodexPart>;
    readonly needsAttention?: CodexNeedsAttentionRequest;
};

export type CodexAssistantErrorKind =
    | "aborted"
    | "output-length-exceeded"
    | "structured-output-retry-exhausted"
    | "other";

export class CodexAssistantError extends Error {
    readonly _tag = "CodexAssistantError";
    readonly kind: CodexAssistantErrorKind;
    readonly errorName: string;
    readonly retries?: number;
    readonly sdkError: NonNullable<CodexAssistantMessage["error"]>;

    constructor(input: {
        readonly kind: CodexAssistantErrorKind;
        readonly message: string;
        readonly errorName: string;
        readonly retries?: number;
        readonly sdkError: NonNullable<CodexAssistantMessage["error"]>;
    }) {
        super(input.message);
        this.name = "CodexAssistantError";
        this.kind = input.kind;
        this.errorName = input.errorName;
        this.retries = input.retries;
        this.sdkError = input.sdkError;
    }
}

export type CodexRepositoryInvariant = {
    readonly branch: string;
    readonly head: string;
};

export type CodexRepositoryInvariantVerifier = (
    repositoryPath: string,
    expected: CodexRepositoryInvariant,
) => Promise<void>;

export type CodexSessionDiagnostic = {
    readonly runId: string;
    readonly sessionID: string;
    readonly directory: string;
    readonly agent?: string;
    readonly model?: CodexModel;
    readonly variant?: string;
    readonly recordedAt: string;
};

export type CodexSessionDiagnosticInput = Omit<
    CodexSessionDiagnostic,
    "runId" | "recordedAt"
>;

/** Successful sessions remain available for post-run inspection. */
export const CodexSessionRetentionPolicy = "retain" as const;
export type CodexSessionRetentionPolicy = typeof CodexSessionRetentionPolicy;

export const CODEX_SESSION_RETENTION_POLICY = CodexSessionRetentionPolicy;

export type CodexSessionDiagnostics = {
    readonly record: (
        runId: string,
        session: CodexSessionDiagnosticInput,
    ) => void;
    readonly list: (runId: string) => ReadonlyArray<CodexSessionDiagnostic>;
};

export const makeCodexSessionDiagnostics = (
    now: () => string = () => new Date().toISOString(),
): CodexSessionDiagnostics => {
    const sessions = new Map<string, CodexSessionDiagnostic[]>();

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
 * Codex permission rules for task agents. The agent may inspect and edit
 * files, but deterministic Ralphie steps retain ownership of commits, pushes,
 * branch changes, worktrees, resets/cleanups, and GitHub mutations.
 */
export const CODEX_TASK_PERMISSION_POLICY: CodexPermissionRuleset =
    "workspace-write";

/**
 * Structured decision sessions may inspect repository files and read Git state,
 * but cannot mutate the checkout. Codex permission rules use the last matching
 * rule, so the narrow read-only allowances must follow the catch-all denial.
 */
export const CODEX_DECISION_PERMISSION_POLICY: CodexPermissionRuleset =
    "read-only";

type CodexPromptParameters = Parameters<CodexClient["session"]["prompt"]>[0];

export type CodexTaskPromptInput = Omit<
    CodexPromptParameters,
    "sessionID" | "directory" | "model" | "variant"
>;

const describeApiError = (error: unknown): string => {
    if (typeof error !== "object" || error === null) return String(error);

    const candidate = error as {
        readonly name?: unknown;
        readonly data?: { readonly message?: unknown };
    };
    const name =
        typeof candidate.name === "string" ? candidate.name : "CodexError";
    const message =
        typeof candidate.data?.message === "string"
            ? candidate.data.message
            : JSON.stringify(error);

    return `${name}: ${message}`;
};

export const toCodexAssistantError = (
    error: NonNullable<CodexAssistantMessage["error"]>,
): CodexAssistantError => {
    const kind =
        error.name === "MessageAbortedError"
            ? "aborted"
            : error.name === "MessageOutputLengthError"
              ? "output-length-exceeded"
              : error.name === "StructuredOutputError"
                ? "structured-output-retry-exhausted"
                : "other";

    return new CodexAssistantError({
        kind,
        message: describeApiError(error),
        errorName: error.name,
        ...(error.name === "StructuredOutputError" &&
        error.data?.retries !== undefined
            ? { retries: error.data.retries }
            : {}),
        sdkError: error,
    });
};

const assistantFailure = (
    prefix: string,
    error: NonNullable<CodexAssistantMessage["error"]>,
): RalphieError => {
    const typedError = toCodexAssistantError(error);
    return new RalphieError({
        message: `${prefix} (${typedError.kind}): ${typedError.message}`,
        cause: typedError,
    });
};

export const reportCodexFailure = async (
    request: {
        readonly directory: string;
        readonly title: string;
        readonly progress?: ProgressReporterService;
        readonly progressStage?: ProgressStage;
        readonly progressIssue?: ProgressIssue;
    },
    error: RalphieError,
): Promise<void> => {
    if (request.progress === undefined) return;

    const assistantError =
        error.cause instanceof CodexAssistantError ? error.cause : undefined;
    const causeMessage = (() => {
        let cause: unknown = error.cause;
        for (let depth = 0; depth < 4 && cause !== undefined; depth += 1) {
            if (cause instanceof Error && cause.message !== error.message) {
                return cause.message;
            }
            if (
                typeof cause !== "object" ||
                cause === null ||
                !("cause" in cause)
            ) {
                break;
            }
            cause = (cause as { readonly cause?: unknown }).cause;
        }
        return undefined;
    })();

    try {
        await request.progress.emit({
            stage: request.progressStage ?? "implementation",
            status: "failed",
            ...(request.progressIssue === undefined
                ? {}
                : { issue: request.progressIssue }),
            message: `Codex task failed: ${error.message}`,
            details: {
                directory: request.directory,
                title: request.title,
                ...(causeMessage === undefined ? {} : { cause: causeMessage }),
                ...(assistantError === undefined
                    ? {}
                    : {
                          assistantError: assistantError.kind,
                          sessionError: assistantError.errorName,
                          ...(assistantError.retries === undefined
                              ? {}
                              : { retries: assistantError.retries }),
                      }),
                ...(request.progressStage === "grounding"
                    ? { agentWorkSkipped: false }
                    : {}),
            },
        });
    } catch {
        // Reporting must never hide the original Codex failure.
    }
};

const signalOptions = (signal: AbortSignal | undefined) =>
    signal === undefined ? undefined : { signal };

const verifyCodexTaskRequest = async (
    request: CodexTaskRequest,
): Promise<void> => {
    if (
        request.repositoryInvariant !== undefined &&
        request.verifyRepositoryInvariant !== undefined
    ) {
        await request.verifyRepositoryInvariant(
            request.directory,
            request.repositoryInvariant,
        );
    }
    if (request.verifyAfter !== undefined) await request.verifyAfter();
};

const promptCodexTask = async (
    client: CodexClient,
    session: CodexTaskSession,
    request: CodexTaskRequest,
): Promise<CodexTaskResult> => {
    const response = await client.session.prompt(
        taskSessionPromptParameters(session, {
            parts: [{ type: "text", text: request.prompt }],
        }),
        signalOptions(request.signal),
    );

    if (response.error !== undefined || response.data === undefined) {
        throw new Error(
            `Codex task prompt failed: ${describeApiError(response.error)}`,
        );
    }
    if (response.data.info.error !== undefined) {
        throw assistantFailure(
            "Codex assistant failed",
            response.data.info.error,
        );
    }

    await verifyCodexTaskRequest(request);
    return {
        session,
        response: response.data.info,
        parts: response.data.parts,
    };
};

/** Build prompt parameters for a task session. */
export const taskSessionPromptParameters = (
    session: CodexTaskSession,
    input: CodexTaskPromptInput,
): CodexPromptParameters => ({
    ...input,
    sessionID: session.sessionID,
    directory: session.directory,
    ...(session.selection.model === undefined
        ? {}
        : { model: session.selection.model }),
    ...(session.selection.variant === undefined
        ? {}
        : { variant: session.selection.variant }),
});

/** Create an isolated task session rooted in a repository checkout. */
export const createCodexTaskSession = async (
    client: CodexClient,
    request: CodexTaskSessionRequest,
): Promise<CodexTaskSession> => {
    try {
        const response = await client.session.create(
            {
                directory: request.directory,
                title: request.title,
                sandbox: CODEX_TASK_PERMISSION_POLICY,
                ...(request.selection.model === undefined
                    ? {}
                    : { model: request.selection.model }),
            },
            request.signal === undefined
                ? undefined
                : { signal: request.signal },
        );

        if (response.error !== undefined || response.data === undefined) {
            throw new Error(
                `Could not create Codex task session: ${describeApiError(response.error)}`,
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
                model: session.selection.model,
                variant: session.selection.variant,
            });
        }

        return session;
    } catch (cause) {
        if (cause instanceof RalphieError) throw cause;
        throw new RalphieError({
            message: "Failed to create an Codex task session.",
            cause,
        });
    }
};

/** Run an ordinary text task in a new session. */
export const runCodexTask = async (
    client: CodexClient,
    request: CodexTaskRequest,
): Promise<CodexTaskResult> => {
    try {
        const session = await createCodexTaskSession(client, request);
        return await promptCodexTask(client, session, request);
    } catch (cause) {
        const error =
            cause instanceof RalphieError
                ? cause
                : new RalphieError({
                      message: "Failed to run an Codex task.",
                      cause,
                  });
        await reportCodexFailure(request, error);
        throw error;
    }
};

export type CodexTaskSessionService = {
    readonly create: (
        request: CodexTaskSessionRequest,
    ) => Promise<CodexTaskSession>;
    readonly run: (request: CodexTaskRequest) => Promise<CodexTaskResult>;
    readonly diagnostics: CodexSessionDiagnostics;
};

export const makeCodexTaskSessionService = (
    client: CodexClient,
): CodexTaskSessionService => {
    const diagnostics = makeCodexSessionDiagnostics();
    const withDiagnostics = <Request extends CodexTaskSessionRequest>(
        request: Request,
    ): Request =>
        request.diagnostics === undefined
            ? { ...request, diagnostics }
            : request;

    return {
        diagnostics,
        create: (request) =>
            createCodexTaskSession(client, withDiagnostics(request)),
        run: (request) => runCodexTask(client, withDiagnostics(request)),
    };
};