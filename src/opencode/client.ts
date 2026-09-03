import { extractNeedsAttentionJson, extractStructuredJson } from "./json.ts";
import { isDeniedShellResource } from "./permissions.ts";
import { RalphieError } from "../shared/error.ts";

export type AgentModel = {
    readonly providerID: string;
    readonly modelID: string;
};

export type AgentSelection = {
    readonly agent: string;
    readonly model?: AgentModel;
    readonly variant?: string;
};

export const AgentSessionProfile = {
    Default: "default",
    Review: "review",
} as const;

export type AgentSessionProfile =
    (typeof AgentSessionProfile)[keyof typeof AgentSessionProfile];

export const AGENT_REVIEW_SESSION_PROFILE = AgentSessionProfile.Review;

export type AgentAssistantError = {
    readonly name: string;
    readonly data?: {
        readonly message?: string;
        readonly retries?: number;
    };
};

export type AgentAssistantMessage = {
    readonly id: string;
    readonly role: "assistant";
    readonly error?: AgentAssistantError;
    readonly structured?: unknown;
    readonly text?: string;
    readonly [key: string]: unknown;
};

export type AgentPart = {
    readonly type: string;
    readonly text?: string;
    readonly [key: string]: unknown;
};

export type AgentSessionEvent = any;

export type AgentEventContext = {
    readonly sessionID: string;
    readonly directory: string;
    readonly title?: string;
};

export type AgentEventListener = (
    event: any,
    context: AgentEventContext,
) => void;

// Legacy Pi-era aliases kept for the progress layer migration.
export type PiSessionEvent = any;
export type PiEventContext = AgentEventContext;
export type PiEventListener = AgentEventListener;
export type PiClient = AgentClient;
export type PiAssistantMessage = AgentAssistantMessage;
export type PiAssistantError = AgentAssistantError;
export type PiPart = AgentPart;
export const PiSessionProfile = AgentSessionProfile;
export type PiPermissionRuleset = ReadonlyArray<{
    readonly permission: string;
    readonly pattern: string;
    readonly action: "allow" | "deny";
}>;

type CreateSessionInput = {
    readonly directory: string;
    readonly title?: string;
    readonly agent?: string;
    readonly model?:
        | AgentModel
        | {
              readonly providerID: string;
              readonly id: string;
          };
    readonly variant?: string;
    readonly profile?: AgentSessionProfile;
};

type PromptFormat = {
    readonly type: "json_schema";
    readonly schema: unknown;
    readonly retryCount?: number;
    readonly validate?: (value: unknown) => {
        readonly success: boolean;
        readonly error?: string;
    };
};

type PromptInput = {
    readonly sessionID: string;
    readonly directory: string;
    readonly agent?: string;
    readonly model?: AgentModel;
    readonly variant?: string;
    readonly profile?: AgentSessionProfile;
    readonly parts: ReadonlyArray<{
        readonly type: "text";
        readonly text: string;
    }>;
    readonly format?: PromptFormat;
};

type ApiResult<T> = {
    readonly data?: T;
    readonly error?: unknown;
};

export type AgentClient = {
    readonly session: {
        readonly create: (
            input: CreateSessionInput,
            options?: {
                readonly signal?: AbortSignal;
            },
        ) => Promise<
            ApiResult<{
                readonly id: string;
            }>
        >;
        readonly prompt: (
            input: PromptInput,
            options?: {
                readonly signal?: AbortSignal;
            },
        ) => Promise<
            ApiResult<{
                readonly info: AgentAssistantMessage;
                readonly parts: ReadonlyArray<AgentPart>;
                readonly needsAttention?: unknown;
            }>
        >;
    };
    readonly close?: () => void;
};

/** Minimal OpenCode transport; production binds this to @opencode-ai/client. */
export type OpenCodeTransport = {
    readonly sessionCreate: (input: {
        readonly title?: string;
        readonly agent?: string;
        readonly model?: {
            readonly providerID: string;
            readonly id: string;
            readonly variant?: string;
        };
        readonly directory: string;
    }) => Promise<{ readonly id: string }>;
    readonly sessionPrompt: (input: {
        readonly sessionID: string;
        readonly text: string;
    }) => Promise<void>;
    readonly sessionWait: (input: {
        readonly sessionID: string;
        readonly signal?: AbortSignal;
    }) => Promise<void>;
    readonly sessionInterrupt: (input: {
        readonly sessionID: string;
    }) => Promise<void>;
    readonly messageList: (input: {
        readonly sessionID: string;
    }) => Promise<ReadonlyArray<OpenCodeMessage>>;
    readonly permissionList?: (input: {
        readonly sessionID: string;
    }) => Promise<ReadonlyArray<OpenCodePermissionRequest>>;
    readonly permissionReply?: (input: {
        readonly sessionID: string;
        readonly requestID: string;
        readonly reply: "once" | "always" | "reject";
    }) => Promise<void>;
};

export type OpenCodeMessage = {
    readonly id: string;
    readonly type: string;
    readonly error?: unknown;
    readonly finish?: unknown;
    readonly content?: ReadonlyArray<{
        readonly type: string;
        readonly text?: string;
        readonly id?: string;
        readonly name?: string;
        readonly state?: {
            readonly status?: string;
            readonly input?: unknown;
            readonly content?: unknown;
            readonly metadata?: unknown;
        };
    }>;
};

export type OpenCodeClientOptions = {
    /** Retry budget for transport-level drops of the session wait long-poll. */
    readonly sessionWaitMaxRetries?: number;
    /** Initial backoff between wait retries; doubles after each failure. */
    readonly sessionWaitBackoffMs?: number;
};

export type OpenCodePermissionRequest = {
    readonly id: string;
    readonly sessionID: string;
    readonly action: string;
    readonly resources: ReadonlyArray<string>;
};

type PendingSession = {
    readonly directory: string;
    readonly title?: string;
    readonly agent?: string;
    readonly model?:
        | AgentModel
        | { readonly providerID: string; readonly id: string };
    readonly variant?: string;
    readonly profile?: AgentSessionProfile;
    readonly openCodeSessionID: string;
};

const modelIDOf = (
    model: CreateSessionInput["model"] | PromptInput["model"],
): string | undefined => {
    if (model === undefined) return undefined;
    return "modelID" in model ? model.modelID : model.id;
};

const toTransportModel = (
    model: PendingSession["model"],
    variant: string | undefined,
):
    | {
          readonly providerID: string;
          readonly id: string;
          readonly variant?: string;
      }
    | undefined => {
    if (model === undefined) {
        return variant === undefined ? undefined : undefined;
    }
    const id = modelIDOf(model);
    if (id === undefined) return undefined;
    return {
        providerID: model.providerID,
        id,
        ...(variant === undefined ? {} : { variant }),
    };
};

const assistantTextOf = (messages: ReadonlyArray<OpenCodeMessage>): string => {
    const chronological = [...messages].reverse();
    const texts: string[] = [];
    for (const message of chronological) {
        if (message.type !== "assistant" || message.content === undefined) {
            continue;
        }
        for (const part of message.content) {
            if (part.type === "text" && typeof part.text === "string") {
                texts.push(part.text);
            }
        }
    }
    return texts.join("\n").trim();
};

const toolEventsOf = (
    messages: ReadonlyArray<OpenCodeMessage>,
): Array<{ readonly type: string; [key: string]: unknown }> => {
    const events: Array<{ readonly type: string; [key: string]: unknown }> = [];
    const chronological = [...messages].reverse();
    for (const message of chronological) {
        if (message.type !== "assistant" || message.content === undefined) {
            continue;
        }
        for (const part of message.content) {
            if (part.type !== "tool" || part.id === undefined) continue;
            const name = part.name ?? "tool";
            const input = part.state?.input;
            const status = part.state?.status;
            const toolCallId = part.id;
            events.push({
                type: "tool_execution_start",
                toolCallId,
                toolName: name,
                args: input,
            });
            events.push({
                type: "tool_execution_end",
                toolCallId,
                toolName: name,
                result: part.state?.content,
                isError: status === "error",
            });
        }
    }
    return events;
};

const emitSessionTranscript = (
    emit: (event: any, context: AgentEventContext) => void,
    messages: ReadonlyArray<OpenCodeMessage>,
    text: string,
    context: AgentEventContext,
): void => {
    if (text !== "") {
        emit(
            {
                type: "message_update",
                assistantMessageEvent: {
                    type: "text_start",
                    contentIndex: 0,
                },
            },
            context,
        );
        emit(
            {
                type: "message_update",
                assistantMessageEvent: {
                    type: "text_delta",
                    contentIndex: 0,
                    delta: text.slice(0, 5000),
                },
            },
            context,
        );
        emit(
            {
                type: "message_update",
                assistantMessageEvent: {
                    type: "text_end",
                    contentIndex: 0,
                },
            },
            context,
        );
    }
    for (const toolEvent of toolEventsOf(messages)) {
        emit(toolEvent, context);
    }
};

const assistantErrorOf = (
    messages: ReadonlyArray<OpenCodeMessage>,
): AgentAssistantError | undefined => {
    for (const message of [...messages].reverse()) {
        if (message.type !== "assistant") continue;
        const error = (message as { readonly error?: unknown }).error as
            | { readonly message?: unknown }
            | undefined;
        if (error !== undefined) {
            return {
                name: "OpenCodeAssistantError",
                data: {
                    message:
                        typeof error.message === "string"
                            ? error.message
                            : "OpenCode assistant failed.",
                },
            };
        }
        const finish = (message as { readonly finish?: unknown }).finish;
        if (finish === "error") {
            return {
                name: "OpenCodeAssistantError",
                data: { message: "OpenCode assistant finished with error." },
            };
        }
        if (finish === "length") {
            return { name: "MessageOutputLengthError" };
        }
    }
    return undefined;
};

const unattendedContract = `UNATTENDED EXECUTION CONTRACT:
- You are running autonomously in a non-interactive harness. No user or operator can answer during this turn.
- Do not ask questions in prose, request confirmation, offer choices, pause for input, or wait for a reply.
- Inspect the available repository context, make reasonable decisions, and complete as much of the task as is safely possible.
- If a repository-backed blocker genuinely prevents safe progress, emit a fenced needs-attention block (see below) instead of asking a question. Then continue to satisfy the final response contract.`;

const schemaBlock = (schema: unknown): string => {
    try {
        const text = JSON.stringify(schema);
        return text.length > 8000 ? `${text.slice(0, 8000)}…` : text;
    } catch {
        return "[unserializable schema]";
    }
};

const structuredContract = (
    retry: boolean,
    schema?: unknown,
    lastError?: string,
): string => {
    const schemaSection =
        schema === undefined
            ? ""
            : `\n\nJSON SCHEMA (your \`\`\`json block must validate against it):\n\`\`\`json\n${schemaBlock(schema)}\n\`\`\``;
    if (retry) {
        const errorSection =
            lastError === undefined || lastError === ""
                ? ""
                : `\n\nPREVIOUS VALIDATION ERROR (fix every item):\n${lastError.slice(0, 2000)}`;
        return `RESPONSE CONTRACT VIOLATION: your previous response did not contain a valid fenced json result. Reply now with exactly one \`\`\`json block containing the complete schema-valid result and nothing else.${schemaSection}${errorSection}`;
    }
    return `MANDATORY RESPONSE CONTRACT:
- Complete the analysis before responding.
- Your final response must contain exactly one \`\`\`json fenced block with the complete schema-valid result.
- Do not return prose, Markdown outside the block, or a question as the final answer.
- When a repository-backed blocker (outdated premise, conflicting requirements, missing information, external dependency, cannot reproduce) prevents safe progress, additionally include one \`\`\`needs-attention fenced block with {"reason": "<one of outdated_premise|conflicting_requirements|missing_information|external_dependency|cannot_reproduce>", "message": "<concise explanation>"}.
- Do not use needs-attention for work that is merely hard, large, slow, or uncertain.${schemaSection}`;
};

export const buildOpenCodeAttemptPrompt = (
    prompt: string,
    structured: boolean,
    retry: boolean,
    schema?: unknown,
    lastError?: string,
): string => {
    if (retry) {
        return `${unattendedContract}\n\n${structuredContract(true, schema, lastError)}\n\nOriginal task:\n${prompt}`;
    }
    const withContract = `${prompt}\n\n${unattendedContract}`;
    if (!structured) {
        return `${withContract}\n\nWhen blocked by a repository-backed reason above, include a \`\`\`needs-attention block with {"reason": "...", "message": "..."}. Otherwise just do the work and summarize briefly.`;
    }
    return `${withContract}\n\n${structuredContract(false, schema)}`;
};

const promptTextForAttempt = (
    input: PromptInput,
    attempt: number,
    lastError?: string,
): string => {
    const base = input.parts.map((part) => part.text).join("\n");
    return buildOpenCodeAttemptPrompt(
        base,
        input.format !== undefined,
        attempt !== 0,
        input.format?.schema,
        lastError,
    );
};

const normalizeStructuredCandidate = (candidate: unknown): unknown => {
    if (
        candidate === null ||
        typeof candidate !== "object" ||
        Array.isArray(candidate)
    ) {
        return candidate;
    }
    return Object.fromEntries(
        Object.entries(candidate as Record<string, unknown>).filter(
            ([, value]) => value !== null,
        ),
    );
};

const textParts = (text: string): ReadonlyArray<AgentPart> =>
    text === ""
        ? []
        : [{ type: "text", text: text.slice(0, 500) } as AgentPart];

type AttemptOutcome = {
    readonly text: string;
    readonly messages: ReadonlyArray<OpenCodeMessage>;
};

const runPromptOnce = async (
    transport: OpenCodeTransport,
    openCodeSessionID: string,
    text: string,
    signal: AbortSignal | undefined,
    options: OpenCodeClientOptions,
): Promise<AttemptOutcome> => {
    await transport.sessionPrompt({ sessionID: openCodeSessionID, text });
    await waitWithWatcher(transport, openCodeSessionID, signal, options);
    const messages = await transport.messageList({
        sessionID: openCodeSessionID,
    });
    return { text: assistantTextOf(messages), messages };
};

const validStructuredCandidate = (
    format: PromptFormat,
    text: string,
): { readonly value?: unknown; readonly error?: string } => {
    const candidate = extractStructuredJson(text);
    if (candidate === undefined)
        return { error: "No fenced json block was found in the response." };
    const normalized = normalizeStructuredCandidate(candidate);
    if (format.validate === undefined) return { value: normalized };
    const validation = format.validate(normalized);
    return validation.success
        ? { value: normalized }
        : { error: validation.error ?? "Schema validation failed." };
};

type PromptApiResult = ApiResult<{
    readonly info: AgentAssistantMessage;
    readonly parts: ReadonlyArray<AgentPart>;
    readonly needsAttention?: unknown;
}>;

const finishStructuredAttempt = (
    emit: (event: any, context: AgentEventContext) => void,
    input: PromptInput,
    context: AgentEventContext,
    outcome: AttemptOutcome,
    structured: unknown,
): PromptApiResult => {
    const needsAttention = extractNeedsAttentionJson(outcome.text);
    const error = assistantErrorOf(outcome.messages);
    emitSessionTranscript(emit, outcome.messages, outcome.text, context);
    emit({ type: "agent_end", willRetry: false }, context);
    return {
        data: {
            info: {
                id: input.sessionID,
                role: "assistant",
                ...(error === undefined ? {} : { error }),
                structured,
            },
            parts: textParts(outcome.text),
            ...(needsAttention === undefined ? {} : { needsAttention }),
        },
    };
};

const runStructuredPrompt = async (
    transport: OpenCodeTransport,
    emit: (event: any, context: AgentEventContext) => void,
    input: PromptInput & { readonly format: PromptFormat },
    created: PendingSession,
    context: AgentEventContext,
    signal: AbortSignal | undefined,
    options: OpenCodeClientOptions,
): Promise<PromptApiResult> => {
    const maximumAttempts = (input.format.retryCount ?? 2) + 1;
    let last: AttemptOutcome = { text: "", messages: [] };
    let lastError: string | undefined;
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
        last = await runPromptOnce(
            transport,
            created.openCodeSessionID,
            promptTextForAttempt(input, attempt, lastError),
            signal,
            options,
        );
        const checked = validStructuredCandidate(input.format, last.text);
        if (checked.value !== undefined) {
            return finishStructuredAttempt(
                emit,
                input,
                context,
                last,
                checked.value,
            );
        }
        lastError = checked.error;
    }
    const error = assistantErrorOf(last.messages);
    if (error !== undefined) {
        emit({ type: "agent_end", willRetry: false }, context);
        return {
            data: {
                info: { id: input.sessionID, role: "assistant", error },
                parts: [],
            },
        };
    }
    throw new RalphieError({
        message: `OpenCode completed without a valid fenced json result.${lastError === undefined ? "" : ` Last validation error: ${lastError.slice(0, 500)}`}`,
    });
};

const runUnstructuredPrompt = async (
    transport: OpenCodeTransport,
    emit: (event: any, context: AgentEventContext) => void,
    input: PromptInput,
    created: PendingSession,
    context: AgentEventContext,
    signal: AbortSignal | undefined,
    options: OpenCodeClientOptions,
): Promise<PromptApiResult> => {
    const outcome = await runPromptOnce(
        transport,
        created.openCodeSessionID,
        promptTextForAttempt(input, 0),
        signal,
        options,
    );
    const needsAttention = extractNeedsAttentionJson(outcome.text);
    emitSessionTranscript(emit, outcome.messages, outcome.text, context);
    emit({ type: "agent_end", willRetry: false }, context);
    const error = assistantErrorOf(outcome.messages);
    return {
        data: {
            info: {
                id: input.sessionID,
                role: "assistant",
                ...(error === undefined ? {} : { error }),
            },
            parts: textParts(outcome.text),
            ...(needsAttention === undefined ? {} : { needsAttention }),
        },
    };
};

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

const SESSION_WAIT_MAX_RETRIES = 8;
const SESSION_WAIT_BACKOFF_MS = 250;
const SESSION_WAIT_BACKOFF_CAP_MS = 4_000;

/** A turn is complete when its newest assistant message records a finish reason other than a pending tool loop, or carries an error. */
const isTurnTerminal = (messages: ReadonlyArray<OpenCodeMessage>): boolean => {
    for (const message of [...messages].reverse()) {
        if (message.type !== "assistant") continue;
        if ((message as { readonly error?: unknown }).error !== undefined) {
            return true;
        }
        const finish = (message as { readonly finish?: unknown }).finish;
        return finish !== undefined && finish !== "tool-calls";
    }
    return false;
};

/** Returns undefined once the wait completes, otherwise the last failure. */
const waitForSessionTurn = async (
    transport: OpenCodeTransport,
    openCodeSessionID: string,
    signal: AbortSignal | undefined,
    maxRetries: number,
    backoffMs: number,
): Promise<unknown> => {
    let failure: unknown = undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        try {
            await transport.sessionWait({
                sessionID: openCodeSessionID,
                signal,
            });
            return undefined;
        } catch (cause) {
            if (signal?.aborted === true) throw signal.reason ?? cause;
            failure = cause;
            if (attempt < maxRetries) {
                await sleep(
                    Math.min(
                        backoffMs * 2 ** attempt,
                        SESSION_WAIT_BACKOFF_CAP_MS,
                    ),
                );
            }
        }
    }
    return failure;
};

const sessionCompletedWhileDisconnected = async (
    transport: OpenCodeTransport,
    openCodeSessionID: string,
): Promise<boolean> => {
    try {
        const messages = await transport.messageList({
            sessionID: openCodeSessionID,
        });
        return isTurnTerminal(messages);
    } catch {
        return false;
    }
};

/**
 * Wait for a session turn, tolerating transport-level drops of the long-poll.
 *
 * The OpenCode session keeps running server-side when a wait request drops, so
 * a lost poll only loses the wait, not the work. Re-issue the wait with
 * backoff; when the retry budget is exhausted, accept a transcript that
 * already shows the turn completed. Caller cancellation remains fatal.
 */
const sessionWaitResilient = async (
    transport: OpenCodeTransport,
    openCodeSessionID: string,
    signal: AbortSignal | undefined,
    options: OpenCodeClientOptions,
): Promise<void> => {
    const maxRetries =
        options.sessionWaitMaxRetries ?? SESSION_WAIT_MAX_RETRIES;
    const backoffMs = options.sessionWaitBackoffMs ?? SESSION_WAIT_BACKOFF_MS;
    const failure = await waitForSessionTurn(
        transport,
        openCodeSessionID,
        signal,
        maxRetries,
        backoffMs,
    );
    if (failure === undefined) return;
    if (await sessionCompletedWhileDisconnected(transport, openCodeSessionID)) {
        return;
    }
    throw new RalphieError({
        message: `OpenCode session wait disconnected ${maxRetries + 1} times; the agent session may still be running.`,
        cause: failure,
    });
};

const runPermissionWatcher = async (
    transport: OpenCodeTransport,
    openCodeSessionID: string,
    done: () => boolean,
): Promise<void> => {
    if (
        transport.permissionList === undefined ||
        transport.permissionReply === undefined
    ) {
        return;
    }
    while (!done()) {
        try {
            const requests = await transport.permissionList({
                sessionID: openCodeSessionID,
            });
            for (const request of requests) {
                const denied =
                    request.action === "shell" &&
                    request.resources.some((resource) =>
                        isDeniedShellResource(resource),
                    );
                // Unattended: allow ordinary work once, reject denied shell.
                await transport
                    .permissionReply({
                        sessionID: openCodeSessionID,
                        requestID: request.id,
                        reply: denied ? "reject" : "once",
                    })
                    .catch(() => undefined);
            }
        } catch {
            // Best effort; a failed poll must not fail the session.
        }
        await sleep(250);
    }
};

const waitWithWatcher = async (
    transport: OpenCodeTransport,
    openCodeSessionID: string,
    signal: AbortSignal | undefined,
    options: OpenCodeClientOptions,
): Promise<void> => {
    let finished = false;
    const watcher = runPermissionWatcher(
        transport,
        openCodeSessionID,
        () => finished,
    );
    const abortWatcher = () => {
        finished = true;
    };
    if (signal?.aborted === true) {
        finished = true;
        await watcher.catch(() => undefined);
        throw signal.reason;
    }
    const onAbort = () => {
        void transport
            .sessionInterrupt({ sessionID: openCodeSessionID })
            .catch(() => undefined);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
        await sessionWaitResilient(
            transport,
            openCodeSessionID,
            signal,
            options,
        );
        finished = true;
        await watcher.catch(() => undefined);
    } catch (cause) {
        finished = true;
        await watcher.catch(() => undefined);
        // Ensure a hung agent loop does not leak after abort.
        if (signal?.aborted) {
            await transport
                .sessionInterrupt({ sessionID: openCodeSessionID })
                .catch(() => undefined);
        }
        throw cause;
    } finally {
        signal?.removeEventListener("abort", onAbort);
        abortWatcher();
    }
};

export const makeOpenCodeClient = (
    transport: OpenCodeTransport,
    eventListener?: AgentEventListener,
    clientOptions: OpenCodeClientOptions = {},
): AgentClient => {
    const pending = new Map<string, PendingSession>();
    let counter = 0;

    const emit = (event: any, context: AgentEventContext): void => {
        try {
            eventListener?.(event, context);
        } catch {
            // Listener failures must not fail the session.
        }
    };

    return {
        session: {
            create: async (input, options) => {
                options?.signal?.throwIfAborted();
                const createdSession = await transport.sessionCreate({
                    directory: input.directory,
                    ...(input.title === undefined
                        ? {}
                        : { title: input.title }),
                    ...(input.agent === undefined &&
                    input.profile !== AgentSessionProfile.Review
                        ? {}
                        : {
                              agent:
                                  input.profile === AgentSessionProfile.Review
                                      ? "explore"
                                      : (input.agent ?? "build"),
                          }),
                    ...(toTransportModel(input.model, input.variant) ===
                    undefined
                        ? {}
                        : {
                              model: toTransportModel(
                                  input.model,
                                  input.variant,
                              )!,
                          }),
                });
                const openCodeSessionID = createdSession.id;
                counter += 1;
                const id = `opencode-${counter}-${openCodeSessionID}`;
                pending.set(id, {
                    directory: input.directory,
                    title: input.title,
                    agent: input.agent,
                    model: input.model,
                    variant: input.variant,
                    profile: input.profile,
                    openCodeSessionID,
                });
                return { data: { id } };
            },
            prompt: async (input, options) => {
                const created = pending.get(input.sessionID);
                if (created === undefined) {
                    return {
                        error: new Error(
                            `Unknown OpenCode session: ${input.sessionID}`,
                        ),
                    };
                }
                const context: AgentEventContext = {
                    sessionID: input.sessionID,
                    directory: input.directory,
                    ...(created.title === undefined
                        ? {}
                        : { title: created.title }),
                };
                emit({ type: "agent_start" }, context);
                try {
                    options?.signal?.throwIfAborted();
                    const result =
                        input.format === undefined
                            ? await runUnstructuredPrompt(
                                  transport,
                                  emit,
                                  input,
                                  created,
                                  context,
                                  options?.signal,
                                  clientOptions,
                              )
                            : await runStructuredPrompt(
                                  transport,
                                  emit,
                                  input as PromptInput & {
                                      readonly format: PromptFormat;
                                  },
                                  created,
                                  context,
                                  options?.signal,
                                  clientOptions,
                              );
                    pending.delete(input.sessionID);
                    return result;
                } catch (cause) {
                    emit({ type: "agent_end", willRetry: false }, context);
                    pending.delete(input.sessionID);
                    throw cause;
                }
            },
        },
        close: () => {
            pending.clear();
        },
    };
};