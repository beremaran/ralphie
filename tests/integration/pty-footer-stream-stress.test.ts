import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
    AgentEventContext,
    AgentSessionEvent,
} from "../../src/agent/contracts.ts";
import { stripTerminalControls } from "../../src/shared/terminal.ts";
import { makeProgressCoordinator } from "../../src/progress/coordinator.ts";
import {
    INTERACTIVE_REGION_MAX_ROWS,
    makeTerminalOutputController,
} from "../../src/progress/terminal-controller.ts";
import {
    ACTIVE_MARKER,
    DONE_MARKER,
    EVENT_LOG_NAME,
    FOOTER_MARKER,
    LONG_FAILURE_MESSAGE,
    RESIZE_MARKER_PREFIX,
    SCENARIO_DONE_MARKER,
    STREAM_FINALIZED_MARKER,
} from "./pty-driver-child.ts";
import { isProcessAlive, launchPtyCommand, PtyScreen } from "./pty-driver.ts";

const CLEAR = "\r\x1b[2K";

/** Environment for the real-PTY child: a clean TTY context, never CI. */
const childEnv = (): Record<string, string> => {
    const env: Record<string, string> = { TERM: "xterm-256color" };
    for (const [key, value] of Object.entries(process.env)) {
        if (value === undefined) continue;
        if (
            key === "CI" ||
            key === "GITHUB_ACTIONS" ||
            key.startsWith("GITHUB_")
        ) {
            continue;
        }
        env[key] = value;
    }
    return env;
};

const CONTEXT: AgentEventContext = {
    sessionID: "pty-stress-session",
    directory: "/workspace/repository",
    title: "Task",
};

const SEEDED = {
    repository: "acme/widgets",
    issueNumber: 195,
    issueTitle: "PTY scenario issue",
    issueCurrent: 2,
    issueTotal: 5,
    attempt: 2,
    maxAttempts: 4,
} as const;

const asEvent = (value: unknown): AgentSessionEvent =>
    value as AgentSessionEvent;

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

const thinkingDelta = (contentIndex: number, delta: string) =>
    asEvent({
        type: "message_update",
        assistantMessageEvent: {
            type: "thinking_delta",
            contentIndex,
            delta,
        },
    });

type ResizeHarness = {
    readonly emit: () => void;
    readonly subscription: {
        readonly subscribe: (listener: () => void) => () => void;
    };
};

const makeResizeHarness = (): ResizeHarness & {
    readonly count: () => number;
} => {
    const listeners: Array<() => void> = [];
    return {
        emit: () => {
            for (const listener of [...listeners]) listener();
        },
        subscription: {
            subscribe: (listener: () => void) => {
                listeners.push(listener);
                return () => {
                    const index = listeners.indexOf(listener);
                    if (index >= 0) listeners.splice(index, 1);
                };
            },
        },
        count: () => listeners.length,
    };
};

type StrategyEvent =
    | { readonly kind: "write"; readonly text: string }
    | { readonly kind: "paint"; readonly text: string; readonly width: number }
    | { readonly kind: "clear" };

type RecordingStrategy = {
    readonly strategy: {
        readonly write: (text: string) => void;
        readonly paintFooter: (text: string) => void;
        readonly clearFooter: () => void;
        readonly restore: () => void;
    };
    /** Every byte in emission order (writes + paints + clears). */
    readonly raw: () => string;
    /** Only `write` bytes (durable content + region mechanics). */
    readonly writes: () => string;
    /** Only `paintFooter` rows (ephemeral region content). */
    readonly paints: () => readonly string[];
    readonly paintCount: () => number;
    readonly clearCount: () => number;
    /** Rows painted in the final region repaint (the current visible region). */
    readonly finalRegion: () => readonly string[];
    /** Ordered strategy events: durable writes vs ephemeral paints/clears. */
    readonly events: () => readonly StrategyEvent[];
    /** Terminal width sampled at each paint (parallel to `paints()`). */
    readonly paintWidths: () => readonly number[];
};

/**
 * Strategy seam that distinguishes durable content writes from ephemeral
 * footer paints while preserving the exact emission order in `raw()`.
 * Optionally mirrors every byte into a `PtyScreen` oracle. The optional
 * `width` sampler records the terminal width active at each paint so tests
 * can prove rows were clipped to the width of their own repaint, not just
 * the final width after later resizes.
 */
const makeRecordingStrategy = (
    oracle?: PtyScreen,
    width?: () => number,
): RecordingStrategy => {
    let raw = "";
    let writes = "";
    const paints: string[] = [];
    const paintWidths: number[] = [];
    const events: StrategyEvent[] = [];
    let clears = 0;
    let lastClearIndex = -1;
    return {
        strategy: {
            write: (text) => {
                raw += text;
                writes += text;
                events.push({ kind: "write", text });
                oracle?.feed(text);
            },
            paintFooter: (text) => {
                raw += text;
                paints.push(text);
                const sampled = width?.() ?? Number.NaN;
                paintWidths.push(sampled);
                events.push({ kind: "paint", text, width: sampled });
                oracle?.feed(text);
            },
            clearFooter: () => {
                raw += CLEAR;
                clears += 1;
                lastClearIndex = paints.length - 1;
                events.push({ kind: "clear" });
                oracle?.feed(CLEAR);
            },
            restore: () => {},
        },
        raw: () => raw,
        writes: () => writes,
        paints: () => [...paints],
        paintCount: () => paints.length,
        clearCount: () => clears,
        finalRegion: () => paints.slice(lastClearIndex + 1),
        events: () => [...events],
        paintWidths: () => [...paintWidths],
    };
};

const seededProgressUpdate = (
    stage: "run" | "grounding" | "implementation",
    status: "info" | "started" | "succeeded",
) => ({
    stage,
    status,
    message: `${stage} ${status} marker`,
    repository: SEEDED.repository,
    issue: { number: SEEDED.issueNumber, title: SEEDED.issueTitle },
    current: SEEDED.issueCurrent,
    total: SEEDED.issueTotal,
    attempt: SEEDED.attempt,
    maxAttempts: SEEDED.maxAttempts,
});

const assertOrderedOnce = (
    haystack: string,
    tokens: readonly string[],
): void => {
    let cursor = -1;
    for (const token of tokens) {
        const at = haystack.indexOf(token, cursor + 1);
        expect(
            at,
            `delta ${token} missing, duplicated, or reordered`,
        ).toBeGreaterThan(cursor);
        expect(haystack.indexOf(token)).toBe(haystack.lastIndexOf(token));
        cursor = at;
    }
};

const emitOrderedTextBurst = (
    coordinator: ReturnType<typeof makeProgressCoordinator>,
    messageCount: number,
    deltasPerMessage: number,
): string[] => {
    const tokens: string[] = [];
    let global = 0;
    for (let message = 0; message < messageCount; message += 1) {
        coordinator.piListener(textStart(message), CONTEXT);
        for (let index = 0; index < deltasPerMessage; index += 1) {
            const token = `t${String(global).padStart(4, "0")}|`;
            tokens.push(token);
            coordinator.piListener(textDelta(message, token), CONTEXT);
            // Interleave thinking deltas: they ride the same
            // incremental-stream path, update the Thinking activity,
            // and must never break the open transcript line.
            if (global % 50 === 0) {
                coordinator.piListener(
                    thinkingDelta(0, `think${global}|`),
                    CONTEXT,
                );
            }
            global += 1;
        }
        coordinator.piListener(textEnd(message), CONTEXT);
    }
    return tokens;
};

const emitDurableBurst = (
    coordinator: ReturnType<typeof makeProgressCoordinator>,
    messageCount: number,
    deltasPerMessage: number,
): void => {
    for (let message = 0; message < messageCount; message += 1) {
        coordinator.piListener(textStart(message), CONTEXT);
        for (let index = 0; index < deltasPerMessage; index += 1) {
            const global = message * deltasPerMessage + index;
            coordinator.piListener(
                textDelta(
                    message,
                    `durable-${String(global).padStart(3, "0")}|`,
                ),
                CONTEXT,
            );
            if (global % 30 === 0) {
                coordinator.piListener(
                    thinkingDelta(0, `ephemeral-think-${global}|`),
                    CONTEXT,
                );
            }
        }
        coordinator.piListener(textEnd(message), CONTEXT);
    }
};

const assertNoEphemeralRows = (rows: readonly string[]): void => {
    for (const row of rows) {
        // Footer-only chrome in this suite: the live status indicator, the
        // stage/activity separator, the footer-form review token (durable
        // progress uses "(2/4)", never "Review 2/4"), and the thinking deltas
        // that must never enter the transcript. Started progress stays
        // live-only in interactive mode, so no durable row carries these.
        expect(row).not.toContain("◐");
        expect(row).not.toContain("›");
        expect(row).not.toContain("Review 2/4");
        expect(row).not.toContain("ephemeral-think-");
    }
};

const assertPaintsNotLeaked = (
    paints: readonly string[],
    rows: readonly string[],
    writes: string,
): void => {
    const cleanWrites = stripTerminalControls(writes);
    for (const paint of paints) {
        const cleanPaint = stripTerminalControls(paint).trim();
        if (cleanPaint === "") continue;
        // Footer-only chrome must never reach the durable channel: the
        // ephemeral surface is paintFooter-only, never strategy.write.
        expect(cleanWrites).not.toContain(cleanPaint);
        // No paint may survive as (a substring of) a transcript/scrollback
        // row unless that same substring is also present in the durable
        // writes, proving it arrived durably rather than via a leak. Exact
        // row equality alone would miss a footer leak embedded inside a
        // longer scrollback row.
        for (const row of rows) {
            if (row === "" || !row.includes(cleanPaint)) continue;
            expect(
                cleanWrites.includes(cleanPaint),
                `ephemeral paint leaked into transcript row ${JSON.stringify(row)}`,
            ).toBe(true);
        }
    }
};

type RegionModel = {
    batches: number[];
    current: number;
    regionShown: boolean;
    previousWasPaint: boolean;
};

const freshRegionModel = (): RegionModel => ({
    batches: [],
    current: 0,
    regionShown: false,
    previousWasPaint: false,
});

const closeBatch = (model: RegionModel): void => {
    if (model.current > 0) {
        model.batches.push(model.current);
        model.current = 0;
    }
};

const applyClearEvent = (model: RegionModel): void => {
    closeBatch(model);
    model.regionShown = false;
    model.previousWasPaint = false;
};

const applyPaintEvent = (model: RegionModel): void => {
    if (!model.previousWasPaint && model.batches.length > 0) {
        expect(
            model.regionShown,
            "repaint painted over a stale region without clearing first",
        ).toBe(false);
    }
    model.current += 1;
    expect(
        model.current,
        "repaint batch exceeds the replaceable region height",
    ).toBeLessThanOrEqual(INTERACTIVE_REGION_MAX_ROWS);
    model.regionShown = true;
    model.previousWasPaint = true;
};

const isRegionMechanics = (text: string): boolean =>
    text === "\n" || text === "\x1b[1A";

const applyWriteEvent = (model: RegionModel, text: string): void => {
    if (isRegionMechanics(text)) return;
    closeBatch(model);
    model.previousWasPaint = false;
};

/** Replacement repaints erase before redrawing; batches fit the region. */
const assertClearBeforeDraw = (
    events: readonly StrategyEvent[],
    paintCount: number,
    clearCount: number,
): void => {
    expect(paintCount).toBeGreaterThan(0);
    expect(clearCount).toBeGreaterThan(0);
    // Replays the controller's region model over the ordered event stream:
    // a clear erases the visible region, a paint makes it visible, and
    // durable writes never touch it (the controller clears first, writes
    // durably, then repaints, so the repaint after a durable write is valid
    // because the earlier clear already erased the region). Every repaint
    // after the first must find the region erased, proving stale rows never
    // linger beneath the fresh region.
    const model = freshRegionModel();
    for (const event of events) {
        if (event.kind === "clear") applyClearEvent(model);
        else if (event.kind === "paint") applyPaintEvent(model);
        else applyWriteEvent(model, event.text);
    }
    closeBatch(model);
    expect(model.batches.length).toBeGreaterThan(0);
};

describe("interactive footer streaming stress (issue #311)", () => {
    test("thousands of text deltas stream in transcript order independent of footer scheduling", async () => {
        const resize = makeResizeHarness();
        const recording = makeRecordingStrategy();
        const coordinator = makeProgressCoordinator({
            mode: "interactive",
            verbose: false,
            colors: false,
            width: () => 120,
            strategy: recording.strategy,
            resize: resize.subscription,
            now: () => new Date("2026-09-04T12:00:00.000Z"),
            breadcrumbThreshold: 1_000_000,
            write: () => {
                throw new Error(
                    "interactive path must not use the fallback sink",
                );
            },
        });
        try {
            await coordinator.progress.emit(
                seededProgressUpdate("run", "info"),
            );
            await coordinator.progress.emit(
                seededProgressUpdate("grounding", "started"),
            );
            await coordinator.progress.emit(
                seededProgressUpdate("implementation", "started"),
            );
            coordinator.piListener(asEvent({ type: "agent_start" }), CONTEXT);

            // 200 separate assistant messages x 12 deltas = 2400 deltas.
            // Separate messages (distinct contentIndex) keep each message under
            // the transcript's 140-character per-stream render budget, so every
            // delta stays visible and ordering proves the transcript path never
            // waits for the footer scheduler.
            const tokens = emitOrderedTextBurst(coordinator, 200, 12);

            // No footer flush has been forced yet: the transcript bytes below
            // were all written synchronously by the coordinator, never by
            // the timer.
            const writes = recording.writes();
            const clean = stripTerminalControls(writes);
            expect(clean).toContain("t0000|");
            expect(clean).toContain(
                `t${String(tokens.length - 1).padStart(4, "0")}|`,
            );

            // Every token appears exactly once and in emission order.
            assertOrderedOnce(clean, tokens);

            // Thinking deltas never enter the human transcript.
            expect(clean).not.toContain("think0|");
            expect(clean).not.toContain("think");

            // Footer invalidations coalesce: thousands of events produce
            // fewer paints than deltas, not one per delta.
            await Bun.sleep(200);
            expect(recording.paintCount()).toBeGreaterThan(0);
            expect(recording.paintCount()).toBeLessThan(tokens.length);

            // Draining the scheduler paints the current footer once; the
            // transcript order above is unchanged by the flush.
            await Bun.sleep(200);
            assertOrderedOnce(
                stripTerminalControls(recording.writes()),
                tokens,
            );
        } finally {
            await coordinator.dispose();
        }
    }, 30_000);

    test("footer paints coalesce near the 100-125 ms cadence with deterministic timing", async () => {
        const resize = makeResizeHarness();
        const recording = makeRecordingStrategy();
        const currentWidth = 120;
        let tick = -1;
        const controller = makeTerminalOutputController({
            mode: "interactive",
            strategy: recording.strategy,
            width: () => currentWidth,
            footer: {
                footerLine: () =>
                    tick < 0 ? undefined : `stress tick ${tick}`,
            },
            resize: resize.subscription,
        });
        try {
            // Stale replacement: ten rapid invalidations before the timer
            // fires must paint only the latest footer, never the stale ticks.
            for (let index = 0; index < 10; index += 1) {
                tick = index;
                controller.invalidate();
            }
            expect(recording.paintCount()).toBe(0);
            await Bun.sleep(200);
            expect(recording.paints()).toEqual(["stress tick 9"]);

            // Spaced invalidations paint once each: five ticks spaced beyond
            // the cadence window produce five strictly increasing paints.
            const paintsBefore = recording.paintCount();
            for (let index = 0; index < 5; index += 1) {
                tick = 100 + index;
                controller.invalidate();
                await Bun.sleep(160);
            }
            const paints = recording.paintCount() - paintsBefore;
            expect(paints).toBe(5);

            // Painted ticks are strictly increasing: stale renders were
            // replaced safely, never painted out of order or duplicated.
            const tickNumbers = recording
                .paints()
                .map((row) => Number(row.replace("stress tick ", "")))
                .filter((value) => Number.isFinite(value));
            for (let index = 1; index < tickNumbers.length; index += 1) {
                expect(tickNumbers[index] as number).toBeGreaterThan(
                    tickNumbers[index - 1] as number,
                );
            }
            expect(new Set(tickNumbers).size).toBe(tickNumbers.length);
        } finally {
            controller.dispose();
        }
    }, 30_000);

    test("footer reflects the current leaf state and activity across transitions with seeded context", async () => {
        const resize = makeResizeHarness();
        const recording = makeRecordingStrategy();
        const coordinator = makeProgressCoordinator({
            mode: "interactive",
            verbose: false,
            colors: false,
            width: () => 120,
            strategy: recording.strategy,
            resize: resize.subscription,
            now: () => new Date("2026-09-04T12:00:00.000Z"),
            breadcrumbThreshold: 1_000_000,
            write: () => {},
        });
        const footerText = async (): Promise<string> => {
            await Bun.sleep(160);
            return recording.finalRegion().join("\n");
        };
        try {
            await coordinator.progress.emit({
                stage: "implementation",
                status: "started",
                message: "Implementing the PTY driver",
                repository: SEEDED.repository,
                issue: { number: SEEDED.issueNumber, title: SEEDED.issueTitle },
                current: SEEDED.issueCurrent,
                total: SEEDED.issueTotal,
                attempt: SEEDED.attempt,
                maxAttempts: SEEDED.maxAttempts,
            });
            await Bun.sleep(160);
            const leafFragments = [
                "[acme/widgets]",
                "[2/5]",
                "#195",
                "Review 2/4",
                "Implementing changes",
            ];
            for (const fragment of leafFragments) {
                expect(
                    await footerText(),
                    `seeded footer missing leaf fragment ${fragment}`,
                ).toContain(fragment);
            }

            const expectActivity = async (
                event: AgentSessionEvent,
                label: string,
            ): Promise<void> => {
                coordinator.piListener(event, CONTEXT);
                await Bun.sleep(160);
                const footer = await footerText();
                for (const fragment of leafFragments) {
                    expect(footer).toContain(fragment);
                }
                expect(
                    coordinator.getDisplayState().activityLabel,
                    `display state activity mismatch for ${label}`,
                ).toContain(label);
                // At 120 columns the footer is wide enough to carry the
                // activity label alongside the leaf state.
                expect(footer).toContain(label);
            };

            coordinator.piListener(asEvent({ type: "agent_start" }), CONTEXT);
            await Bun.sleep(160);
            expect(await footerText()).toContain("Thinking");

            await expectActivity(
                asEvent({
                    type: "message_update",
                    assistantMessageEvent: {
                        type: "thinking_delta",
                        contentIndex: 0,
                        delta: "hmm",
                    },
                }),
                "Thinking",
            );
            // Responding opens a transcript line (which hides the region while
            // open by design), so close it before asserting the visible
            // footer. The display state still carries Responding throughout.
            coordinator.piListener(textStart(0), CONTEXT);
            coordinator.piListener(textDelta(0, "hello "), CONTEXT);
            expect(coordinator.getDisplayState().activityLabel).toContain(
                "Responding",
            );
            coordinator.piListener(textEnd(0), CONTEXT);
            await Bun.sleep(160);
            {
                const footer = await footerText();
                for (const fragment of leafFragments) {
                    expect(footer).toContain(fragment);
                }
                expect(footer).toContain("Responding");
            }
            await expectActivity(
                asEvent({
                    type: "tool_execution_start",
                    toolCallId: "stress-tool",
                    toolName: "bash",
                    args: { command: "echo stress" },
                }),
                "Using bash",
            );
            await expectActivity(
                asEvent({
                    type: "tool_execution_update",
                    toolCallId: "stress-tool",
                    toolName: "bash",
                    partialResult: { content: "tick" },
                }),
                "Using bash",
            );
            // Tool end settles to Waiting before the next lifecycle phase.
            coordinator.piListener(
                asEvent({
                    type: "tool_execution_end",
                    toolCallId: "stress-tool",
                    toolName: "bash",
                    result: { content: "ok" },
                    isError: false,
                }),
                CONTEXT,
            );
            await Bun.sleep(160);
            expect(await footerText()).toContain("Waiting");

            await expectActivity(
                asEvent({ type: "compaction_start", reason: "context full" }),
                "Compacting",
            );
            coordinator.piListener(
                asEvent({ type: "compaction_end" }),
                CONTEXT,
            );
            await Bun.sleep(160);
            expect(await footerText()).toContain("Waiting");

            await expectActivity(
                asEvent({
                    type: "auto_retry_start",
                    attempt: 2,
                    maxAttempts: 3,
                }),
                "Retrying",
            );
            await expectActivity(
                asEvent({
                    type: "summarization_retry_scheduled",
                    attempt: 1,
                    maxAttempts: 2,
                }),
                "Retrying",
            );
            coordinator.piListener(
                asEvent({ type: "summarization_retry_finished" }),
                CONTEXT,
            );
            await Bun.sleep(160);
            expect(await footerText()).toContain("Waiting");

            coordinator.piListener(
                asEvent({ type: "agent_end", willRetry: true }),
                CONTEXT,
            );
            await Bun.sleep(160);
            expect(await footerText()).toContain("Retrying");
            coordinator.piListener(
                asEvent({ type: "agent_end", willRetry: false }),
                CONTEXT,
            );
            await Bun.sleep(160);
            expect(await footerText()).toContain("Waiting");

            // Durable progress stays ordered through the transitions.
            await coordinator.progress.emit({
                stage: "implementation",
                status: "succeeded",
                message: "PTY driver implemented",
                repository: SEEDED.repository,
                issue: { number: SEEDED.issueNumber, title: SEEDED.issueTitle },
                current: SEEDED.issueCurrent,
                total: SEEDED.issueTotal,
                attempt: SEEDED.attempt,
                maxAttempts: SEEDED.maxAttempts,
            });
            await coordinator.progress.emit({
                stage: "verification",
                status: "failed",
                message: "verification gate failed",
                repository: SEEDED.repository,
                issue: { number: SEEDED.issueNumber, title: SEEDED.issueTitle },
                current: SEEDED.issueCurrent,
                total: SEEDED.issueTotal,
                attempt: SEEDED.attempt,
                maxAttempts: SEEDED.maxAttempts,
            });
            const durable = stripTerminalControls(recording.writes());
            expect(durable.indexOf("Implementing the PTY driver")).toBeLessThan(
                durable.indexOf("PTY driver implemented"),
            );
            expect(durable.indexOf("PTY driver implemented")).toBeLessThan(
                durable.indexOf("verification gate failed"),
            );
        } finally {
            await coordinator.dispose();
        }
    }, 30_000);

    test("ANSI splits, partial lines, narrow widths, and mid-fragment resizes preserve transcript integrity", async () => {
        const resize = makeResizeHarness();
        let currentWidth = 40;
        const oracle = new PtyScreen(currentWidth, 12);
        const recording = makeRecordingStrategy(oracle, () => currentWidth);
        const coordinator = makeProgressCoordinator({
            mode: "interactive",
            verbose: false,
            colors: false,
            width: () => currentWidth,
            strategy: recording.strategy,
            resize: resize.subscription,
            now: () => new Date("2026-09-04T12:00:00.000Z"),
            breadcrumbThreshold: 1_000_000,
            write: () => {},
        });
        const applyResize = async (
            columns: number,
            rows: number,
        ): Promise<void> => {
            currentWidth = columns;
            oracle.resize(columns, rows);
            resize.emit();
            await Bun.sleep(160);
            // The live surface reflows at the new width: no visible row may
            // exceed the width that painted it.
            for (const row of oracle.screen()) {
                expect(
                    Bun.stringWidth(row),
                    `visible row exceeds ${columns} columns after resize`,
                ).toBeLessThanOrEqual(columns);
            }
        };
        const assertScreenWidth = (columns: number): void => {
            for (const row of oracle.screen()) {
                expect(
                    Bun.stringWidth(row),
                    `visible row exceeds ${columns} columns`,
                ).toBeLessThanOrEqual(columns);
            }
        };
        try {
            await coordinator.progress.emit(
                seededProgressUpdate("implementation", "started"),
            );
            coordinator.piListener(asEvent({ type: "agent_start" }), CONTEXT);
            coordinator.piListener(textStart(0), CONTEXT);

            // Long ANSI-bearing line plus arbitrary partial lines. The SGR run
            // and OSC hyperlink are complete within their deltas (the
            // transcript sanitizer strips them per delta); the ZWJ grapheme is
            // split across a delta boundary the way the smoke fixture splits
            // it, and the trailing fragment stays open mid-line.
            coordinator.piListener(textDelta(0, "ANSI run "), CONTEXT);
            coordinator.piListener(
                textDelta(0, "SGR \u001b[31mred\u001b[0m after "),
                CONTEXT,
            );
            coordinator.piListener(
                textDelta(
                    0,
                    "OSC \u001b]8;;https://example.invalid\u0007link\u0007 end ",
                ),
                CONTEXT,
            );
            coordinator.piListener(
                textDelta(0, "BEL\u0007 BS\u0008 kept "),
                CONTEXT,
            );
            coordinator.piListener(textDelta(0, "ZWJ 👩\u200d"), CONTEXT);
            // Narrow while the grapheme fragment is still open: the footer
            // must never interleave bytes into the open fragment.
            await applyResize(16, 12);
            assertScreenWidth(16);
            coordinator.piListener(textDelta(0, "💻 rejoined "), CONTEXT);
            assertScreenWidth(16);
            coordinator.piListener(textDelta(0, "partial-"), CONTEXT);
            // Shrink and regrow while a partial line is open.
            await applyResize(12, 12);
            assertScreenWidth(12);
            coordinator.piListener(textDelta(0, "fragment"), CONTEXT);
            assertScreenWidth(12);
            await applyResize(60, 12);
            assertScreenWidth(60);
            coordinator.piListener(textDelta(0, " closed\n"), CONTEXT);
            coordinator.piListener(
                textDelta(
                    0,
                    "next line wraps at sixty columns with a long durable tail\n",
                ),
                CONTEXT,
            );
            coordinator.piListener(textEnd(0), CONTEXT);
            await Bun.sleep(200);

            const writes = recording.writes();
            expect(writes).not.toContain("\u001b[31m");
            expect(writes).not.toContain("https://example.invalid");
            expect(stripTerminalControls(writes)).toContain("SGR");
            expect(stripTerminalControls(writes)).toContain("red");
            expect(stripTerminalControls(writes)).toContain("OSC");
            expect(stripTerminalControls(writes)).toContain("BEL");
            expect(stripTerminalControls(writes)).toContain("BS");
            // The split grapheme re-joins across the delta boundary.
            expect(stripTerminalControls(writes)).toContain("👩\u200d💻");
            // The partial line streams inline in order without duplication.
            const clean = stripTerminalControls(writes);
            expect(clean.indexOf("partial-")).toBeGreaterThan(-1);
            expect(clean.indexOf("fragment")).toBeGreaterThan(
                clean.indexOf("partial-"),
            );
            expect(clean.indexOf("closed")).toBeGreaterThan(
                clean.indexOf("fragment"),
            );
            expect(clean.split("partial-fragment closed")).toHaveLength(2);

            // Direct controller proof for split control sequences: raw bytes
            // containing an incomplete CSI must defer the footer until the
            // sequence closes, even across a resize.
            const splitResize = makeResizeHarness();
            let splitWidth = 40;
            const splitRecording = makeRecordingStrategy();
            const splitController = makeTerminalOutputController({
                mode: "interactive",
                strategy: splitRecording.strategy,
                width: () => splitWidth,
                footer: {
                    footerLine: () => "SPLIT_FOOTER",
                },
                resize: splitResize.subscription,
            });
            try {
                splitController.writeTranscript("\u001b[31");
                splitController.invalidate();
                await Bun.sleep(200);
                expect(splitRecording.raw()).toBe("\u001b[31");
                splitWidth = 16;
                splitResize.emit();
                await Bun.sleep(200);
                expect(splitRecording.raw()).toBe("\u001b[31");
                splitController.writeTranscript("mred\u001b[0m\n");
                expect(splitRecording.raw()).toBe(
                    "\u001b[31mred\u001b[0m\nSPLIT_FOOTER",
                );
            } finally {
                splitController.dispose();
            }

            // Narrow widths clip every footer row at paint time: each paint
            // was sampled against the width active when it was painted, so
            // rows painted at 16/12 columns prove mid-fragment resize
            // clipping rather than only the final 60-column width.
            const paints = recording.paints();
            const paintWidths = recording.paintWidths();
            expect(paints.length).toBe(paintWidths.length);
            for (let index = 0; index < paints.length; index += 1) {
                const sampled = paintWidths[index] as number;
                expect(
                    Bun.stringWidth(
                        stripTerminalControls(paints[index] as string),
                    ),
                    `footer paint exceeds its paint-time width ${String(sampled)}`,
                ).toBeLessThanOrEqual(sampled);
            }
            // Dedicated narrow-width proof: a long footer line painted at
            // 16 and 12 columns clips there (the coordinator defers region
            // repaints while a transcript fragment is open, so this drives
            // the controller directly at each narrow width).
            for (const narrow of [16, 12] as const) {
                const narrowResize = makeResizeHarness();
                const narrowRecording = makeRecordingStrategy(
                    undefined,
                    () => narrow,
                );
                const narrowController = makeTerminalOutputController({
                    mode: "interactive",
                    strategy: narrowRecording.strategy,
                    width: () => narrow,
                    footer: {
                        footerLine: () =>
                            `narrow footer line that must clip at ${String(narrow)} columns with room to spare`,
                    },
                    resize: narrowResize.subscription,
                });
                try {
                    narrowController.invalidate();
                    await Bun.sleep(160);
                    expect(narrowRecording.paintCount()).toBeGreaterThan(0);
                    for (const row of narrowRecording.paints()) {
                        expect(
                            Bun.stringWidth(stripTerminalControls(row)),
                            `footer paint exceeds narrow width ${String(narrow)}`,
                        ).toBeLessThanOrEqual(narrow);
                    }
                } finally {
                    narrowController.dispose();
                }
            }
            // The terminal oracle never sees a row wider than the final
            // surface: all visible rows respect the final 60-column width.
            for (const row of oracle.screen()) {
                expect(Bun.stringWidth(row)).toBeLessThanOrEqual(60);
            }
        } finally {
            await coordinator.dispose();
        }
    }, 30_000);

    test("ephemeral footer bytes never become transcript/scrollback rows and stale renders are replaced safely", async () => {
        const resize = makeResizeHarness();
        let currentWidth = 80;
        const oracle = new PtyScreen(currentWidth, 24);
        const recording = makeRecordingStrategy(oracle, () => currentWidth);
        const coordinator = makeProgressCoordinator({
            mode: "interactive",
            verbose: false,
            colors: false,
            width: () => currentWidth,
            strategy: recording.strategy,
            resize: resize.subscription,
            now: () => new Date("2026-09-04T12:00:00.000Z"),
            breadcrumbThreshold: 1_000_000,
            write: () => {},
        });
        try {
            await coordinator.progress.emit(
                seededProgressUpdate("implementation", "started"),
            );
            coordinator.piListener(asEvent({ type: "agent_start" }), CONTEXT);
            // 30 messages x 10 deltas keep every message under the 140-char
            // per-stream budget, so all 300 durable tokens stay visible while
            // thinking deltas ride along without entering the transcript.
            emitDurableBurst(coordinator, 30, 10);
            await Bun.sleep(200);

            // Replacement repaints always erase first: the ordered strategy
            // event stream proves every repaint batch after the first was
            // preceded by a clear (so stale footer rows never linger beneath
            // the fresh region) and every batch fits the region height.
            assertClearBeforeDraw(
                recording.events(),
                recording.paintCount(),
                recording.clearCount(),
            );
            for (const row of recording.paints()) {
                expect(
                    Bun.stringWidth(stripTerminalControls(row)),
                ).toBeLessThanOrEqual(currentWidth);
            }

            await coordinator.dispose();

            // After disposal the live region is erased in place: the final
            // screen and scrollback contain the durable transcript in order,
            // and no ephemeral footer paint survives as a row.
            const cleanRaw = stripTerminalControls(recording.raw());
            expect(cleanRaw).toContain("durable-000|");
            expect(cleanRaw).toContain("durable-299|");
            expect(cleanRaw.indexOf("durable-000|")).toBeLessThan(
                cleanRaw.indexOf("durable-299|"),
            );
            const rows = [...oracle.scrollback(), ...oracle.screen()];
            const joined = rows.join("\n");
            expect(joined).toContain("durable-000|");
            expect(joined).toContain("durable-299|");
            assertNoEphemeralRows(rows);
            // No footer paint leaked an extra transcript row: no paint
            // survives as (a substring of) a transcript/scrollback row
            // unless the durable writes carry it too, and footer-only
            // chrome never reaches the durable channel at all.
            assertPaintsNotLeaked(recording.paints(), rows, recording.writes());
        } finally {
            await coordinator.dispose();
        }
    }, 30_000);

    test("real-PTY marker-synchronized proof: smoke session streams in order across resizes without footer leaks", async () => {
        const workspace = await mkdtemp(
            join(tmpdir(), "ralphie-footer-stress-"),
        );
        const childModule = new URL("./pty-driver-child.ts", import.meta.url)
            .pathname;
        const session = await launchPtyCommand({
            command: [process.execPath, childModule, "--workspace", workspace],
            columns: 100,
            rows: 30,
            env: childEnv(),
        });
        try {
            // The child is a PTY session leader with its own process group.
            expect(session.childPgid()).toBe(session.childPid());

            // The real coordinator painted its interactive footer with the
            // live implementation stage, synchronized on the child marker.
            await session.waitFor(FOOTER_MARKER);
            expect(
                session.screen().map(stripTerminalControls).join("\n"),
            ).toContain("Implementing changes");

            // The deterministic scenario stream is open; the child holds it
            // open until the driver resizes twice.
            await session.waitFor(ACTIVE_MARKER);

            // Narrow then restore through the real PTY: the kernel forwards
            // SIGWINCH and the coordinator repaints at each width while the
            // transcript fragment stays open mid-line.
            session.resize(60, 20);
            await session.waitFor(`${RESIZE_MARKER_PREFIX}60x20`);
            session.resize(100, 30);
            await session.waitFor(`${RESIZE_MARKER_PREFIX}100x30`);

            // The stream finalizes exactly once and only after the second
            // resize, then the child settles progress and exits 0.
            const rawAtFinalize = await session.waitFor(
                STREAM_FINALIZED_MARKER,
            );
            expect(
                rawAtFinalize.indexOf(STREAM_FINALIZED_MARKER),
            ).toBeGreaterThan(
                rawAtFinalize.indexOf(`${RESIZE_MARKER_PREFIX}100x30`),
            );
            expect(
                rawAtFinalize.split(STREAM_FINALIZED_MARKER).length - 1,
            ).toBe(1);
            await session.waitFor(DONE_MARKER);
            await session.waitFor(SCENARIO_DONE_MARKER);
            const exit = await session.waitForExit();
            expect(exit).toEqual({ code: 0, signal: null });

            // Transcript order on the real terminal: the deterministic stream
            // survived wrapping and mid-fragment resizes without loss,
            // duplication, or reordering, including the rejoined ZWJ pair.
            const raw = session.raw();
            expect(raw).toContain("\x1b[");
            const cleanRaw = stripTerminalControls(raw);
            for (const fragment of [
                "PTY scenario",
                "agent run",
                "ASCII run",
                "（漢字）",
                "👩\u200d💻",
                "mid-line",
            ]) {
                expect(cleanRaw).toContain(fragment);
            }
            expect(cleanRaw.indexOf("PTY scenario")).toBeLessThan(
                cleanRaw.indexOf("mid-line"),
            );
            expect(cleanRaw.indexOf(FOOTER_MARKER)).toBeLessThan(
                cleanRaw.indexOf(ACTIVE_MARKER),
            );
            expect(cleanRaw.indexOf(ACTIVE_MARKER)).toBeLessThan(
                cleanRaw.indexOf(STREAM_FINALIZED_MARKER),
            );

            // No ephemeral footer bytes leaked into the durable surface: the
            // visible surface stays credential-free and no live-only fragment
            // survives on screen or in scrollback after disposal.
            expect(raw).not.toContain("rk_s3cret_pty_9f3d_token");
            const rows = [...session.scrollback(), ...session.screen()];
            expect(rows.join("")).not.toContain("rk_s3cret_pty_9f3d_token");
            for (const row of rows) {
                expect(
                    Bun.stringWidth(row),
                    "real-PTY row exceeds the final 100-column width",
                ).toBeLessThanOrEqual(100);
            }
            // The long durable failure line was emitted at the final width:
            // it wraps instead of fitting in one row.
            const cleanedScreen = session.screen().map(stripTerminalControls);
            expect(cleanedScreen.join("")).toContain(LONG_FAILURE_MESSAGE);
            expect(
                cleanedScreen.some((row) => row.includes(LONG_FAILURE_MESSAGE)),
            ).toBe(false);

            // The fake workflow wrote its event log: progress, every agent
            // milestone, both resizes, and the finalize/done markers.
            const logText = await readFile(
                join(workspace, EVENT_LOG_NAME),
                "utf8",
            );
            const entries = logText
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line) as Record<string, unknown>);
            expect(entries).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        kind: "progress",
                        stage: "implementation",
                        status: "started",
                    }),
                    expect.objectContaining({
                        kind: "agent",
                        type: "text_delta",
                    }),
                    expect.objectContaining({
                        kind: "resize",
                        columns: 60,
                        rows: 20,
                    }),
                    expect.objectContaining({
                        kind: "resize",
                        columns: 100,
                        rows: 30,
                    }),
                    expect.objectContaining({ kind: "active" }),
                    expect.objectContaining({
                        kind: "marker",
                        name: STREAM_FINALIZED_MARKER,
                    }),
                    expect.objectContaining({ kind: "done" }),
                ]),
            );

            // The child exited by itself; its PID and process group are gone.
            expect(isProcessAlive(session.childPid() as number)).toBe(false);
            expect(isProcessAlive(-(session.childPgid() as number))).toBe(
                false,
            );
        } finally {
            await session.close();
        }
        expect(isProcessAlive(session.helperPid)).toBe(false);
        await rm(workspace, { recursive: true, force: true });
    }, 120_000);
});