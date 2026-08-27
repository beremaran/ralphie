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
            "╭─ Pi · Implement issue #42 · session-1\n" +
                "│\n" +
                "│  ⋯ thinking inspect files\n" +
                "│\n" +
                "│  ✦ assistant I will make the change.\n" +
                "│\n" +
                "│  $ rg TODO\n" +
                "│    src/index.ts\n" +
                "│  ✓ bash done · 1 line\n" +
                "╰─ settled\n",
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

    test("keeps interleaved streams readable and de-duplicates tool output", () => {
        let output = "";
        const render = makePiTranscriptRenderer({
            write: (text) => {
                output += text;
            },
            width: () => 80,
        });

        render(event({ type: "agent_start" }), context);
        render(
            event({
                type: "message_update",
                message: { role: "assistant" },
                assistantMessageEvent: {
                    type: "thinking_start",
                    contentIndex: 0,
                },
            }),
            context,
        );
        render(
            event({
                type: "message_update",
                message: { role: "assistant" },
                assistantMessageEvent: {
                    type: "thinking_delta",
                    contentIndex: 0,
                    delta: "checking",
                },
            }),
            context,
        );
        render(
            event({
                type: "message_update",
                message: { role: "assistant" },
                assistantMessageEvent: {
                    type: "text_start",
                    contentIndex: 1,
                },
            }),
            context,
        );
        render(
            event({
                type: "message_update",
                message: { role: "assistant" },
                assistantMessageEvent: {
                    type: "text_delta",
                    contentIndex: 1,
                    delta: "ready",
                },
            }),
            context,
        );
        render(
            event({
                type: "message_update",
                message: { role: "assistant" },
                assistantMessageEvent: {
                    type: "thinking_end",
                    contentIndex: 0,
                },
            }),
            context,
        );
        render(
            event({
                type: "message_update",
                message: { role: "assistant" },
                assistantMessageEvent: {
                    type: "text_end",
                    contentIndex: 1,
                },
            }),
            context,
        );
        render(
            event({
                type: "tool_execution_start",
                toolCallId: "call-1",
                toolName: "bash",
                args: { command: "printf 'first\\nsecond\\n'" },
            }),
            context,
        );
        render(
            event({
                type: "tool_execution_update",
                toolCallId: "call-1",
                toolName: "bash",
                args: {},
                partialResult: {
                    content: [{ type: "text", text: "first\n" }],
                },
            }),
            context,
        );
        render(
            event({
                type: "tool_execution_update",
                toolCallId: "call-1",
                toolName: "bash",
                args: {},
                partialResult: {
                    content: [{ type: "text", text: "first\nsecond\n" }],
                },
            }),
            context,
        );
        render(
            event({
                type: "tool_execution_end",
                toolCallId: "call-1",
                toolName: "bash",
                isError: false,
                result: {
                    content: [{ type: "text", text: "first\nsecond\n" }],
                },
            }),
            context,
        );
        render(event({ type: "agent_end", willRetry: false }), context);

        expect(output).toBe(
            "╭─ Pi · Implement issue #42 · session-1\n" +
                "│\n" +
                "│  ⋯ thinking checking\n" +
                "│\n" +
                "│  ✦ assistant ready\n" +
                "│\n" +
                "│  $ printf 'first\\nsecond\\n'\n" +
                "│    first\n" +
                "│    second\n" +
                "│  ✓ bash done · 2 lines\n" +
                "╰─ done\n",
        );
    });

    test("normalizes terminal control sequences in streamed text", () => {
        let output = "";
        const render = makePiTranscriptRenderer({
            write: (text) => {
                output += text;
            },
        });

        render(
            event({
                type: "message_update",
                message: { role: "assistant" },
                assistantMessageEvent: {
                    type: "text_delta",
                    delta: "\u001b[31mone\u001b[0m\r\ntwo\tthree",
                },
            }),
            context,
        );

        expect(output).toBe(
            "╭─ Pi · Implement issue #42 · session-1\n" +
                "│\n" +
                "│  ✦ assistant one\n" +
                "│    two    three",
        );
        expect(output).not.toContain("\u001b");
        expect(output).not.toContain("\r");
    });

    test("bounds noisy tool results while keeping a useful summary", () => {
        let output = "";
        const render = makePiTranscriptRenderer({
            write: (text) => {
                output += text;
            },
        });
        const result = Array.from(
            { length: 14 },
            (_, index) => `line ${index + 1}`,
        ).join("\n");

        render(
            event({
                type: "tool_execution_start",
                toolCallId: "call-2",
                toolName: "read",
                args: { path: "src/index.ts" },
            }),
            context,
        );
        render(
            event({
                type: "tool_execution_end",
                toolCallId: "call-2",
                toolName: "read",
                isError: false,
                result: { content: [{ type: "text", text: result }] },
            }),
            context,
        );

        expect(output).toContain("line 12");
        expect(output).not.toContain("line 13");
        expect(output).toContain("… output truncated");
        expect(output).toContain("✓ read done · 14 lines · truncated");
    });
});