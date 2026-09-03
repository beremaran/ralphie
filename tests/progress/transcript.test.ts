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

describe("transcript is lossless for sensitive-looking text", () => {
    test("token-like values survive session headers", () => {
        const { renderer, output } = makeCapture();
        renderer(asEvent({ type: "agent_start" }), {
            sessionID: "ghp_HEADERSESSIONTOKEN",
            directory: "/tmp",
            title: "Task with github_pat_HEADERPATTYPE secret",
        });
        const text = output();
        expect(text).toContain("ghp_HEADERSESSIONTOKEN");
        expect(text).toContain("github_pat_HEADERPATTYPE");
        expect(text).not.toContain("[REDACTED]");
    });

    test("token-like values survive streamed human text", () => {
        const { renderer, output } = makeCapture();
        renderer(asEvent({ type: "agent_start" }), context);
        renderer(
            asEvent({
                type: "message_start",
                message: {
                    role: "user",
                    content: "use gh ghp_STREAMTOKEN and Bearer STREAM-BEARER",
                },
            }),
            context,
        );
        const text = output();
        expect(text).toContain("ghp_STREAMTOKEN");
        expect(text).toContain("STREAM-BEARER");
        expect(text).not.toContain("[REDACTED]");
    });

    test("tokens survive assistant streams, tool output, and errors", () => {
        const { renderer, output } = makeCapture();
        renderer(asEvent({ type: "agent_start" }), context);
        renderer(
            asEvent({
                type: "message_update",
                assistantMessageEvent: {
                    type: "text_delta",
                    contentIndex: 0,
                    delta: "assistant says Bearer ASSISTANT-BEARER",
                },
            }),
            context,
        );
        renderer(
            asEvent({
                type: "tool_execution_start",
                toolCallId: "1",
                toolName: "bash",
                args: { command: "echo ghp_TOOLEVENTTOKEN" },
            }),
            context,
        );
        renderer(
            asEvent({
                type: "tool_execution_end",
                toolCallId: "1",
                toolName: "bash",
                result: { content: "plain ghp_TOOLOUTPUTTOKEN" },
                isError: true,
            }),
            context,
        );
        const text = output();
        expect(text).toContain("ASSISTANT-BEARER");
        expect(text).toContain("ghp_TOOLEVENTTOKEN");
        expect(text).toContain("ghp_TOOLOUTPUTTOKEN");
        expect(text).not.toContain("[REDACTED]");
    });

    test("JSON records retain complete nested event data", () => {
        const chunks: string[] = [];
        const renderer = makePiTranscriptRenderer({
            write: (text: string) => {
                chunks.push(text);
            },
            json: true,
        });
        renderer(
            asEvent({
                type: "tool_execution_start",
                toolCallId: "1",
                toolName: "bash",
                args: {
                    command: "echo hi",
                    token: "sk-json-nested",
                    credentials: { apiKey: "ghp_JSONKEYVALUESECRET" },
                },
            }),
            {
                sessionID: "session-json",
                directory: "/tmp",
                title: "JSON task ghp_JSONTITLESECRET",
            },
        );
        const output = chunks.join("");
        expect(output).toContain('"type":"pi_event"');
        expect(output).toContain('"token":"sk-json-nested"');
        expect(output).toContain('"apiKey":"ghp_JSONKEYVALUESECRET"');
        expect(output).toContain("ghp_JSONTITLESECRET");
        expect(output).not.toContain("[REDACTED]");
    });
});

describe("transcript terminal safety", () => {
    test("strips ANSI and control sequences from streamed text", () => {
        const { renderer, output } = makeCapture();
        renderer(asEvent({ type: "agent_start" }), context);
        renderer(
            asEvent({
                type: "tool_execution_update",
                toolCallId: "1",
                toolName: "bash",
                partialResult: { content: "\u001b[31mred\u001b[0m\tdone" },
            }),
            context,
        );
        const text = output();
        expect(text).toContain("red");
        expect(text).toContain("    done");
        expect(text).not.toContain("\u001b");
        expect(text).not.toContain("\t");
    });

    test("normalizes carriage returns in streamed output", () => {
        const { renderer, output } = makeCapture();
        renderer(asEvent({ type: "agent_start" }), context);
        renderer(
            asEvent({
                type: "tool_execution_update",
                toolCallId: "1",
                toolName: "bash",
                partialResult: { content: "line1\rline2\r\nline3" },
            }),
            context,
        );
        const text = output();
        expect(text).not.toContain("\r");
        expect(text).toContain("line1");
        expect(text).toContain("line2");
        expect(text).toContain("line3");
    });

    test("falls back to [unserializable] for non-JSON event values", () => {
        const chunks: string[] = [];
        const renderer = makePiTranscriptRenderer({
            write: (text: string) => {
                chunks.push(text);
            },
            json: true,
        });
        renderer(asEvent({ type: "agent_start", unrenderable: 1n }), context);
        expect(chunks.join("")).toContain("[unserializable]");
    });
});