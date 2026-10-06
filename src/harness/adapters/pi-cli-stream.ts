import type { TurnEvent } from "../ports.ts";
import {
    asNumberOrZero,
    asRecord,
    asString,
    type JsonRecord,
    parseLine,
} from "./json-record.ts";
import {
    blockEvent,
    contentBlocks,
    renderToolOutput,
    type ToolUseShape,
} from "./stream-blocks.ts";

/** How the last assistant message of a pi run ended. */
export type PiFinalMessage =
    | { readonly failed: false; readonly text: string }
    | { readonly failed: true; readonly errorMessage: string };

export type PiStreamSummary = {
    readonly sessionID: string | undefined;
    /** The last assistant message; earlier retried failures are superseded. */
    readonly final: PiFinalMessage | undefined;
};

const PI_TOOL_CALL: ToolUseShape = {
    type: "toolCall",
    inputField: "arguments",
};

type Usage = {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
};

/**
 * Translates pi's `--mode json` events into session events, one line at a
 * time. Each assistant message arrives whole at `message_end`, so every text
 * fragment closes its block. Usage is summed over the run and reported once
 * by {@link finish}, as one delta.
 */
export const makePiStreamReader = (input: {
    readonly onEvent: (event: TurnEvent) => void;
}): {
    readonly feed: (line: string) => void;
    readonly finish: () => PiStreamSummary;
} => {
    let sessionID: string | undefined;
    let final: PiFinalMessage | undefined;
    const usage: Usage = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
    };

    const addUsage = (raw: unknown): void => {
        const record = asRecord(raw);
        if (record === undefined) return;
        usage.input += asNumberOrZero(record.input);
        usage.output += asNumberOrZero(record.output);
        usage.cacheRead += asNumberOrZero(record.cacheRead);
        usage.cacheWrite += asNumberOrZero(record.cacheWrite);
        usage.cost += asNumberOrZero(asRecord(record.cost)?.total);
    };

    const assistantEnd = (message: JsonRecord): void => {
        for (const block of contentBlocks(message)) {
            const event = blockEvent(block, PI_TOOL_CALL);
            if (event !== undefined) input.onEvent(event);
        }
        addUsage(message.usage);
        const stopReason = asString(message.stopReason);
        if (stopReason === "error" || stopReason === "aborted") {
            final = {
                failed: true,
                errorMessage:
                    asString(message.errorMessage) ??
                    `pi response ended with stop reason "${stopReason}".`,
            };
            return;
        }
        final = {
            failed: false,
            text: contentBlocks(message)
                .filter((block) => block.type === "text")
                .map((block) => asString(block.text) ?? "")
                .join(""),
        };
    };

    const toolEnd = (record: JsonRecord): void => {
        const callId = asString(record.toolCallId);
        if (callId === undefined) return;
        input.onEvent({
            type: "tool_result",
            callId,
            name: asString(record.toolName) ?? "unknown",
            output: renderToolOutput(asRecord(record.result)?.content),
            isError: record.isError === true,
        });
    };

    return {
        feed: (line) => {
            const record = parseLine(line);
            if (record === undefined) return;
            if (record.type === "session") {
                sessionID = asString(record.id) ?? sessionID;
            } else if (record.type === "tool_execution_end") {
                toolEnd(record);
            } else if (record.type === "message_end") {
                const message = asRecord(record.message);
                if (message?.role === "assistant") assistantEnd(message);
            }
        },
        finish: () => {
            const total =
                usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
            if (total > 0 || usage.cost > 0) {
                input.onEvent({
                    type: "usage",
                    inputTokens: usage.input,
                    outputTokens: usage.output,
                    cacheReadTokens: usage.cacheRead,
                    cacheWriteTokens: usage.cacheWrite,
                    ...(usage.cost > 0 ? { costUsd: usage.cost } : {}),
                });
                usage.input = usage.output = 0;
                usage.cacheRead = usage.cacheWrite = usage.cost = 0;
            }
            return { sessionID, final };
        },
    };
};