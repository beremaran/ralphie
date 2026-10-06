import type { TurnEvent } from "../ports.ts";
import {
    asNumber,
    asRecord,
    asString,
    type JsonRecord,
    parseLine,
} from "./json-record.ts";

/** What Claude Code reported when the session ended. */
export type ClaudeResult = {
    readonly isError: boolean;
    readonly subtype: string | undefined;
    readonly terminalReason: string | undefined;
    readonly apiErrorStatus: number | undefined;
    /** The final assistant message. */
    readonly text: string;
    readonly structured: unknown;
    readonly errors: readonly string[];
    readonly sessionID: string | undefined;
};

export type ClaudeStreamSummary = {
    readonly sessionID: string | undefined;
    /** Permission mode the session actually started in. */
    readonly permissionMode: string | undefined;
    /** Error code Claude Code attached to an assistant message, if any. */
    readonly assistantError: string | undefined;
    readonly result: ClaudeResult | undefined;
};

const contentBlocks = (message: unknown): readonly JsonRecord[] => {
    const content = asRecord(message)?.content;
    if (!Array.isArray(content)) return [];
    return content.flatMap((block) => {
        const record = asRecord(block);
        return record === undefined ? [] : [record];
    });
};

/** Text rendering of a tool result's content, which is a string or blocks. */
const renderToolOutput = (content: unknown): string => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.map((part) => asString(asRecord(part)?.text) ?? "").join("");
};

const usageEvent = (record: JsonRecord): TurnEvent | undefined => {
    const usage = asRecord(record.usage);
    if (usage === undefined) return undefined;
    const inputTokens = asNumber(usage.input_tokens) ?? 0;
    const outputTokens = asNumber(usage.output_tokens) ?? 0;
    const cacheReadTokens = asNumber(usage.cache_read_input_tokens);
    const cacheWriteTokens = asNumber(usage.cache_creation_input_tokens);
    const costUsd = asNumber(record.total_cost_usd);
    const spent =
        inputTokens +
        outputTokens +
        (cacheReadTokens ?? 0) +
        (cacheWriteTokens ?? 0);
    if (spent === 0 && (costUsd ?? 0) === 0) return undefined;
    return {
        type: "usage",
        inputTokens,
        outputTokens,
        ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
        ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
        ...(costUsd === undefined ? {} : { costUsd }),
    };
};

const readResult = (record: JsonRecord): ClaudeResult => ({
    isError: record.is_error === true,
    subtype: asString(record.subtype),
    terminalReason: asString(record.terminal_reason),
    apiErrorStatus: asNumber(record.api_error_status),
    text: asString(record.result) ?? "",
    structured: record.structured_output,
    errors: Array.isArray(record.errors)
        ? record.errors.flatMap((error) => asString(error) ?? [])
        : [],
    sessionID: asString(record.session_id),
});

/**
 * Translates Claude Code's `stream-json` output into session events, one line
 * at a time, and remembers the facts failure detection needs.
 *
 * Whole content blocks arrive per message, so every text fragment closes its
 * block. Usage is taken once, from the final result, because assistant
 * messages repeat their usage across the blocks of one response.
 */
export const makeClaudeStreamReader = (input: {
    readonly onEvent: (event: TurnEvent) => void;
    /** Called once, when the session reports the mode it started in. */
    readonly onInit: (permissionMode: string | undefined) => void;
}): {
    readonly feed: (line: string) => void;
    readonly summary: () => ClaudeStreamSummary;
} => {
    const toolNames = new Map<string, string>();
    let sessionID: string | undefined;
    let permissionMode: string | undefined;
    let assistantError: string | undefined;
    let result: ClaudeResult | undefined;

    const blockEvent = (block: JsonRecord): TurnEvent | undefined => {
        const text = asString(block.text) ?? "";
        const thinking = asString(block.thinking) ?? "";
        const id = asString(block.id);
        const name = asString(block.name);
        if (block.type === "text" && text !== "") {
            return { type: "assistant_text", kind: "text", text, done: true };
        }
        if (block.type === "thinking" && thinking !== "") {
            return {
                type: "assistant_text",
                kind: "thinking",
                text: thinking,
                done: true,
            };
        }
        if (
            block.type === "tool_use" &&
            id !== undefined &&
            name !== undefined
        ) {
            toolNames.set(id, name);
            return {
                type: "tool_call",
                callId: id,
                name,
                input: asRecord(block.input) ?? {},
            };
        }
        return undefined;
    };

    const assistant = (record: JsonRecord): void => {
        assistantError = asString(record.error) ?? assistantError;
        for (const block of contentBlocks(record.message)) {
            const event = blockEvent(block);
            if (event !== undefined) input.onEvent(event);
        }
    };

    const user = (record: JsonRecord): void => {
        for (const block of contentBlocks(record.message)) {
            const callId = asString(block.tool_use_id);
            if (block.type !== "tool_result" || callId === undefined) continue;
            input.onEvent({
                type: "tool_result",
                callId,
                name: toolNames.get(callId) ?? "unknown",
                output: renderToolOutput(block.content),
                isError: block.is_error === true,
            });
        }
    };

    const system = (record: JsonRecord): void => {
        if (record.subtype !== "init") return;
        sessionID = asString(record.session_id) ?? sessionID;
        permissionMode = asString(record.permissionMode);
        input.onInit(permissionMode);
    };

    const finish = (record: JsonRecord): void => {
        result = readResult(record);
        sessionID = result.sessionID ?? sessionID;
        const usage = usageEvent(record);
        if (usage !== undefined) input.onEvent(usage);
    };

    return {
        feed: (line) => {
            const record = parseLine(line);
            if (record === undefined) return;
            if (record.type === "system") system(record);
            else if (record.type === "assistant") assistant(record);
            else if (record.type === "user") user(record);
            else if (record.type === "result") finish(record);
        },
        summary: () => ({ sessionID, permissionMode, assistantError, result }),
    };
};