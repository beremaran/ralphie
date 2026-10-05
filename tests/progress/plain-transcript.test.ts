import { describe, expect, test } from "bun:test";

import type { AgentEventContext } from "../../src/agent/ports.ts";
import { makeProgressCoordinator } from "../../src/progress/adapters/coordinator.ts";

const context: AgentEventContext = {
    sessionID: "s",
    directory: "/w",
    title: "Implement #1",
};

describe("plain transcript", () => {
    test("renders text, tool results, errors and the harness name", async () => {
        let output = "";
        const coordinator = makeProgressCoordinator({
            mode: "plain",
            colors: false,
            runId: "r",
            write: (text) => {
                output += text;
            },
            width: () => 80,
        });
        const emit = (
            event: Parameters<typeof coordinator.sessionListener>[0],
        ) => coordinator.sessionListener(event, context);

        emit({ type: "session_started", harness: "claude-code" });
        emit({ type: "text_delta", channel: "assistant", text: "working" });
        emit({ type: "text_end", channel: "assistant" });
        emit({ type: "tool_call", toolName: "bash", args: { command: "ls" } });
        emit({
            type: "tool_result",
            toolName: "bash",
            isError: true,
            text: "exit 2",
        });
        emit({ type: "usage", usage: { inputTokens: 1 } });
        emit({ type: "error", message: "rate limited" });
        emit({ type: "session_finished" });
        await coordinator.dispose();

        expect(output).toBe(
            [
                "╭─ claude-code · Implement #1",
                "│  working",
                "│  $ ls",
                "│  ✗ bash failed: exit 2",
                "│  ✗ error: rate limited",
                "╰─ done",
                "",
            ].join("\n"),
        );
    });
});