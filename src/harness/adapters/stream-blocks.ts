import type { TurnEvent } from "../ports.ts";
import { asRecord, asString, type JsonRecord } from "./json-record.ts";

/**
 * The shared content-block reduction the stream adapters all do: extract
 * message content blocks, render tool output text, and turn one block into a
 * session event. Each stream file keeps the knowledge of its own wire format
 * (the tool-use block discriminator and input field) and passes it in; the
 * reduction to the normalized event shape lives here.
 */

/** The content blocks of a message, in order. */
export const contentBlocks = (message: unknown): readonly JsonRecord[] => {
    const content = asRecord(message)?.content;
    if (!Array.isArray(content)) return [];
    return content.flatMap((block) => {
        const record = asRecord(block);
        return record === undefined ? [] : [record];
    });
};

/** Text rendering of a tool result's content, which is a string or blocks. */
export const renderToolOutput = (content: unknown): string => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.map((part) => asString(asRecord(part)?.text) ?? "").join("");
};

/** How one native format names its tool-use block and its input field. */
export type ToolUseShape = {
    readonly type: string;
    readonly inputField: string;
};

/** Reduce one content block to the session event it carries, if any. */
export const blockEvent = (
    block: JsonRecord,
    toolUse: ToolUseShape,
): TurnEvent | undefined => {
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
    if (block.type === toolUse.type && id !== undefined && name !== undefined) {
        return {
            type: "tool_call",
            callId: id,
            name,
            input: asRecord(block[toolUse.inputField]) ?? {},
        };
    }
    return undefined;
};