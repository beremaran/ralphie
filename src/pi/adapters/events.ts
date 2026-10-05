import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";

import type { SessionEvent } from "../../harness/ports.ts";

/** Plain text of a pi tool result, content part list, or string. */
const contentText = (value: unknown): string | undefined => {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
        const parts = value.flatMap((part) => {
            const text = (part as { text?: unknown } | null)?.text;
            return typeof text === "string" ? [text] : [];
        });
        return parts.length === 0 ? undefined : parts.join("\n");
    }
    if (typeof value === "object" && value !== null) {
        const text = (value as { text?: unknown }).text;
        if (typeof text === "string") return text;
        const content = (value as { content?: unknown }).content;
        return content === undefined ? undefined : contentText(content);
    }
    return undefined;
};

const inputRecord = (args: unknown): Readonly<Record<string, unknown>> =>
    typeof args === "object" && args !== null && !Array.isArray(args)
        ? (args as Readonly<Record<string, unknown>>)
        : {};

type AssistantUpdate = Extract<
    AgentEvent,
    { type: "message_update" }
>["assistantMessageEvent"];

const fragment = (
    kind: "text" | "thinking",
    text: string,
    done: boolean,
): readonly SessionEvent[] => [{ type: "assistant_text", kind, text, done }];

const assistantText = (update: AssistantUpdate): readonly SessionEvent[] => {
    switch (update.type) {
        case "text_delta":
            return fragment("text", update.delta, false);
        case "text_end":
            return fragment("text", "", true);
        case "thinking_delta":
            return fragment("thinking", update.delta, false);
        case "thinking_end":
            return fragment("thinking", "", true);
        default:
            return [];
    }
};

/** Why a finished assistant response failed, if it did. */
const assistantFailure = (message: AssistantMessage): string | undefined => {
    switch (message.stopReason) {
        case "error":
            return message.errorMessage ?? "The assistant response failed.";
        case "aborted":
            return (
                message.errorMessage ?? "The assistant response was aborted."
            );
        case "length":
            return "The assistant response stopped at its output length limit.";
        default:
            return undefined;
    }
};

const assistantResponseEnd = (
    message: AssistantMessage,
): readonly SessionEvent[] => {
    const failure = assistantFailure(message);
    return [
        {
            type: "usage",
            inputTokens: message.usage.input,
            outputTokens: message.usage.output,
            cacheReadTokens: message.usage.cacheRead,
            cacheWriteTokens: message.usage.cacheWrite,
            costUsd: message.usage.cost.total,
        },
        ...(failure === undefined
            ? []
            : [{ type: "error" as const, message: failure }]),
    ];
};

/**
 * Translate one native pi agent event into session events.
 *
 * Native events without a session counterpart (turn and message boundaries,
 * streamed tool-call arguments, partial tool output) translate to nothing.
 */
export const translatePiEvent = (
    event: AgentEvent,
): readonly SessionEvent[] => {
    switch (event.type) {
        case "agent_start":
            return [{ type: "session_started" }];
        case "agent_end":
            return [{ type: "session_finished" }];
        case "message_update":
            return assistantText(event.assistantMessageEvent);
        case "message_end":
            return event.message.role === "assistant"
                ? assistantResponseEnd(event.message)
                : [];
        case "tool_execution_start":
            return [
                {
                    type: "tool_call",
                    callId: event.toolCallId,
                    name: event.toolName,
                    input: inputRecord(event.args),
                },
            ];
        case "tool_execution_end":
            return [
                {
                    type: "tool_result",
                    callId: event.toolCallId,
                    name: event.toolName,
                    output: contentText(event.result) ?? "",
                    isError: event.isError,
                },
            ];
        default:
            return [];
    }
};