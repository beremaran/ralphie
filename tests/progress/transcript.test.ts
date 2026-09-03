import { describe, expect, test } from "bun:test";
import { makePiTranscriptRenderer } from "../../src/progress/transcript.ts";
import type { PiEventContext, PiSessionEvent } from "../../src/pi/client.ts";

const context: PiEventContext = {
    sessionID: "session-1",
    directory: "/tmp",
    title: "Task",
};

const asEvent = (value: unknown): PiSessionEvent =>
    value as unknown as PiSessionEvent;

const makeCapture = () => {
    const chunks: string[] = [];
    const renderer = makePiTranscriptRenderer({
        write: (text: string) => {
            chunks.push(text);
        },
        colors: false,
        json: false,
        verbose: false,
        width: () => 100,
    });
    return { chunks, renderer, output: () => chunks.join("") };
};

describe("transcript output bounds", () => {
    test("tool live output is bounded to 140 characters", () => {
        const { renderer, output } = makeCapture();
        renderer(asEvent({ type: "agent_start" }), context);
        renderer(
            asEvent({
                type: "tool_execution_start",
                toolCallId: "1",
                toolName: "bash",
                args: { command: "echo hi" },
            }),
            context,
        );
        renderer(
            asEvent({
                type: "tool_execution_update",
                toolCallId: "1",
                toolName: "bash",
                partialResult: { content: "a".repeat(500) },
            }),
            context,
        );
        renderer(
            asEvent({
                type: "tool_execution_end",
                toolCallId: "1",
                toolName: "bash",
                result: { content: "a".repeat(500) },
                isError: false,
            }),
            context,
        );
        const text = output();
        expect(text.includes("a".repeat(141))).toBe(false);
        expect(text.includes("a".repeat(140))).toBe(true);
        expect(text.includes("truncated")).toBe(true);
        expect(text.includes("500 chars")).toBe(true);
    });

    test("thinking stream is bounded to 140 characters", () => {
        const { renderer, output } = makeCapture();
        renderer(asEvent({ type: "agent_start" }), context);
        renderer(
            asEvent({
                type: "message_update",
                assistantMessageEvent: {
                    type: "thinking_start",
                    contentIndex: 0,
                },
            }),
            context,
        );
        renderer(
            asEvent({
                type: "message_update",
                assistantMessageEvent: {
                    type: "thinking_delta",
                    contentIndex: 0,
                    delta: "t".repeat(500),
                },
            }),
            context,
        );
        renderer(
            asEvent({
                type: "message_update",
                assistantMessageEvent: {
                    type: "thinking_end",
                    contentIndex: 0,
                },
            }),
            context,
        );
        const text = output();
        expect(text.includes("t".repeat(141))).toBe(false);
        expect(text.includes("t".repeat(140))).toBe(true);
        expect(text.includes("500 chars")).toBe(true);
        expect(text.includes("truncated")).toBe(true);
    });

    test("assistant stream shows background counts when truncated", () => {
        const { renderer, output } = makeCapture();
        renderer(asEvent({ type: "agent_start" }), context);
        renderer(
            asEvent({
                type: "message_update",
                assistantMessageEvent: {
                    type: "text_start",
                    contentIndex: 1,
                },
            }),
            context,
        );
        renderer(
            asEvent({
                type: "message_update",
                assistantMessageEvent: {
                    type: "text_delta",
                    contentIndex: 1,
                    delta: "s".repeat(300),
                },
            }),
            context,
        );
        renderer(
            asEvent({
                type: "message_update",
                assistantMessageEvent: {
                    type: "text_end",
                    contentIndex: 1,
                },
            }),
            context,
        );
        const text = output();
        expect(text.includes("s".repeat(141))).toBe(false);
        expect(text.includes("300 chars")).toBe(true);
        expect(text.includes("truncated")).toBe(true);
    });

    test("final preview is bounded to 3 lines and 140 characters", () => {
        const { renderer, output } = makeCapture();
        renderer(asEvent({ type: "agent_start" }), context);
        renderer(
            asEvent({
                type: "tool_execution_start",
                toolCallId: "2",
                toolName: "bash",
                args: { command: "echo hi" },
            }),
            context,
        );
        renderer(
            asEvent({
                type: "tool_execution_end",
                toolCallId: "2",
                toolName: "bash",
                result: { content: "l1\nl2\nl3\nl4\nl5" },
                isError: false,
            }),
            context,
        );
        const text = output();
        expect(text.includes("l1")).toBe(true);
        expect(text.includes("l3")).toBe(true);
        expect(text.includes("l4")).toBe(false);
        expect(text.includes("output truncated")).toBe(true);
    });
});