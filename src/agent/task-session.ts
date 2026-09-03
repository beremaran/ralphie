import type { AgentAssistantMessage, AgentClient } from "../opencode/client.ts";
import { z } from "zod";

import {
    type ProgressStage,
    type ProgressStatus,
    type ProgressIssue,
    type ProgressReporterService,
} from "../progress/progress.ts";
import { RalphieError } from "../shared/error.ts";
import type { AgentModel, AgentSelection } from "./model.ts";

export type AgentTaskSessionRequest = {
    readonly directory: string;
    readonly title: string;
    readonly selection: AgentSelection;
    readonly runId?: string;
    readonly diagnostics?: AgentSessionDiagnostics;
    readonly signal?: AbortSignal;
};

export type AgentTaskSession = {
    readonly sessionID: string;
    readonly directory: string;
    readonly selection: AgentSelection;
};

export type AgentTaskRequest = AgentTaskSessionRequest & {
    readonly prompt: string;
    readonly repositoryInvariant?: AgentRepositoryInvariant;
    readonly verifyRepositoryInvariant?: AgentRepositoryInvariantVerifier;
    readonly verifyAfter?: (signal?: AbortSignal) => Promise<void>;
    readonly progress?: ProgressReporterService;
    readonly progressStage?: ProgressStage;
    readonly progressIssue?: ProgressIssue;
};

export const NEEDS_ATTENTION_REASONS = [
    "outdated_premise",
    "conflicting_requirements",
    "missing_information",
    "external_dependency",
    "cannot_reproduce",
] as const;

export type NeedsAttentionReasonValue =
    (typeof NEEDS_ATTENTION_REASONS)[number];

export const NEEDS_ATTENTION_MESSAGE_LIMIT = 2_000;

/** A bounded request to defer work; this is not a final workflow decision. */
export const needsAttentionRequestSchema = z
    .object({
        reason: z.enum(NEEDS_ATTENTION_REASONS),
        message: z
            .string()
            .min(1)
            .max(NEEDS_ATTENTION_MESSAGE_LIMIT)
            .refine((value) => value.trim().length > 0, {
                message: "Expected a non-blank message.",
            })
            .optional(),
    })
    .strict();

export type NeedsAttentionRequest = z.infer<typeof needsAttentionRequestSchema>;

/** Parse only the structured side channel; invalid values are ignored. */
export const parseNeedsAttentionRequest = (
    value: unknown,
): NeedsAttentionRequest | undefined => {
    const parsed = needsAttentionRequestSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
};

export type AgentTaskResult = {
    readonly session: AgentTaskSession;
    readonly response: AgentAssistantMessage;
    readonly parts: ReadonlyArray<{
        readonly type: string;
        readonly text?: string;
    }>;
    readonly needsAttention?: NeedsAttentionRequest;
    readonly text?: string;
};

export type AgentAssistantErrorKind =
    | "aborted"
    | "output-length-exceeded"
    | "structured-output-retry-exhausted"
    | "other";

export class AgentAssistantError extends Error {
    readonly _tag = "AgentAssistantError";
    readonly kind: AgentAssistantErrorKind;
    readonly errorName: string;
    readonly retries?: number;
    readonly agentError: NonNullable<AgentAssistantMessage["error"]>;

    constructor(input: {
        readonly kind: AgentAssistantErrorKind;
        readonly message: string;
        readonly errorName: string;
        readonly retries?: number;
        readonly agentError: NonNullable<AgentAssistantMessage["error"]>;
    }) {
        super(input.message);
        this.name = "AgentAssistantError";
        this.kind = input.kind;
        this.errorName = input.errorName;
        this.retries = input.retries;
        this.agentError = input.agentError;
    }
}

export type AgentRepositoryInvariant = {
    readonly branch: string;
    readonly head: string;
};

export type AgentRepositoryInvariantVerifier = (
    repositoryPath: string,
    expected: AgentRepositoryInvariant,
    signal?: AbortSignal,
) => Promise<void>;

export type AgentSessionDiagnostic = {
    readonly runId: string;
    readonly sessionID: string;
    readonly directory: string;
    readonly agent?: string;
    readonly model?: AgentModel;
    readonly variant?: string;
    readonly recordedAt: string;
};

export type AgentSessionDiagnosticInput = Omit<
    AgentSessionDiagnostic,
    "runId" | "recordedAt"
>;

/** Successful sessions remain available for post-run inspection. */
export const AgentSessionRetentionPolicy = "retain" as const;
export type AgentSessionRetentionPolicy = typeof AgentSessionRetentionPolicy;

export const AGENT_SESSION_RETENTION_POLICY = AgentSessionRetentionPolicy;

export type AgentSessionDiagnostics = {
    readonly record: (
        runId: string,
        session: AgentSessionDiagnosticInput,
    ) => void;
    readonly list: (runId: string) => ReadonlyArray<AgentSessionDiagnostic>;
};

export const makeAgentSessionDiagnostics = (
    now: () => string = () => new Date().toISOString(),
): AgentSessionDiagnostics => {
    const sessions = new Map<string, AgentSessionDiagnostic[]>();

    return {
        record: (runId, session) => {
            const runSessions = sessions.get(runId) ?? [];
            runSessions.push({ ...session, runId, recordedAt: now() });
            sessions.set(runId, runSessions);
        },
        list: (runId) => [...(sessions.get(runId) ?? [])],
    };
};

type AgentPromptParameters = Parameters<AgentClient["session"]["prompt"]>[0];

export type AgentTaskPromptInput = Omit<
    AgentPromptParameters,
    "sessionID" | "directory" | "agent" | "model" | "variant"
>;

const describeApiError = (error: unknown): string => {
    if (typeof error !== "object" || error === null) return String(error);

    const candidate = error as {
        readonly name?: unknown;
        readonly data?: { readonly message?: unknown };
    };
    const name =
        typeof candidate.name === "string" ? candidate.name : "OpenCodeError";
    const message =
        typeof candidate.data?.message === "string"
            ? candidate.data.message
            : JSON.stringify(error);

    return `${name}: ${message}`;
};

export const toAgentAssistantError = (
    error: NonNullable<AgentAssistantMessage["error"]>,
): AgentAssistantError => {
    const kind =
        error.name === "MessageAbortedError"
            ? "aborted"
            : error.name === "MessageOutputLengthError"
              ? "output-length-exceeded"
              : error.name === "StructuredOutputError"
                ? "structured-output-retry-exhausted"
                : "other";

    return new AgentAssistantError({
        kind,
        message: describeApiError(error),
        errorName: error.name,
        ...(error.name === "StructuredOutputError" &&
        error.data?.retries !== undefined
            ? { retries: error.data.retries }
            : {}),
        agentError: error,
    });
};

const assistantFailure = (
    prefix: string,
    error: NonNullable<AgentAssistantMessage["error"]>,
): RalphieError => {
    const typedError = toAgentAssistantError(error);
    return new RalphieError({
        message: `${prefix} (${typedError.kind}): ${typedError.message}`,
        cause: typedError,
    });
};

export const reportAgentFailure = async (
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
        error.cause instanceof AgentAssistantError ? error.cause : undefined;
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
            message: `OpenCode task failed: ${error.message}`,
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
        // Reporting must never hide the original failure.
    }
};

const createSessionModel = (model: AgentModel) => ({
    providerID: model.providerID,
    modelID: model.modelID,
});

const signalOptions = (signal: AbortSignal | undefined) =>
    signal === undefined ? undefined : { signal };

const verifyAgentTaskRequest = async (
    request: AgentTaskRequest,
): Promise<void> => {
    if (
        request.repositoryInvariant !== undefined &&
        request.verifyRepositoryInvariant !== undefined
    ) {
        await request.verifyRepositoryInvariant(
            request.directory,
            request.repositoryInvariant,
            request.signal,
        );
    }
    if (request.verifyAfter !== undefined) {
        await request.verifyAfter(request.signal);
    }
};

const promptAgentTask = async (
    client: AgentClient,
    session: AgentTaskSession,
    request: AgentTaskRequest,
): Promise<AgentTaskResult> => {
    const response = await client.session.prompt(
        taskSessionPromptParameters(session, {
            parts: [{ type: "text", text: request.prompt }],
        }),
        signalOptions(request.signal),
    );

    if (response.error !== undefined || response.data === undefined) {
        throw new Error(
            `OpenCode task prompt failed: ${describeApiError(response.error)}`,
        );
    }
    if (response.data.info.error !== undefined) {
        throw assistantFailure(
            "OpenCode assistant failed",
            response.data.info.error,
        );
    }

    await verifyAgentTaskRequest(request);
    const needsAttention = parseNeedsAttentionRequest(
        response.data.needsAttention,
    );
    return {
        session,
        response: response.data.info,
        parts: response.data.parts,
        text: response.data.info.text,
        ...(needsAttention === undefined ? {} : { needsAttention }),
    };
};

/** Build prompt parameters for a task session. */
export const taskSessionPromptParameters = (
    session: AgentTaskSession,
    input: AgentTaskPromptInput,
): AgentPromptParameters => ({
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

/** Create an isolated task session rooted in a repository checkout. */
export const createAgentTaskSession = async (
    client: AgentClient,
    request: AgentTaskSessionRequest,
): Promise<AgentTaskSession> => {
    try {
        const response = await client.session.create(
            {
                directory: request.directory,
                title: request.title,
                agent: request.selection.agent,
                ...(request.selection.model === undefined
                    ? {}
                    : { model: createSessionModel(request.selection.model) }),
                ...(request.selection.variant === undefined
                    ? {}
                    : { variant: request.selection.variant }),
            },
            request.signal === undefined
                ? undefined
                : { signal: request.signal },
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
    } catch (cause) {
        if (cause instanceof RalphieError) throw cause;
        throw new RalphieError({
            message: "Failed to create an OpenCode task session.",
            cause,
        });
    }
};

/** Run an ordinary text task in a new session. */
export const runAgentTask = async (
    client: AgentClient,
    request: AgentTaskRequest,
): Promise<AgentTaskResult> => {
    try {
        const session = await createAgentTaskSession(client, request);
        return await promptAgentTask(client, session, request);
    } catch (cause) {
        const error =
            cause instanceof RalphieError
                ? cause
                : new RalphieError({
                      message: "Failed to run an OpenCode task.",
                      cause,
                  });
        await reportAgentFailure(request, error);
        throw error;
    }
};

export type AgentTaskSessionService = {
    readonly create: (
        request: AgentTaskSessionRequest,
    ) => Promise<AgentTaskSession>;
    readonly run: (request: AgentTaskRequest) => Promise<AgentTaskResult>;
    readonly diagnostics: AgentSessionDiagnostics;
};

export const makeAgentTaskSessionService = (
    client: AgentClient,
): AgentTaskSessionService => {
    const diagnostics = makeAgentSessionDiagnostics();
    const withDiagnostics = <Request extends AgentTaskSessionRequest>(
        request: Request,
    ): Request =>
        request.diagnostics === undefined
            ? { ...request, diagnostics }
            : request;

    return {
        diagnostics,
        create: (request) =>
            createAgentTaskSession(client, withDiagnostics(request)),
        run: (request) => runAgentTask(client, withDiagnostics(request)),
    };
};

/** Server owns permissions now; kept as empty placeholders. */
export const AGENT_TASK_PERMISSION_POLICY: ReadonlyArray<{
    readonly permission: string;
    readonly pattern: string;
    readonly action: "allow" | "deny";
}> = [];
export const AGENT_DECISION_PERMISSION_POLICY: ReadonlyArray<{
    readonly permission: string;
    readonly pattern: string;
    readonly action: "allow" | "deny";
}> = [];