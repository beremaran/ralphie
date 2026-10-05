import type { SessionEvent, SessionUsage } from "../../agent/events.ts";

const HARNESS = "pi";

const record = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)
        : {};

const numberOf = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Plain text of a pi tool result, message part list or string. */
const resultText = (value: unknown): string | undefined => {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
        const parts = value.flatMap((part) => {
            const text = record(part).text;
            return typeof text === "string" ? [text] : [];
        });
        return parts.length === 0 ? undefined : parts.join("\n");
    }
    const { text, content } = record(value);
    if (typeof text === "string") return text;
    return content === undefined ? undefined : resultText(content);
};

const withDefined = <T extends object>(value: T): T =>
    Object.fromEntries(
        Object.entries(value).filter(([, entry]) => entry !== undefined),
    ) as T;

const usageOf = (value: unknown): SessionUsage | undefined => {
    const usage = record(value);
    if (Object.keys(usage).length === 0) return undefined;
    return withDefined({
        inputTokens: numberOf(usage.input),
        outputTokens: numberOf(usage.output),
        cacheReadTokens: numberOf(usage.cacheRead),
        cacheWriteTokens: numberOf(usage.cacheWrite),
        totalTokens: numberOf(usage.totalTokens),
        costUsd: numberOf(record(usage.cost).total),
    });
};

const messageUpdate = (event: Record<string, unknown>): SessionEvent[] => {
    const update = record(event.assistantMessageEvent);
    const channel =
        typeof update.type === "string" && update.type.startsWith("thinking_")
            ? "thinking"
            : "assistant";
    if (update.type === "text_delta" || update.type === "thinking_delta") {
        return typeof update.delta === "string"
            ? [{ type: "text_delta", channel, text: update.delta }]
            : [];
    }
    if (update.type === "text_end" || update.type === "thinking_end") {
        return [{ type: "text_end", channel }];
    }
    return [];
};

const messageEnd = (event: Record<string, unknown>): SessionEvent[] => {
    const message = record(event.message);
    if (message.role !== "assistant") return [];
    const usage = usageOf(message.usage);
    const failed =
        message.stopReason === "error" &&
        typeof message.errorMessage === "string";
    return [
        ...(usage === undefined ? [] : [{ type: "usage", usage } as const]),
        ...(failed
            ? [
                  {
                      type: "error",
                      message: message.errorMessage as string,
                  } as const,
              ]
            : []),
    ];
};

const toolCall = (event: Record<string, unknown>): SessionEvent => ({
    type: "tool_call",
    ...(typeof event.toolCallId === "string"
        ? { toolCallId: event.toolCallId }
        : {}),
    toolName: String(event.toolName ?? "tool"),
    ...(event.args === undefined ? {} : { args: event.args }),
});

const toolResult = (event: Record<string, unknown>): SessionEvent => {
    const text = resultText(event.result);
    return {
        type: "tool_result",
        ...(typeof event.toolCallId === "string"
            ? { toolCallId: event.toolCallId }
            : {}),
        toolName: String(event.toolName ?? "tool"),
        isError: event.isError === true,
        ...(text === undefined ? {} : { text }),
    };
};

/** Translate one native pi agent event into zero or more normalized events. */
export const translatePiEvent = (nativeEvent: unknown): SessionEvent[] => {
    const event = record(nativeEvent);
    switch (event.type) {
        case "agent_start":
            return [{ type: "session_started", harness: HARNESS }];
        case "agent_end":
            return [{ type: "session_finished" }];
        case "message_update":
            return messageUpdate(event);
        case "message_end":
            return messageEnd(event);
        case "tool_execution_start":
            return [toolCall(event)];
        case "tool_execution_end":
            return [toolResult(event)];
        default:
            return [];
    }
};