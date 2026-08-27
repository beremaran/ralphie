import { describe, expect, test } from "bun:test";

import type { PiSessionEvent } from "../../src/pi/client.ts";
import { makePiTranscriptRenderer } from "../../src/progress/transcript.ts";

const context = {
    sessionID: "session-1",
    directory: "/workspace/repository",
    title: "Implement issue #42",
};

const event = (value: unknown): PiSessionEvent => value as PiSessionEvent;

describe("Pi transcript rendering", () => {
    test("streams thinking, assistant text, tool calls, and results", () => {
        let output = "";
        const render = makePiTranscriptRenderer({
            write: (text) => {
                output += text;
            },
        });

        render(event({ type: "agent_start" }), context);
        render(
            event({
                type: "message_update",
                message: { role: "assistant" },
                assistantMessageEvent: { type: "thinking_start" },
            }),
            context,
        );
        render(
            event({
                type: "message_update",
                message: { role: "assistant" },
                assistantMessageEvent: {
                    type: "thinking_delta",
                    delta: "inspect files",
                },
            }),
            context,
        );
        render(
            event({
                type: "message_update",
                message: { role: "assistant" },
                assistantMessageEvent: { type: "thinking_end" },
            }),
            context,
        );
        render(
            event({
                type: "message_update",
                message: { role: "assistant" },
                assistantMessageEvent: { type: "text_start" },
            }),
            context,
        );
        render(
            event({
                type: "message_update",
                message: { role: "assistant" },
                assistantMessageEvent: {
                    type: "text_delta",
                    delta: "I will make the change.",
                },
            }),
            context,
        );
        render(
            event({
                type: "message_update",
                message: { role: "assistant" },
                assistantMessageEvent: { type: "text_end" },
            }),
            context,
        );
        render(
            event({
                type: "tool_execution_start",
                toolName: "bash",
                args: { command: "rg TODO" },
            }),
            context,
        );
        render(
            event({
                type: "tool_execution_end",
                toolName: "bash",
                isError: false,
                result: { content: [{ type: "text", text: "src/index.ts" }] },
            }),
            context,
        );
        render(event({ type: "agent_settled" }), context);

        expect(output).toBe(
            "[pi] Implement issue #42 (session-1)\n" +
                "[thinking] inspect files\n" +
                "[assistant] I will make the change.\n" +
                '[tool] bash {"command":"rg TODO"}\n' +
                '[tool-result] {"content":[{"type":"text","text":"src/index.ts"}]}\n' +
                "[settled]\n",
        );
    });

    test("redacts streamed text and emits complete JSON events", () => {
        let output = "";
        const render = makePiTranscriptRenderer({
            write: (text) => {
                output += text;
            },
            json: true,
        });

        render(
            event({
                type: "message_update",
                message: { role: "assistant" },
                assistantMessageEvent: {
                    type: "text_delta",
                    delta: "Bearer private-value",
                },
            }),
            context,
        );

        const parsed = JSON.parse(output);
        expect(parsed).toMatchObject({
            type: "pi_event",
            sessionID: "session-1",
            event: {
                type: "message_update",
                assistantMessageEvent: {
                    delta: "Bearer [REDACTED]",
                },
            },
        });
    });
});