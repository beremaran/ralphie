import { describe, expect, test } from "bun:test";

import type { CodexSessionEvent } from "../../src/codex/client.ts";
import type { DisplayState } from "../../src/progress/display-state.ts";
import { makeCodexTranscriptRenderer } from "../../src/progress/transcript.ts";

const context = {
    sessionID: "session-1",
    directory: "/workspace/repository",
    title: "Implement issue #42",
};

const event = (value: unknown): CodexSessionEvent => value as CodexSessionEvent;

const graphemeSegmenter = new Intl.Segmenter(undefined, {
    granularity: "grapheme",
});

const visibleRows = (text: string, width: number): number => {
    let rows = 0;
    let column = 0;
    let rowCounted = false;
    for (const { segment } of graphemeSegmenter.segment(text)) {
        if (segment === "\n") {
            rows += 1;
            column = 0;
            rowCounted = true;
            continue;
        }
        const characterWidth = Bun.stringWidth(segment);
        if (characterWidth === 0) continue;
        if (!rowCounted) {
            rows += 1;
            rowCounted = true;
        }
        const occupied = column + characterWidth;
        rows += Math.floor((occupied - 1) / width);
        column = ((occupied - 1) % width) + 1;
    }
    return rows;
};

describe("Codex transcript rendering", () => {
    test("streams thinking, assistant text, tool calls, and results", () => {
        let output = "";
        const render = makeCodexTranscriptRenderer({
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
            "╭─ Codex · Implement issue #42 · session-1\n" +
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

    test("snapshots complete workflow context for an explicit session", () => {
        let output = "";
        const state: DisplayState = {
            repository: "owner/repo",
            issue: { current: 2, total: 4, number: 56, title: "Context" },
            stage: "review-fix",
            reviewAttempt: { current: 1, total: 3 },
            activity: "waiting",
            activityLabel: "Waiting",
        };
        const render = makeCodexTranscriptRenderer({
            write: (text) => {
                output += text;
            },
            getDisplayState: () => state,
        });

        render(event({ type: "agent_start" }), context);

        expect(output).toStartWith(
            "╭─ Codex · Implement issue #42 · session-1 · owner/repo · issue 2/4 · #56 · Addressing review findings · attempt 1/3\n",
        );
    });

    test("samples partial context when an implicit session opens and on later sessions", () => {
        let output = "";
        let state: DisplayState = {
            repository: "owner/repo",
            activity: "waiting",
            activityLabel: "Waiting",
        };
        const render = makeCodexTranscriptRenderer({
            write: (text) => {
                output += text;
            },
            getDisplayState: () => state,
        });

        render(event({ type: "turn_start" }), context);
        render(event({ type: "agent_settled" }), context);
        state = { ...state, stage: "implementation" };
        render(event({ type: "turn_start" }), context);

        expect(output).toContain(
            "╭─ Codex · Implement issue #42 · session-1 · owner/repo\n",
        );
        expect(output).toContain(
            "╭─ Codex · Implement issue #42 · session-1 · owner/repo · Implementing changes\n",
        );
        expect(output).not.toContain("undefined");
    });

    test("redacts secrets and terminal controls in header fields", () => {
        let output = "";
        const render = makeCodexTranscriptRenderer({
            write: (text) => {
                output += text;
            },
            getDisplayState: () => ({
                repository:
                    "\u001b[31mowner/repo?token=private-value\u001b[0m\nforged",
                activity: "waiting",
                activityLabel: "Waiting",
            }),
        });

        render(event({ type: "agent_start" }), {
            ...context,
            sessionID: "session\u001b[2J Bearer private-value",
            title: "Task\r\nBearer private-value",
        });

        expect(output).not.toContain("private-value");
        expect(output).not.toContain("\u001b");
        expect(output).not.toContain("Task\r\n");
        expect(output).toContain("[REDACTED]");
        expect(output.split("\n")[0]).toContain("forged");
    });

    test("redacts streamed text and emits complete JSON events", () => {
        let output = "";
        const render = makeCodexTranscriptRenderer({
            write: (text) => {
                output += text;
            },
            json: true,
            getDisplayState: () => ({
                repository: "must-not-be-added",
                stage: "implementation",
                activity: "waiting",
                activityLabel: "Waiting",
            }),
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
            type: "codex_event",
            sessionID: "session-1",
            event: {
                type: "message_update",
                assistantMessageEvent: {
                    delta: "Bearer [REDACTED]",
                },
            },
        });
        expect(parsed).not.toHaveProperty("repository");
        expect(output.trimEnd().split("\n")).toHaveLength(1);
        expect(output).not.toContain("must-not-be-added");
        expect(output).not.toContain("╭─");
    });

    test("keeps interleaved streams readable and de-duplicates tool output", () => {
        let output = "";
        const render = makeCodexTranscriptRenderer({
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
            "╭─ Codex · Implement issue #42 · session-1\n" +
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

    test("resumes an open stream after an inserted lifecycle line", () => {
        let output = "";
        const render = makeCodexTranscriptRenderer({
            write: (text) => {
                output += text;
            },
        });
        const update = (assistantMessageEvent: unknown) =>
            render(
                event({
                    type: "message_update",
                    assistantMessageEvent,
                }),
                context,
            );

        update({ type: "text_delta", delta: "a", contentIndex: 2 });
        render(
            event({ type: "thinking_level_changed", level: "high" }),
            context,
        );
        update({ type: "text_delta", delta: "b", contentIndex: 2 });
        update({ type: "text_end", contentIndex: 2 });
        render(event({ type: "agent_end", willRetry: false }), context);

        expect(output).toBe(
            "╭─ Codex · Implement issue #42 · session-1\n" +
                "│\n" +
                "│  ✦ assistant a\n" +
                "│\n" +
                "│  • thinking level · high\n" +
                "│    b\n" +
                "╰─ done\n",
        );
    });

    test("normalizes terminal control sequences in streamed text", () => {
        let output = "";
        const render = makeCodexTranscriptRenderer({
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
            "╭─ Codex · Implement issue #42 · session-1\n" +
                "│\n" +
                "│  ✦ assistant one\n" +
                "│    two    three",
        );
        expect(output).not.toContain("\u001b");
        expect(output).not.toContain("\r");
    });

    test("meters sanitized incremental output as visible terminal rows", () => {
        let output = "";
        let width = 4;
        const render = makeCodexTranscriptRenderer({
            write: (text) => {
                output += text;
            },
            width: () => width,
        });

        render(event({ type: "agent_start" }), context);
        for (const character of `${"界".repeat(220)}👨‍👩‍👧‍👦\n\nend\t`) {
            render(
                event({
                    type: "message_update",
                    message: { role: "assistant" },
                    assistantMessageEvent: {
                        type: "text_delta",
                        delta: `\u001b[31m${character}\u001b[0m`,
                    },
                }),
                context,
            );
        }

        expect(render.getVisibleLineCount()).toBe(visibleRows(output, width));
        expect(visibleRows("👨‍👩‍👧‍👦", 2)).toBe(1);
        expect(render.getVisibleLineCount()).toBeGreaterThan(100);
        expect(output).not.toContain("\u001b");
        expect(output).toContain("    ");

        const beforeTrailingNewline = render.getVisibleLineCount();
        render(
            event({
                type: "message_update",
                message: { role: "assistant" },
                assistantMessageEvent: { type: "text_delta", delta: "\n" },
            }),
            context,
        );
        expect(render.getVisibleLineCount()).toBe(beforeTrailingNewline + 1);

        const beforeConsecutiveNewline = render.getVisibleLineCount();
        render(
            event({
                type: "message_update",
                message: { role: "assistant" },
                assistantMessageEvent: { type: "text_delta", delta: "\n" },
            }),
            context,
        );
        expect(render.getVisibleLineCount()).toBe(beforeConsecutiveNewline + 1);
        expect(render.getVisibleLineCount()).toBe(visibleRows(output, width));

        width = 2;
        expect(render.getVisibleLineCount()).toBe(visibleRows(output, width));

        render(event({ type: "agent_settled" }), context);
        output = "";
        render(event({ type: "agent_start" }), context);
        expect(render.getVisibleLineCount()).toBe(visibleRows(output, width));
    });

    test("meters cumulative tool updates only once", () => {
        let output = "";
        const width = 12;
        const render = makeCodexTranscriptRenderer({
            write: (text) => {
                output += text;
            },
            width: () => width,
        });

        render(
            event({
                type: "tool_execution_update",
                toolCallId: "cumulative",
                toolName: "read",
                partialResult: {
                    content: [{ type: "text", text: "first\n" }],
                },
            }),
            context,
        );
        render(
            event({
                type: "tool_execution_update",
                toolCallId: "cumulative",
                toolName: "read",
                partialResult: {
                    content: [{ type: "text", text: "first\nsecond\n" }],
                },
            }),
            context,
        );

        expect(output.match(/first/g)).toHaveLength(1);
        expect(output.match(/second/g)).toHaveLength(1);
        expect(render.getVisibleLineCount()).toBe(visibleRows(output, width));
    });

    test("bounds noisy tool results while keeping a useful summary", () => {
        let output = "";
        const render = makeCodexTranscriptRenderer({
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