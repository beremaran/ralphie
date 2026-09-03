import { describe, expect, test } from "bun:test";

import type {
    AgentEventContext,
    AgentSessionEvent,
} from "../../src/opencode/client.ts";
import { makeProgressCoordinator } from "../../src/progress/coordinator.ts";
import type { FooterTimer } from "../../src/progress/footer.ts";
import { INTERACTIVE_REGION_MAX_ROWS } from "../../src/progress/terminal-controller.ts";
import { makeTerminalOutputController } from "../../src/progress/terminal-controller.ts";
import {
    makeRecordingStrategy,
    PhysicalRowMeter,
    regionBytes,
    type RecordingStrategy,
} from "../shared/physical-row-meter.ts";

const context: AgentEventContext = {
    sessionID: "session-1",
    directory: "/workspace/repository",
    title: "Task",
};

const asEvent = (value: unknown): AgentSessionEvent =>
    value as AgentSessionEvent;

type FakeTimer = FooterTimer & { readonly run: () => void };

const makeFakeTimer = (): FakeTimer => {
    let scheduled: (() => void) | undefined;
    return {
        schedule: (callback) => {
            scheduled = callback;
            return scheduled;
        },
        cancel: () => {
            scheduled = undefined;
        },
        run: () => {
            const callback = scheduled;
            scheduled = undefined;
            callback?.();
        },
    };
};

const makeResizeSource = () => {
    const listeners: Array<() => void> = [];
    return {
        subscribe: (listener: () => void) => {
            listeners.push(listener);
            return () => {
                const index = listeners.indexOf(listener);
                if (index >= 0) listeners.splice(index, 1);
            };
        },
        emit: () => {
            for (const listener of [...listeners]) listener();
        },
    };
};

type Harness = ReturnType<typeof makeHarness>;

/**
 * Interactive coordinator harness with a strategy recorder, fake refresh
 * timer, and fake resize source, mirroring `command.ts` wiring.
 */
const makeHarness = (options: { readonly width?: () => number } = {}) => {
    const strategy = makeRecordingStrategy();
    const timer = makeFakeTimer();
    const resize = makeResizeSource();
    let width = 80;
    const coordinator = makeProgressCoordinator({
        mode: "interactive",
        verbose: false,
        colors: false,
        width: options.width ?? (() => width),
        strategy,
        resize,
        footer: { timer },
        write: () => {},
    });
    return {
        coordinator,
        strategy,
        timer,
        resize,
        width: (value: number) => {
            width = value;
        },
        settle: () => timer.run(),
    };
};

const toolStart = (toolCallId: string, toolName: string, args: unknown) =>
    asEvent({
        type: "tool_execution_start",
        toolCallId,
        toolName,
        args,
    });

const toolUpdate = (toolCallId: string, toolName: string) =>
    asEvent({
        type: "tool_execution_update",
        toolCallId,
        toolName,
        partialResult: { content: "intermediate output chunk" },
    });

const toolEnd = (
    toolCallId: string,
    toolName: string,
    result: unknown,
    isError: boolean,
) =>
    asEvent({
        type: "tool_execution_end",
        toolCallId,
        toolName,
        result,
        isError,
    });

const textDelta = (delta: string) =>
    asEvent({
        type: "message_update",
        assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta,
        },
    });

/** Assert every painted region row fits one physical row at the given width. */
const expectRegionRowsFit = (
    strategy: RecordingStrategy,
    width: number,
): void => {
    const region = strategy.currentRegion();
    for (const row of region) {
        expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width);
    }
    if (region.length === 0) return;
    const meter = new PhysicalRowMeter(width);
    meter.feed(regionBytes(region));
    expect(meter.rows()).toBe(region.length);
};

describe("interactive activity region physical-row regression", () => {
    test("repeated tool calls never exceed three physical rows at any instant", async () => {
        const harness = makeHarness();
        harness.coordinator.listener(asEvent({ type: "agent_start" }), context);
        harness.settle();
        for (let cycle = 0; cycle < 15; cycle += 1) {
            harness.coordinator.listener(
                toolStart(`tool-${cycle}`, "bash", {
                    command: `echo cycle ${cycle}`,
                }),
                context,
            );
            for (let delta = 0; delta < 5; delta += 1) {
                harness.coordinator.listener(
                    toolUpdate(`tool-${cycle}`, "bash"),
                    context,
                );
            }
            harness.coordinator.listener(
                toolEnd(
                    `tool-${cycle}`,
                    "bash",
                    { content: `output ${cycle}` },
                    false,
                ),
                context,
            );
            if (cycle % 3 === 2) {
                await harness.coordinator.progress.emit({
                    stage: "implementation",
                    status: "started",
                    message: "writing change",
                });
                await harness.coordinator.progress.emit({
                    stage: "implementation",
                    status: "succeeded",
                    message: "change written",
                });
            }
            harness.settle();
            expect(harness.strategy.currentRegion().length).toBeLessThanOrEqual(
                INTERACTIVE_REGION_MAX_ROWS,
            );
            expectRegionRowsFit(harness.strategy, 80);
        }
        await harness.coordinator.dispose();
        expect(harness.strategy.peakRegionRows()).toBeLessThanOrEqual(
            INTERACTIVE_REGION_MAX_ROWS,
        );
        // Newline counts alone would overstate the live region: the stream
        // holds many line-feed bytes (durable rows, repaint separators) but
        // the replaceable region stays within its three physical rows.
        expect(harness.strategy.output().split("\n").length).toBeGreaterThan(
            INTERACTIVE_REGION_MAX_ROWS,
        );
        expect(harness.strategy.peakRegionRows()).toBe(
            INTERACTIVE_REGION_MAX_ROWS,
        );
    });

    test("long commands and deep paths stay on one clipped physical row each", async () => {
        const harness = makeHarness({ width: () => 24 });
        const longCommand = `./scripts/verify --config ${"x".repeat(120)}`;
        const deepPath = `/workspace/repository/src/${"d".repeat(80)}/file.ts`;
        harness.coordinator.listener(
            toolStart("bash-1", "bash", { command: longCommand }),
            context,
        );
        harness.coordinator.listener(
            toolStart("read-1", "read", { path: deepPath, offset: 40 }),
            context,
        );
        harness.coordinator.listener(
            toolStart("write-1", "write", {
                path: deepPath,
                content: "a\nb\nc\nd",
            }),
            context,
        );
        harness.settle();

        const region = harness.strategy.currentRegion();
        expect(region.length).toBeLessThanOrEqual(INTERACTIVE_REGION_MAX_ROWS);
        for (const row of region) {
            expect(Bun.stringWidth(row)).toBeLessThanOrEqual(24);
        }
        // The long target text is clipped, never wrapped onto a second row.
        const meter = new PhysicalRowMeter(24);
        meter.feed(regionBytes(region));
        expect(meter.rows()).toBe(region.length);
        expect(meter.row()).toBe(region.length - 1);

        await harness.coordinator.listener(
            toolEnd("bash-1", "bash", { content: "done" }, false),
            context,
        );
        harness.settle();
        expect(harness.strategy.peakRegionRows()).toBeLessThanOrEqual(
            INTERACTIVE_REGION_MAX_ROWS,
        );
        await harness.coordinator.dispose();
    });

    test("narrow terminals and mid-run resize repaint within three rows", async () => {
        const harness = makeHarness();
        harness.coordinator.listener(asEvent({ type: "agent_start" }), context);
        const widths = [12, 26, 6, 40];
        for (const width of widths) {
            harness.width(width);
            harness.resize.emit();
            harness.settle();
            for (let index = 0; index < 3; index += 1) {
                harness.coordinator.listener(
                    toolStart(`resize-${width}-${index}`, "bash", {
                        command: `echo ${"y".repeat(width * 3)}`,
                    }),
                    context,
                );
                harness.coordinator.listener(
                    toolEnd(
                        `resize-${width}-${index}`,
                        "bash",
                        { content: "ok" },
                        false,
                    ),
                    context,
                );
            }
            harness.settle();
            expect(harness.strategy.currentRegion().length).toBeLessThanOrEqual(
                INTERACTIVE_REGION_MAX_ROWS,
            );
            expectRegionRowsFit(harness.strategy, width);
        }
        await harness.coordinator.dispose();
        expect(harness.strategy.peakRegionRows()).toBeLessThanOrEqual(
            INTERACTIVE_REGION_MAX_ROWS,
        );
    });

    test("region bytes never touch interleaved streamed assistant text", async () => {
        const harness = makeHarness();
        const deltas = [
            "The first ",
            "framework ",
            "assembles ",
            "services ",
            "explicitly.",
        ];
        harness.coordinator.listener(asEvent({ type: "agent_start" }), context);
        harness.coordinator.listener(
            asEvent({
                type: "message_update",
                assistantMessageEvent: {
                    type: "text_start",
                    contentIndex: 0,
                },
            }),
            context,
        );
        for (const delta of deltas) {
            harness.coordinator.listener(textDelta(delta), context);
        }
        harness.settle();

        const block = deltas.join("");
        const output = harness.strategy.output();
        expect(output.split(block)).toHaveLength(2);
        const blockStart = output.indexOf(block);
        const blockEnd = blockStart + block.length;
        // The streamed block is one contiguous, untouched byte span: no region
        // erase/up bytes and no injected newline inside it.
        const span = output.slice(blockStart, blockEnd);
        expect(span).toBe(block);
        expect(span).not.toContain("\r");
        expect(span).not.toContain("\x1b");
        expect(span).not.toContain("\n");

        // Tool activity arriving mid-stream never disturbs the block bytes.
        harness.coordinator.listener(
            toolStart("mid-1", "grep", { pattern: "needle" }),
            context,
        );
        harness.coordinator.listener(textDelta(" tail."), context);
        harness.coordinator.listener(
            toolEnd("mid-1", "grep", { content: "match" }, false),
            context,
        );
        harness.settle();
        const after = harness.strategy.output();
        expect(after.split(block)).toHaveLength(2);
        expect(after).toContain(" tail.");
        expect(after.indexOf(" tail.")).toBeGreaterThan(after.indexOf(block));
        // Every delta byte is present in order, exactly once.
        for (const delta of deltas) {
            expect(after.split(delta)).toHaveLength(2);
        }
        await harness.coordinator.dispose();
    });

    test("completion, failure, and cleanup keep the region bounded and durable", async () => {
        const harness = makeHarness();
        harness.coordinator.listener(asEvent({ type: "agent_start" }), context);
        harness.coordinator.listener(
            toolStart("ok-1", "bash", { command: "echo ok" }),
            context,
        );
        harness.coordinator.listener(
            toolEnd("ok-1", "bash", { content: "ok" }, false),
            context,
        );
        harness.coordinator.listener(
            toolStart("fail-1", "grep", { pattern: "needle" }),
            context,
        );
        harness.coordinator.listener(
            toolEnd(
                "fail-1",
                "grep",
                { content: "error: no matches found anywhere at all" },
                true,
            ),
            context,
        );
        harness.settle();
        const output = harness.strategy.output();
        // Concise completion and failure summaries, one bounded line each.
        expect(output.split("✓ bash done")).toHaveLength(2);
        expect(
            output.split("✗ grep failed — error: no matches found anywhere"),
        ).toHaveLength(2);
        expect(harness.strategy.currentRegion().length).toBeLessThanOrEqual(
            INTERACTIVE_REGION_MAX_ROWS,
        );

        await harness.coordinator.dispose();
        // Cleanup flattens the region into scrollback without dropping rows.
        const after = harness.strategy.output();
        expect(after.length).toBeGreaterThan(output.length);
        expect(harness.strategy.peakRegionRows()).toBeLessThanOrEqual(
            INTERACTIVE_REGION_MAX_ROWS,
        );
        expect(harness.strategy.currentRegion().length).toBeLessThanOrEqual(
            INTERACTIVE_REGION_MAX_ROWS,
        );
    });
});

describe("terminal stream boundaries never grow the region", () => {
    const makeBoundaryHarness = () => {
        const strategy = makeRecordingStrategy();
        const timer = makeFakeTimer();
        const resize = makeResizeSource();
        const controller = makeTerminalOutputController({
            mode: "interactive",
            strategy,
            width: () => 80,
            footer: { timer },
            resize,
        });
        return {
            controller,
            strategy,
            timer,
            resize,
            settle: () => timer.run(),
        };
    };

    test("region repaints never cross a split control-sequence boundary", () => {
        const harness = makeBoundaryHarness();
        // A styled transcript fragment split mid-sequence by the stream.
        harness.controller.writeTranscript("plain\x1b[31");
        harness.controller.setFooter("status");
        harness.settle();
        // Nothing paints while the CSI sequence is incomplete.
        expect(harness.strategy.currentRegion()).toEqual([]);
        harness.controller.writeTranscript("mred\x1b[0m\n");
        // After the sequence closes, the region paints within its row cap.
        expect(harness.strategy.currentRegion().length).toBeGreaterThan(0);
        expect(harness.strategy.currentRegion().length).toBeLessThanOrEqual(
            INTERACTIVE_REGION_MAX_ROWS,
        );

        // The same deferral holds across an OSC boundary (title change).
        harness.controller.writeTranscript("\x1b]0;title");
        harness.controller.setFooter("updated");
        harness.settle();
        expect(harness.strategy.currentRegion()).toEqual([]);
        harness.controller.writeTranscript("\x07done\n");
        harness.settle();
        expect(harness.strategy.currentRegion().length).toBeLessThanOrEqual(
            INTERACTIVE_REGION_MAX_ROWS,
        );

        harness.controller.dispose();
        expect(harness.strategy.peakRegionRows()).toBeLessThanOrEqual(
            INTERACTIVE_REGION_MAX_ROWS,
        );
        // No region bytes were ever spliced into the sequences: the stream
        // preserves each fragment exactly as written.
        const bytes = harness.strategy.output();
        expect(bytes).toContain("\x1b[31mred\x1b[0m");
        expect(bytes).toContain("\x1b]0;title\x07done\n");
    });
});