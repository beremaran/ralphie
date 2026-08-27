import type {
    PiAssistantMessage,
    PiClient,
    PiPart,
    PiPermissionRuleset,
} from "../pi/client.ts";

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
    readonly verifyAfter?: () => Promise<void>;
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

export class PiAssistantError extends Error {
    readonly _tag = "PiAssistantError";
    readonly kind: PiAssistantErrorKind;
    readonly errorName: string;
    readonly retries?: number;
    readonly sdkError: NonNullable<PiAssistantMessage["error"]>;

    constructor(input: {
        readonly kind: PiAssistantErrorKind;
        readonly message: string;
        readonly errorName: string;
        readonly retries?: number;
        readonly sdkError: NonNullable<PiAssistantMessage["error"]>;
    }) {
        super(input.message);
        this.name = "PiAssistantError";
        this.kind = input.kind;
        this.errorName = input.errorName;
        this.retries = input.retries;
        this.sdkError = input.sdkError;
    }
}

export type PiRepositoryInvariant = {
    readonly branch: string;
    readonly head: string;
};

export type PiRepositoryInvariantVerifier = (
    repositoryPath: string,
    expected: PiRepositoryInvariant,
) => Promise<void>;

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
export const PiSessionRetentionPolicy = "retain" as const;
export type PiSessionRetentionPolicy = typeof PiSessionRetentionPolicy;

export const PI_SESSION_RETENTION_POLICY = PiSessionRetentionPolicy;

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
            runSessions.push({ ...session, runId, recordedAt: now() });
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

/**
 * Structured decision sessions may inspect repository files and read Git state,
 * but cannot mutate the checkout. Pi permission rules use the last matching
 * rule, so the narrow read-only allowances must follow the catch-all denial.
 */
export const PI_DECISION_PERMISSION_POLICY: PiPermissionRuleset = [
    { permission: "edit", pattern: "*", action: "deny" },
    { permission: "write", pattern: "*", action: "deny" },
    { permission: "bash", pattern: "*", action: "deny" },
    ...PI_TASK_PERMISSION_POLICY,
    { permission: "bash", pattern: "git status*", action: "allow" },
    { permission: "bash", pattern: "git diff*", action: "allow" },
    { permission: "bash", pattern: "git ls-files*", action: "allow" },
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
        readonly data?: { readonly message?: unknown };
    };
    const name =
        typeof candidate.name === "string" ? candidate.name : "PiError";
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
            ? { retries: error.data.retries }
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

export const reportPiFailure = async (
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
        error.cause instanceof PiAssistantError ? error.cause : undefined;
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
            stage: request.progressStage ?? ProgressStage.Implementation,
            status: ProgressStatus.Failed,
            ...(request.progressIssue === undefined
                ? {}
                : { issue: request.progressIssue }),
            message: `Pi task failed: ${error.message}`,
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
            },
        });
    } catch {
        // Reporting must never hide the original Pi failure.
    }
};

const createSessionModel = (model: PiModel) => ({
    providerID: model.providerID,
    id: model.modelID,
});

const signalOptions = (signal: AbortSignal | undefined) =>
    signal === undefined ? undefined : { signal };

const verifyPiTaskRequest = async (request: PiTaskRequest): Promise<void> => {
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

const promptPiTask = async (
    client: PiClient,
    session: PiTaskSession,
    request: PiTaskRequest,
): Promise<PiTaskResult> => {
    const response = await client.session.prompt(
        taskSessionPromptParameters(session, {
            parts: [{ type: "text", text: request.prompt }],
        }),
        signalOptions(request.signal),
    );

    if (response.error !== undefined || response.data === undefined) {
        throw new Error(
            `Pi task prompt failed: ${describeApiError(response.error)}`,
        );
    }
    if (response.data.info.error !== undefined) {
        throw assistantFailure("Pi assistant failed", response.data.info.error);
    }

    await verifyPiTaskRequest(request);
    return {
        session,
        response: response.data.info,
        parts: response.data.parts,
    };
};

/** Build prompt parameters for a task session. */
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
        : { model: session.selection.model }),
    ...(session.selection.variant === undefined
        ? {}
        : { variant: session.selection.variant }),
});

/** Create an isolated task session rooted in a repository checkout. */
export const createPiTaskSession = async (
    client: PiClient,
    request: PiTaskSessionRequest,
): Promise<PiTaskSession> => {
    try {
        const response = await client.session.create(
            {
                directory: request.directory,
                title: request.title,
                agent: request.selection.agent,
                permission: PI_TASK_PERMISSION_POLICY,
                ...(request.selection.model === undefined
                    ? {}
                    : { model: createSessionModel(request.selection.model) }),
            },
            request.signal === undefined
                ? undefined
                : { signal: request.signal },
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
    } catch (cause) {
        if (cause instanceof RalphieError) throw cause;
        throw new RalphieError({
            message: "Failed to create an Pi task session.",
            cause,
        });
    }
};

/** Run an ordinary text task in a new session. */
export const runPiTask = (
    client: PiClient,
    request: PiTaskRequest,
): Promise<PiTaskResult> =>
    withPiAgentPermit(client, async () => {
        try {
            const session = await createPiTaskSession(client, request);
            return await promptPiTask(client, session, request);
        } catch (cause) {
            const error =
                cause instanceof RalphieError
                    ? cause
                    : new RalphieError({
                          message: "Failed to run an Pi task.",
                          cause,
                      });
            await reportPiFailure(request, error);
            throw error;
        }
    });

export type PiTaskSessionService = {
    readonly create: (request: PiTaskSessionRequest) => Promise<PiTaskSession>;
    readonly run: (request: PiTaskRequest) => Promise<PiTaskResult>;
    readonly diagnostics: PiSessionDiagnostics;
};

export const makePiTaskSessionService = (
    client: PiClient,
): PiTaskSessionService => {
    const diagnostics = makePiSessionDiagnostics();
    const withDiagnostics = <Request extends PiTaskSessionRequest>(
        request: Request,
    ): Request =>
        request.diagnostics === undefined
            ? { ...request, diagnostics }
            : request;

    return {
        diagnostics,
        create: (request) =>
            createPiTaskSession(client, withDiagnostics(request)),
        run: (request) => runPiTask(client, withDiagnostics(request)),
    };
};