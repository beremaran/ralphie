import type { TurnEvent } from "../ports.ts";
import {
    asNumber,
    asRecord,
    asString,
    type JsonRecord,
    parseLine,
} from "./json-record.ts";

/** What Codex reported when the turn ended. */
export type CodexStreamSummary = {
    readonly threadID: string | undefined;
    /** The last agent message, which is the final answer. */
    readonly finalText: string | undefined;
    readonly completed: boolean;
    /** Message of a `turn.failed` event; warning-level errors never set it. */
    readonly failureMessage: string | undefined;
};

const usageEvent = (record: JsonRecord): TurnEvent | undefined => {
    const usage = asRecord(record.usage);
    if (usage === undefined) return undefined;
    const inputTokens = asNumber(usage.input_tokens) ?? 0;
    const outputTokens = asNumber(usage.output_tokens) ?? 0;
    const cacheReadTokens = asNumber(usage.cached_input_tokens);
    const cacheWriteTokens = asNumber(usage.cache_write_input_tokens);
    if (inputTokens + outputTokens === 0) return undefined;
    return {
        type: "usage",
        inputTokens,
        outputTokens,
        ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
        ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    };
};

const failureText = (record: JsonRecord): string =>
    asString(asRecord(record.error)?.message) ?? "Codex reported a failure.";

/**
 * Translates `codex exec --json` output into session events, line by line.
 *
 * Items of type `error` are warnings (for example unstable feature notices)
 * and never fail the turn; only `turn.failed` does. Whole items arrive at
 * once, so every text fragment closes its block. Usage is reported once per
 * turn, from `turn.completed`.
 */
export const makeCodexStreamReader = (input: {
    readonly onEvent: (event: TurnEvent) => void;
}): {
    readonly feed: (line: string) => void;
    readonly summary: () => CodexStreamSummary;
} => {
    const started = new Set<string>();
    let threadID: string | undefined;
    let finalText: string | undefined;
    let completed = false;
    let failureMessage: string | undefined;

    const command = (item: JsonRecord, done: boolean): void => {
        const callId = asString(item.id);
        if (callId === undefined) return;
        if (!started.has(callId)) {
            started.add(callId);
            input.onEvent({
                type: "tool_call",
                callId,
                name: "shell",
                input: { command: asString(item.command) ?? "" },
            });
        }
        if (!done) return;
        input.onEvent({
            type: "tool_result",
            callId,
            name: "shell",
            output: asString(item.aggregated_output) ?? "",
            isError:
                item.status === "failed" ||
                (asNumber(item.exit_code) ?? 0) !== 0,
        });
    };

    const completedItem = (item: JsonRecord): void => {
        const text = asString(item.text) ?? "";
        if (item.type === "agent_message") finalText = text;
        const kind = item.type === "reasoning" ? "thinking" : "text";
        if (
            text !== "" &&
            (item.type === "agent_message" || item.type === "reasoning")
        ) {
            input.onEvent({ type: "assistant_text", kind, text, done: true });
        }
    };

    const item = (record: JsonRecord, done: boolean): void => {
        const body = asRecord(record.item);
        if (body === undefined) return;
        if (body.type === "command_execution") command(body, done);
        else if (done) completedItem(body);
    };

    const handlers: Readonly<Record<string, (record: JsonRecord) => void>> = {
        "thread.started": (record) => {
            threadID = asString(record.thread_id) ?? threadID;
        },
        "item.started": (record) => item(record, false),
        "item.completed": (record) => item(record, true),
        "turn.completed": (record) => {
            completed = true;
            const usage = usageEvent(record);
            if (usage !== undefined) input.onEvent(usage);
        },
        "turn.failed": (record) => {
            failureMessage = failureText(record);
        },
    };

    return {
        feed: (line) => {
            const record = parseLine(line);
            handlers[asString(record?.type) ?? ""]?.(record as JsonRecord);
        },
        summary: () => ({ threadID, finalText, completed, failureMessage }),
    };
};