import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentLoopTurnUpdate } from "@earendil-works/pi-agent-core";
import type {
    AssistantMessage,
    Model,
    MutableModels,
    TextContent,
} from "@earendil-works/pi-ai";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "@earendil-works/pi-ai";
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
    type AgentSessionCreateInput,
    type AgentToolDescriptor,
} from "../../agent/ports.ts";
import { RalphieError } from "../../shared/error.ts";
import {
    thinkingLevelFor,
    type PiModelSelection,
} from "../../agent/pi-models.ts";
import { modelReference } from "../../agent/pi-models.ts";
import { resolvePiModel } from "./models.ts";
import { makePiTools, type PiToolSet } from "./tools.ts";
import type { PiAgentSelection } from "../ports.ts";

export type PiAgentClientOptions = {
    readonly models: MutableModels;
    /** Pi config directory used for default-model resolution. */
    readonly agentDir: string;
    /** Pre-resolved default model; falls back to the pi settings file. */
    readonly defaultModel?: AgentModel;
    /** Reads the operator's live pick; sessions switch at their next turn. */
    readonly liveSelection?: () => PiAgentSelection | undefined;
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
- If a repository-backed blocker genuinely prevents safe progress, call the \`request_needs_attention\` tool instead of asking a question. Then continue with the task or the final response contract.`;

const submissionContract = (
    toolName: string,
    retry: boolean,
    lastError?: string,
): string => {
    if (retry) {
        const errorSection =
            lastError === undefined || lastError === ""
                ? ""
                : `\n\nPREVIOUS VALIDATION ERROR (fix every item):\n${lastError.slice(0, 2000)}`;
        return `RESPONSE CONTRACT VIOLATION: you did not call the required \`${toolName}\` tool. Call it now with the complete schema-valid result.${errorSection}`;
    }
    return `MANDATORY RESPONSE CONTRACT:
- Complete the task before responding.
- When the task is done, call the \`${toolName}\` tool exactly once with the complete schema-valid result.
- Do not write the result in prose; the tool call is the result.`;
};

export const buildPiAttemptPrompt = (
    prompt: string,
    structured: boolean,
    retry: boolean,
    toolName?: string,
    lastError?: string,
): string => {
    if (retry && toolName !== undefined) {
        return `${unattendedContract}\n\n${submissionContract(toolName, true, lastError)}\n\nOriginal task:\n${prompt}`;
    }
    const withContract = `${prompt}\n\n${unattendedContract}`;
    if (!structured || toolName === undefined) {
        return withContract;
    }
    return `${withContract}\n\n${submissionContract(toolName, false)}`;
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
        input.format?.tool.name,
        lastError,
    );
};

type ToolCapture = {
    structured?: unknown;
    validationError?: string;
    needsAttention?: unknown;
};

const submissionTool = (
    format: AgentPromptFormat,
    capture: ToolCapture,
): AgentTool => ({
    name: format.tool.name,
    label: "Submit result",
    description: format.tool.description,
    parameters: format.tool.schema as TSchema,
    execute: async (_toolCallId, params) => {
        if (format.validate !== undefined) {
            const validation = format.validate(params);
            if (!validation.success) {
                capture.validationError =
                    validation.error ?? "Schema validation failed.";
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `VALIDATION ERROR: ${capture.validationError}`,
                        },
                    ],
                    details: {},
                    terminate: false,
                };
            }
        }
        capture.structured = params;
        return {
            content: [{ type: "text" as const, text: "Result accepted." }],
            details: {},
            terminate: true,
        };
    },
});

const needsAttentionTool = (
    descriptor: AgentToolDescriptor,
    capture: ToolCapture,
): AgentTool => ({
    name: descriptor.name,
    label: "Request needs attention",
    description: descriptor.description,
    parameters: descriptor.schema as TSchema,
    execute: async (_toolCallId, params) => {
        capture.needsAttention = params;
        return {
            content: [
                {
                    type: "text" as const,
                    text: "Needs-attention request recorded.",
                },
            ],
            details: {},
            terminate: false,
        };
    },
});

const dynamicToolsFor = (
    input: AgentPromptInput,
    capture: ToolCapture,
): ReadonlyArray<AgentTool> => [
    ...(input.format === undefined
        ? []
        : [submissionTool(input.format, capture)]),
    ...(input.needsAttentionTool === undefined
        ? []
        : [needsAttentionTool(input.needsAttentionTool, capture)]),
];

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

const runAgentTurn = async (input: {
    readonly session: PiSession;
    readonly text: string;
    readonly tools: ReadonlyArray<AgentTool>;
    readonly signal?: AbortSignal;
}): Promise<AttemptOutcome> => {
    input.signal?.throwIfAborted();
    input.session.agent.state.tools = [
        ...input.session.tools.tools,
        ...input.tools,
    ];
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

const assistantErrorResult = (
    input: AgentPromptInput,
    error: NonNullable<AgentAssistantMessage["error"]>,
): PromptApiResult => ({
    data: {
        info: {
            id: input.sessionID,
            role: "assistant",
            error,
        },
        parts: [],
    },
});

const finishAttempt = (
    input: AgentPromptInput,
    outcome: AttemptOutcome,
    capture: ToolCapture,
): PromptApiResult => ({
    data: {
        info: {
            id: input.sessionID,
            role: "assistant",
            ...(capture.structured === undefined
                ? {}
                : { structured: capture.structured }),
            text: outcome.text,
        },
        parts: textParts(outcome.text),
        ...(capture.needsAttention === undefined
            ? {}
            : { needsAttention: capture.needsAttention }),
    },
});

const runStructuredPrompt = async (
    input: AgentPromptInput & { readonly format: AgentPromptFormat },
    session: PiSession,
    signal: AbortSignal | undefined,
): Promise<PromptApiResult> => {
    const maximumAttempts = (input.format.retryCount ?? 2) + 1;
    let last: AttemptOutcome = { text: "" };
    let lastError: string | undefined;

    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
        const capture: ToolCapture = {};
        last = await runAgentTurn({
            session,
            text: promptTextForAttempt(input, attempt, lastError),
            tools: dynamicToolsFor(input, capture),
            signal,
        });
        if (last.assistant === undefined) throw silentTurnError(session);
        if (capture.structured !== undefined) {
            return finishAttempt(input, last, capture);
        }
        const assistantError = assistantErrorOf(last.assistant);
        if (assistantError !== undefined) {
            return assistantErrorResult(input, assistantError);
        }
        lastError =
            capture.validationError ??
            `The \`${input.format.tool.name}\` tool was not called.`;
    }

    const assistantError = assistantErrorOf(last.assistant);
    if (assistantError !== undefined) {
        return assistantErrorResult(input, assistantError);
    }
    throw new RalphieError({
        message: `Pi completed without calling the \`${input.format.tool.name}\` tool.${lastError === undefined ? "" : ` Last error: ${lastError.slice(0, 500)}`}`,
    });
};

const runUnstructuredPrompt = async (
    input: AgentPromptInput,
    session: PiSession,
    signal: AbortSignal | undefined,
): Promise<PromptApiResult> => {
    const capture: ToolCapture = {};
    const outcome = await runAgentTurn({
        session,
        text: promptTextForAttempt(input, 0),
        tools: dynamicToolsFor(input, capture),
        signal,
    });
    if (outcome.assistant === undefined) throw silentTurnError(session);
    const error = assistantErrorOf(outcome.assistant);
    if (error !== undefined) return assistantErrorResult(input, error);
    return finishAttempt(input, outcome, capture);
};

const selectionOf = (input: {
    readonly model?: PiModelSelection;
}): PiModelSelection | undefined => input.model;

/** The model and level a session is currently running with. */
type ActiveSelection = {
    reference: string;
    variant: string | undefined;
};

/**
 * Build the per-turn hook that applies the operator's live pick.
 *
 * The pi agent loop calls this between provider requests, so a pick made while
 * a turn is running takes effect on the next request without rebuilding the
 * session or losing its transcript.
 */
const liveSelectionHook = (input: {
    readonly models: MutableModels;
    readonly agentDir: string;
    readonly liveSelection?: () => PiAgentSelection | undefined;
    readonly active: ActiveSelection;
}):
    | ((signal?: AbortSignal) => Promise<AgentLoopTurnUpdate | undefined>)
    | undefined => {
    if (input.liveSelection === undefined) return undefined;
    const liveSelection = input.liveSelection;
    return async () => {
        const picked = liveSelection();
        if (picked === undefined) return undefined;
        const reference = modelReference(picked.model);
        if (reference === undefined) return undefined;
        if (
            reference === input.active.reference &&
            picked.variant === input.active.variant
        ) {
            return undefined;
        }
        try {
            const model = await resolvePiModel({
                models: input.models,
                selection: picked.model,
                agentDir: input.agentDir,
            });
            input.active.reference = reference;
            input.active.variant = picked.variant;
            return {
                model,
                thinkingLevel: thinkingLevelFor(picked.variant),
            };
        } catch {
            // A stale pick must not abort the running turn.
            return undefined;
        }
    };
};

/** Build one session agent, including the live model-switch hook. */
const makeSessionAgent = (input: {
    readonly options: PiAgentClientOptions;
    readonly sessionInput: AgentSessionCreateInput;
    readonly sessionID: string;
    readonly resolvedModel: Model<never>;
    readonly tools: PiToolSet;
}): { readonly agent: Agent; readonly modelReference: string } => {
    const active: ActiveSelection = {
        reference:
            modelReference(
                selectionOf(input.sessionInput) ?? input.options.defaultModel,
            ) ?? `${input.resolvedModel.provider}/${input.resolvedModel.id}`,
        variant: input.sessionInput.variant,
    };
    const prepareNextTurn = liveSelectionHook({
        models: input.options.models,
        agentDir: input.options.agentDir,
        ...(input.options.liveSelection === undefined
            ? {}
            : { liveSelection: input.options.liveSelection }),
        active,
    });
    const agent = new Agent({
        initialState: {
            systemPrompt: input.options.systemPrompt ?? RALPHIE_SYSTEM_PROMPT,
            model: input.resolvedModel,
            thinkingLevel: thinkingLevelFor(input.sessionInput.variant),
            tools: [...input.tools.tools],
        },
        streamFn: input.options.models.streamSimple.bind(input.options.models),
        sessionId: input.sessionID,
        beforeToolCall: input.tools.beforeToolCall,
    });
    if (prepareNextTurn !== undefined) {
        // Assigned after construction so the hook can also update the agent's
        // own state, which seeds later prompts on this session (a structured
        // output retry, for example) with the same pick.
        agent.prepareNextTurn = async (signal) => {
            const update = await prepareNextTurn(signal);
            if (update?.model !== undefined) agent.state.model = update.model;
            if (update?.thinkingLevel !== undefined) {
                agent.state.thinkingLevel = update.thinkingLevel;
            }
            return update;
        };
    }
    return { modelReference: active.reference, agent };
};

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
                const { agent, modelReference } = makeSessionAgent({
                    options,
                    sessionInput: input,
                    sessionID: id,
                    resolvedModel,
                    tools,
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
                    modelReference,
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