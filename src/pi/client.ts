import {
    createAgentSession,
    createBashToolDefinition,
    DefaultResourceLoader,
    getAgentDir,
    ModelRuntime,
    SessionManager,
    type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";

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

const unsafeShellComposition = /[\n\r;&|<>`]|\$\(/;
const deniedTaskCommand =
    /(?:^|\s)(?:git\s+(?:commit|push|branch|checkout|switch|worktree|reset|clean)|gh(?:\s|$))/i;

export const isPiTaskCommandAllowed = (command: string): boolean =>
    !unsafeShellComposition.test(command) &&
    !deniedTaskCommand.test(command.trim());

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

export const makePiClient = (modelRuntime: ModelRuntime): PiClient => {
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

                const readOnly =
                    created.permission?.some(
                        (rule) =>
                            rule.permission === "edit" &&
                            rule.action === "deny",
                    ) ?? false;
                let structured: unknown;
                const customTools: AnyToolDefinition[] = readOnly
                    ? []
                    : [makeBashTool(input.directory)];
                const activeTools = readOnly
                    ? ["read", "grep", "find", "ls"]
                    : ["read", "bash", "edit", "write"];

                if (input.format !== undefined) {
                    customTools.push({
                        name: "submit_result",
                        label: "Submit result",
                        description:
                            "Mandatory final response tool. After completing the task, call this tool exactly once with the complete result matching its schema. Never return the result as prose, Markdown, or printed JSON, and never end the turn without calling this tool. If validation rejects an invocation, correct every reported field and call it again.",
                        parameters: input.format.schema as never,
                        constrainedSampling: {
                            type: "json_schema",
                            strict: "prefer",
                        },
                        executionMode: "sequential",
                        execute: async (_toolCallId, params) => {
                            if (input.format?.validate !== undefined) {
                                const validation =
                                    input.format.validate(params);
                                if (!validation.success) {
                                    throw new Error(
                                        validation.error === undefined
                                            ? "Structured result failed Ralphie's schema validation. Correct the arguments and call submit_result again."
                                            : `Structured result failed Ralphie's schema validation:\n${validation.error}\nCorrect the arguments and call submit_result again.`,
                                    );
                                }
                            }
                            structured = params;
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
                    } as AnyToolDefinition);
                    activeTools.push("submit_result");
                }

                const resourceLoader = new DefaultResourceLoader({
                    cwd: input.directory,
                    agentDir: process.env.PI_CODING_AGENT_DIR ?? getAgentDir(),
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
                    tools: activeTools,
                    customTools,
                    resourceLoader,
                    sessionManager: SessionManager.inMemory(input.directory, {
                        id: input.sessionID,
                    }),
                });
                active.add(session);
                const abort = () => void session.abort();
                options?.signal?.addEventListener("abort", abort, {
                    once: true,
                });

                try {
                    const prompt = input.parts
                        .map((part) => part.text)
                        .join("\n");
                    const maximumAttempts =
                        input.format === undefined
                            ? 1
                            : (input.format.retryCount ?? 2) + 1;
                    let assistant: ReturnType<typeof finalAssistant>;
                    for (
                        let attempt = 0;
                        attempt < maximumAttempts;
                        attempt += 1
                    ) {
                        await session.prompt(
                            attempt === 0
                                ? input.format === undefined
                                    ? prompt
                                    : `${prompt}\n\nMANDATORY RESPONSE CONTRACT:\n- Complete the analysis before submitting.\n- Your final action must be exactly one call to the submit_result tool.\n- Supply every required field and obey all field relationships in the schema.\n- Do not return prose, Markdown, a code fence, or printed JSON as the final answer.\n- Do not end the turn without a successful submit_result call.\n- If the tool reports validation errors, correct all errors and call it again.`
                                : "RESPONSE CONTRACT VIOLATION: your previous response ended without a valid submit_result call. Call submit_result now with the complete schema-valid result. Do not provide more analysis, prose, Markdown, or printed JSON. If validation reports errors, correct them and call the tool again.",
                            {
                                expandPromptTemplates: false,
                            },
                        );
                        assistant = finalAssistant(session.messages);
                        if (
                            structured !== undefined ||
                            assistant?.stopReason === "aborted" ||
                            assistant?.stopReason === "error"
                        ) {
                            break;
                        }
                    }
                    const error = assistantError(
                        assistant,
                        input.format !== undefined && structured === undefined
                            ? (input.format.retryCount ?? 2)
                            : 0,
                    );
                    const parts = assistantParts(assistant);
                    return {
                        data: {
                            info: {
                                id: input.sessionID,
                                role: "assistant",
                                ...(error === undefined
                                    ? {}
                                    : {
                                          error,
                                      }),
                                ...(structured === undefined
                                    ? {}
                                    : {
                                          structured,
                                      }),
                            },
                            parts,
                        },
                    };
                } finally {
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