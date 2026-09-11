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

    test("keeps the transcript pinned to the newest output", async () => {
        const setup = await createTestRenderer({ width: 60, height: 10 });
        const coordinator = makeProgressCoordinator({
            mode: "interactive",
            colors: false,
            runId: "tui-run-3",
            now: FIXED_NOW,
            createRenderer: async () => setup.renderer,
        });

        for (let index = 0; index < 40; index += 1) {
            await coordinator.progress.emit({
                stage: "run",
                status: "info",
                message: `transcript-line-${String(index).padStart(2, "0")}`,
            });
        }

        await coordinator.ready;
        await setup.renderOnce();
        let frame = setup.captureCharFrame();
        expect(frame).toContain("transcript-line-39");
        expect(frame).not.toContain("transcript-line-00");

        // The transcript owns Up/Down/PgUp/PgDn/Home/End while focused.
        setup.mockInput.pressKey("HOME");
        await setup.renderOnce();
        frame = setup.captureCharFrame();
        expect(frame).toContain("transcript-line-00");
        expect(frame).not.toContain("transcript-line-39");

        setup.mockInput.pressKey("END");
        await setup.renderOnce();
        frame = setup.captureCharFrame();
        expect(frame).toContain("transcript-line-39");

        await coordinator.dispose();
    });

    test("lists every discovered issue and switches transcripts on navigation", async () => {
        const setup = await createTestRenderer({ width: 80, height: 16 });
        const coordinator = makeProgressCoordinator({
            mode: "interactive",
            colors: false,
            runId: "tui-run-sidebar",
            now: FIXED_NOW,
            createRenderer: async () => setup.renderer,
        });

        await coordinator.progress.emit({
            stage: "issue-queue",
            status: "info",
            message: "Issue queue ready with 3 issues.",
            details: {
                issues: [
                    { number: 41, title: "First task" },
                    { number: 42, title: "Second task" },
                    { number: 43, title: "Third task" },
                ],
            },
        });

        const execute = async (
            number: number,
            title: string,
            text: string,
        ): Promise<void> => {
            await coordinator.progress.emit({
                stage: "issue-execution",
                status: "started",
                message: `Executing #${number}...`,
                issue: { number, title },
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
                        delta: text,
                    },
                },
                context,
            );
            await coordinator.progress.emit({
                stage: "issue-execution",
                status: "succeeded",
                message: `Issue #${number} completed.`,
                issue: { number, title },
            });
        };

        await execute(41, "First task", "alpha work");
        await execute(42, "Second task", "beta work");

        await coordinator.ready;
        await setup.renderOnce();
        let frame = setup.captureCharFrame();
        expect(frame).toContain("✓ #41 First task");
        expect(frame).toContain("▌ ✓ #42 Second task");
        expect(frame).toContain("○ #43 Third task");
        expect(frame).toContain("beta work");
        expect(frame).not.toContain("alpha work");

        setup.mockInput.pressArrow("left", { ctrl: true });
        await setup.renderOnce();
        frame = setup.captureCharFrame();
        expect(frame).toContain("▌ ✓ #41");
        expect(frame).toContain("alpha work");
        expect(frame).not.toContain("beta work");

        // The hidden transcript keeps recording while the view is pinned.
        coordinator.piListener(
            {
                type: "message_update",
                assistantMessageEvent: {
                    type: "text_delta",
                    contentIndex: 0,
                    delta: " extended",
                },
            },
            context,
        );
        setup.mockInput.pressKey("]");
        await setup.renderOnce();
        frame = setup.captureCharFrame();
        expect(frame).toContain("beta work extended");

        await coordinator.dispose();
    });

    test("follows the active issue until the user navigates away", async () => {
        const setup = await createTestRenderer({ width: 80, height: 16 });
        const coordinator = makeProgressCoordinator({
            mode: "interactive",
            colors: false,
            runId: "tui-run-follow",
            now: FIXED_NOW,
            createRenderer: async () => setup.renderer,
        });

        await coordinator.progress.emit({
            stage: "issue-queue",
            status: "info",
            message: "Issue queue ready with 3 issues.",
            details: {
                issues: [
                    { number: 51, title: "First task" },
                    { number: 52, title: "Second task" },
                    { number: 53, title: "Third task" },
                ],
            },
        });

        const execute = async (
            number: number,
            title: string,
            text: string,
            complete: boolean,
        ): Promise<void> => {
            await coordinator.progress.emit({
                stage: "issue-execution",
                status: "started",
                message: `Executing #${number}...`,
                issue: { number, title },
            });
            coordinator.piListener({ type: "agent_start" }, context);
            coordinator.piListener(
                {
                    type: "message_update",
                    assistantMessageEvent: {
                        type: "text_delta",
                        contentIndex: 0,
                        delta: text,
                    },
                },
                context,
            );
            if (!complete) return;
            await coordinator.progress.emit({
                stage: "issue-execution",
                status: "succeeded",
                message: `Issue #${number} completed.`,
                issue: { number, title },
            });
        };

        await execute(51, "First task", "first work", true);
        await execute(52, "Second task", "second work", true);

        await coordinator.ready;
        await setup.renderOnce();
        let frame = setup.captureCharFrame();
        expect(frame).toContain("▌ ✓ #52 Second task");
        expect(frame).toContain("second work");

        setup.mockInput.pressKey("[");
        await setup.renderOnce();
        frame = setup.captureCharFrame();
        expect(frame).toContain("first work");

        // A new active issue must not steal the view while browsing.
        await execute(53, "Third task", "third work", false);
        await setup.renderOnce();
        frame = setup.captureCharFrame();
        expect(frame).toContain("first work");
        expect(frame).not.toContain("third work");

        // Selecting the active issue re-engages the follow.
        setup.mockInput.pressKey("]");
        setup.mockInput.pressKey("]");
        await setup.renderOnce();
        frame = setup.captureCharFrame();
        expect(frame).toContain("▌ ▶ #53 Third task");
        expect(frame).toContain("third work");

        await coordinator.progress.emit({
            stage: "issue-queue",
            status: "info",
            message: "Issue queue refreshed; added 1 new issues.",
            details: {
                added: 1,
                issues: [
                    { number: 51, title: "First task" },
                    { number: 52, title: "Second task" },
                    { number: 53, title: "Third task" },
                    { number: 54, title: "Fourth task" },
                ],
            },
        });
        await execute(54, "Fourth task", "fourth work", false);
        await setup.renderOnce();
        frame = setup.captureCharFrame();
        expect(frame).toContain("▌ ▶ #54 Fourth task");
        expect(frame).toContain("fourth work");

        await coordinator.dispose();
    });

    test("scrolls the sidebar to keep the selected issue visible", async () => {
        const setup = await createTestRenderer({ width: 80, height: 10 });
        const coordinator = makeProgressCoordinator({
            mode: "interactive",
            colors: false,
            runId: "tui-run-scroll",
            now: FIXED_NOW,
            createRenderer: async () => setup.renderer,
        });

        const issues = Array.from({ length: 30 }, (_, index) => ({
            number: 100 + index,
            title: `Task ${index}`,
        }));
        await coordinator.progress.emit({
            stage: "issue-queue",
            status: "info",
            message: "Issue queue ready with 30 issues.",
            details: { issues },
        });

        await coordinator.ready;
        await setup.renderOnce();
        let frame = setup.captureCharFrame();
        expect(frame).toContain("#100");
        expect(frame).not.toContain("#129");

        // Run plus 30 issues: 30 steps forward reaches the last issue.
        for (let index = 0; index < 30; index += 1) {
            setup.mockInput.pressKey("]");
        }
        await setup.renderOnce();
        frame = setup.captureCharFrame();
        expect(frame).toContain("▌ ○ #129 Task 29");
        expect(frame).not.toContain("#100");

        await coordinator.dispose();
    });

    test("pauses, stops, and quits from the keyboard", async () => {
        const setup = await createTestRenderer({ width: 120, height: 16 });
        let quitCalls = 0;
        const coordinator = makeProgressCoordinator({
            mode: "interactive",
            colors: false,
            runId: "tui-run-control",
            now: FIXED_NOW,
            createRenderer: async () => setup.renderer,
            quit: () => {
                quitCalls += 1;
            },
        });
        const control = coordinator.control;
        expect(control).toBeDefined();
        if (control === undefined) return;

        await coordinator.progress.emit({
            stage: "issue-queue",
            status: "info",
            message: "Issue queue ready with 2 issues.",
            details: {
                issues: [
                    { number: 61, title: "First task" },
                    { number: 62, title: "Second task" },
                ],
            },
        });
        await coordinator.progress.emit({
            stage: "issue-execution",
            status: "started",
            message: "Executing #61...",
            issue: { number: 61, title: "First task" },
        });
        await coordinator.ready;
        await setup.renderOnce();

        setup.mockInput.pressKey("p");
        await setup.renderOnce();
        let frame = setup.captureCharFrame();
        expect(frame).toContain("pausing after this issue");
        expect(frame).toContain("p pause · s stop · q quit");

        let released = false;
        const pauseWaiter = control.waitForQueue().then(() => {
            released = true;
        });
        await Promise.resolve();
        expect(released).toBe(false);

        setup.mockInput.pressKey("p");
        await pauseWaiter;
        expect(released).toBe(true);

        // Once the active issue finishes, the pause is unconditional.
        await coordinator.progress.emit({
            stage: "issue-execution",
            status: "succeeded",
            message: "Issue #61 completed.",
            issue: { number: 61, title: "First task" },
        });
        setup.mockInput.pressKey("p");
        await setup.renderOnce();
        frame = setup.captureCharFrame();
        expect(frame).toContain("paused");

        // Stopping releases a pause so the workflow can observe the stop.
        let stopReleased = false;
        const stopWaiter = control.waitForQueue().then(() => {
            stopReleased = true;
        });
        setup.mockInput.pressKey("s");
        await stopWaiter;
        expect(stopReleased).toBe(true);
        expect(control.stopAfterCurrent()).toBe(true);
        await setup.renderOnce();
        frame = setup.captureCharFrame();
        expect(frame).toContain("stopping after this issue");
        expect(frame).not.toContain("paused");

        setup.mockInput.pressKey("q");
        expect(quitCalls).toBe(1);

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