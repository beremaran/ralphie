import { describe, expect, test } from "bun:test";

import { translatePiEvent } from "../src/pi/adapters/events.ts";

describe("pi event translation", () => {
    test("maps session lifecycle", () => {
        expect(translatePiEvent({ type: "agent_start" })).toEqual([
            { type: "session_started", harness: "pi" },
        ]);
        expect(translatePiEvent({ type: "agent_end", messages: [] })).toEqual([
            { type: "session_finished" },
        ]);
    });

    test("maps assistant and thinking text streams", () => {
        const update = (type: string, extra: object = {}) =>
            translatePiEvent({
                type: "message_update",
                assistantMessageEvent: { type, contentIndex: 0, ...extra },
            });
        expect(update("text_delta", { delta: "hi" })).toEqual([
            { type: "text_delta", channel: "assistant", text: "hi" },
        ]);
        expect(update("thinking_delta", { delta: "hm" })).toEqual([
            { type: "text_delta", channel: "thinking", text: "hm" },
        ]);
        expect(update("text_end")).toEqual([
            { type: "text_end", channel: "assistant" },
        ]);
        expect(update("thinking_end")).toEqual([
            { type: "text_end", channel: "thinking" },
        ]);
        expect(update("text_start")).toEqual([]);
        expect(update("toolcall_delta")).toEqual([]);
    });

    test("maps tool calls and results, extracting result text", () => {
        expect(
            translatePiEvent({
                type: "tool_execution_start",
                toolCallId: "t1",
                toolName: "bash",
                args: { command: "ls" },
            }),
        ).toEqual([
            {
                type: "tool_call",
                toolCallId: "t1",
                toolName: "bash",
                args: { command: "ls" },
            },
        ]);

        const result = (value: unknown, isError = false) =>
            translatePiEvent({
                type: "tool_execution_end",
                toolCallId: "t1",
                toolName: "bash",
                result: value,
                isError,
            });
        expect(result("plain")).toEqual([
            {
                type: "tool_result",
                toolCallId: "t1",
                toolName: "bash",
                isError: false,
                text: "plain",
            },
        ]);
        expect(result({ text: "text field" }, true)[0]).toMatchObject({
            isError: true,
            text: "text field",
        });
        expect(result({ content: "nested string" })[0]).toMatchObject({
            text: "nested string",
        });
        expect(
            result({ content: [{ text: "one" }, { text: "two" }] })[0],
        ).toMatchObject({ text: "one\ntwo" });
        expect(result({ content: [{ type: "image" }] })[0]).not.toHaveProperty(
            "text",
        );
        expect(result(undefined)[0]).not.toHaveProperty("text");
    });

    test("reports usage and failures from finished assistant messages", () => {
        expect(
            translatePiEvent({
                type: "message_end",
                message: {
                    role: "assistant",
                    stopReason: "error",
                    errorMessage: "rate limited",
                    usage: {
                        input: 10,
                        output: 5,
                        cacheRead: 2,
                        cacheWrite: 1,
                        totalTokens: 18,
                        cost: { total: 0.25 },
                    },
                },
            }),
        ).toEqual([
            {
                type: "usage",
                usage: {
                    inputTokens: 10,
                    outputTokens: 5,
                    cacheReadTokens: 2,
                    cacheWriteTokens: 1,
                    totalTokens: 18,
                    costUsd: 0.25,
                },
            },
            { type: "error", message: "rate limited" },
        ]);
        expect(
            translatePiEvent({
                type: "message_end",
                message: { role: "user" },
            }),
        ).toEqual([]);
    });

    test("ignores native events with no normalized meaning", () => {
        for (const type of ["turn_start", "turn_end", "message_start"]) {
            expect(translatePiEvent({ type })).toEqual([]);
        }
        expect(translatePiEvent(undefined)).toEqual([]);
    });
});