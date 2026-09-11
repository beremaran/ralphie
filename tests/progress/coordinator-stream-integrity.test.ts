import { describe, expect, test } from "bun:test";

import type {
    AgentEventContext,
    AgentSessionEvent,
} from "../../src/agent/contracts.ts";
import { breadcrumbCandidateFor } from "../../src/progress/breadcrumb-label.ts";
import { makeProgressCoordinator } from "../../src/progress/coordinator.ts";
import type {
    TerminalOutputController,
    TerminalOutputStrategy,
    TerminalResizeSubscription,
} from "../../src/progress/terminal-controller.ts";
import { stripTerminalControls } from "../../src/shared/terminal.ts";

const context: AgentEventContext = {
    sessionID: "stream-session",
    directory: "/workspace/owner/repository",
    title: "Coordinator integrity",
};

const asEvent = (value: unknown): AgentSessionEvent =>
    value as AgentSessionEvent;

const messageUpdate = (assistantMessageEvent: unknown): AgentSessionEvent =>
    asEvent({ type: "message_update", assistantMessageEvent });

const textStart = (): AgentSessionEvent =>
    messageUpdate({ type: "text_start", contentIndex: 0 });

const textDelta = (delta: string): AgentSessionEvent =>
    messageUpdate({ type: "text_delta", contentIndex: 0, delta });

const textEnd = (): AgentSessionEvent =>
    messageUpdate({ type: "text_end", contentIndex: 0 });

const toolStart = (id: string): AgentSessionEvent =>
    asEvent({
        type: "tool_execution_start",
        toolCallId: id,
        toolName: "integrity-tool",
        args: { command: `echo ${id}` },
    });

const toolUpdate = (id: string): AgentSessionEvent =>
    asEvent({
        type: "tool_execution_update",
        toolCallId: id,
        toolName: "integrity-tool",
        partialResult: { content: `intermediate-${id}` },
    });

const toolEnd = (id: string): AgentSessionEvent =>
    asEvent({
        type: "tool_execution_end",
        toolCallId: id,
        toolName: "integrity-tool",
        result: { content: `tool-result-${id}` },
        isError: false,
    });

type RecordingOperation =
    | { readonly kind: "write"; readonly text: string }
    | { readonly kind: "paint"; readonly text: string }
    | { readonly kind: "clear" }
    | { readonly kind: "restore" };

const makeRecordingStrategy = () => {
    const operations: RecordingOperation[] = [];
    let region: string[] = [];
    const strategy: TerminalOutputStrategy & {
        readonly operations: () => readonly RecordingOperation[];
        readonly currentRegion: () => readonly string[];
        readonly durableBytes: () => string;
        readonly restoreCount: () => number;
    } = {
        write: (text) => operations.push({ kind: "write", text }),
        paintFooter: (text) => {
            operations.push({ kind: "paint", text });
            region.push(text);
        },
        clearFooter: () => {
            operations.push({ kind: "clear" });
            region = region.slice(0, -1);
        },
        restore: () => operations.push({ kind: "restore" }),
        operations: () => operations,
        currentRegion: () => region,
        durableBytes: () =>
            stripTerminalControls(
                operations
                    .filter(
                        (
                            operation,
                        ): operation is Extract<
                            RecordingOperation,
                            { readonly kind: "write" }
                        > => operation.kind === "write",
                    )
                    .map((operation) => operation.text)
                    .join(""),
            ),
        restoreCount: () =>
            operations.filter((operation) => operation.kind === "restore")
                .length,
    };
    return strategy;
};

const makeResizeSource = () => {
    const listeners: Array<() => void> = [];
    const resize: TerminalResizeSubscription & {
        readonly emit: () => void;
        readonly listenerCount: () => number;
    } = {
        subscribe: (listener) => {
            listeners.push(listener);
            return () => {
                const index = listeners.indexOf(listener);
                if (index >= 0) listeners.splice(index, 1);
            };
        },
        emit: () => {
            for (const listener of [...listeners]) listener();
        },
        listenerCount: () => listeners.length,
    };
    return resize;
};

const countOf = (text: string, value: string): number => {
    let count = 0;
    let offset = 0;
    while (true) {
        const index = text.indexOf(value, offset);
        if (index < 0) return count;
        count += 1;
        offset = index + value.length;
    }
};

const ordered = (text: string, values: readonly string[]): void => {
    let previous = -1;
    for (const value of values) {
        const index = text.indexOf(value, previous + 1);
        expect(
            index,
            `missing or out-of-order marker ${value}`,
        ).toBeGreaterThan(previous);
        previous = index;
        expect(countOf(text, value), `duplicate marker ${value}`).toBe(1);
    }
};

const makeHarness = (initialWidth = 80) => {
    let width = initialWidth;
    const strategy = makeRecordingStrategy();
    const resize = makeResizeSource();
    let controller: TerminalOutputController | undefined;
    const coordinator = makeProgressCoordinator({
        mode: "interactive",
        colors: false,
        width: () => width,
        footer: { width: () => width, intervalMs: 5 },
        strategy,
        resize,
        now: () => new Date("2026-09-09T00:00:00.000Z"),
        runId: "coordinator-run",
        onController: (value) => {
            controller = value;
        },
    });
    return {
        coordinator,
        strategy,
        resize,
        controller: () => controller,
        setWidth: (next: number) => {
            width = next;
        },
    };
};

describe("coordinator transcript and stream integrity", () => {
    test("reassembles long assistant output once and records the exact truncation", async () => {
        const { coordinator, strategy } = makeHarness(32);
        const longText = "long-output-marker ".repeat(24);

        coordinator.piListener(asEvent({ type: "agent_start" }), context);
        coordinator.piListener(textStart(), context);
        for (let index = 0; index < longText.length; index += 7) {
            coordinator.piListener(
                textDelta(longText.slice(index, index + 7)),
                context,
            );
        }
        coordinator.piListener(textEnd(), context);

        const output = strategy.durableBytes();
        expect(output).toContain(longText.slice(0, 140));
        expect(output).not.toContain(longText);
        expect(output).toContain(`${longText.length} chars · truncated`);
        expect(countOf(output, "long-output-marker")).toBe(
            Math.floor(140 / "long-output-marker ".length),
        );
        await coordinator.dispose();
    });

    test("keeps interleaved assistant, tool, and progress markers in emit order", async () => {
        const { coordinator, strategy } = makeHarness();
        coordinator.piListener(asEvent({ type: "agent_start" }), context);
        coordinator.piListener(textStart(), context);
        coordinator.piListener(textDelta("assistant-A "), context);
        coordinator.piListener(toolStart("tool-A"), context);
        coordinator.piListener(textDelta("assistant-B "), context);
        coordinator.piListener(toolUpdate("tool-A"), context);
        await coordinator.progress.emit({
            stage: "implementation",
            status: "info",
            message: "progress-A",
        });
        coordinator.piListener(textDelta("assistant-C"), context);
        coordinator.piListener(toolEnd("tool-A"), context);
        await coordinator.progress.emit({
            stage: "implementation",
            status: "info",
            message: "progress-B",
        });
        coordinator.piListener(textEnd(), context);

        const output = strategy.durableBytes();
        ordered(output, [
            "assistant-A",
            "tool-A",
            "assistant-B",
            "progress-A",
            "assistant-C",
            "integrity-tool done",
            "progress-B",
        ]);
        expect(output).not.toContain("\x1b");
        expect(output).not.toContain("\r");
        await coordinator.dispose();
    });

    test("keeps completed breadcrumbs contiguous, ordered, and stable through live refreshes", async () => {
        const { coordinator, strategy } = makeHarness();
        coordinator.piListener(asEvent({ type: "agent_start" }), context);

        await coordinator.progress.emit({
            stage: "implementation",
            status: "started",
            message: "breadcrumb-one",
            repository: "repo-one",
            issue: { number: 1, title: "first issue" },
        });
        const first = breadcrumbCandidateFor(coordinator.getDisplayState());
        coordinator.insertBreadcrumb?.(first);

        await coordinator.progress.emit({
            stage: "verification",
            status: "started",
            message: "breadcrumb-two",
            repository: "repo-two",
            issue: { number: 2, title: "second issue" },
        });
        const second = breadcrumbCandidateFor(coordinator.getDisplayState());
        coordinator.insertBreadcrumb?.(second);

        for (let index = 0; index < 6; index += 1) {
            await coordinator.progress.emit({
                stage: "verification",
                status: "info",
                message: `refresh-${index}`,
            });
        }

        const output = strategy.durableBytes();
        const firstIndex = output.indexOf(first.label);
        const secondIndex = output.indexOf(second.label);
        expect(firstIndex).toBeGreaterThanOrEqual(0);
        expect(secondIndex).toBeGreaterThan(firstIndex);
        expect(countOf(output, first.label)).toBe(1);
        expect(countOf(output, second.label)).toBe(1);
        expect(output.slice(firstIndex, firstIndex + first.label.length)).toBe(
            first.label,
        );
        expect(
            output.slice(secondIndex, secondIndex + second.label.length),
        ).toBe(second.label);
        await coordinator.dispose();
    });

    test("defers resize repaint around an open transcript and fits the final region", async () => {
        const harness = makeHarness(48);
        const { coordinator, strategy, resize, controller, setWidth } = harness;
        coordinator.piListener(asEvent({ type: "agent_start" }), context);
        await coordinator.progress.emit({
            stage: "implementation",
            status: "started",
            message: "resize-footer",
        });
        controller()?.flush();

        coordinator.piListener(textStart(), context);
        coordinator.piListener(textDelta("open-transcript-marker"), context);
        const beforeResize = strategy.operations().length;
        setWidth(12);
        resize.emit();
        controller()?.flush();
        expect(strategy.operations().length).toBe(beforeResize);

        coordinator.piListener(textEnd(), context);
        controller()?.flush();
        expect(strategy.currentRegion().length).toBeLessThanOrEqual(3);
        for (const row of strategy.currentRegion()) {
            expect(Bun.stringWidth(row)).toBeLessThanOrEqual(12);
        }
        expect(strategy.durableBytes()).toContain("open-transcript-marker");
        expect(resize.listenerCount()).toBe(1);
        await coordinator.dispose();
        expect(resize.listenerCount()).toBe(0);
        expect(strategy.restoreCount()).toBe(1);
    });
});