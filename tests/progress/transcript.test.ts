import { describe, expect, test } from "bun:test";
import { makeAgentTranscriptRenderer } from "../../src/progress/transcript.ts";
import type {
    AgentEventContext,
    AgentSessionEvent,
} from "../../src/opencode/client.ts";

const context: AgentEventContext = {
    sessionID: "session-1",
    directory: "/tmp",
    title: "Task",
};

const asEvent = (value: unknown): AgentSessionEvent =>
    value as unknown as AgentSessionEvent;

const makeCapture = () => {
    const chunks: string[] = [];
    const renderer = makeAgentTranscriptRenderer({
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
    test("tool live output never enters the human transcript", () => {
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
        expect(text).toContain("│  $ echo hi");
        expect(text).toContain("│  ✓ bash done");
        expect(text).not.toContain("a".repeat(10));
        expect(text).not.toContain("truncated");
        expect(text).not.toContain("500 chars");
    });

    test("streamed thinking never enters the human transcript", () => {
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
        renderer(
            asEvent({
                type: "message_update",
                assistantMessageEvent: {
                    type: "text_delta",
                    contentIndex: 0,
                    delta: "answer",
                },
            }),
            context,
        );
        const text = output();
        expect(text).not.toContain("t".repeat(10));
        expect(text).not.toContain("⋯");
        expect(text).not.toContain("500 chars");
        expect(text).not.toContain("truncated");
        expect(text).toContain("answer");
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

    test("final tool output never enters the human transcript", () => {
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
        expect(text).toContain("│  $ echo hi");
        expect(text).toContain("│  ✓ bash done");
        expect(text).not.toContain("l1");
        expect(text).not.toContain("l5");
        expect(text).not.toContain("output truncated");
    });

    test("tool completion emits one concise success summary", () => {
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
                partialResult: { content: "partial".repeat(40) },
            }),
            context,
        );
        renderer(
            asEvent({
                type: "tool_execution_end",
                toolCallId: "1",
                toolName: "bash",
                result: { content: "partial".repeat(40) },
                isError: false,
            }),
            context,
        );
        const text = output();
        expect(text).toContain("│  ✓ bash done");
        expect(text).not.toContain("partial");
        expect(
            text.split("\n").filter((line) => line.includes("✓ bash done")),
        ).toHaveLength(1);
    });

    test("tool failure emits one sanitized bounded summary with error detail", () => {
        const { renderer, output } = makeCapture();
        renderer(asEvent({ type: "agent_start" }), context);
        renderer(
            asEvent({
                type: "tool_execution_start",
                toolCallId: "1",
                toolName: "grep",
                args: { pattern: "needle" },
            }),
            context,
        );
        const longError =
            "error: directive failed because of a long explanation ".repeat(20);
        renderer(
            asEvent({
                type: "tool_execution_end",
                toolCallId: "1",
                toolName: "grep",
                result: { content: longError },
                isError: true,
            }),
            context,
        );
        const text = output();
        expect(text).toContain("│  ✗ grep failed —");
        expect(text).not.toContain(longError);
        const summary = text
            .split("\n")
            .find((line) => line.includes("✗ grep failed —"));
        expect(summary).toBeDefined();
        const visible = (summary as string).replace(/\.{3}\s*$/, "…");
        expect(visible.endsWith("…")).toBe(true);
        expect(
            Array.from((summary as string).replace("│  ", "")).length,
        ).toBeLessThanOrEqual(160);
    });

    test("tool failure without readable output still emits a concise summary", () => {
        const { renderer, output } = makeCapture();
        renderer(asEvent({ type: "agent_start" }), context);
        renderer(
            asEvent({
                type: "tool_execution_start",
                toolCallId: "1",
                toolName: "edit",
                args: { file_path: "/tmp/a.ts" },
            }),
            context,
        );
        renderer(
            asEvent({
                type: "tool_execution_end",
                toolCallId: "1",
                toolName: "edit",
                result: undefined,
                isError: true,
            }),
            context,
        );
        const text = output();
        expect(text).toContain("│  ✗ edit failed");
        expect(text).not.toContain("—");
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
    });

    test("JSON records retain complete nested event data", () => {
        const chunks: string[] = [];
        const renderer = makeAgentTranscriptRenderer({
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
        expect(output).toContain('"type":"opencode_event"');
        expect(output).toContain('"token":"sk-json-nested"');
        expect(output).toContain('"apiKey":"ghp_JSONKEYVALUESECRET"');
        expect(output).toContain("ghp_JSONTITLESECRET");
    });
});

describe("transcript terminal safety", () => {
    test("strips ANSI and control sequences from streamed text", () => {
        const { renderer, output } = makeCapture();
        renderer(asEvent({ type: "agent_start" }), context);
        renderer(
            asEvent({
                type: "message_update",
                assistantMessageEvent: {
                    type: "text_delta",
                    contentIndex: 0,
                    delta: "\u001b[31mred\u001b[0m\tdone",
                },
            }),
            context,
        );
        const text = output();
        expect(text).toContain("red");
        expect(text).toContain("    done");
        expect(text).not.toContain("\u001b");
        expect(text).not.toContain("\t");
    });

    test("normalizes carriage returns in streamed assistant text", () => {
        const { renderer, output } = makeCapture();
        renderer(asEvent({ type: "agent_start" }), context);
        renderer(
            asEvent({
                type: "message_update",
                assistantMessageEvent: {
                    type: "text_delta",
                    contentIndex: 0,
                    delta: "line1\rline2\r\nline3",
                },
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
        const renderer = makeAgentTranscriptRenderer({
            write: (text: string) => {
                chunks.push(text);
            },
            json: true,
        });
        renderer(asEvent({ type: "agent_start", unrenderable: 1n }), context);
        expect(chunks.join("")).toContain("[unserializable]");
    });
});