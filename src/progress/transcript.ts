import type {
    PiEventContext,
    PiEventListener,
    PiSessionEvent,
} from "../pi/client.ts";
import {
    redactSensitiveText,
    redactSensitiveValue,
} from "../shared/redaction.ts";
import { cyan, dim, red, yellow } from "./colors.ts";

export type PiTranscriptRendererOptions = {
    readonly write: (text: string) => void;
    readonly colors?: boolean;
    readonly json?: boolean;
};

const plain = (text: string): string => text;

const contentText = (message: unknown): string | undefined => {
    if (typeof message !== "object" || message === null) return undefined;
    const content = (message as { readonly content?: unknown }).content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return undefined;
    const text = content
        .filter(
            (part): part is { readonly text: string } =>
                typeof part === "object" &&
                part !== null &&
                (part as { readonly type?: unknown }).type === "text" &&
                typeof (part as { readonly text?: unknown }).text === "string",
        )
        .map((part) => part.text)
        .join("");
    return text.length === 0 ? undefined : text;
};

const safeJson = (value: unknown): string => {
    try {
        const redacted = redactSensitiveValue(value);
        return JSON.stringify(redacted) ?? String(redacted);
    } catch {
        return "[unserializable]";
    }
};

const eventJson = (event: PiSessionEvent, context: PiEventContext): string =>
    safeJson({
        type: "pi_event",
        sessionID: context.sessionID,
        directory: context.directory,
        ...(context.title === undefined ? {} : { title: context.title }),
        event,
    });

const eventMessage = (event: PiSessionEvent): string => {
    if (event.type === "tool_execution_end") {
        return safeJson(event.result);
    }
    if (event.type === "tool_execution_start") {
        return `${event.toolName} ${safeJson(event.args)}`;
    }
    if (event.type === "message_start") {
        return contentText(event.message) ?? safeJson(event.message);
    }
    if (event.type === "message_end") {
        return contentText(event.message) ?? safeJson(event.message);
    }
    return safeJson(event);
};

type TranscriptStyles = {
    readonly assistant: (text: string) => string;
    readonly event: (text: string) => string;
    readonly error: (text: string) => string;
    readonly thinking: (text: string) => string;
    readonly tool: (text: string) => string;
};

type MessageUpdateEvent = Extract<PiSessionEvent, { type: "message_update" }>;

const renderMessageUpdate = (
    event: MessageUpdateEvent,
    styles: TranscriptStyles,
    write: (text: string) => void,
    line: (text: string) => void,
    delta: (text: string) => void,
): void => {
    switch (event.assistantMessageEvent.type) {
        case "thinking_start":
            write(`${styles.thinking("[thinking]")} `);
            return;
        case "thinking_delta":
            delta(event.assistantMessageEvent.delta);
            return;
        case "thinking_end":
            write("\n");
            return;
        case "text_start":
            write(`${styles.assistant("[assistant]")} `);
            return;
        case "text_delta":
            delta(event.assistantMessageEvent.delta);
            return;
        case "text_end":
            write("\n");
            return;
        case "toolcall_start":
            write(`${styles.tool("[tool-call]")} `);
            return;
        case "toolcall_delta":
            delta(event.assistantMessageEvent.delta);
            return;
        case "toolcall_end":
            write("\n");
            return;
        case "error":
            line(
                `${styles.error("[assistant-error]")} ${redactSensitiveText(event.assistantMessageEvent.error.errorMessage ?? event.assistantMessageEvent.reason)}`,
            );
            return;
        default:
            return;
    }
};

const renderTerminalEvent = (
    event: PiSessionEvent,
    context: PiEventContext,
    styles: TranscriptStyles,
    write: (text: string) => void,
    line: (text: string) => void,
    delta: (text: string) => void,
): void => {
    switch (event.type) {
        case "agent_start":
            line(
                `${styles.assistant("[pi]")} ${context.title ?? "Pi task"} (${context.sessionID})`,
            );
            return;
        case "agent_end":
            line(styles.event("[agent]"));
            return;
        case "agent_settled":
            line(styles.event("[settled]"));
            return;
        case "message_start":
            if (event.message.role === "user") {
                line(
                    `${styles.assistant("[user]")} ${redactSensitiveText(eventMessage(event))}`,
                );
            }
            return;
        case "message_update":
            renderMessageUpdate(event, styles, write, line, delta);
            return;
        case "message_end":
            return;
        case "tool_execution_start":
            line(`${styles.tool("[tool]")} ${eventMessage(event)}`);
            return;
        case "tool_execution_end":
            line(
                `${styles[event.isError ? "error" : "tool"](event.isError ? "[tool-error]" : "[tool-result]")} ${eventMessage(event)}`,
            );
            return;
        case "tool_execution_update":
            line(
                `${styles.tool("[tool-update]")} ${event.toolName} ${safeJson(event.partialResult)}`,
            );
            return;
        case "bash_execution_update":
            line(
                `${styles.tool("[tool-output]")} ${redactSensitiveText(event.delta)}`,
            );
            return;
        case "turn_start":
        case "turn_end":
        case "compaction_start":
        case "compaction_end":
        case "auto_retry_start":
        case "auto_retry_end":
        case "summarization_retry_scheduled":
        case "summarization_retry_attempt_start":
        case "summarization_retry_finished":
        case "queue_update":
        case "session_info_changed":
        case "thinking_level_changed":
        case "entry_appended":
            line(`${styles.event(`[${event.type}]`)} ${eventMessage(event)}`);
            return;
    }
};

export const makePiTranscriptRenderer = ({
    write,
    colors = false,
    json = false,
}: PiTranscriptRendererOptions): PiEventListener => {
    const style = colors
        ? {
              assistant: cyan,
              event: dim,
              error: red,
              thinking: yellow,
              tool: yellow,
          }
        : {
              assistant: plain,
              event: plain,
              error: plain,
              thinking: plain,
              tool: plain,
          };
    const line = (text: string): void => write(`${text}\n`);
    const delta = (text: string): void => write(redactSensitiveText(text));

    return (event, context) => {
        if (json) {
            line(eventJson(event, context));
            return;
        }

        renderTerminalEvent(event, context, style, write, line, delta);
    };
};