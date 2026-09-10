import { Agent } from "@earendil-works/pi-agent-core";
import type {
    AssistantMessage,
    MutableModels,
    TextContent,
} from "@earendil-works/pi-ai";

import {
    AgentSessionProfile,
    type AgentAssistantMessage,
    type AgentApiResult,
    type AgentClient,
    type AgentEventContext,
    type AgentEventListener,
    type AgentModel,
    type AgentPart,
    type AgentPromptFormat,
    type AgentPromptInput,
} from "../agent/contracts.ts";
import { RalphieError } from "../shared/error.ts";
import { extractNeedsAttentionJson, extractStructuredJson } from "./json.ts";
import {
    modelReference,
    resolvePiModel,
    thinkingLevelFor,
    type PiModelSelection,
} from "./models.ts";
import { makePiTools, type PiToolSet } from "./tools.ts";

export type PiAgentClientOptions = {
    readonly models: MutableModels;
    /** Pi config directory used for default-model resolution. */
    readonly agentDir: string;
    /** Pre-resolved default model; falls back to the pi settings file. */
    readonly defaultModel?: AgentModel;
    readonly eventListener?: AgentEventListener;
    readonly systemPrompt?: string;
};

type PiSession = {
    readonly id: string;
    readonly directory: string;
    readonly title?: string;
    readonly modelReference: string;
    readonly agent: Agent;
    readonly tools: PiToolSet;
    readonly unsubscribe: () => void;
};

type AttemptOutcome = {
    readonly text: string;
    readonly assistant?: AssistantMessage;
};

type PromptApiResult = AgentApiResult<{
    readonly info: AgentAssistantMessage;
    readonly parts: ReadonlyArray<AgentPart>;
    readonly needsAttention?: unknown;
}>;

export const RALPHIE_SYSTEM_PROMPT = `You are an autonomous coding agent working inside a checked-out Git repository.
Ralphie owns staging, commits, pushes, and all GitHub mutations; never perform delivery-state changes.
Use the read, write, edit, and bash tools to inspect and modify files inside the repository checkout.
Follow the task prompt exactly and satisfy the requested final response contract.`;

const unattendedContract = `UNATTENDED EXECUTION CONTRACT:
- You are running autonomously in a non-interactive agent session. No user or operator can answer during this turn.
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

export const buildPiAttemptPrompt = (
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
    input: AgentPromptInput,
    attempt: number,
    lastError?: string,
): string => {
    const base = input.parts.map((part) => part.text).join("\n");
    return buildPiAttemptPrompt(
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

const lastAssistantMessage = (agent: Agent): AssistantMessage | undefined => {
    for (const message of [...agent.state.messages].reverse()) {
        if (message.role === "assistant") return message;
    }
    return undefined;
};

const assistantTextOf = (message: AssistantMessage | undefined): string => {
    if (message === undefined) return "";
    return message.content
        .filter((block): block is TextContent => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
};

const assistantErrorOf = (
    message: AssistantMessage | undefined,
): AgentAssistantMessage["error"] | undefined => {
    if (message === undefined) return undefined;
    if (message.stopReason === "aborted") {
        return {
            name: "MessageAbortedError",
            data: {
                message: message.errorMessage ?? "Pi assistant was aborted.",
            },
        };
    }
    if (message.stopReason === "length") {
        return { name: "MessageOutputLengthError" };
    }
    if (message.stopReason === "error") {
        return {
            name: "PiAssistantError",
            data: { message: message.errorMessage ?? "Pi assistant failed." },
        };
    }
    return undefined;
};

const validStructuredCandidate = (
    format: AgentPromptFormat,
    text: string,
): { readonly value?: unknown; readonly error?: string } => {
    const candidate = extractStructuredJson(text);
    if (candidate === undefined) {
        return { error: "No fenced json block was found in the response." };
    }
    const normalized = normalizeStructuredCandidate(candidate);
    if (format.validate === undefined) return { value: normalized };
    const validation = format.validate(normalized);
    return validation.success
        ? { value: normalized }
        : { error: validation.error ?? "Schema validation failed." };
};

const runAgentTurn = async (input: {
    readonly session: PiSession;
    readonly text: string;
    readonly signal?: AbortSignal;
}): Promise<AttemptOutcome> => {
    input.signal?.throwIfAborted();
    const onAbort = (): void => input.session.agent.abort();
    input.signal?.addEventListener("abort", onAbort, { once: true });
    try {
        await input.session.agent.prompt(input.text);
    } finally {
        input.signal?.removeEventListener("abort", onAbort);
    }
    if (input.signal?.aborted === true) input.signal.throwIfAborted();
    const assistant = lastAssistantMessage(input.session.agent);
    return { text: assistantTextOf(assistant), assistant };
};

const silentTurnError = (session: PiSession): RalphieError =>
    new RalphieError({
        message: `Pi completed the turn without producing any assistant response (${session.modelReference}, session ${session.id}). The turn likely failed before execution; check the model and provider credentials.`,
    });

const finishStructuredAttempt = (
    input: AgentPromptInput,
    outcome: AttemptOutcome,
    structured: unknown,
): PromptApiResult => {
    const needsAttention = extractNeedsAttentionJson(outcome.text);
    return {
        data: {
            info: {
                id: input.sessionID,
                role: "assistant",
                structured,
                text: outcome.text,
            },
            parts: textParts(outcome.text),
            ...(needsAttention === undefined ? {} : { needsAttention }),
        },
    };
};

const runStructuredPrompt = async (
    input: AgentPromptInput & { readonly format: AgentPromptFormat },
    session: PiSession,
    signal: AbortSignal | undefined,
): Promise<PromptApiResult> => {
    const maximumAttempts = (input.format.retryCount ?? 2) + 1;
    let last: AttemptOutcome = { text: "" };
    let lastError: string | undefined;

    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
        last = await runAgentTurn({
            session,
            text: promptTextForAttempt(input, attempt, lastError),
            signal,
        });
        if (last.assistant === undefined) throw silentTurnError(session);
        const checked = validStructuredCandidate(input.format, last.text);
        if (checked.value !== undefined) {
            return finishStructuredAttempt(input, last, checked.value);
        }
        lastError = checked.error;
        const assistantError = assistantErrorOf(last.assistant);
        if (assistantError !== undefined) {
            return {
                data: {
                    info: {
                        id: input.sessionID,
                        role: "assistant",
                        error: assistantError,
                    },
                    parts: [],
                },
            };
        }
    }

    const assistantError = assistantErrorOf(last.assistant);
    if (assistantError !== undefined) {
        return {
            data: {
                info: {
                    id: input.sessionID,
                    role: "assistant",
                    error: assistantError,
                },
                parts: [],
            },
        };
    }
    const preview =
        last.text.trim() === ""
            ? ""
            : ` Last response preview: ${JSON.stringify(last.text.slice(0, 160))}.`;
    throw new RalphieError({
        message: `Pi completed without a valid fenced json result.${lastError === undefined ? "" : ` Last validation error: ${lastError.slice(0, 500)}`}${preview}`,
    });
};

const runUnstructuredPrompt = async (
    input: AgentPromptInput,
    session: PiSession,
    signal: AbortSignal | undefined,
): Promise<PromptApiResult> => {
    const outcome = await runAgentTurn({
        session,
        text: promptTextForAttempt(input, 0),
        signal,
    });
    if (outcome.assistant === undefined) throw silentTurnError(session);
    const needsAttention = extractNeedsAttentionJson(outcome.text);
    const error = assistantErrorOf(outcome.assistant);
    return {
        data: {
            info: {
                id: input.sessionID,
                role: "assistant",
                ...(error === undefined ? {} : { error }),
                text: outcome.text,
            },
            parts: textParts(outcome.text),
            ...(needsAttention === undefined ? {} : { needsAttention }),
        },
    };
};

const selectionOf = (input: {
    readonly model?: PiModelSelection;
}): PiModelSelection | undefined => input.model;

export const makePiAgentClient = (
    options: PiAgentClientOptions,
): AgentClient => {
    const pending = new Map<string, PiSession>();

    const emit = (event: unknown, context: AgentEventContext): void => {
        try {
            options.eventListener?.(event, context);
        } catch {
            // Listener failures must not fail the session.
        }
    };

    const dispose = async (session: PiSession): Promise<void> => {
        session.unsubscribe();
        await session.tools.cleanup().catch(() => undefined);
    };

    return {
        session: {
            create: async (input, requestOptions) => {
                requestOptions?.signal?.throwIfAborted();
                const directory = input.directory;
                const id = `pi-${crypto.randomUUID()}`;
                const resolvedModel = await resolvePiModel({
                    models: options.models,
                    selection: selectionOf(input),
                    ...(options.defaultModel === undefined
                        ? {}
                        : { defaultModel: options.defaultModel }),
                    agentDir: options.agentDir,
                });
                const tools = makePiTools({
                    directory,
                    readOnly: input.profile === AgentSessionProfile.Review,
                });
                const agent = new Agent({
                    initialState: {
                        systemPrompt:
                            options.systemPrompt ?? RALPHIE_SYSTEM_PROMPT,
                        model: resolvedModel,
                        thinkingLevel: thinkingLevelFor(input.variant),
                        tools: [...tools.tools],
                    },
                    streamFn: options.models.streamSimple.bind(options.models),
                    sessionId: id,
                    beforeToolCall: tools.beforeToolCall,
                });
                const context: AgentEventContext = {
                    sessionID: id,
                    directory,
                    ...(input.title === undefined
                        ? {}
                        : { title: input.title }),
                };
                const unsubscribe = agent.subscribe((event) => {
                    emit(event, context);
                });
                pending.set(id, {
                    id,
                    directory,
                    ...(input.title === undefined
                        ? {}
                        : { title: input.title }),
                    modelReference:
                        modelReference(
                            selectionOf(input) ?? options.defaultModel,
                        ) ?? `${resolvedModel.provider}/${resolvedModel.id}`,
                    agent,
                    tools,
                    unsubscribe,
                });
                return { data: { id } };
            },
            prompt: async (input, requestOptions) => {
                const session = pending.get(input.sessionID);
                if (session === undefined) {
                    return {
                        error: new Error(
                            `Unknown pi session: ${input.sessionID}`,
                        ),
                    };
                }
                requestOptions?.signal?.throwIfAborted();
                try {
                    return input.format === undefined
                        ? await runUnstructuredPrompt(
                              input,
                              session,
                              requestOptions?.signal,
                          )
                        : await runStructuredPrompt(
                              input as AgentPromptInput & {
                                  readonly format: AgentPromptFormat;
                              },
                              session,
                              requestOptions?.signal,
                          );
                } finally {
                    pending.delete(input.sessionID);
                    await dispose(session);
                }
            },
        },
        close: async () => {
            const sessions = [...pending.values()];
            pending.clear();
            await Promise.allSettled(sessions.map(dispose));
        },
    };
};