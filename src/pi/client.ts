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
    PI_NEEDS_ATTENTION_MESSAGE_LIMIT,
    PI_NEEDS_ATTENTION_REASONS,
} from "../agent/task-session.ts";

export type PiModel = {
    readonly providerID: string;
    readonly modelID: string;
};

export type PiPermissionRuleset = ReadonlyArray<{
    readonly permission: string;
    readonly pattern: string;
    readonly action: "allow" | "deny";
}>;

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
};

type PromptInput = {
    readonly sessionID: string;
    readonly directory: string;
    readonly agent?: string;
    readonly model?: PiModel;
    readonly variant?: string;
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
type PiSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

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
        execute: async (_toolCallId, params) => {
            if (format.validate !== undefined) {
                const validation = format.validate(params);
                if (!validation.success) {
                    throw new Error(
                        validation.error === undefined
                            ? "Structured result failed Ralphie's schema validation. Correct the arguments and call submit_result again."
                            : `Structured result failed Ralphie's schema validation:\n${validation.error}\nCorrect the arguments and call submit_result again.`,
                    );
                }
            }
            setStructured(params);
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
): PromptTools => {
    const readOnly =
        created.permission?.some(
            (rule) => rule.permission === "edit" && rule.action === "deny",
        ) ?? false;
    const customTools: AnyToolDefinition[] = readOnly
        ? []
        : [makeBashTool(input.directory)];
    const activeTools = readOnly
        ? ["read", "grep", "find", "ls"]
        : ["read", "bash", "edit", "write"];
    customTools.push(makeNeedsAttentionTool(setNeedsAttention));
    activeTools.push("request_needs_attention");
    if (input.format !== undefined) {
        customTools.push(makeStructuredResultTool(input.format, setStructured));
        activeTools.push("submit_result");
    }
    return { activeTools, customTools };
};

const createPromptSession = async (
    modelRuntime: ModelRuntime,
    input: PromptInput,
    created: PendingSession,
    tools: PromptTools,
    agentDir: string,
): Promise<PiSession> => {
    const resourceLoader = new DefaultResourceLoader({
        cwd: input.directory,
        agentDir,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
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
    });
    return session;
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

export const makePiClient = (
    modelRuntime: ModelRuntime,
    eventListener?: PiEventListener,
    agentDir = process.env.PI_CODING_AGENT_DIR ?? getAgentDir(),
): PiClient => {
    const pending = new Map<string, PendingSession>();
    const active = new Set<{
        abort: () => Promise<void>;
    }>();

    return {
        session: {
            create: async (input, options) => {
                if (options?.signal?.aborted) throw options.signal.reason;
                const id = randomUUID();
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

                let structured: unknown;
                let needsAttention: unknown;
                const tools = makePromptTools(
                    input,
                    created,
                    (value) => {
                        structured = value;
                    },
                    (value) => {
                        needsAttention ??= value;
                    },
                );
                const session = await createPromptSession(
                    modelRuntime,
                    input,
                    created,
                    tools,
                    agentDir,
                );
                active.add(session);
                const unsubscribe =
                    eventListener === undefined
                        ? undefined
                        : session.subscribe((event) =>
                              eventListener(event, {
                                  sessionID: input.sessionID,
                                  directory: input.directory,
                                  title: created.title,
                              }),
                          );
                const abort = () => void session.abort();
                options?.signal?.addEventListener("abort", abort, {
                    once: true,
                });

                try {
                    const prompt = input.parts
                        .map((part) => part.text)
                        .join("\n");
                    const { assistant } = await runPromptAttempts(
                        session,
                        input,
                        prompt,
                        () => structured,
                    );
                    return makePromptResponse(
                        input,
                        assistant,
                        structured,
                        needsAttention,
                    );
                } finally {
                    unsubscribe?.();
                    options?.signal?.removeEventListener("abort", abort);
                    active.delete(session);
                    pending.delete(input.sessionID);
                    await session.dispose();
                }
            },
        },
        close: () => {
            for (const session of active) void session.abort();
            active.clear();
            pending.clear();
        },
    };
};