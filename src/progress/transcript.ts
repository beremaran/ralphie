import type {
    PiEventContext,
    PiEventListener,
    PiSessionEvent,
} from "../opencode/client.ts";
import { stripTerminalControls } from "../shared/redaction.ts";
import { cyan, dim, green, red, yellow } from "./colors.ts";
import {
    prepareBreadcrumbCandidate,
    renderBreadcrumbLabel,
    type BreadcrumbLabelCandidate,
    type NormalizedBreadcrumb,
} from "./breadcrumb-label.ts";
import { progressStageLabel, type DisplayState } from "./display-state.ts";

export type PiTranscriptRendererOptions = {
    readonly write: (text: string) => void;
    readonly colors?: boolean;
    readonly json?: boolean;
    readonly verbose?: boolean;
    readonly width?: () => number;
    /** Current sanitized workflow state, sampled when a session header opens. */
    readonly getDisplayState?: () => DisplayState;
    /** Called after a session header has been measured. */
    readonly onSessionStart?: () => void;
};

/** A transcript listener with coordinator-facing stream-boundary hooks. */
export type PiTranscriptRenderer = PiEventListener & {
    /** Finish the current visible line without dropping the active stream key. */
    readonly interruptLine: () => void;
    /** Insert a normalized breadcrumb and safely resume any interrupted stream. */
    readonly insertBreadcrumb: (
        candidate: BreadcrumbLabelCandidate,
    ) => NormalizedBreadcrumb;
    /** Visible terminal rows written during the current Pi session. */
    readonly getVisibleLineCount: () => number;
};

const plain = (text: string): string => text;

/**
 * Neutralize terminal state (ANSI/OSC sequences, CR/LF variants, tabs, and
 * C0/C1 cursor/erase/bell controls) without otherwise altering the text.
 * This is purely terminal hygiene: secrets and other sensitive-looking text
 * intentionally pass through unchanged.
 */
const sanitizeTerminalText = (text: string): string =>
    stripTerminalControls(text).replace(/\t/g, "    ");

const oneLine = (text: string): string =>
    sanitizeTerminalText(text).replace(/\s+/g, " ").trim();

/** Stateful accounting for the terminal rows occupied by incremental writes. */
const graphemeSegmenter = new Intl.Segmenter(undefined, {
    granularity: "grapheme",
});

const makeVisualLineMeter = (width: () => number) => {
    let transcript = "";

    const getVisibleLineCount = (): number => {
        const terminalWidth = Math.max(1, Math.floor(width()));
        let lines = 0;
        let column = 0;
        let rowCounted = false;

        for (const { segment } of graphemeSegmenter.segment(transcript)) {
            if (segment === "\n") {
                lines += 1;
                column = 0;
                rowCounted = true;
                continue;
            }
            const characterWidth = Bun.stringWidth(segment);
            if (characterWidth === 0) continue;
            if (!rowCounted) {
                lines += 1;
                rowCounted = true;
            }
            const occupied = column + characterWidth;
            lines += Math.floor((occupied - 1) / terminalWidth);
            column = ((occupied - 1) % terminalWidth) + 1;
        }
        return lines;
    };

    return {
        measure: (text: string) => {
            transcript += sanitizeTerminalText(text);
        },
        reset: () => {
            transcript = "";
        },
        getVisibleLineCount,
    };
};

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

/** Serialize event values verbatim; JSON transcript records are lossless. */
const safeJson = (value: unknown): string => {
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return "[unserializable]";
    }
};

const eventJson = (event: PiSessionEvent, context: PiEventContext): string =>
    safeJson({
        type: "opencode_event",
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

const workflowHeader = (state: DisplayState | undefined): string => {
    if (state === undefined) return "";
    const segments: string[] = [];
    if (state.repository !== undefined && oneLine(state.repository) !== "") {
        segments.push(oneLine(state.repository));
    }
    if (state.issue !== undefined) {
        segments.push(
            `issue ${state.issue.current}/${state.issue.total} · #${state.issue.number}`,
        );
    }
    if (state.stage !== undefined)
        segments.push(progressStageLabel(state.stage));
    if (state.reviewAttempt !== undefined) {
        segments.push(
            `attempt ${state.reviewAttempt.current}/${state.reviewAttempt.total}`,
        );
    }
    return segments.length === 0 ? "" : ` · ${segments.join(" · ")}`;
};

const makeTranscriptWriter = (
    write: (text: string) => void,
    styles: TranscriptStyles,
    getDisplayState?: () => DisplayState,
    resetLineMeter?: () => void,
    onSessionStart?: () => void,
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
    /** Finish an external interruption while retaining the active stream key. */
    readonly interruptLine: () => void;
    /** Insert a complete line while retaining the active stream for resumption. */
    readonly insertLine: (
        text: string,
        options?: { readonly blankBefore?: boolean; readonly key?: StreamKey },
    ) => void;
    readonly insertBreadcrumb: (label: string) => void;
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
    };

    const finishStream = (): void => {
        finishLine();
        activeKey = undefined;
    };

    const interruptLine = (): void => {
        finishLine();
    };

    const blankBeforeBlock = (): void => {
        finishStream();
        if (hasBlock) write("│\n");
    };

    const beginSession = (context: PiEventContext): void => {
        if (sessionOpen) finishSession("interrupted");
        resetLineMeter?.();
        const title =
            oneLine(context.title ?? "OpenCode task") || "OpenCode task";
        const session = oneLine(context.sessionID);
        const workflow = workflowHeader(getDisplayState?.());
        write(
            `╭─ ${styles.assistant("OpenCode")} · ${title}${session === "" ? "" : ` · ${styles.event(session)}`}${styles.event(workflow)}\n│\n`,
        );
        sessionOpen = true;
        hasBlock = false;
        onSessionStart?.();
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
        finishStream();
    };

    const insertLine = (
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
        if (options.key !== undefined) activeKey = options.key;
        lineOpen = false;
    };

    const insertBreadcrumb = (label: string): void => {
        insertLine(label, { blankBefore: false });
    };

    const line = (
        text: string,
        options: {
            readonly blankBefore?: boolean;
            readonly key?: StreamKey;
        } = {},
    ): void => {
        insertLine(text, options);
    };

    const finishSession = (label: string): void => {
        if (!sessionOpen) return;
        finishStream();
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
        interruptLine,
        insertLine,
        insertBreadcrumb,
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
    _verbose: boolean,
): {
    readonly text: string;
    readonly omitted: boolean;
    readonly lines: number;
} => {
    void _verbose;
    const clean = sanitizeTerminalText(text).trim();
    if (clean === "") return { text: "", omitted: false, lines: 0 };

    const maxLines = 3;
    const maxCharacters = 140;
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

const STREAM_OUTPUT_LIMIT = 140;

type MessageStreamState = {
    renderedCharacters: number;
    totalCharacters: number;
    outputLimited: boolean;
};

const messageStateFor = (
    states: Map<string, MessageStreamState>,
    key: string,
): MessageStreamState => {
    const existing = states.get(key);
    if (existing !== undefined) return existing;
    const state: MessageStreamState = {
        renderedCharacters: 0,
        totalCharacters: 0,
        outputLimited: false,
    };
    states.set(key, state);
    return state;
};

const renderBoundedMessageDelta = (
    key: StreamKey,
    delta: string,
    states: Map<string, MessageStreamState>,
    writer: TranscriptWriter,
    textStyle: (text: string) => string,
    fallbackLabel: string,
): void => {
    const state = messageStateFor(states, key);
    state.totalCharacters += delta.length;
    const remaining = STREAM_OUTPUT_LIMIT - state.renderedCharacters;
    if (remaining <= 0) {
        state.outputLimited = true;
        return;
    }
    const visible = delta.slice(0, remaining);
    writer.writeStream(key, visible, textStyle, fallbackLabel);
    state.renderedCharacters += visible.length;
    if (visible.length < delta.length) state.outputLimited = true;
};

const endMessageStream = (
    key: StreamKey,
    states: Map<string, MessageStreamState>,
    writer: TranscriptWriter,
    label: string,
    style: (text: string) => string,
): void => {
    const state = states.get(key);
    writer.endStream(key);
    states.delete(key);
    if (state?.outputLimited === true) {
        writer.line(
            `${style(label)} · ${state.totalCharacters} chars · truncated`,
            { blankBefore: false },
        );
    }
};

const renderMessageUpdate = (
    event: MessageUpdateEvent,
    styles: TranscriptStyles,
    writer: TranscriptWriter,
    states: Map<string, MessageStreamState>,
): void => {
    const update = event.assistantMessageEvent;
    switch (update.type) {
        case "thinking_start":
        case "thinking_delta":
        case "thinking_end":
            // Streamed thinking is routed to the compact activity surface only;
            // it is never written into the human transcript.
            return;
        case "text_start":
            writer.startStream(
                messageUpdateKey(event, "assistant"),
                styles.assistant("✦ assistant "),
            );
            return;
        case "text_delta":
            renderBoundedMessageDelta(
                messageUpdateKey(event, "assistant"),
                update.delta,
                states,
                writer,
                styles.assistant,
                styles.assistant("✦ assistant "),
            );
            return;
        case "text_end":
            endMessageStream(
                messageUpdateKey(event, "assistant"),
                states,
                writer,
                "✦ assistant done",
                styles.assistant,
            );
            return;
        case "toolcall_start":
        case "toolcall_delta":
        case "toolcall_end":
            return;
        case "error": {
            const message =
                update.error.errorMessage ??
                update.reason ??
                "OpenCode response failed.";
            writer.line(
                `${styles.error("✗ assistant error")} ${sanitizeTerminalText(message)}`,
            );
            return;
        }
        default:
            return;
    }
};

const FAILURE_DETAIL_LIMIT = 140;

/**
 * One-line, sanitized, bounded failure detail derived from a tool result.
 * Enough detail to act on, without the full multi-line output (which lives in
 * the compact activity surface instead of the human transcript).
 */
const toolFailureDetail = (result: unknown): string => {
    if (result === undefined || result === null) return "";
    const clean = oneLine(toolResultText(result));
    if (clean === "") return "";
    const characters = Array.from(clean);
    return characters.length <= FAILURE_DETAIL_LIMIT
        ? clean
        : `${characters.slice(0, FAILURE_DETAIL_LIMIT).join("")}…`;
};

const renderToolExecutionEnd = (
    event: Extract<PiSessionEvent, { type: "tool_execution_end" }>,
    styles: TranscriptStyles,
    writer: TranscriptWriter,
): void => {
    const name = oneLine(event.toolName) || "tool";
    if (!event.isError) {
        writer.line(`${styles.success("✓")} ${name} done`, {
            blankBefore: false,
        });
        return;
    }
    const detail = toolFailureDetail(event.result);
    writer.line(
        detail === ""
            ? `${styles.error("✗")} ${name} failed`
            : `${styles.error("✗")} ${name} failed — ${styles.error(detail)}`,
        { blankBefore: false },
    );
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
                `${styles.event("↻")} retrying OpenCode request · attempt ${event.attempt}/${event.maxAttempts}`,
            );
            return;
        case "auto_retry_end":
            writer.line(
                `${styles.event("↻")} OpenCode retry ${event.success ? "succeeded" : "failed"}`,
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
    messageStates: Map<string, MessageStreamState>,
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
            renderMessageUpdate(event, styles, writer, messageStates);
            return;
        case "tool_execution_start":
            writer.line(
                styles.tool(
                    formatToolCall(event.toolName, event.args, width() - 6),
                ),
            );
            return;
        case "tool_execution_update":
        case "bash_execution_update":
            // Intermediate tool output streams into the compact activity
            // surface; the human transcript only records the call and outcome.
            return;
        case "tool_execution_end":
            renderToolExecutionEnd(event, styles, writer);
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
    getDisplayState,
    onSessionStart,
}: PiTranscriptRendererOptions): PiTranscriptRenderer => {
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
    const lineMeter = makeVisualLineMeter(width);
    const measuredWrite = (text: string): void => {
        lineMeter.measure(text);
        write(text);
    };
    const writer = makeTranscriptWriter(
        measuredWrite,
        styles,
        getDisplayState,
        lineMeter.reset,
        onSessionStart,
    );
    const messageStates = new Map<string, MessageStreamState>();

    const render: PiEventListener = (event, context) => {
        if (json) {
            write(`${eventJson(event, context)}\n`);
            return;
        }

        renderTerminalEvent(
            event,
            context,
            styles,
            writer,
            messageStates,
            verbose,
            width,
        );
    };
    const insertBreadcrumb = (
        candidate: BreadcrumbLabelCandidate,
    ): NormalizedBreadcrumb => {
        const prepared = prepareBreadcrumbCandidate(candidate);
        if (!json && prepared.label !== "") {
            writer.insertBreadcrumb(
                renderBreadcrumbLabel(candidate, { style: styles.event }),
            );
        }
        return prepared;
    };
    return Object.assign(render, {
        interruptLine: writer.interruptLine,
        insertBreadcrumb,
        getVisibleLineCount: lineMeter.getVisibleLineCount,
    });
};