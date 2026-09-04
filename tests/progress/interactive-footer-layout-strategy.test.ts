import { describe, expect, test } from "bun:test";

import type {
    AgentEventContext,
    AgentSessionEvent,
} from "../../src/opencode/client.ts";
import { makeProgressCoordinator } from "../../src/progress/coordinator.ts";
import type { FooterTimer } from "../../src/progress/footer.ts";
import {
    INTERACTIVE_FOOTER_LAYOUT_STRATEGY,
    INTERACTIVE_FOOTER_USES_RESERVED_ROW,
    INTERACTIVE_FOOTER_USES_SCROLL_REGION,
    INTERACTIVE_REGION_MAX_ROWS,
    makeDefaultTerminalOutputStrategy,
    makeDurableBreadcrumbStrategy,
    makeDurableBreadcrumbTerminalOutputStrategy,
    makeInteractiveTerminalOutputStrategy,
    makeTerminalOutputController,
} from "../../src/progress/terminal-controller.ts";
import { stripTerminalControls } from "../../src/shared/terminal.ts";

const CLEAR = "\r\x1b[2K";

const CONTEXT: AgentEventContext = {
    sessionID: "layout-lock-session",
    directory: "/workspace/repository",
    title: "Task",
};

const asEvent = (value: unknown): AgentSessionEvent =>
    value as AgentSessionEvent;

const captureModeOutput = async (
    mode: "plain" | "json" | "quiet",
): Promise<string> => {
    let output = "";
    const coordinator = makeProgressCoordinator({
        mode,
        verbose: false,
        colors: false,
        width: () => 80,
        write: (text) => {
            output += text;
        },
    });
    coordinator.piListener(asEvent({ type: "agent_start" }), CONTEXT);
    coordinator.piListener(textStart(0), CONTEXT);
    coordinator.piListener(textDelta(0, "hello world"), CONTEXT);
    coordinator.piListener(textEnd(0), CONTEXT);
    await coordinator.progress.emit({
        stage: "implementation",
        status: "succeeded",
        message: "done now",
    });
    await coordinator.progress.emit({
        stage: "verification",
        status: "failed",
        message: "boom",
    });
    await coordinator.dispose();
    return output;
};

const expectModeClean = (
    mode: "plain" | "json" | "quiet",
    output: string,
): void => {
    expect(output).not.toContain("\x1b");
    expect(output).not.toContain("\r");
    if (mode === "json") {
        expect(output).not.toContain("╭─");
        for (const line of output.trim().split("\n")) {
            expect(() => JSON.parse(line)).not.toThrow();
        }
        return;
    }
    if (mode === "quiet") {
        expect(output).not.toContain("hello world");
        expect(output).not.toContain("done now");
        expect(output).toContain("boom");
        return;
    }
    expect(output).toContain("hello world");
    expect(output).toContain("done now");
};

const textStart = (contentIndex: number) =>
    asEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_start", contentIndex },
    });

const textDelta = (contentIndex: number, delta: string) =>
    asEvent({
        type: "message_update",
        assistantMessageEvent: {
            type: "text_delta",
            contentIndex,
            delta,
        },
    });

const textEnd = (contentIndex: number) =>
    asEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_end", contentIndex },
    });

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

type RecordingStrategy = {
    readonly strategy: {
        readonly write: (text: string) => void;
        readonly paintFooter: (text: string) => void;
        readonly clearFooter: () => void;
        readonly restore: () => void;
    };
    readonly raw: () => string;
    readonly writes: () => string;
    readonly paints: () => readonly string[];
    readonly clearCount: () => number;
    readonly restoreCount: () => number;
    readonly finalRegion: () => readonly string[];
};

const makeRecordingStrategy = (): RecordingStrategy => {
    let raw = "";
    let writes = "";
    const paints: string[] = [];
    let clears = 0;
    let restores = 0;
    let lastClearIndex = -1;
    return {
        strategy: {
            write: (text) => {
                raw += text;
                writes += text;
            },
            paintFooter: (text) => {
                raw += text;
                paints.push(text);
            },
            clearFooter: () => {
                raw += CLEAR;
                clears += 1;
                lastClearIndex = paints.length - 1;
            },
            restore: () => {
                restores += 1;
            },
        },
        raw: () => raw,
        writes: () => writes,
        paints: () => [...paints],
        clearCount: () => clears,
        restoreCount: () => restores,
        finalRegion: () => paints.slice(lastClearIndex + 1),
    };
};

/**
 * Lock: the inline durable layout never emits reserved-row or scroll-region
 * sequences. Only in-place erase (`\r\x1b[2K`) and step-up (`\x1b[1A`) plus
 * SGR color (`\x1b[...m`, unused with colors:false) may appear. Any DECSTBM
 * (`...r`), CUP (`H`/`f`), scroll (`S`/`T`), save/restore cursor, or
 * alternate-screen sequence fails this assertion and proves an untested
 * terminal path became observable.
 */
const assertNoScrollRegionOrReservedRowBytes = (raw: string): void => {
    const sequences = raw.match(/\x1b\[[0-9;?]*[ -/]*[@-~]/g) ?? [];
    for (const sequence of sequences) {
        const final = sequence.at(-1) as string;
        expect(
            ["K", "A", "m"].includes(final),
            `forbidden terminal sequence ${JSON.stringify(sequence)}: reserved-row/scroll-region path is disabled`,
        ).toBe(true);
    }
    expect(raw.match(/\x1b\[[0-9;]*r/)).toBeNull();
    expect(raw.match(/\x1b\[[0-9;]*[Hf]/)).toBeNull();
    for (const forbidden of [
        "\x1b7",
        "\x1b8",
        "\x1bM",
        "\x1bc",
        "[?25",
        "[?1049",
    ]) {
        expect(
            raw.includes(forbidden),
            `raw bytes contain reserved-row/scroll-region marker ${JSON.stringify(forbidden)}`,
        ).toBe(false);
    }
};

const assertEphemeralNotLeaked = (
    paints: readonly string[],
    writes: string,
): void => {
    const cleanWrites = stripTerminalControls(writes);
    for (const paint of paints) {
        const cleanPaint = stripTerminalControls(paint).trim();
        if (cleanPaint === "") continue;
        expect(cleanWrites).not.toContain(cleanPaint);
    }
    expect(cleanWrites).not.toContain("◐");
    expect(cleanWrites).not.toContain("›");
};

describe("interactive footer layout strategy lock (issue #313)", () => {
    test("locks durable-transcript-breadcrumbs as the interactive default", () => {
        expect(INTERACTIVE_FOOTER_LAYOUT_STRATEGY).toBe(
            "durable-transcript-breadcrumbs",
        );
        expect(INTERACTIVE_FOOTER_USES_SCROLL_REGION).toBe(false);
        expect(INTERACTIVE_FOOTER_USES_RESERVED_ROW).toBe(false);
        expect(INTERACTIVE_REGION_MAX_ROWS).toBe(3);
        // All three factory names resolve to the same locked implementation so
        // a future reserved-row/scroll-region strategy cannot silently become
        // the default without updating this lock.
        expect(makeDurableBreadcrumbStrategy).toBe(
            makeDefaultTerminalOutputStrategy,
        );
        expect(makeDurableBreadcrumbTerminalOutputStrategy).toBe(
            makeDefaultTerminalOutputStrategy,
        );
        expect(makeInteractiveTerminalOutputStrategy).toBe(
            makeDurableBreadcrumbTerminalOutputStrategy,
        );
    });

    test("the controller default strategy is the locked durable strategy", () => {
        const timer = makeFakeTimer();
        const resize = makeResizeSource();
        let implicit = "";
        const implicitController = makeTerminalOutputController({
            mode: "interactive",
            write: (text) => {
                implicit += text;
            },
            footer: { timer },
            resize,
        });
        const recording = makeRecordingStrategy();
        const explicitTimer = makeFakeTimer();
        const explicitResize = makeResizeSource();
        const explicitController = makeTerminalOutputController({
            mode: "interactive",
            strategy: recording.strategy,
            footer: { timer: explicitTimer },
            resize: explicitResize,
            width: () => 80,
        });
        try {
            implicitController.setFooter("locked default");
            timer.run();
            explicitController.setFooter("locked default");
            explicitTimer.run();
            // Both surfaces paint the same footer row through the durable
            // path; the implicit default never takes an untested branch.
            expect(implicit).toBe("locked default");
            expect(recording.paints()).toEqual(["locked default"]);
            assertNoScrollRegionOrReservedRowBytes(implicit);
            assertNoScrollRegionOrReservedRowBytes(recording.raw());
        } finally {
            implicitController.dispose();
            explicitController.dispose();
        }
    });

    test("high-rate writes, narrow/dynamic resize, and split ANSI stay scroll-region-free without leaking footer bytes", async () => {
        const timer = makeFakeTimer();
        const resize = makeResizeSource();
        let currentWidth = 80;
        const recording = makeRecordingStrategy();
        let fallback = "";
        const coordinator = makeProgressCoordinator({
            mode: "interactive",
            verbose: false,
            colors: false,
            width: () => currentWidth,
            strategy: recording.strategy,
            resize,
            footer: { timer },
            write: (text) => {
                fallback += text;
            },
        });
        try {
            await coordinator.progress.emit({
                stage: "implementation",
                status: "started",
                message: "locking the layout",
            });
            coordinator.piListener(asEvent({ type: "agent_start" }), CONTEXT);
            coordinator.piListener(textStart(0), CONTEXT);
            for (let index = 0; index < 120; index += 1) {
                coordinator.piListener(
                    textDelta(0, `w${String(index).padStart(3, "0")}|`),
                    CONTEXT,
                );
                if (index === 40) {
                    currentWidth = 16;
                    resize.emit();
                    timer.run();
                }
                if (index === 80) {
                    currentWidth = 80;
                    resize.emit();
                    timer.run();
                }
            }
            coordinator.piListener(textEnd(0), CONTEXT);
            timer.run();
            await coordinator.progress.emit({
                stage: "implementation",
                status: "succeeded",
                message: "layout locked",
            });
            timer.run();

            // Coordinator routing stays intact: every byte flows through the
            // strategy surface, never the fallback sink.
            expect(fallback).toBe("");
            expect(recording.paints().length).toBeGreaterThan(0);
            expect(recording.clearCount()).toBeGreaterThan(0);
            assertNoScrollRegionOrReservedRowBytes(recording.raw());
            assertEphemeralNotLeaked(recording.paints(), recording.writes());
            for (const row of recording.paints()) {
                expect(
                    Bun.stringWidth(stripTerminalControls(row)),
                ).toBeLessThanOrEqual(80);
            }

            // Direct split-sequence proof on the same locked strategy: an
            // incomplete CSI defers the footer without scroll-region bytes.
            const splitTimer = makeFakeTimer();
            const splitResize = makeResizeSource();
            const splitRecording = makeRecordingStrategy();
            const splitController = makeTerminalOutputController({
                mode: "interactive",
                strategy: splitRecording.strategy,
                width: () => 40,
                footer: {
                    footerLine: () => "SPLIT_LOCK",
                    timer: splitTimer,
                },
                resize: splitResize,
            });
            try {
                splitController.writeTranscript("\x1b[31");
                splitController.invalidate();
                splitTimer.run();
                expect(splitRecording.raw()).toBe("\x1b[31");
                splitController.writeTranscript("mred\x1b[0m\n");
                expect(splitRecording.raw()).toBe(
                    "\x1b[31mred\x1b[0m\nSPLIT_LOCK",
                );
                assertNoScrollRegionOrReservedRowBytes(splitRecording.raw());
            } finally {
                splitController.dispose();
            }
        } finally {
            await coordinator.dispose();
        }
        // Disposal clears stale status and restores terminal state: the live
        // region is erased, the stream settles on a fresh line, and no footer
        // row survives.
        expect(recording.finalRegion()).toEqual([]);
        expect(recording.raw().endsWith("\n")).toBe(true);
        assertNoScrollRegionOrReservedRowBytes(recording.raw());
        assertEphemeralNotLeaked(recording.paints(), recording.writes());
        expect(recording.restoreCount()).toBe(1);
        const settled = recording.raw();
        resize.emit();
        timer.run();
        expect(recording.raw()).toBe(settled);
    });

    test("completion and failure dispose paths clear stale status and restore terminal state", async () => {
        for (const ending of ["completion", "failure"] as const) {
            const timer = makeFakeTimer();
            const resize = makeResizeSource();
            const recording = makeRecordingStrategy();
            const coordinator = makeProgressCoordinator({
                mode: "interactive",
                verbose: false,
                colors: false,
                width: () => 80,
                strategy: recording.strategy,
                resize,
                footer: { timer },
                write: () => {},
            });
            try {
                await coordinator.progress.emit({
                    stage: "grounding",
                    status: "started",
                    message: "grounding run",
                });
                coordinator.piListener(
                    asEvent({ type: "agent_start" }),
                    CONTEXT,
                );
                coordinator.piListener(textStart(0), CONTEXT);
                coordinator.piListener(textDelta(0, "partial-"), CONTEXT);
                coordinator.piListener(textDelta(0, "fragment"), CONTEXT);
                coordinator.piListener(textDelta(0, " closed\n"), CONTEXT);
                coordinator.piListener(textEnd(0), CONTEXT);
                timer.run();
                expect(recording.paints().length).toBeGreaterThan(0);
                if (ending === "completion") {
                    await coordinator.progress.emit({
                        stage: "verification",
                        status: "succeeded",
                        message: "verification passed",
                    });
                } else {
                    await coordinator.progress.emit({
                        stage: "verification",
                        status: "failed",
                        message: "verification failed",
                    });
                }
                timer.run();
            } finally {
                await coordinator.dispose();
            }
            expect(recording.finalRegion()).toEqual([]);
            expect(recording.raw().endsWith("\n")).toBe(true);
            assertNoScrollRegionOrReservedRowBytes(recording.raw());
            assertEphemeralNotLeaked(recording.paints(), recording.writes());
            expect(recording.restoreCount()).toBe(1);
            // Repeated cleanup is idempotent: resize and a second dispose
            // write no further bytes.
            const settled = recording.raw();
            resize.emit();
            timer.run();
            expect(recording.raw()).toBe(settled);
            await coordinator.dispose();
            expect(recording.raw()).toBe(settled);
        }
    });

    test("plain, JSON, and quiet modes stay cursor-free with coordinator routing intact", async () => {
        for (const mode of ["plain", "json", "quiet"] as const) {
            expectModeClean(mode, await captureModeOutput(mode));
        }
    });
});