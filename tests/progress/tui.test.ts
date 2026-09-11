import { describe, expect, test } from "bun:test";

import type { AgentEventContext } from "../../src/agent/ports.ts";
import { makeProgressCoordinator } from "../../src/progress/adapters/coordinator.ts";
import { createTestRenderer } from "@opentui/core/testing";

const context: AgentEventContext = {
    sessionID: "tui-session",
    directory: "/workspace/owner/repository",
    title: "Implement login",
};

const FIXED_NOW = () => new Date("2026-09-11T00:00:00.000Z");

describe("OpenTUI progress coordinator", () => {
    test("renders the transcript, tool activity, and status in one frame", async () => {
        const setup = await createTestRenderer({ width: 80, height: 20 });
        const coordinator = makeProgressCoordinator({
            mode: "interactive",
            colors: false,
            runId: "tui-run",
            now: FIXED_NOW,
            createRenderer: async () => setup.renderer,
        });

        await coordinator.progress.emit({
            stage: "run",
            status: "info",
            message: "Ralphie started for owner/repo on main.",
            details: { repository: "owner/repo" },
        });
        await coordinator.progress.emit({
            stage: "implementation",
            status: "started",
            message: "Implementing #42 Fix login...",
            issue: { number: 42, title: "Fix login" },
            current: 1,
            total: 3,
        });
        coordinator.piListener({ type: "agent_start" }, context);
        coordinator.piListener(
            {
                type: "message_update",
                assistantMessageEvent: {
                    type: "text_delta",
                    contentIndex: 0,
                    delta: "Working on ",
                },
            },
            context,
        );
        coordinator.piListener(
            {
                type: "message_update",
                assistantMessageEvent: {
                    type: "text_delta",
                    contentIndex: 0,
                    delta: "the login flow.",
                },
            },
            context,
        );
        coordinator.piListener(
            {
                type: "message_update",
                assistantMessageEvent: { type: "text_end", contentIndex: 0 },
            },
            context,
        );
        coordinator.piListener(
            {
                type: "tool_execution_start",
                toolCallId: "tool-1",
                toolName: "bash",
                args: { command: "bun test" },
            },
            context,
        );
        coordinator.piListener(
            {
                type: "tool_execution_end",
                toolCallId: "tool-1",
                toolName: "bash",
                result: { content: "ok" },
                isError: false,
            },
            context,
        );

        await coordinator.ready;
        await setup.renderOnce();
        const frame = setup.captureCharFrame();

        expect(frame).toContain("ralphie");
        expect(frame).toContain("owner/repo");
        expect(frame).toContain("pi · Implement login");
        expect(frame).toContain("Working on the login flow.");
        expect(frame).toContain("$ bun test");
        expect(frame).toContain("✓ bash done");
        expect(frame).toContain("#42");
        expect(frame).toContain("Implementing changes");

        await coordinator.dispose();
    });

    test("renders progress outcomes and disposes without leaking timers", async () => {
        const setup = await createTestRenderer({ width: 80, height: 12 });
        const coordinator = makeProgressCoordinator({
            mode: "interactive",
            colors: false,
            runId: "tui-run-2",
            now: FIXED_NOW,
            createRenderer: async () => setup.renderer,
        });

        await coordinator.progress.emit({
            stage: "verification",
            status: "failed",
            message: "verification-failed-marker",
            issue: { number: 7, title: "Broken check" },
        });
        await coordinator.progress.emit({
            stage: "grounding",
            status: "needs-attention",
            message: "needs-attention-marker",
            issue: { number: 8, title: "Needs a decision" },
        });

        await coordinator.ready;
        await setup.renderOnce();
        const frame = setup.captureCharFrame();
        expect(frame).toContain("verification-failed-marker");
        expect(frame).toContain("needs-attention-marker");

        await coordinator.dispose();
        // A second dispose is harmless and emits nothing.
        await coordinator.dispose();
    });
});