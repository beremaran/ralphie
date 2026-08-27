import type {
    PiEventContext,
    PiEventListener,
    PiSessionEvent,
} from "../pi/client.ts";
import {
    redactSensitiveText,
    redactSensitiveValue,
} from "../shared/redaction.ts";
import { cyan, dim, green, red, yellow } from "./colors.ts";

export type PiTranscriptRendererOptions = {
    readonly write: (text: string) => void;
    readonly colors?: boolean;
    readonly json?: boolean;
    readonly verbose?: boolean;
    readonly width?: () => number;
};

const plain = (text: string): string => text;

const ANSI_ESCAPE =
    /\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~])/g;

/** Keep model and tool output from changing the terminal's state. */
const sanitizeTerminalText = (text: string): string =>
    redactSensitiveText(
        text
            .replace(/\r\n?/g, "\n")
            .replace(ANSI_ESCAPE, "")
            .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
            .replace(/\t/g, "    "),
    );

const oneLine = (text: string): string =>
    sanitizeTerminalText(text).replace(/\s+/g, " ").trim();

const stringValue = (value: unknown): string | undefined =>
    typeof value === "string" ? value : undefined;

const recordValue = (
    value: unknown,
): Readonly<Record<string, unknown>> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Readonly<Record<string, unknown>>)
        : undefined;

const valueAt = (value: unknown, key: string): unknown =>
    recordValue(value)?.[key];

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

const clipToWidth = (text: string, width: number): string => {
    if (Bun.stringWidth(text) <= width) return text;
    if (width <= 1) return "…";

    const contentWidth = width - Bun.stringWidth("…");
    let clipped = "";
    let used = 0;
    for (const character of text) {
        const characterWidth = Bun.stringWidth(character);
        if (used + characterWidth > contentWidth) break;
        clipped += character;
        used += characterWidth;
    }
    return `${clipped}…`;
};

const inlinePreview = (text: string, width: number): string =>
    clipToWidth(oneLine(text), Math.max(12, width));

const pathArgument = (args: unknown): string | undefined =>
    stringValue(valueAt(args, "file_path")) ??
    stringValue(valueAt(args, "path"));

type ToolCallFormatter = (args: unknown, width: number) => string;

const formatBashCall: ToolCallFormatter = (args, width) => {
    const command = stringValue(valueAt(args, "command")) ?? "…";
    const timeout = valueAt(args, "timeout");
    const suffix = typeof timeout === "number" ? ` · timeout ${timeout}s` : "";
    return inlinePreview(`$ ${command}${suffix}`, width);
};

const formatReadCall: ToolCallFormatter = (args, width) => {
    const target = pathArgument(args) ?? "…";
    const offset = valueAt(args, "offset");
    const limit = valueAt(args, "limit");
    const start = typeof offset === "number" ? offset : 1;
    const range =
        typeof offset !== "number" && typeof limit !== "number"
            ? ""
            : `:${start}${typeof limit === "number" ? `-${start + limit - 1}` : ""}`;
    return inlinePreview(`read ${target}${range}`, width);
};

const formatWriteCall: ToolCallFormatter = (args, width) => {
    const target = pathArgument(args) ?? "…";
    const content = stringValue(valueAt(args, "content"));
    const lineCount = content === undefined ? 0 : content.split("\n").length;
    const suffix = lineCount > 1 ? ` (${lineCount} lines)` : "";
    return inlinePreview(`write ${target}${suffix}`, width);
};

const formatEditCall: ToolCallFormatter = (args, width) =>
    inlinePreview(`edit ${pathArgument(args) ?? "…"}`, width);

const formatLsCall: ToolCallFormatter = (args, width) =>
    inlinePreview(`ls ${pathArgument(args) ?? "."}`, width);

const formatFindCall: ToolCallFormatter = (args, width) => {
    const pattern = stringValue(valueAt(args, "pattern")) ?? "*";
    return inlinePreview(
        `find ${pattern} in ${pathArgument(args) ?? "."}`,
        width,
    );
};

const formatGrepCall: ToolCallFormatter = (args, width) => {
    const pattern = stringValue(valueAt(args, "pattern")) ?? "";
    return inlinePreview(
        `grep /${pattern}/ in ${pathArgument(args) ?? "."}`,
        width,
    );
};

const knownToolCallFormatters: Readonly<Record<string, ToolCallFormatter>> = {
    bash: formatBashCall,
    read: formatReadCall,
    write: formatWriteCall,
    edit: formatEditCall,
    ls: formatLsCall,
    find: formatFindCall,
    grep: formatGrepCall,
    submit_result: () => "submit result",
};

const formatToolCall = (
    toolName: string,
    args: unknown,
    width: number,
): string => {
    const name = oneLine(toolName) || "tool";
    const formatter = knownToolCallFormatters[name];
    return formatter === undefined
        ? inlinePreview(`${name} ${safeJson(args)}`, width)
        : formatter(args, width);
};

type TranscriptStyles = {
    readonly assistant: (text: string) => string;
    readonly event: (text: string) => string;
    readonly error: (text: string) => string;
    readonly thinking: (text: string) => string;
    readonly tool: (text: string) => string;
    readonly success: (text: string) => string;
};

type StreamKey = string;

type TranscriptWriter = ReturnType<typeof makeTranscriptWriter>;

const makeTranscriptWriter = (
    write: (text: string) => void,
    styles: TranscriptStyles,
): {
    readonly beginSession: (context: PiEventContext) => void;
    readonly ensureSession: (context: PiEventContext) => void;
    readonly startStream: (key: StreamKey, label: string) => void;
    readonly writeStream: (
        key: StreamKey,
        text: string,
        textStyle: (text: string) => string,
        fallbackLabel: string,
    ) => void;
    readonly endStream: (key: StreamKey) => void;
    readonly line: (
        text: string,
        options?: { readonly blankBefore?: boolean; readonly key?: StreamKey },
    ) => void;
    readonly finishSession: (label: string) => void;
} => {
    let sessionOpen = false;
    let hasBlock = false;
    let activeKey: StreamKey | undefined;
    let lineOpen = false;

    const finishLine = (): void => {
        if (lineOpen) write("\n");
        lineOpen = false;
        activeKey = undefined;
    };

    const blankBeforeBlock = (): void => {
        finishLine();
        if (hasBlock) write("│\n");
    };

    const beginSession = (context: PiEventContext): void => {
        if (sessionOpen) finishSession("interrupted");
        const title = oneLine(context.title ?? "Pi task") || "Pi task";
        const session = oneLine(context.sessionID);
        write(
            `╭─ ${styles.assistant("Pi")} · ${title}${session === "" ? "" : ` · ${styles.event(session)}`}\n│\n`,
        );
        sessionOpen = true;
        hasBlock = false;
    };

    const ensureSession = (context: PiEventContext): void => {
        if (!sessionOpen) beginSession(context);
    };

    const startStream = (key: StreamKey, label: string): void => {
        if (activeKey === key) {
            if (!lineOpen) {
                write("│    ");
                lineOpen = true;
            }
            return;
        }
        blankBeforeBlock();
        write(`│  ${label}`);
        lineOpen = true;
        activeKey = key;
        hasBlock = true;
    };

    const writeStreamPart = (
        part: string | undefined,
        textStyle: (text: string) => string,
    ): void => {
        if (part === undefined || part.length === 0) return;
        if (!lineOpen) {
            write("│    ");
            lineOpen = true;
        }
        write(textStyle(part));
    };

    const writeStream = (
        key: StreamKey,
        text: string,
        textStyle: (text: string) => string,
        fallbackLabel: string,
    ): void => {
        const clean = sanitizeTerminalText(text);
        if (clean.length === 0) return;
        if (activeKey !== key) startStream(key, fallbackLabel);

        const parts = clean.split("\n");
        for (let index = 0; index < parts.length; index += 1) {
            writeStreamPart(parts[index], textStyle);
            if (index < parts.length - 1) {
                write("\n");
                lineOpen = false;
            }
        }
    };

    const endStream = (key: StreamKey): void => {
        if (activeKey !== key) return;
        finishLine();
    };

    const line = (
        text: string,
        options: {
            readonly blankBefore?: boolean;
            readonly key?: StreamKey;
        } = {},
    ): void => {
        finishLine();
        if (options.blankBefore !== false && hasBlock) write("│\n");
        write(`│  ${text}\n`);
        hasBlock = true;
        activeKey = options.key;
        lineOpen = false;
    };

    const finishSession = (label: string): void => {
        if (!sessionOpen) return;
        finishLine();
        write(`╰─ ${label}\n`);
        sessionOpen = false;
        hasBlock = false;
    };

    return {
        beginSession,
        ensureSession,
        startStream,
        writeStream,
        endStream,
        line,
        finishSession,
    };
};

type MessageUpdateEvent = Extract<PiSessionEvent, { type: "message_update" }>;

const contentIndexFor = (event: MessageUpdateEvent): string => {
    const index = (
        event.assistantMessageEvent as { readonly contentIndex?: unknown }
    ).contentIndex;
    return typeof index === "number" ? String(index) : "0";
};

const messageUpdateKey = (
    event: MessageUpdateEvent,
    kind: "thinking" | "assistant",
): StreamKey => `${kind}:${contentIndexFor(event)}`;

const messageId = (message: unknown): string => {
    const id = stringValue(valueAt(message, "id"));
    return id === undefined || id.length === 0 ? "user" : id;
};

const previewText = (
    text: string,
    verbose: boolean,
): {
    readonly text: string;
    readonly omitted: boolean;
    readonly lines: number;
} => {
    const clean = sanitizeTerminalText(text).trim();
    if (clean === "") return { text: "", omitted: false, lines: 0 };

    const maxLines = verbose ? 40 : 12;
    const maxCharacters = verbose ? 8_000 : 2_400;
    const sourceLines = clean.split("\n");
    let result = sourceLines.slice(0, maxLines).join("\n");
    let omitted = sourceLines.length > maxLines;
    if (result.length > maxCharacters) {
        result = result.slice(0, maxCharacters).trimEnd();
        omitted = true;
    }
    if (omitted) result += "\n… output truncated";
    return { text: result, omitted, lines: sourceLines.length };
};

const toolResultText = (result: unknown): string => {
    const text = contentText(result);
    if (text !== undefined) return text;
    return Array.isArray(valueAt(result, "content")) ? "" : safeJson(result);
};

type ToolExecutionState = {
    readonly key: StreamKey;
    latestOutput: string;
    renderedCharacters: number;
    outputLimited: boolean;
};

const LIVE_OUTPUT_LIMIT = 2_400;

const cumulativeDelta = (previous: string, next: string): string => {
    if (next === previous) return "";
    return next.startsWith(previous) ? next.slice(previous.length) : next;
};

const renderMessageUpdate = (
    event: MessageUpdateEvent,
    styles: TranscriptStyles,
    writer: TranscriptWriter,
): void => {
    const update = event.assistantMessageEvent;
    switch (update.type) {
        case "thinking_start":
            writer.startStream(
                messageUpdateKey(event, "thinking"),
                styles.thinking("⋯ thinking "),
            );
            return;
        case "thinking_delta":
            writer.writeStream(
                messageUpdateKey(event, "thinking"),
                update.delta,
                styles.thinking,
                styles.thinking("⋯ thinking "),
            );
            return;
        case "thinking_end":
            writer.endStream(messageUpdateKey(event, "thinking"));
            return;
        case "text_start":
            writer.startStream(
                messageUpdateKey(event, "assistant"),
                styles.assistant("✦ assistant "),
            );
            return;
        case "text_delta":
            writer.writeStream(
                messageUpdateKey(event, "assistant"),
                update.delta,
                styles.assistant,
                styles.assistant("✦ assistant "),
            );
            return;
        case "text_end":
            writer.endStream(messageUpdateKey(event, "assistant"));
            return;
        case "toolcall_start":
        case "toolcall_delta":
        case "toolcall_end":
            return;
        case "error": {
            const message =
                update.error.errorMessage ??
                update.reason ??
                "Pi response failed.";
            writer.line(
                `${styles.error("✗ assistant error")} ${sanitizeTerminalText(message)}`,
            );
            return;
        }
        default:
            return;
    }
};

const outputStateFor = (
    states: Map<string, ToolExecutionState>,
    key: string,
    toolName: string,
): ToolExecutionState => {
    const existing = states.get(key);
    if (existing !== undefined) return existing;
    const state: ToolExecutionState = {
        key: `tool:${key}`,
        latestOutput: "",
        renderedCharacters: 0,
        outputLimited: false,
    };
    states.set(key, state);
    return state;
};

const renderToolDelta = (
    state: ToolExecutionState,
    delta: string,
    styles: TranscriptStyles,
    writer: TranscriptWriter,
): void => {
    const remaining = LIVE_OUTPUT_LIMIT - state.renderedCharacters;
    if (remaining <= 0) {
        state.outputLimited = true;
        return;
    }
    const visible = delta.slice(0, remaining);
    writer.writeStream(
        state.key,
        visible,
        styles.event,
        styles.event("output "),
    );
    state.renderedCharacters += visible.length;
    if (visible.length < delta.length) state.outputLimited = true;
};

const renderToolExecutionUpdate = (
    event: Extract<PiSessionEvent, { type: "tool_execution_update" }>,
    states: Map<string, ToolExecutionState>,
    styles: TranscriptStyles,
    writer: TranscriptWriter,
): void => {
    const key = event.toolCallId;
    const state = outputStateFor(states, key, event.toolName);
    const output = contentText(event.partialResult);
    if (output === undefined) return;
    const delta = cumulativeDelta(state.latestOutput, output);
    state.latestOutput = output;
    renderToolDelta(state, delta, styles, writer);
};

const renderBashExecutionUpdate = (
    event: Extract<PiSessionEvent, { type: "bash_execution_update" }>,
    states: Map<string, ToolExecutionState>,
    styles: TranscriptStyles,
    writer: TranscriptWriter,
): void => {
    const key = event.id ?? "bash-stream";
    const state = outputStateFor(states, key, "bash");
    state.latestOutput += event.delta;
    renderToolDelta(state, event.delta, styles, writer);
};

const renderToolExecutionEnd = (
    event: Extract<PiSessionEvent, { type: "tool_execution_end" }>,
    states: Map<string, ToolExecutionState>,
    styles: TranscriptStyles,
    writer: TranscriptWriter,
    verbose: boolean,
): void => {
    const state = outputStateFor(states, event.toolCallId, event.toolName);
    const finalOutput = toolResultText(event.result);
    const finalPreview = previewText(finalOutput, verbose);
    const finalDelta = cumulativeDelta(state.latestOutput, finalOutput);
    state.latestOutput = finalOutput;
    if (state.renderedCharacters === 0 && finalPreview.text !== "") {
        writer.writeStream(
            state.key,
            finalPreview.text,
            styles.event,
            styles.event("output "),
        );
    } else if (state.renderedCharacters > 0 && finalDelta !== "") {
        renderToolDelta(state, finalDelta, styles, writer);
    }
    writer.endStream(state.key);

    const lineCount = finalPreview.lines;
    const count =
        lineCount === 0
            ? ""
            : ` · ${lineCount} line${lineCount === 1 ? "" : "s"}`;
    const truncated =
        state.outputLimited || finalPreview.omitted ? " · truncated" : "";
    const status = event.isError ? styles.error("✗") : styles.success("✓");
    writer.line(
        `${status} ${oneLine(event.toolName) || "tool"} ${event.isError ? "failed" : "done"}${count}${truncated}`,
        { blankBefore: false },
    );
    states.delete(event.toolCallId);
};

const renderUserMessage = (
    event: Extract<PiSessionEvent, { type: "message_start" }>,
    styles: TranscriptStyles,
    writer: TranscriptWriter,
    verbose: boolean,
): void => {
    if (event.message.role !== "user") return;
    const text = contentText(event.message);
    if (text === undefined) return;
    const preview = previewText(text, verbose);
    if (preview.text === "") return;
    const key = `user:${messageId(event.message)}`;
    writer.startStream(key, styles.event("› prompt "));
    writer.writeStream(
        key,
        preview.text,
        styles.event,
        styles.event("› prompt "),
    );
    writer.endStream(key);
};

const renderLifecycleEvent = (
    event: PiSessionEvent,
    styles: TranscriptStyles,
    writer: TranscriptWriter,
): void => {
    switch (event.type) {
        case "compaction_start":
            writer.line(
                `${styles.event("↻")} compacting context · ${oneLine(event.reason)}`,
            );
            return;
        case "compaction_end": {
            const state = event.aborted
                ? "aborted"
                : event.errorMessage === undefined
                  ? "done"
                  : `failed: ${oneLine(event.errorMessage)}`;
            writer.line(`${styles.event("↻")} context compaction ${state}`);
            return;
        }
        case "auto_retry_start":
            writer.line(
                `${styles.event("↻")} retrying Pi request · attempt ${event.attempt}/${event.maxAttempts}`,
            );
            return;
        case "auto_retry_end":
            writer.line(
                `${styles.event("↻")} Pi retry ${event.success ? "succeeded" : "failed"}`,
            );
            return;
        case "summarization_retry_scheduled":
            writer.line(
                `${styles.event("↻")} retrying context summary · attempt ${event.attempt}/${event.maxAttempts}`,
            );
            return;
        case "summarization_retry_attempt_start":
            writer.line(`${styles.event("↻")} retrying context summary`);
            return;
        case "summarization_retry_finished":
            writer.line(`${styles.event("↻")} context summary finished`);
            return;
        case "thinking_level_changed":
            writer.line(
                `${styles.event("•")} thinking level · ${oneLine(event.level)}`,
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
    writer: TranscriptWriter,
    states: Map<string, ToolExecutionState>,
    verbose: boolean,
    width: () => number,
): void => {
    if (event.type === "agent_start") {
        writer.beginSession(context);
        return;
    }
    if (event.type === "agent_end") {
        writer.finishSession(event.willRetry ? "retrying…" : "done");
        return;
    }
    if (event.type === "agent_settled") {
        writer.finishSession("settled");
        return;
    }

    writer.ensureSession(context);
    switch (event.type) {
        case "message_start":
            renderUserMessage(event, styles, writer, verbose);
            return;
        case "message_update":
            renderMessageUpdate(event, styles, writer);
            return;
        case "tool_execution_start": {
            const state = outputStateFor(
                states,
                event.toolCallId,
                event.toolName,
            );
            writer.line(
                styles.tool(
                    formatToolCall(event.toolName, event.args, width() - 6),
                ),
                { key: state.key },
            );
            return;
        }
        case "tool_execution_update":
            renderToolExecutionUpdate(event, states, styles, writer);
            return;
        case "tool_execution_end":
            renderToolExecutionEnd(event, states, styles, writer, verbose);
            return;
        case "bash_execution_update":
            renderBashExecutionUpdate(event, states, styles, writer);
            return;
        case "turn_start":
        case "turn_end":
        case "queue_update":
        case "session_info_changed":
        case "entry_appended":
            return;
        case "compaction_start":
        case "compaction_end":
        case "auto_retry_start":
        case "auto_retry_end":
        case "summarization_retry_scheduled":
        case "summarization_retry_attempt_start":
        case "summarization_retry_finished":
        case "thinking_level_changed":
            renderLifecycleEvent(event, styles, writer);
            return;
        case "message_end":
            return;
        default:
            return;
    }
};

export const makePiTranscriptRenderer = ({
    write,
    colors = false,
    json = false,
    verbose = false,
    width = () => process.stderr.columns ?? 100,
}: PiTranscriptRendererOptions): PiEventListener => {
    const styles: TranscriptStyles = colors
        ? {
              assistant: cyan,
              event: dim,
              error: red,
              thinking: yellow,
              tool: yellow,
              success: green,
          }
        : {
              assistant: plain,
              event: plain,
              error: plain,
              thinking: plain,
              tool: plain,
              success: plain,
          };
    const writer = makeTranscriptWriter(write, styles);
    const toolStates = new Map<string, ToolExecutionState>();

    return (event, context) => {
        if (json) {
            write(`${eventJson(event, context)}\n`);
            return;
        }

        renderTerminalEvent(
            event,
            context,
            styles,
            writer,
            toolStates,
            verbose,
            width,
        );
    };
};