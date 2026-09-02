import {
    createAgentSession,
    createBashToolDefinition,
    DefaultResourceLoader,
    getAgentDir,
    ModelRuntime,
    SessionManager,
    type AgentSessionEvent,
    type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";

import {
    normalizeEnumNullLiterals,
    stripExplicitNulls,
} from "../agent/json-schema.ts";
import {
    PI_NEEDS_ATTENTION_MESSAGE_LIMIT,
    PI_NEEDS_ATTENTION_REASONS,
} from "../agent/task-session.ts";
import { RalphieError } from "../shared/error.ts";
import {
    makeSubmitResultGuard,
    type SubmitResultGuard,
} from "./submit-result-guard.ts";

export type PiModel = {
    readonly providerID: string;
    readonly modelID: string;
};

export type PiPermissionRuleset = ReadonlyArray<{
    readonly permission: string;
    readonly pattern: string;
    readonly action: "allow" | "deny";
}>;

export const PiSessionProfile = {
    Default: "default",
    Review: "review",
} as const;

export type PiSessionProfile =
    (typeof PiSessionProfile)[keyof typeof PiSessionProfile];

export const PI_REVIEW_SESSION_PROFILE = PiSessionProfile.Review;

export type PiAssistantError = {
    readonly name: string;
    readonly data?: {
        readonly message?: string;
        readonly retries?: number;
    };
};

export type PiAssistantMessage = {
    readonly id: string;
    readonly role: "assistant";
    readonly error?: PiAssistantError;
    readonly structured?: unknown;
    readonly [key: string]: unknown;
};

export type PiPart = {
    readonly type: string;
    readonly text?: string;
    readonly [key: string]: unknown;
};

export type PiSessionEvent = AgentSessionEvent;

export type PiEventContext = {
    readonly sessionID: string;
    readonly directory: string;
    readonly title?: string;
};

export type PiEventListener = (
    event: PiSessionEvent,
    context: PiEventContext,
) => void;

type CreateSessionInput = {
    readonly directory: string;
    readonly title?: string;
    readonly agent?: string;
    readonly model?:
        | PiModel
        | {
              readonly providerID: string;
              readonly id: string;
          };
    readonly permission?: PiPermissionRuleset;
    readonly profile?: PiSessionProfile;
};

type PromptInput = {
    readonly sessionID: string;
    readonly directory: string;
    readonly agent?: string;
    readonly model?: PiModel;
    readonly variant?: string;
    readonly profile?: PiSessionProfile;
    readonly parts: ReadonlyArray<{
        readonly type: "text";
        readonly text: string;
    }>;
    readonly format?: {
        readonly type: "json_schema";
        readonly schema: unknown;
        readonly retryCount?: number;
        readonly validate?: (value: unknown) => {
            readonly success: boolean;
            readonly error?: string;
        };
    };
};

type ApiResult<T> = {
    readonly data?: T;
    readonly error?: unknown;
};

export type PiClient = {
    readonly session: {
        create: (
            input: CreateSessionInput,
            options?: {
                readonly signal?: AbortSignal;
            },
        ) => Promise<
            ApiResult<{
                readonly id: string;
            }>
        >;
        prompt: (
            input: PromptInput,
            options?: {
                readonly signal?: AbortSignal;
            },
        ) => Promise<
            ApiResult<{
                readonly info: PiAssistantMessage;
                readonly parts: ReadonlyArray<PiPart>;
                /** Structured side-channel data captured from Pi tools. */
                readonly needsAttention?: unknown;
            }>
        >;
    };
    readonly close?: () => void;
};

type PendingSession = CreateSessionInput;

type ThinkingLevel =
    | "off"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max";

const deniedTaskCommand =
    /(?:^|\s)(?:git\s+(?:commit|push|branch|checkout|switch|worktree|reset|clean)|gh(?:\s|$))/i;

export const isPiTaskCommandAllowed = (command: string): boolean => {
    const trimmed = command.trim();
    return trimmed.length > 0 && !deniedTaskCommand.test(trimmed);
};

type AnyToolDefinition = ToolDefinition<any, any, any>;

const makeBashTool = (directory: string): AnyToolDefinition =>
    createBashToolDefinition(directory, {
        spawnHook: (context) => {
            if (!isPiTaskCommandAllowed(context.command)) {
                throw new Error(
                    `Ralphie policy denied shell command: ${context.command}`,
                );
            }
            return context;
        },
    });

const thinkingLevelFor = (
    variant: string | undefined,
): ThinkingLevel | undefined => {
    if (variant === undefined) return undefined;
    const levels: ReadonlyArray<ThinkingLevel> = [
        "off",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
    ];
    if (!levels.includes(variant as ThinkingLevel)) {
        throw new Error(`Unsupported Pi thinking level: ${variant}`);
    }
    return variant as ThinkingLevel;
};

const finalAssistant = (
    messages: ReadonlyArray<unknown>,
):
    | {
          readonly content?: unknown;
          readonly stopReason?: unknown;
          readonly errorMessage?: unknown;
      }
    | undefined =>
    [...messages].reverse().find(
        (
            message,
        ): message is {
            readonly role: "assistant";
            readonly content?: unknown;
            readonly stopReason?: unknown;
            readonly errorMessage?: unknown;
        } =>
            typeof message === "object" &&
            message !== null &&
            (
                message as {
                    readonly role?: unknown;
                }
            ).role === "assistant",
    );

const assistantParts = (
    assistant: ReturnType<typeof finalAssistant>,
): PiPart[] => {
    if (!assistant || !Array.isArray(assistant.content)) return [];
    return assistant.content.filter(
        (part): part is PiPart =>
            typeof part === "object" && part !== null && "type" in part,
    );
};

const assistantText = (
    assistant: ReturnType<typeof finalAssistant>,
): string | undefined => {
    const text = assistantParts(assistant)
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n")
        .trim();
    return text.length === 0 ? undefined : text.slice(0, 500);
};

const assistantError = (
    assistant: ReturnType<typeof finalAssistant>,
    structuredRetries: number,
): PiAssistantError | undefined => {
    if (assistant?.stopReason === "aborted")
        return {
            name: "MessageAbortedError",
        };
    if (assistant?.stopReason === "length")
        return {
            name: "MessageOutputLengthError",
        };
    if (assistant?.stopReason === "error") {
        return {
            name: "PiAgentError",
            data: {
                message:
                    typeof assistant.errorMessage === "string"
                        ? assistant.errorMessage
                        : "Pi provider request failed.",
            },
        };
    }
    return structuredRetries > 0
        ? {
              name: "StructuredOutputError",
              data: {
                  message: `Pi completed without a valid structured result.${
                      assistantText(assistant) === undefined
                          ? ""
                          : ` Last assistant text: ${assistantText(assistant)}`
                  }`,
                  retries: structuredRetries,
              },
          }
        : undefined;
};

const modelFor = (
    runtime: ModelRuntime,
    model: PromptInput["model"] | CreateSessionInput["model"],
) => {
    if (model === undefined) return undefined;
    const modelID = "modelID" in model ? model.modelID : model.id;
    if (
        model.providerID === "openai" &&
        !runtime.hasConfiguredAuth("openai") &&
        runtime.hasConfiguredAuth("openai-codex")
    ) {
        const subscriptionModel = runtime.getModel("openai-codex", modelID);
        if (subscriptionModel !== undefined) return subscriptionModel;
    }
    const resolved = runtime.getModel(model.providerID, modelID);
    if (resolved === undefined) {
        throw new Error(`Pi model not found: ${model.providerID}/${modelID}`);
    }
    return resolved;
};

type PromptFormat = NonNullable<PromptInput["format"]>;
type CreateAgentSession = typeof createAgentSession;
type CreateAgentSessionResult = Awaited<ReturnType<CreateAgentSession>>;
type PiSession = CreateAgentSessionResult["session"];

const needsAttentionToolParameters = {
    type: "object",
    properties: {
        reason: {
            type: "string",
            enum: PI_NEEDS_ATTENTION_REASONS,
            description: "The repository-backed reason work cannot proceed.",
        },
        message: {
            type: "string",
            minLength: 1,
            maxLength: PI_NEEDS_ATTENTION_MESSAGE_LIMIT,
            description: "A concise explanation grounded in repository facts.",
        },
    },
    required: ["reason"],
    additionalProperties: false,
} as const;

const makeNeedsAttentionTool = (
    setNeedsAttention: (value: unknown) => void,
): AnyToolDefinition =>
    ({
        name: "request_needs_attention",
        label: "Request needs attention",
        description:
            "Request operator attention when a repository-backed blocker prevents safe progress. This unattended session has no operator who can answer questions during the turn, so use this tool instead of asking in prose. This is a side-channel request, not the final task or review result.",
        promptSnippet:
            "Request needs attention for a repository-backed blocker",
        promptGuidelines: [
            "Use request_needs_attention only for an outdated premise, conflicting requirements, missing information, external dependency, or a problem that cannot be reproduced.",
            "Do not use request_needs_attention for work that is merely hard, large, slow, or uncertain.",
            "Never ask the user or operator a question in prose or wait for a reply; this session is unattended.",
        ],
        parameters: needsAttentionToolParameters as never,
        executionMode: "sequential",
        execute: async (_toolCallId, params) => {
            setNeedsAttention(params);
            return {
                content: [
                    {
                        type: "text",
                        text: "Needs-attention request recorded.",
                    },
                ],
                details: {},
            };
        },
    }) as AnyToolDefinition;

const makeStructuredResultTool = (
    format: PromptFormat,
    setStructured: (value: unknown) => void,
    guard: SubmitResultGuard,
): AnyToolDefinition =>
    ({
        name: "submit_result",
        label: "Submit result",
        description:
            "Mandatory final response tool. After completing the task, call this tool exactly once with the complete result matching its schema. Never return the result as prose, Markdown, or printed JSON, and never end the turn without calling this tool. If validation rejects an invocation, correct every reported field and call it again.",
        parameters: format.schema as never,
        constrainedSampling: {
            type: "json_schema",
            strict: "prefer",
        },
        executionMode: "sequential",
        prepareArguments: (args: unknown) => {
            guard.beginAttempt(args);
            return normalizeEnumNullLiterals(format.schema, args);
        },
        execute: async (_toolCallId, params) => {
            const candidate = stripExplicitNulls(params);
            if (format.validate !== undefined) {
                const validation = format.validate(candidate);
                if (!validation.success) {
                    const failure =
                        validation.error === undefined
                            ? "Structured result failed Ralphie's schema validation."
                            : `Structured result failed Ralphie's schema validation:\n${validation.error}`;
                    guard.recordFailure(failure);
                    throw new Error(
                        `${failure}\nCorrect the arguments and call submit_result again.`,
                    );
                }
            }
            guard.recordSuccess();
            setStructured(candidate);
            return {
                content: [
                    {
                        type: "text",
                        text: "Structured result accepted.",
                    },
                ],
                details: {},
                terminate: true,
            };
        },
    }) as AnyToolDefinition;

const unattendedSessionContract = `UNATTENDED EXECUTION CONTRACT:
- You are running autonomously in a non-interactive harness. No user or operator can answer during this turn.
- Do not ask questions in prose, request confirmation, offer choices, pause for input, or wait for a reply.
- Inspect the available repository context, make reasonable decisions, and complete as much of the task as is safely possible.
- If a repository-backed blocker genuinely prevents safe progress, call request_needs_attention instead of asking a question. Then continue to satisfy any final response contract.
- If a completion or result tool is provided, you must call it as instructed before ending the turn. Do not merely describe the intended result or proposed next steps.`;

export const buildPiAttemptPrompt = (
    prompt: string,
    structured: boolean,
    retry: boolean,
): string => {
    if (retry) {
        return `${unattendedSessionContract}\n\nRESPONSE CONTRACT VIOLATION: your previous response ended without a valid submit_result call. Call submit_result now with the complete schema-valid result. Do not provide more analysis, prose, Markdown, printed JSON, or questions. If validation reports errors, correct them and call the tool again.`;
    }
    const withSessionContract = `${prompt}\n\n${unattendedSessionContract}`;
    if (!structured) return withSessionContract;
    return `${withSessionContract}\n\nMANDATORY RESPONSE CONTRACT:\n- Complete the analysis before submitting.\n- Your final action must be exactly one call to the submit_result tool.\n- Supply every required field and obey all field relationships in the schema.\n- Do not return prose, Markdown, a code fence, printed JSON, or a question as the final answer.\n- Do not end the turn without a successful submit_result call.\n- If the tool reports validation errors, correct all errors and call it again.`;
};

const promptForAttempt = (
    input: PromptInput,
    prompt: string,
    attempt: number,
): string =>
    buildPiAttemptPrompt(prompt, input.format !== undefined, attempt !== 0);

const runPromptAttempts = async (
    session: PiSession,
    input: PromptInput,
    prompt: string,
    structured: () => unknown,
): Promise<{
    readonly assistant: ReturnType<typeof finalAssistant>;
    readonly structured: unknown;
}> => {
    const maximumAttempts =
        input.format === undefined ? 1 : (input.format.retryCount ?? 2) + 1;
    let assistant: ReturnType<typeof finalAssistant>;
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
        await session.prompt(promptForAttempt(input, prompt, attempt), {
            expandPromptTemplates: false,
        });
        assistant = finalAssistant(session.messages);
        if (
            structured() !== undefined ||
            assistant?.stopReason === "aborted" ||
            assistant?.stopReason === "error"
        ) {
            break;
        }
    }
    return { assistant, structured: structured() };
};

type PromptTools = {
    readonly activeTools: string[];
    readonly customTools: AnyToolDefinition[];
};

const makePromptTools = (
    input: PromptInput,
    created: PendingSession,
    setStructured: (value: unknown) => void,
    setNeedsAttention: (value: unknown) => void,
    guard: SubmitResultGuard,
): PromptTools => {
    const reviewProfile =
        created.profile === PiSessionProfile.Review ||
        input.profile === PiSessionProfile.Review;
    const customTools: AnyToolDefinition[] = reviewProfile
        ? []
        : [makeBashTool(input.directory)];
    const activeTools = reviewProfile
        ? []
        : created.permission?.some(
                (rule) => rule.permission === "edit" && rule.action === "deny",
            )
          ? ["read", "grep", "find", "ls"]
          : ["read", "bash", "edit", "write"];
    customTools.push(makeNeedsAttentionTool(setNeedsAttention));
    activeTools.push("request_needs_attention");
    if (input.format !== undefined) {
        customTools.push(
            makeStructuredResultTool(input.format, setStructured, guard),
        );
        activeTools.push("submit_result");
    }
    return { activeTools, customTools };
};

const disposeAbortedSession = async (session: PiSession): Promise<void> => {
    await session.abort().catch(() => undefined);
    session.dispose();
};

const awaitWithAbort = async <Value>(
    operation: () => PromiseLike<Value>,
    signal: AbortSignal | undefined,
): Promise<Value> => {
    if (signal === undefined) return await operation();
    signal.throwIfAborted();
    return await new Promise<Value>((resolve, reject) => {
        let settled = false;
        const onAbort = () => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", onAbort);
            reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) {
            onAbort();
            return;
        }
        Promise.resolve()
            .then(operation)
            .then(
                (value) => {
                    if (settled) return;
                    settled = true;
                    signal.removeEventListener("abort", onAbort);
                    resolve(value);
                },
                (cause) => {
                    if (settled) return;
                    settled = true;
                    signal.removeEventListener("abort", onAbort);
                    reject(cause);
                },
            );
    });
};

const createPromptSession = async (
    modelRuntime: ModelRuntime,
    input: PromptInput,
    created: PendingSession,
    tools: PromptTools,
    agentDir: string,
    signal: AbortSignal | undefined,
    createSession: CreateAgentSession,
): Promise<PiSession> => {
    signal?.throwIfAborted();
    const reviewProfile =
        created.profile === PiSessionProfile.Review ||
        input.profile === PiSessionProfile.Review;
    const resourceLoader = new DefaultResourceLoader({
        cwd: input.directory,
        agentDir,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        ...(reviewProfile
            ? {
                  noContextFiles: true,
                  systemPrompt: "",
                  appendSystemPrompt: [],
              }
            : {}),
    });
    let session: PiSession | undefined;
    let abortedDuringConstruction = false;
    const abortDuringConstruction = () => {
        abortedDuringConstruction = true;
    };
    signal?.addEventListener("abort", abortDuringConstruction, { once: true });
    try {
        await awaitWithAbort(() => resourceLoader.reload(), signal);
        const startConstruction = (): Promise<CreateAgentSessionResult> => {
            const construction = Promise.resolve().then(() =>
                createSession({
                    cwd: input.directory,
                    modelRuntime,
                    model: modelFor(modelRuntime, input.model ?? created.model),
                    thinkingLevel: thinkingLevelFor(input.variant),
                    tools: tools.activeTools,
                    customTools: tools.customTools,
                    resourceLoader,
                    sessionManager: SessionManager.inMemory(input.directory, {
                        id: input.sessionID,
                    }),
                }),
            );
            void construction.then(
                (result) => {
                    if (abortedDuringConstruction || signal?.aborted) {
                        void disposeAbortedSession(result.session).catch(
                            () => undefined,
                        );
                    }
                },
                () => undefined,
            );
            return construction;
        };
        const result = await awaitWithAbort(startConstruction, signal);
        session = result.session;
        if (abortedDuringConstruction || signal?.aborted) {
            await disposeAbortedSession(session);
            session = undefined;
            signal?.throwIfAborted();
            throw new Error("Pi session construction was aborted.");
        }
        return session;
    } catch (cause) {
        if (session !== undefined) {
            await disposeAbortedSession(session);
        }
        throw cause;
    } finally {
        signal?.removeEventListener("abort", abortDuringConstruction);
    }
};

const makePromptResponse = (
    input: PromptInput,
    assistant: ReturnType<typeof finalAssistant>,
    structured: unknown,
    needsAttention: unknown,
): {
    readonly data: {
        readonly info: PiAssistantMessage;
        readonly parts: ReadonlyArray<PiPart>;
    };
} => {
    const error = assistantError(
        assistant,
        input.format !== undefined && structured === undefined
            ? (input.format.retryCount ?? 2)
            : 0,
    );
    return {
        data: {
            info: {
                id: input.sessionID,
                role: "assistant",
                ...(error === undefined ? {} : { error }),
                ...(structured === undefined ? {} : { structured }),
            },
            parts: assistantParts(assistant),
            ...(needsAttention === undefined ? {} : { needsAttention }),
        },
    };
};

type PromptOptions = {
    readonly signal?: AbortSignal;
};

const runPiPrompt = async (
    modelRuntime: ModelRuntime,
    eventListener: PiEventListener | undefined,
    active: Set<PiSession>,
    pending: Map<string, PendingSession>,
    input: PromptInput,
    options: PromptOptions | undefined,
    created: PendingSession,
    agentDir: string,
    createSession: CreateAgentSession,
) => {
    let session: PiSession | undefined;
    let unsubscribe: (() => void) | undefined;
    let abort: (() => void) | undefined;
    try {
        options?.signal?.throwIfAborted();
        let structured: unknown;
        let needsAttention: unknown;
        const guard = makeSubmitResultGuard();
        const tools = makePromptTools(
            input,
            created,
            (value) => {
                structured = value;
            },
            (value) => {
                needsAttention ??= value;
            },
            guard,
        );
        session = await createPromptSession(
            modelRuntime,
            input,
            created,
            tools,
            agentDir,
            options?.signal,
            createSession,
        );
        options?.signal?.throwIfAborted();
        active.add(session);
        guard.onTrip(() => void session?.abort());
        unsubscribe =
            eventListener === undefined
                ? undefined
                : session.subscribe((event) =>
                      eventListener(event, {
                          sessionID: input.sessionID,
                          directory: input.directory,
                          title: created.title,
                      }),
                  );
        abort = () => void session?.abort();
        options?.signal?.addEventListener("abort", abort, { once: true });
        if (options?.signal?.aborted) abort();

        const prompt = input.parts.map((part) => part.text).join("\n");
        const { assistant } = await runPromptAttempts(
            session,
            input,
            prompt,
            () => structured,
        );
        const tripReason = guard.tripReason();
        if (tripReason !== undefined) {
            throw new RalphieError({
                message: `${tripReason}.${
                    input.model === undefined
                        ? ""
                        : ` Model: ${input.model.providerID}/${input.model.modelID}.`
                }`,
            });
        }
        return makePromptResponse(input, assistant, structured, needsAttention);
    } finally {
        unsubscribe?.();
        if (abort !== undefined) {
            options?.signal?.removeEventListener("abort", abort);
        }
        if (session !== undefined) {
            active.delete(session);
            session.dispose();
        }
        pending.delete(input.sessionID);
    }
};

export const makePiClient = (
    modelRuntime: ModelRuntime,
    eventListener?: PiEventListener,
    agentDir = process.env.PI_CODING_AGENT_DIR ?? getAgentDir(),
    createSession: CreateAgentSession = createAgentSession,
): PiClient => {
    const pending = new Map<string, PendingSession>();
    const issuedSessionIDs = new Set<string>();
    const active = new Set<PiSession>();

    return {
        session: {
            create: async (input, options) => {
                if (options?.signal?.aborted) throw options.signal.reason;
                let id = randomUUID();
                while (issuedSessionIDs.has(id)) id = randomUUID();
                issuedSessionIDs.add(id);
                pending.set(id, input);
                return {
                    data: {
                        id,
                    },
                };
            },
            prompt: async (input, options) => {
                const created = pending.get(input.sessionID);
                if (created === undefined) {
                    return {
                        error: new Error(
                            `Unknown Pi session: ${input.sessionID}`,
                        ),
                    };
                }
                return await runPiPrompt(
                    modelRuntime,
                    eventListener,
                    active,
                    pending,
                    input,
                    options,
                    created,
                    agentDir,
                    createSession,
                );
            },
        },
        close: () => {
            for (const session of active) void session.abort();
            active.clear();
            pending.clear();
        },
    };
};