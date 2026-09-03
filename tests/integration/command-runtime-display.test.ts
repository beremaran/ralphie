import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
    runCommand,
    type CliTerminalInfo,
    type CommandFactories,
    type CommandOutput,
    type CommandRuntime,
} from "../../src/command.ts";
import type {
    AgentEventContext,
    AgentEventListener,
    AgentSessionEvent,
} from "../../src/opencode/client.ts";
import type { OpenCodeProviderConfig } from "../../src/opencode/config.ts";
import type {
    OpenCodeRuntime,
    OpenCodeService,
} from "../../src/opencode/server.ts";
import {
    makeProgressCoordinator,
    type ProgressCoordinator,
    type ProgressCoordinatorOptions,
} from "../../src/progress/coordinator.ts";
import { breadcrumbCandidateFor } from "../../src/progress/breadcrumb.ts";
import type { FooterTimer } from "../../src/progress/footer.ts";
import type { ProgressRenderMode } from "../../src/progress/progress.ts";
import type { RalphieRuntime } from "../../src/runtime.ts";
import { stripTerminalControls } from "../../src/shared/terminal.ts";
import type { WorkflowOptions } from "../../src/workflow.ts";
import {
    CLEAR_LINE,
    CURSOR_UP,
    makeRecordingStrategy,
    PhysicalRowMeter,
    regionBytes,
    type RecordingStrategy,
    type StrategyOp,
} from "../shared/physical-row-meter.ts";
import { RalphieExitCode } from "../../src/process/exit-code.ts";
import {
    ASSISTANT_DELTAS,
    CREDENTIAL_RAW,
    CREDENTIAL_TEXT,
    INTERLEAVED_RAW,
    INTERLEAVED_TEXT,
    LABEL_ISSUE,
    LABEL_REPOSITORY,
    LONG_PROGRESS,
    LONG_TEXT,
    RESIZE_TARGET_WIDTH,
    SCENARIO_NAMES,
    UNSAFE_API_KEY,
    UNSAFE_DETAILS,
    UNSAFE_TOKEN,
    VERIFICATION_FAILURE_MESSAGE,
    VERIFICATION_NEEDS_ATTENTION_MESSAGE,
    WIDE_PROGRESS_DONE,
    WIDE_PROGRESS_STARTED,
    WIDE_TEXT,
    eventEmitsFor,
    playScriptedScenario,
    progressEmitsFor,
    type ScenarioName,
} from "../shared/scripted-scenarios.ts";

/**
 * End-to-end display regression through the real command runtime
 * (`runCommand`): real coordinator wiring, real mode resolution, and a fake
 * Agent service replaying a deterministic, mode-parametric scripted scenario
 * set. Physical rows are measured with a terminal emulator, never from
 * newline counts.
 */

const context: AgentEventContext = {
    sessionID: "session-1",
    directory: "/workspace/owner/repository",
    title: "Task",
};

/** Fixed clock so every rendered duration and footer is byte-identical. */
const FIXED_NOW = () => new Date("2026-01-01T00:00:00.000Z");

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

/** Fake TTY stderr so `runCommand` selects interactive mode and resize works. */
const makeFakeStderr = (initialWidth: number) => {
    let width = initialWidth;
    const listeners: Array<() => void> = [];
    const stream = {
        isTTY: true,
        rows: 24,
        get columns() {
            return width;
        },
        write: () => {},
        on: (_type: string, listener: () => void) => {
            listeners.push(listener);
            return stream;
        },
        removeListener: (_type: string, listener: () => void) => {
            const index = listeners.indexOf(listener);
            if (index >= 0) listeners.splice(index, 1);
            return stream;
        },
        emitResize: () => {
            for (const listener of [...listeners]) listener();
        },
        setWidth: (value: number) => {
            width = value;
        },
    };
    return stream;
};

const makeCapture = (): CommandOutput & {
    readonly stdoutBytes: () => string;
    readonly stderrBytes: () => string;
} => {
    let stdout = "";
    let stderr = "";
    return {
        stdout: (text) => {
            stdout += text;
        },
        stderr: (text) => {
            stderr += text;
        },
        stdoutBytes: () => stdout,
        stderrBytes: () => stderr,
    };
};

const noopSummary = undefined as never;

/** Fake agent service whose session replay is scripted by the fake workflow. */
const makeFakePi = (): OpenCodeService => {
    const runtime = {
        url: "http://127.0.0.1:1",
        client: {
            session: {
                create: async () => ({ data: { id: context.sessionID } }),
                prompt: async () => ({ data: { info: {}, parts: [] } }),
            },
            close: () => {},
        },
        close: async () => {},
    } as unknown as OpenCodeRuntime;
    return {
        start: async () => runtime,
    };
};

type DisplaySession = {
    readonly strategy: RecordingStrategy;
    readonly timer: FakeTimer;
    readonly settle: () => void;
    readonly samples: number[];
    /** Terminal width sampled when each painted region row was emitted. */
    readonly paintWidths: readonly number[];
};

const insertBreadcrumbFrom = (coordinator: ProgressCoordinator | undefined) => {
    if (coordinator === undefined) return;
    coordinator.insertBreadcrumb?.(
        breadcrumbCandidateFor(coordinator.getDisplayState()),
    );
};

/**
 * Interactive harness around the real command runtime: a fake TTY stderr
 * drives mode selection and resize while the coordinator routes its bytes
 * into a recording strategy so region rows and physical rows are observable.
 * The harness starts at a caller-chosen width and can resize mid-run through
 * the scripted `resize` step.
 */
const runInteractiveCommand = async ({
    workspace,
    scenario = "completion",
    width = 80,
    preAborted = false,
    workflowError,
    onSession,
    onDisposed,
}: {
    readonly workspace: string;
    readonly scenario?: ScenarioName;
    readonly width?: number;
    readonly preAborted?: boolean;
    readonly workflowError?: Error;
    readonly onSession?: (session: DisplaySession) => Promise<void> | void;
    readonly onDisposed?: (strategy: RecordingStrategy) => void;
}): Promise<{
    readonly strategy: RecordingStrategy;
    readonly paintWidths: readonly number[];
}> => {
    const strategy = makeRecordingStrategy();
    const widthAtPaint: number[] = [];
    // Record the terminal width at the moment of every region-row paint so
    // frame-level assertions can attribute each row to the width it was
    // clipped at, including across a mid-run resize.
    const measuredStrategy: RecordingStrategy = {
        ...strategy,
        paintFooter: (text) => {
            widthAtPaint.push(fakeStderr.columns);
            return strategy.paintFooter(text);
        },
    };
    const timer = makeFakeTimer();
    const samples: number[] = [];
    const fakeStderr = makeFakeStderr(width);
    const abortController = new AbortController();
    if (preAborted) abortController.abort();
    const originalDescriptor = Object.getOwnPropertyDescriptor(
        process,
        "stderr",
    );
    Object.defineProperty(process, "stderr", {
        value: fakeStderr,
        configurable: true,
    });
    let listener: AgentEventListener | undefined;
    let coordinator: ProgressCoordinator | undefined;
    try {
        const factories: CommandFactories = {
            makeCoordinator: (options: ProgressCoordinatorOptions) => {
                const made = makeProgressCoordinator({
                    ...options,
                    strategy: measuredStrategy,
                    footer: { timer },
                    now: FIXED_NOW,
                });
                coordinator = made;
                return made;
            },
            makeOpenCode: (_config: OpenCodeProviderConfig, eventListener) => {
                listener = eventListener;
                return makeFakePi();
            },
            makeRuntime: ({ opencode, progress }) =>
                ({ opencode, progress }) as unknown as CommandRuntime,
            runWorkflow: async (
                _options: WorkflowOptions,
                runtime: RalphieRuntime,
            ) => {
                const piListener = listener as AgentEventListener;
                const settle = (): void => {
                    timer.run();
                    samples.push(strategy.currentRegion().length);
                };
                await playScriptedScenario(scenario, "interactive", {
                    listener: piListener,
                    context,
                    progress: runtime.progress,
                    settle,
                    insertBreadcrumb: () => insertBreadcrumbFrom(coordinator),
                    resize: (newWidth) => {
                        fakeStderr.setWidth(newWidth);
                        fakeStderr.emitResize();
                    },
                    abort: () => abortController.abort(),
                    signal: abortController.signal,
                });
                if (workflowError !== undefined) throw workflowError;
                if (onSession !== undefined) {
                    await onSession({
                        strategy: measuredStrategy,
                        timer,
                        settle,
                        samples,
                        paintWidths: widthAtPaint,
                    });
                }
                return noopSummary;
            },
        };
        await runCommand(["owner/repository", "--workspace", workspace], {
            terminal: {
                isInteractive: true,
                isCI: false,
                width,
            } satisfies CliTerminalInfo,
            output: makeCapture(),
            factories,
            signal: abortController.signal,
        });
    } finally {
        if (originalDescriptor !== undefined) {
            Object.defineProperty(process, "stderr", originalDescriptor);
        } else {
            delete (process as { stderr?: unknown }).stderr;
        }
        onDisposed?.(measuredStrategy);
    }
    return { strategy: measuredStrategy, paintWidths: widthAtPaint };
};

/** Noninteractive harness: plain/CI, JSON, and quiet modes need no TTY. */
const runNoninteractiveCommand = async ({
    args,
    terminal,
    scenario = "completion",
    preAborted = false,
    workflowError,
}: {
    readonly args: readonly string[];
    readonly terminal: CliTerminalInfo;
    readonly scenario?: ScenarioName;
    readonly preAborted?: boolean;
    readonly workflowError?: Error;
}): Promise<ReturnType<typeof makeCapture>> => {
    const capture = makeCapture();
    const abortController = new AbortController();
    if (preAborted) abortController.abort();
    let listener: AgentEventListener | undefined;
    let coordinator: ProgressCoordinator | undefined;
    await runCommand([...args], {
        terminal,
        output: capture,
        signal: abortController.signal,
        factories: {
            makeCoordinator: (options: ProgressCoordinatorOptions) => {
                const made = makeProgressCoordinator({
                    ...options,
                    now: FIXED_NOW,
                });
                coordinator = made;
                return made;
            },
            makeOpenCode: (_config, eventListener) => {
                listener = eventListener;
                return makeFakePi();
            },
            makeRuntime: ({ opencode, progress }) =>
                ({ opencode, progress }) as unknown as CommandRuntime,
            runWorkflow: async (
                _options: WorkflowOptions,
                runtime: RalphieRuntime,
            ) => {
                await playScriptedScenario(scenario, outputModeOf(args), {
                    listener: listener as AgentEventListener,
                    context,
                    progress: runtime.progress,
                    insertBreadcrumb: () => insertBreadcrumbFrom(coordinator),
                    abort: () => abortController.abort(),
                    signal: abortController.signal,
                });
                if (workflowError !== undefined) throw workflowError;
                return noopSummary;
            },
        },
    });
    return capture;
};

type OutputMode = "default" | "verbose" | "quiet" | "json";

const OUTPUT_MODES: readonly OutputMode[] = [
    "default",
    "verbose",
    "quiet",
    "json",
];

const NONINTERACTIVE_TERMINAL: CliTerminalInfo = {
    isInteractive: false,
    isCI: true,
    width: 80,
};

/** Redirected (non-CI) terminal: plain mode with output piped elsewhere. */
const REDIRECTED_TERMINAL: CliTerminalInfo = {
    isInteractive: false,
    isCI: false,
    width: 80,
};

/** The plain/CI and redirected (non-CI) terminal configurations. */
const NONINTERACTIVE_TERMINALS: readonly CliTerminalInfo[] = [
    NONINTERACTIVE_TERMINAL,
    REDIRECTED_TERMINAL,
];

/** Human-readable output modes covered by the noninteractive matrix. */
const NONINTERACTIVE_MATRIX_MODES = ["default", "verbose", "quiet"] as const;

const terminalLabel = (terminal: CliTerminalInfo): string =>
    terminal.isCI ? "plain/CI" : "redirected";

const argsFor = (mode: OutputMode, workspace: string): string[] =>
    mode === "default"
        ? ["owner/repository", "--workspace", workspace]
        : ["owner/repository", "--output", mode, "--workspace", workspace];

const outputModeOf = (args: readonly string[]): ProgressRenderMode => {
    const index = args.indexOf("--output");
    if (index < 0) return "plain";
    const value = args[index + 1];
    if (value === "json" || value === "quiet") return value;
    return "plain";
};

/** Durable transcript bytes only; region paints are excluded. */
const durableBytes = (strategy: RecordingStrategy): string =>
    strategy
        .ops()
        .filter((op) => op.kind === "write")
        .map((op) => op.text)
        .join("");

/** Mask per-run JSON metadata so bytes are comparable across runs. */
const maskRunMeta = (text: string): string =>
    text
        .replace(/"runId":"[^"]*"/g, '"runId":"<run>"')
        .replace(/"timestamp":"[^"]*"/g, '"timestamp":"<at>"');

/** Breadcrumb rows: `│  `-prefixed durable lines that are not content rows. */
const isBreadcrumbRow = (line: string): boolean => {
    if (!line.startsWith("│  ")) return false;
    if (line.startsWith("│    ")) return false;
    const content = line.slice(3);
    return (
        !content.startsWith("$ ") &&
        !content.startsWith("✓ ") &&
        !content.startsWith("✗ ") &&
        !content.startsWith("✦ ") &&
        !content.startsWith("↻ ") &&
        !content.startsWith("› prompt ")
    );
};

/** Same bytes as CLEAR_LIVE_LINE in src/progress/progress.ts: `\r\x1b[2K`. */
const CLEAR_LIVE_LINE = CLEAR_LINE;

/**
 * C0 cursor/erase/bell controls (except tab and newline), DEL, and C1
 * controls, mirroring TERMINAL_CONTROL_CODE in src/shared/terminal.ts.
 */
const TERMINAL_CONTROL_CODE =
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0080-\u009f]/;

/** Assert a capture is byte-clean: no ESC, CR, or C0/C1 cursor/erase/bell. */
const expectControlFree = (text: string): void => {
    expect(text).not.toContain("\x1b");
    expect(text).not.toContain("\r");
    expect(text).not.toMatch(TERMINAL_CONTROL_CODE);
    // stripTerminalControls must be an identity no-op on the captured bytes.
    expect(stripTerminalControls(text)).toBe(text);
};

const graphemeSegmenter = new Intl.Segmenter(undefined, {
    granularity: "grapheme",
});

/**
 * Reconstruct every painted frame of the replaceable region from the
 * operation stream: consecutive paints are one frame; the controller emits a
 * bare newline write between the rows of a frame, and any other op (clear,
 * durable write, restore) closes the frame.
 */
const framesOf = (
    strategy: RecordingStrategy,
): readonly (readonly string[])[] => {
    const frames: string[][] = [];
    let current: string[] = [];
    for (const op of strategy.ops()) {
        if (op.kind === "paint") {
            current.push(op.text);
            continue;
        }
        if (op.kind === "write" && op.text === "\n" && current.length > 0) {
            continue;
        }
        if (current.length > 0) {
            frames.push(current);
            current = [];
        }
    }
    if (current.length > 0) frames.push(current);
    return frames;
};

/**
 * Assert every painted region frame stays within the three-row cap, every
 * row is clipped to the width that was active when it was painted, and every
 * row occupies exactly one physical terminal row (never wraps).
 */
const expectFramesFit = (
    strategy: RecordingStrategy,
    paintWidths: readonly number[],
): void => {
    const frames = framesOf(strategy);
    expect(frames.length).toBeGreaterThan(0);
    let paintIndex = 0;
    for (const frame of frames) {
        expect(frame.length).toBeLessThanOrEqual(3);
        const frameWidth = paintWidths[paintIndex] as number;
        const meter = new PhysicalRowMeter(frameWidth);
        meter.feed(regionBytes(frame));
        expect(meter.rows()).toBe(frame.length);
        for (const row of frame) {
            const width = paintWidths[paintIndex] as number;
            paintIndex += 1;
            expect(
                Bun.stringWidth(stripTerminalControls(row)),
            ).toBeLessThanOrEqual(width);
        }
    }
    expect(paintIndex).toBe(paintWidths.length);
    expect(strategy.peakRegionRows()).toBeLessThanOrEqual(3);
};

/**
 * Assert no painted region row contains a dangling modifier segment. Every
 * complete grapheme has nonzero display width; a mid-grapheme split leaves a
 * zero-width combining mark, ZWJ, or variation selector behind.
 */
const expectNoSplitGraphemes = (strategy: RecordingStrategy): void => {
    for (const frame of framesOf(strategy)) {
        for (const row of frame) {
            const stripped = stripTerminalControls(row);
            for (const { segment } of graphemeSegmenter.segment(stripped)) {
                expect(Bun.stringWidth(segment)).toBeGreaterThan(0);
            }
        }
    }
};

describe("command runtime display: interactive mode", () => {
    test("never exceeds three physical rows across calls, tokens, and cleanup", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "ralphie-display-"));
        try {
            await runInteractiveCommand({
                workspace,
                onSession: ({ strategy, samples }) => {
                    // Every sampled instant stays within the three-row cap.
                    for (const rows of samples) {
                        expect(rows).toBeLessThanOrEqual(3);
                    }
                    expect(strategy.peakRegionRows()).toBeLessThanOrEqual(3);

                    const raw = strategy.output();
                    const clean = stripTerminalControls(raw);
                    // Streamed assistant text is preserved exactly, once.
                    const block = ASSISTANT_DELTAS.join("");
                    expect(clean.split(block)).toHaveLength(2);
                    const start = clean.indexOf(block);
                    expect(clean.slice(start, start + block.length)).toBe(
                        block,
                    );

                    // Concise completion/error summaries survive the run.
                    expect(clean.split("✓ bash done").length).toBe(5);
                    expect(clean).toContain(
                        "✗ grep failed — error: no matches found in the repository",
                    );
                    expect(clean).toContain("change written");
                    expect(clean).toContain(VERIFICATION_FAILURE_MESSAGE);

                    // Newline counts would overstate the live region; the
                    // physical-row emulator keeps the in-progress surface at
                    // its three-row cap while scrollback grows.
                    expect(raw.split("\n").length).toBeGreaterThan(3);
                    const meter = new PhysicalRowMeter(80);
                    meter.feed(raw);
                    expect(meter.rows()).toBe(meter.peakRows());
                    expect(meter.peakRows()).toBeGreaterThan(0);
                },
            });
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    test("repaints within the cap at a new width after a mid-run resize", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "ralphie-display-"));
        try {
            await runInteractiveCommand({
                workspace,
                scenario: "resize",
                width: 80,
                onSession: ({ strategy }) => {
                    const narrow = RESIZE_TARGET_WIDTH;
                    const region = strategy.currentRegion();
                    expect(region.length).toBeLessThanOrEqual(3);
                    for (const row of region) {
                        expect(
                            Bun.stringWidth(stripTerminalControls(row)),
                        ).toBeLessThanOrEqual(narrow);
                    }
                    if (region.length > 0) {
                        const meter = new PhysicalRowMeter(narrow);
                        meter.feed(regionBytes(region));
                        expect(meter.rows()).toBe(region.length);
                    }
                    expect(strategy.peakRegionRows()).toBeLessThanOrEqual(3);

                    // Content before and after the mid-run resize survives
                    // (the post-resize tool row is clipped to the new width).
                    const durable = stripTerminalControls(
                        durableBytes(strategy),
                    );
                    expect(durable).toContain("echo pre-resize");
                    expect(durable).toContain("$ echo post");
                    expect(durable.split("✓ bash done").length).toBe(3);
                },
            });
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    test("erase and cursor controls appear only in live-region updates, never in durable rows", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "ralphie-matrix-"));
        try {
            const { strategy } = await runInteractiveCommand({
                workspace,
                scenario: "interleaved-streams",
            });
            const output = strategy.output();

            // Every erase sequence is a live-region operation: each
            // `\r\x1b[2K` emission was recorded as a clear op, and no stray
            // carriage return exists outside those erase sequences.
            expect(strategy.clearCount()).toBe(
                output.split(CLEAR_LIVE_LINE).length - 1,
            );
            expect(output.replaceAll(CLEAR_LIVE_LINE, "")).not.toContain("\r");

            // Cursor-up bytes occur only while erasing the live region: every
            // `\x1b[1A` write immediately follows a clear op.
            let awaitingCursorUp = false;
            let cursorUpWrites = 0;
            for (const op of strategy.ops()) {
                if (op.kind === "clear") {
                    awaitingCursorUp = true;
                    continue;
                }
                if (op.kind === "write" && op.text === CURSOR_UP) {
                    expect(awaitingCursorUp).toBe(true);
                    awaitingCursorUp = false;
                    cursorUpWrites += 1;
                    continue;
                }
                awaitingCursorUp = false;
            }
            expect(cursorUpWrites).toBe(output.split(CURSOR_UP).length - 1);

            // Durable rows carry styling only: once the SGR color codes are
            // removed, no escape, carriage return, erase, or cursor-motion
            // control remains in the transcript, breadcrumb, or raw rows.
            const durableRows = strategy
                .ops()
                .filter(
                    (
                        op,
                    ): op is Extract<StrategyOp, { readonly kind: "write" }> =>
                        op.kind === "write" && op.text !== CURSOR_UP,
                )
                .map((op) => op.text)
                .join("");
            expect(durableRows).not.toContain("\r");
            expect(durableRows.replace(/\x1b\[[0-9;]*m/g, "")).not.toContain(
                "\x1b",
            );

            // The partial raw chunks and streamed deltas survived intact.
            expect(durableRows).toContain(
                `${INTERLEAVED_RAW[0]}${INTERLEAVED_RAW[1]}`,
            );
            for (const part of INTERLEAVED_TEXT) {
                expect(durableRows).toContain(part);
            }
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    test("every live frame stays clipped, unwrapped, and grapheme-complete at narrow widths and after a mid-run resize", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "ralphie-matrix-"));
        try {
            for (const width of [40, 24, 12, 8]) {
                const { strategy, paintWidths } = await runInteractiveCommand({
                    workspace,
                    scenario: "wide-grapheme",
                    width,
                });
                expectFramesFit(strategy, paintWidths);
                expectNoSplitGraphemes(strategy);
                // The wide text survives intact in the durable transcript at
                // every width.
                const durable = stripTerminalControls(durableBytes(strategy));
                expect(durable).toContain(WIDE_TEXT);
            }

            // After a mid-run resize the same invariants hold for every frame
            // painted at the new width.
            const resized = await runInteractiveCommand({
                workspace,
                scenario: "resize",
            });
            expectFramesFit(resized.strategy, resized.paintWidths);
            expectNoSplitGraphemes(resized.strategy);
            expect(new Set(resized.paintWidths)).toContain(RESIZE_TARGET_WIDTH);
            const region = resized.strategy.currentRegion();
            for (const row of region) {
                expect(
                    Bun.stringWidth(stripTerminalControls(row)),
                ).toBeLessThanOrEqual(RESIZE_TARGET_WIDTH);
            }
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    test("long streamed text reassembles once while long rows stay on one physical line", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "ralphie-matrix-"));
        try {
            const { strategy, paintWidths } = await runInteractiveCommand({
                workspace,
                scenario: "long-output",
            });
            const durable = stripTerminalControls(durableBytes(strategy));

            // The streamed assistant text is preserved contiguously up to the
            // transcript cap (STREAM_OUTPUT_LIMIT = 140 in transcript.ts) and
            // appears exactly once in scrollback; the marker reports the full
            // reassembled length.
            const visible = LONG_TEXT.slice(0, 140);
            expect(durable.split(visible)).toHaveLength(2);
            expect(durable).toContain(
                `✦ assistant done · ${LONG_TEXT.length} chars · truncated`,
            );

            // The long tool command line is a single clipped durable row.
            const toolLine = durable
                .split("\n")
                .find((line) => line.includes("$ echo"));
            expect(toolLine).toBeDefined();
            expect(toolLine as string).toContain("…");
            expect(Bun.stringWidth(toolLine as string)).toBeLessThanOrEqual(80);

            // Live activity/footer frames never wrap and stay within the cap.
            expectFramesFit(strategy, paintWidths);
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    test("completed breadcrumb rows stay byte-stable through repeated live refreshes", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "ralphie-matrix-"));
        try {
            const { strategy } = await runInteractiveCommand({
                workspace,
                scenario: "breadcrumb-refresh",
            });
            const durable = stripTerminalControls(durableBytes(strategy));

            // The three explicit breadcrumbs were written once each and their
            // text is unchanged in the final scrollback.
            const breadcrumbRows = durable
                .split("\n")
                .filter((line) => isBreadcrumbRow(line));
            expect(breadcrumbRows).toHaveLength(3);
            for (const row of breadcrumbRows) {
                expect(row).toBe("│  › Waiting");
            }
            expect(durable.split("│  › Waiting")).toHaveLength(4);

            // The refreshes that followed re-painted the live region only:
            // ops after the last breadcrumb never re-emit or alter the rows.
            const ops = strategy.ops();
            let lastBreadcrumbWrite = -1;
            ops.forEach((op, index) => {
                if (op.kind === "write" && op.text.includes("› Waiting")) {
                    lastBreadcrumbWrite = index;
                }
            });
            const after = ops.slice(lastBreadcrumbWrite + 1);
            expect(
                after.filter((op) => op.kind === "paint").length,
            ).toBeGreaterThanOrEqual(10);
            expect(
                after.filter((op) => op.kind === "clear").length,
            ).toBeGreaterThanOrEqual(5);
            for (const op of after) {
                if (op.kind === "paint") {
                    expect(op.text).not.toContain("│  › Waiting");
                }
            }
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    test("abort and error disposal leave a clean surface and a failure exit code", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "ralphie-matrix-"));
        const previousExitCode = process.exitCode;
        try {
            // (a) A throwing fake workflow: the run still disposes the
            // coordinator, flattens the live region, keeps durable rows, and
            // fails the process exit code.
            let throwingKinds: readonly string[] = [];
            let throwingStrategy: RecordingStrategy | undefined;
            await expect(
                runInteractiveCommand({
                    workspace,
                    scenario: "completion",
                    workflowError: new Error("simulated workflow failure"),
                    onDisposed: (strategy) => {
                        throwingKinds = strategy.ops().map((op) => op.kind);
                        throwingStrategy = strategy;
                    },
                }),
            ).rejects.toThrow("simulated workflow failure");
            expect(process.exitCode).toBe(RalphieExitCode.Failure);
            expect(throwingKinds).toContain("restore");
            expect(throwingKinds.at(-1)).toBe("restore");
            const throwingOutput = throwingStrategy?.output() ?? "";
            expect(throwingOutput.endsWith("\n")).toBe(true);
            const throwingDurable = stripTerminalControls(
                durableBytes(throwingStrategy as RecordingStrategy),
            );
            expect(throwingDurable).toContain(ASSISTANT_DELTAS.join(""));
            expect(throwingDurable).toContain("✓ bash done");

            // (b) The abort scenario aborts the run's own signal before the
            // throwing workflow: cancelled exit code, durable rows intact.
            let abortedKinds: readonly string[] = [];
            let abortedStrategy: RecordingStrategy | undefined;
            await expect(
                runInteractiveCommand({
                    workspace,
                    scenario: "abort",
                    workflowError: new Error("aborted before disposal"),
                    onDisposed: (strategy) => {
                        abortedKinds = strategy.ops().map((op) => op.kind);
                        abortedStrategy = strategy;
                    },
                }),
            ).rejects.toThrow("aborted before disposal");
            expect(process.exitCode).toBe(RalphieExitCode.Cancelled);
            expect(abortedKinds.at(-1)).toBe("restore");
            expect(abortedStrategy?.output().endsWith("\n")).toBe(true);
            const abortedDurable = stripTerminalControls(
                durableBytes(abortedStrategy as RecordingStrategy),
            );
            expect(abortedDurable).toContain(
                "Starting the aborted run session.",
            );

            // (c) A pre-aborted input signal disposes without throwing and
            // emits nothing, so no live-row bytes can dangle.
            let preAbortedStrategy: RecordingStrategy | undefined;
            await expect(
                runInteractiveCommand({
                    workspace,
                    scenario: "abort",
                    preAborted: true,
                    workflowError: new Error("pre-aborted signal"),
                    onDisposed: (strategy) => {
                        preAbortedStrategy = strategy;
                    },
                }),
            ).rejects.toThrow("pre-aborted signal");
            expect(process.exitCode).toBe(RalphieExitCode.Cancelled);
            expect(preAbortedStrategy?.output()).toBe("");
            expect(preAbortedStrategy?.ops().map((op) => op.kind)).toContain(
                "restore",
            );
        } finally {
            process.exitCode = previousExitCode;
            await rm(workspace, { recursive: true, force: true });
        }
    });
});

/**
 * Landmark substrings every scenario must contain in strict emit order.
 * Each entry mirrors a distinct durable write of the plain renderer, so
 * monotonically increasing positions prove the capture is append-only and
 * never reordered, for every scenario and terminal configuration.
 */
const orderedMarkersFor = (scenario: ScenarioName): readonly string[] => {
    switch (scenario) {
        case "completion":
            return [
                "╭─ OpenCode · Task · session-1",
                ASSISTANT_DELTAS.join(""),
                "$ echo cycle 0",
                "✓ bash done",
                "✗ grep failed",
                "✓ change written",
                VERIFICATION_FAILURE_MESSAGE,
                "╰─ settled",
            ];
        case "interleaved-streams":
            return [
                "╭─ OpenCode · Task · session-1",
                INTERLEAVED_RAW[0],
                INTERLEAVED_RAW[1],
                INTERLEAVED_TEXT[0],
                INTERLEAVED_RAW[2],
                INTERLEAVED_TEXT[1],
                INTERLEAVED_RAW[3],
                "assembling",
                INTERLEAVED_TEXT[2],
                "✓ bash done",
                INTERLEAVED_RAW[4],
                "assembled",
                "╰─ settled",
                VERIFICATION_FAILURE_MESSAGE,
            ];
        case "thinking-tools":
            return [
                "╭─ OpenCode · Task · session-1",
                "find *.ts in /workspace",
                "Let me look at the entry point and its imports.",
                " The module boundary looks clean.",
                "✓ find done",
                "╰─ settled",
                VERIFICATION_FAILURE_MESSAGE,
            ];
        case "lifecycle":
            return [
                "╭─ OpenCode · Task · session-1",
                "Working through a dense turn with lifecycle boundaries.",
                "↻ compacting context · context window nearing capacity",
                "↻ context compaction done",
                "↻ retrying OpenCode request · attempt 1/3",
                "OpenCode retry failed",
                "↻ retrying OpenCode request · attempt 2/3",
                "OpenCode retry succeeded",
                "↻ retrying context summary · attempt 1/2",
                "↻ context summary finished",
                "╰─ retrying…",
                "Retrying with a shorter context.",
                "╰─ settled",
                VERIFICATION_FAILURE_MESSAGE,
            ];
        case "abort":
            return [
                "╭─ OpenCode · Task · session-1",
                "Starting the aborted run session.",
                "✓ bash done",
                "╰─ settled",
                VERIFICATION_FAILURE_MESSAGE,
            ];
        case "breadcrumb-refresh":
            return [
                "╭─ OpenCode · Task · session-1",
                "First change lands on the existing path.",
                "✓ bash done",
                "│  › Waiting",
                "◐ running gate 1",
                "✓ gate 5 passed",
                "╰─ settled",
                VERIFICATION_FAILURE_MESSAGE,
            ];
        case "long-output":
            return [
                "╭─ OpenCode · Task · session-1",
                `✦ assistant done · ${LONG_TEXT.length} chars · truncated`,
                "$ echo",
                "✓ bash done",
                LONG_PROGRESS,
                "long output handled",
                "╰─ settled",
                VERIFICATION_FAILURE_MESSAGE,
            ];
        case "wide-grapheme":
            return [
                "╭─ OpenCode · Task · session-1",
                WIDE_TEXT,
                "$ echo",
                "✓ bash done",
                WIDE_PROGRESS_STARTED,
                WIDE_PROGRESS_DONE,
                "╰─ settled",
                VERIFICATION_FAILURE_MESSAGE,
            ];
        case "verbose-unsafe":
            return [
                "╭─ OpenCode · Task · session-1",
                "Authenticating against the artifact registry.",
                "$ upload the artifact bundle",
                "✓ bash done",
                "uploading artifact",
                "artifact uploaded",
                "╰─ settled",
                VERIFICATION_FAILURE_MESSAGE,
            ];
        case "split-credentials":
            return [
                "╭─ OpenCode · Task · session-1",
                `Bearer ${CREDENTIAL_TEXT}`,
                CREDENTIAL_RAW,
                "$ echo split",
                "✓ bash done",
                "╰─ settled",
                VERIFICATION_FAILURE_MESSAGE,
            ];
        case "resize":
            return [
                "╭─ OpenCode · Task · session-1",
                "Starting at the wide width for the first cycle.",
                "$ echo pre-resize",
                "✓ bash done",
                "$ echo post-resize",
                "✓ bash done",
                "checking the narrow region",
                "narrow region verified",
                "╰─ settled",
                VERIFICATION_FAILURE_MESSAGE,
            ];
    }
};

/**
 * Consecutive writeRaw chunks must land contiguously in the capture: no byte
 * from another stream may be interleaved between them.
 */
const expectContiguousRawChunks = (
    scenario: ScenarioName,
    text: string,
): void => {
    if (scenario === "interleaved-streams") {
        expect(text).toContain(`${INTERLEAVED_RAW[0]}${INTERLEAVED_RAW[1]}`);
    }
    if (scenario === "split-credentials") {
        expect(text).toContain(CREDENTIAL_RAW);
    }
};

/** A parsed JSON-mode stdout record. */
type JsonRecord = Readonly<Record<string, unknown>>;

/** Shape 1: a parsed JSON-mode progress event record. */
type ProgressRecord = JsonRecord & {
    readonly stage: string;
    readonly status: string;
    readonly runId: string;
    readonly timestamp: string;
    readonly message: string;
};

/** Shape 2: the lossless transcript envelope around one verbatim agent event. */
const isOpenCodeEventRecord = (record: JsonRecord): boolean =>
    record.type === "opencode_event" &&
    typeof record.sessionID === "string" &&
    typeof record.directory === "string" &&
    typeof record.event === "object" &&
    record.event !== null;

/**
 * Assistant text deltas carried by the `opencode_event` records, in emit
 * order. Every `text_delta` agent event yields exactly one record, so the
 * ordered deltas reassemble streamed content that was split across
 * chunk/delta boundaries contiguously.
 */
const textDeltasOf = (records: readonly JsonRecord[]): readonly string[] => {
    const deltas: string[] = [];
    for (const record of records) {
        if (!isOpenCodeEventRecord(record)) continue;
        const event = record.event as AgentSessionEvent;
        if (event.type !== "message_update") continue;
        const update = event.assistantMessageEvent;
        if (update.type !== "text_delta") continue;
        deltas.push(update.delta);
    }
    return deltas;
};

/** Multi-delta assistant messages per scenario, in emit order. */
const ASSEMBLED_MESSAGE_DELTAS: Partial<
    Readonly<Record<ScenarioName, readonly string[]>>
> = {
    completion: ASSISTANT_DELTAS,
    "interleaved-streams": INTERLEAVED_TEXT,
    "split-credentials": ["Bearer ", CREDENTIAL_TEXT],
};

/** Human-transcript glyphs that must never appear in JSON-mode stdout. */
const HUMAN_GLYPHS = [
    "✓",
    "✗",
    "│",
    "╭─",
    "╰─",
    "↻",
    "◐",
    "⚠",
    "✦",
    "›",
] as const;

/**
 * Parse every non-empty stdout line as one complete JSON record: the stream
 * is newline-delimited with no partial lines and no trailing garbage.
 */
const parseJsonRecords = (
    stdout: string,
    scenario: ScenarioName,
): readonly JsonRecord[] => {
    expect(stdout.endsWith("\n")).toBe(true);
    const lines = stdout.split("\n");
    expect(lines.at(-1)).toBe("");
    expect(lines.slice(0, -1)).not.toContain("");
    return lines
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as JsonRecord);
};

/**
 * Classify every record into exactly one of the two allowed shapes: a
 * progress event or an `opencode_event`. Nothing else is permitted.
 */
const classifyJsonRecords = (
    records: readonly JsonRecord[],
    scenario: ScenarioName,
): {
    readonly progressRecords: readonly JsonRecord[];
    readonly opencodeRecords: readonly JsonRecord[];
} => {
    const progressRecords: JsonRecord[] = [];
    const opencodeRecords: JsonRecord[] = [];
    for (const record of records) {
        if (isOpenCodeEventRecord(record)) {
            opencodeRecords.push(record);
            continue;
        }
        expect(
            typeof record.stage === "string" &&
                typeof record.status === "string" &&
                typeof record.runId === "string" &&
                typeof record.timestamp === "string" &&
                typeof record.message === "string",
            `${scenario} emitted a record that is neither a progress event nor an opencode_event: ${JSON.stringify(record)}`,
        ).toBe(true);
        progressRecords.push(record);
    }
    expect(
        progressRecords.length + opencodeRecords.length,
        `${scenario} json records were not all classified`,
    ).toBe(records.length);
    return { progressRecords, opencodeRecords };
};

/**
 * Agent events map one-to-one to lossless records: every record embeds its
 * scripted event verbatim inside the session envelope.
 */
const expectOpenCodeEventRecords = (
    opencodeRecords: readonly JsonRecord[],
    scenario: ScenarioName,
): void => {
    const expectedEvents = eventEmitsFor(scenario);
    expect(
        opencodeRecords.length,
        `${scenario} opencode_event record count`,
    ).toBe(expectedEvents.length);
    for (const [index, expected] of expectedEvents.entries()) {
        expect(
            opencodeRecords[index]?.event,
            `${scenario} opencode_event record ${index} payload`,
        ).toEqual(expected);
        expect(opencodeRecords[index]?.sessionID).toBe(context.sessionID);
        expect(opencodeRecords[index]?.directory).toBe(context.directory);
    }
};

/**
 * Progress records carry exactly the emitted fields with values verbatim:
 * one record per emit, one runId per run, and ISO-8601 timestamps.
 */
const expectProgressMatrix = (
    progressRecords: readonly JsonRecord[],
    scenario: ScenarioName,
): void => {
    const runIds = new Set<string>();
    for (const record of progressRecords) {
        runIds.add(record.runId as string);
    }
    expect(runIds.size, `${scenario} used multiple runIds`).toBe(1);

    for (const record of progressRecords) {
        const timestamp = record.timestamp as string;
        const parsed = new Date(timestamp);
        expect(
            Number.isNaN(parsed.getTime()),
            `${scenario} timestamp ${JSON.stringify(timestamp)} is not a valid date`,
        ).toBe(false);
        expect(
            parsed.toISOString(),
            `${scenario} timestamp ${JSON.stringify(timestamp)} is not ISO-8601`,
        ).toBe(timestamp);
    }

    const expectedProgress = progressEmitsFor(scenario);
    expect(progressRecords.length, `${scenario} progress record count`).toBe(
        expectedProgress.length,
    );
    for (const [index, update] of expectedProgress.entries()) {
        const actual = progressRecords[index];
        expect(
            actual,
            `${scenario} progress record ${index} missing`,
        ).toBeDefined();
        const record = actual as ProgressRecord;
        expect(record).toEqual({
            ...update,
            runId: record.runId,
            timestamp: record.timestamp,
        });
    }
};

/**
 * Lossless values (GH-180 unredacted contract): credential-like strings
 * inside `details` survive byte-exact, and content split across
 * chunks/deltas reassembles contiguously with writeRaw suppressed.
 */
const expectLosslessJsonValues = (
    progressRecords: readonly JsonRecord[],
    records: readonly JsonRecord[],
    stdout: string,
    scenario: ScenarioName,
): void => {
    // The `verbose-unsafe` scenario is the JSON-mode stand-in for the
    // `--output verbose` unsafe-details case: JSON never redacts, masks, or
    // elides what verbose mode surfaces.
    if (scenario === "verbose-unsafe") {
        const unsafeDetails = JSON.stringify(UNSAFE_DETAILS);
        const unsafeRecords = progressRecords.filter(
            (record) => JSON.stringify(record.details) === unsafeDetails,
        );
        expect(
            unsafeRecords.length,
            `${scenario} expected three unsafe-details records`,
        ).toBe(3);
        for (const record of unsafeRecords) {
            expect(record.details).toEqual(UNSAFE_DETAILS);
        }
        expect(stdout).toContain(UNSAFE_API_KEY);
        expect(stdout).toContain(UNSAFE_TOKEN);
        expect(stdout).toContain(unsafeDetails);
    }

    // Split-chunk/delta content: each logical emit produces exactly one
    // record, and joining the records in order reassembles the payload
    // contiguously.
    const deltaExpectations = ASSEMBLED_MESSAGE_DELTAS[scenario];
    if (deltaExpectations !== undefined) {
        const deltas = textDeltasOf(records);
        expect(
            deltas,
            `${scenario} text_delta emits did not map one-to-one to records`,
        ).toEqual([...deltaExpectations]);
        expect(deltas.join("")).toBe(deltaExpectations.join(""));
    }

    // writeRaw is suppressed in JSON: raw chunks never leak.
    if (scenario === "interleaved-streams") {
        for (const chunk of INTERLEAVED_RAW) {
            expect(
                stdout,
                `${scenario} raw chunk leaked into json stdout`,
            ).not.toContain(chunk);
        }
    }
    if (scenario === "split-credentials") {
        expect(stdout).not.toContain(CREDENTIAL_RAW);
        expect(stdout).not.toContain("sk-proj-");
        // The credential delivered in one text_delta lands byte-exact.
        expect(stdout).toContain(CREDENTIAL_TEXT);
    }
};

/** Assert stdout is free of control bytes and human-transcript glyphs. */
const expectCleanJsonStdout = (
    stdout: string,
    scenario: ScenarioName,
): void => {
    expectControlFree(stdout);
    for (const glyph of HUMAN_GLYPHS) {
        expect(
            stdout.includes(glyph),
            `${scenario} json stdout contains human glyph ${JSON.stringify(glyph)}`,
        ).toBe(false);
    }
};

describe("command runtime display: noninteractive fallback", () => {
    test("plain/CI output is deterministic, append-only, and control-free", async () => {
        const first = await mkdtemp(join(tmpdir(), "ralphie-plain-"));
        const second = await mkdtemp(join(tmpdir(), "ralphie-plain-"));
        try {
            const runOne = await runNoninteractiveCommand({
                args: ["owner/repository", "--workspace", first],
                terminal: NONINTERACTIVE_TERMINAL,
            });
            const runTwo = await runNoninteractiveCommand({
                args: ["owner/repository", "--workspace", second],
                terminal: NONINTERACTIVE_TERMINAL,
            });

            const text = runOne.stderrBytes();
            expect(text).not.toContain("\x1b");
            expect(text).not.toContain("\r");
            expect(text).toContain("╭─ OpenCode · Task · session-1");
            expect(text).toContain(ASSISTANT_DELTAS.join(""));
            expect(text).toContain("│  $ echo cycle 0");
            expect(text).toContain("✓ bash done");
            expect(text).toContain("✗ grep failed");
            expect(text).toContain("change written");
            // Two independent runs produce identical bytes.
            expect(runTwo.stderrBytes()).toBe(text);
            // stdout stays empty for human modes.
            expect(runOne.stdoutBytes()).toBe("");
        } finally {
            await rm(first, { recursive: true, force: true });
            await rm(second, { recursive: true, force: true });
        }
    });

    test("json mode emits parseable lossless JSON Lines on stdout", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "ralphie-json-"));
        try {
            const result = await runNoninteractiveCommand({
                args: argsFor("json", workspace),
                terminal: NONINTERACTIVE_TERMINAL,
            });

            const stdout = result.stdoutBytes();
            const lines = stdout.trim().split("\n");
            expect(lines.length).toBeGreaterThan(0);
            const runIds = new Set<string>();
            for (const line of lines) {
                const record = JSON.parse(line);
                expect(
                    record.type === "opencode_event" ||
                        record.stage !== undefined,
                ).toBe(true);
                if (record.runId !== undefined) runIds.add(record.runId);
            }
            expect(runIds.size).toBe(1);
            // Structured progress values and agent payloads stay lossless.
            expect(stdout).toContain('"verify":"bun run check"');
            expect(stdout).toContain('"command":"echo cycle 0');
            expect(stdout).toContain(
                '"directory":"/workspace/owner/repository"',
            );
            // No human transcript/summary rows and no control bytes.
            expect(stdout).not.toContain("╭─");
            expect(stdout).not.toContain("✓ bash done");
            expect(stdout).not.toContain("\x1b");
            expect(result.stderrBytes()).toBe("");
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    test("json mode emits a strict two-shape, lossless record matrix for every scenario", async () => {
        for (const scenario of SCENARIO_NAMES) {
            const workspace = await mkdtemp(join(tmpdir(), "ralphie-json-"));
            try {
                const result = await runNoninteractiveCommand({
                    args: argsFor("json", workspace),
                    terminal: NONINTERACTIVE_TERMINAL,
                    scenario,
                });
                const stdout = result.stdoutBytes();
                expect(
                    stdout.length,
                    `${scenario} json emitted nothing on stdout`,
                ).toBeGreaterThan(0);
                // JSON mode owns stdout; stderr stays empty.
                expect(result.stderrBytes()).toBe("");

                // (1) Every non-empty line parses as one complete JSON record.
                const records = parseJsonRecords(stdout, scenario);

                // (2) Every record is exactly one of two shapes.
                const { progressRecords, opencodeRecords } =
                    classifyJsonRecords(records, scenario);
                expectOpenCodeEventRecords(opencodeRecords, scenario);

                // (3)-(5) One runId, ISO-8601 timestamps, and one lossless
                // record per progress emit.
                expectProgressMatrix(progressRecords, scenario);

                // (5) Lossless unsafe values and split-chunk assembly.
                expectLosslessJsonValues(
                    progressRecords,
                    records,
                    stdout,
                    scenario,
                );

                // (6) No control bytes and no human glyphs.
                expectCleanJsonStdout(stdout, scenario);
            } finally {
                await rm(workspace, { recursive: true, force: true });
            }
        }
    });

    test("quiet mode suppresses routine activity but surfaces failures", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "ralphie-quiet-"));
        try {
            const result = await runNoninteractiveCommand({
                args: argsFor("quiet", workspace),
                terminal: NONINTERACTIVE_TERMINAL,
            });

            const text = result.stderrBytes();
            expect(text).not.toContain("╭─");
            expect(text).not.toContain(ASSISTANT_DELTAS.join(""));
            expect(text).not.toContain("change written");
            expect(text).toContain("✗");
            expect(text).toContain(VERIFICATION_FAILURE_MESSAGE);
            expect(text).not.toContain("\x1b");
            expect(result.stdoutBytes()).toBe("");
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    /**
     * Transcript, breadcrumb, writeRaw, and routine-progress content every
     * quiet run must suppress, per scenario.
     */
    const suppressedQuietContentFor = (
        scenario: ScenarioName,
    ): readonly string[] => {
        switch (scenario) {
            case "completion":
                return [
                    ASSISTANT_DELTAS.join(""),
                    "writing change",
                    "change written",
                    "✓ bash done",
                    "✗ grep failed",
                ];
            case "interleaved-streams":
                return [
                    INTERLEAVED_RAW[0],
                    INTERLEAVED_TEXT[0],
                    "assembling",
                    "assembled",
                ];
            case "thinking-tools":
                return [
                    "Let me look at the entry point and its imports.",
                    "find *.ts",
                    "✓ find done",
                ];
            case "lifecycle":
                return [
                    "Working through a dense turn with lifecycle boundaries.",
                    "↻ compacting context",
                    "↻ retrying OpenCode request",
                ];
            case "abort":
                return ["Starting the aborted run session.", "✓ bash done"];
            case "breadcrumb-refresh":
                return [
                    "First change lands on the existing path.",
                    "│  › Waiting",
                    "running gate 1",
                    "gate 5 passed",
                ];
            case "long-output":
                return [
                    LONG_TEXT.slice(0, 140),
                    LONG_PROGRESS,
                    "long output handled",
                ];
            case "wide-grapheme":
                return [WIDE_TEXT, WIDE_PROGRESS_STARTED, WIDE_PROGRESS_DONE];
            case "verbose-unsafe":
                return [
                    "Authenticating against the artifact registry.",
                    "uploading artifact",
                    "artifact uploaded",
                    "upload the artifact bundle",
                ];
            case "split-credentials":
                return [`Bearer ${CREDENTIAL_TEXT}`, CREDENTIAL_RAW];
            case "resize":
                return [
                    "Starting at the wide width for the first cycle.",
                    "checking the narrow region",
                    "narrow region verified",
                    "✓ bash done",
                ];
        }
    };

    /**
     * The suppression-scope invariant: in quiet mode every stderr line is a
     * failure or needs-attention progress line, so no transcript, breadcrumb,
     * raw, or routine-progress content can leak through.
     */
    const expectOnlyFailureLines = (
        scenario: ScenarioName,
        text: string,
    ): void => {
        for (const line of text.split("\n")) {
            if (line === "") continue;
            expect(
                line.startsWith("✗") || line.startsWith("⚠"),
                `${scenario} quiet emitted a non-failure line: ${JSON.stringify(line)}`,
            ).toBe(true);
        }
    };

    /** Assert the scenario-specific transcript content is fully suppressed. */
    const expectSuppressedQuietContent = (
        scenario: ScenarioName,
        text: string,
    ): void => {
        // No transcript frame or breadcrumb rows at all.
        expect(text).not.toContain("╭─");
        expect(text).not.toContain("│ ");
        // Scenario-specific transcript/breadcrumb/raw/routine content.
        for (const marker of suppressedQuietContentFor(scenario)) {
            expect(
                text,
                `${scenario} quiet leaked ${JSON.stringify(marker)}`,
            ).not.toContain(marker);
        }
    };

    test("quiet mode suppresses transcript, breadcrumbs, raw output, and routine progress for every scenario", async () => {
        for (const scenario of SCENARIO_NAMES) {
            const workspace = await mkdtemp(join(tmpdir(), "ralphie-quiet-"));
            try {
                const result = await runNoninteractiveCommand({
                    args: argsFor("quiet", workspace),
                    terminal: NONINTERACTIVE_TERMINAL,
                    scenario,
                });
                const text = result.stderrBytes();
                expect(
                    text.length,
                    `${scenario} quiet output was empty`,
                ).toBeGreaterThan(0);
                expectOnlyFailureLines(scenario, text);
                expectSuppressedQuietContent(scenario, text);
                // No control bytes anywhere in stderr; stdout stays empty.
                expectControlFree(text);
                expect(result.stdoutBytes()).toBe("");
            } finally {
                await rm(workspace, { recursive: true, force: true });
            }
        }
    });

    test("quiet mode surfaces failed and needs-attention events with symbols and full messages for every scenario", async () => {
        for (const scenario of SCENARIO_NAMES) {
            const workspace = await mkdtemp(join(tmpdir(), "ralphie-quiet-"));
            try {
                const result = await runNoninteractiveCommand({
                    args: argsFor("quiet", workspace),
                    terminal: NONINTERACTIVE_TERMINAL,
                    scenario,
                });
                const text = result.stderrBytes();
                // The failure outcome surfaces (the failing grep activity in
                // completion reports through the run's failed event) with its
                // `✗` symbol, full message, and supplied details verbatim;
                // the fixture's repository path and issue number/title render
                // on the same line exactly as supplied.
                expect(
                    text,
                    `${scenario} quiet dropped the failed event`,
                ).toContain(
                    `✗ [${LABEL_REPOSITORY}] #${LABEL_ISSUE.number} ${VERIFICATION_FAILURE_MESSAGE}`,
                );
                expect(text).toContain(
                    `✗ [${LABEL_REPOSITORY}] #${LABEL_ISSUE.number} ${VERIFICATION_FAILURE_MESSAGE} {"verify":"bun run check"}`,
                );
                // The needs-attention event surfaces with `⚠`, its message,
                // and the issue number and title verbatim.
                expect(
                    text,
                    `${scenario} quiet dropped the needs-attention event`,
                ).toContain(
                    `⚠ [${LABEL_REPOSITORY}] #${LABEL_ISSUE.number} ${LABEL_ISSUE.title} — ${VERIFICATION_NEEDS_ATTENTION_MESSAGE}`,
                );
                // No control bytes anywhere in stderr; stdout stays empty.
                expectControlFree(text);
                expect(result.stdoutBytes()).toBe("");
            } finally {
                await rm(workspace, { recursive: true, force: true });
            }
        }
    });

    test("quiet mode preserves unsafe failure and needs-attention values verbatim for the credential-like scenario", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "ralphie-quiet-"));
        try {
            const result = await runNoninteractiveCommand({
                args: argsFor("quiet", workspace),
                terminal: NONINTERACTIVE_TERMINAL,
                scenario: "verbose-unsafe",
            });
            const text = result.stderrBytes();
            // The needs-attention event surfaces with its full message and the
            // supplied details JSON: nothing is elided, replaced, or masked,
            // per the GH-180 unredacted output contract.
            expect(text).toContain("⚠ artifact upload requires attention");
            expect(text).toContain(JSON.stringify(UNSAFE_DETAILS));
            expect(text).toContain(UNSAFE_API_KEY);
            expect(text).toContain(UNSAFE_TOKEN);
            // The shared epilogue lines carry the repository path and issue
            // number/title verbatim as well.
            expect(text).toContain(
                `✗ [${LABEL_REPOSITORY}] #${LABEL_ISSUE.number} ${VERIFICATION_FAILURE_MESSAGE}`,
            );
            expect(text).toContain(
                `✗ [${LABEL_REPOSITORY}] #${LABEL_ISSUE.number} ${VERIFICATION_FAILURE_MESSAGE} {"verify":"bun run check"}`,
            );
            expect(text).toContain(
                `⚠ [${LABEL_REPOSITORY}] #${LABEL_ISSUE.number} ${LABEL_ISSUE.title} — ${VERIFICATION_NEEDS_ATTENTION_MESSAGE} {"verify":"bun run check"}`,
            );
            // No control bytes anywhere in stderr; stdout stays empty.
            expectControlFree(text);
            expect(result.stdoutBytes()).toBe("");
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    test("plain/CI and redirected outputs are control-free for every scenario and human mode", async () => {
        for (const scenario of SCENARIO_NAMES) {
            for (const terminal of NONINTERACTIVE_TERMINALS) {
                for (const mode of NONINTERACTIVE_MATRIX_MODES) {
                    const workspace = await mkdtemp(
                        join(tmpdir(), "ralphie-plain-"),
                    );
                    try {
                        const result = await runNoninteractiveCommand({
                            args: argsFor(mode, workspace),
                            terminal,
                            scenario,
                        });
                        const text = result.stderrBytes();
                        expect(
                            text.length,
                            `${scenario}/${terminalLabel(terminal)}/${mode} emitted nothing`,
                        ).toBeGreaterThan(0);
                        expectControlFree(text);
                    } finally {
                        await rm(workspace, { recursive: true, force: true });
                    }
                }
            }
        }
    });

    test("plain/CI and redirected outputs are byte-identical across runs with empty stdout", async () => {
        for (const scenario of SCENARIO_NAMES) {
            for (const terminal of NONINTERACTIVE_TERMINALS) {
                for (const mode of NONINTERACTIVE_MATRIX_MODES) {
                    const first = await mkdtemp(
                        join(tmpdir(), "ralphie-plain-"),
                    );
                    const second = await mkdtemp(
                        join(tmpdir(), "ralphie-plain-"),
                    );
                    try {
                        const runOne = await runNoninteractiveCommand({
                            args: argsFor(mode, first),
                            terminal,
                            scenario,
                        });
                        const runTwo = await runNoninteractiveCommand({
                            args: argsFor(mode, second),
                            terminal,
                            scenario,
                        });
                        expect(
                            runTwo.stderrBytes(),
                            `${scenario}/${terminalLabel(terminal)}/${mode} differed across runs`,
                        ).toBe(runOne.stderrBytes());
                        expect(runTwo.stderrBytes().length).toBeGreaterThan(0);
                        // stdout stays empty for every human-readable mode.
                        expect(runOne.stdoutBytes()).toBe("");
                        expect(runTwo.stdoutBytes()).toBe("");
                    } finally {
                        await rm(first, { recursive: true, force: true });
                        await rm(second, { recursive: true, force: true });
                    }
                }
            }
        }
    });

    test("raw chunks and transcript/breadcrumb lines stay in emit order for every scenario", async () => {
        for (const scenario of SCENARIO_NAMES) {
            for (const terminal of NONINTERACTIVE_TERMINALS) {
                const workspace = await mkdtemp(
                    join(tmpdir(), "ralphie-plain-"),
                );
                try {
                    const result = await runNoninteractiveCommand({
                        args: argsFor("default", workspace),
                        terminal,
                        scenario,
                    });
                    const text = result.stderrBytes();
                    let position = -1;
                    for (const marker of orderedMarkersFor(scenario)) {
                        // Search past the previous landmark so repeated rows
                        // (for example two identical tool outcomes) are each
                        // verified at their own emit position.
                        const found = text.indexOf(marker, position + 1);
                        expect(
                            found,
                            `${scenario}/${terminalLabel(terminal)} reordered or dropped ${JSON.stringify(marker)}`,
                        ).toBeGreaterThan(position);
                        position = found;
                    }
                    expectContiguousRawChunks(scenario, text);
                } finally {
                    await rm(workspace, { recursive: true, force: true });
                }
            }
        }
    });

    test("breadcrumb rows are append-only scrollback that survives the run unchanged", async () => {
        for (const terminal of NONINTERACTIVE_TERMINALS) {
            const workspace = await mkdtemp(join(tmpdir(), "ralphie-plain-"));
            try {
                const result = await runNoninteractiveCommand({
                    args: argsFor("default", workspace),
                    terminal,
                    scenario: "breadcrumb-refresh",
                });
                const text = result.stderrBytes();
                // One durable row per explicit breadcrumb, in scrollback order,
                // byte-identical to the inserted row, never re-emitted.
                const breadcrumbRows = text
                    .split("\n")
                    .filter((line) => line.startsWith("│  › Waiting"));
                expect(breadcrumbRows).toEqual([
                    "│  › Waiting",
                    "│  › Waiting",
                    "│  › Waiting",
                ]);
                expect(text.split("│  › Waiting")).toHaveLength(4);
                // The rows landed between the seeding tool and the gates.
                expect(text.indexOf("│  › Waiting")).toBeGreaterThan(
                    text.indexOf("✓ bash done"),
                );
                expect(text.indexOf("│  › Waiting")).toBeLessThan(
                    text.indexOf("◐ running gate 1"),
                );
            } finally {
                await rm(workspace, { recursive: true, force: true });
            }
        }
    });

    test("long output survives in full without control bytes or durable-stream truncation", async () => {
        for (const terminal of NONINTERACTIVE_TERMINALS) {
            const workspace = await mkdtemp(join(tmpdir(), "ralphie-plain-"));
            try {
                const result = await runNoninteractiveCommand({
                    args: argsFor("default", workspace),
                    terminal,
                    scenario: "long-output",
                });
                const text = result.stderrBytes();
                // Streamed assistant text reassembles contiguously up to the
                // transcript cap and reports the full reassembled length.
                const visible = LONG_TEXT.slice(0, 140);
                expect(text.split(visible)).toHaveLength(2);
                expect(text).toContain(
                    `✦ assistant done · ${LONG_TEXT.length} chars · truncated`,
                );
                // Long progress messages reach the durable stream in full.
                expect(text).toContain(LONG_PROGRESS);
                // The long tool line is a single clipped durable row.
                const toolLine = text
                    .split("\n")
                    .find((line) => line.includes("$ echo"));
                expect(toolLine).toBeDefined();
                expect(toolLine as string).toContain("…");
                expect(Bun.stringWidth(toolLine as string)).toBeLessThanOrEqual(
                    80,
                );
                expectControlFree(text);
            } finally {
                await rm(workspace, { recursive: true, force: true });
            }
        }
    });

    test("verbose mode renders progress details inline with values verbatim", async () => {
        for (const terminal of NONINTERACTIVE_TERMINALS) {
            const workspace = await mkdtemp(join(tmpdir(), "ralphie-plain-"));
            try {
                const result = await runNoninteractiveCommand({
                    args: argsFor("verbose", workspace),
                    terminal,
                    scenario: "verbose-unsafe",
                });
                const text = result.stderrBytes();
                const details = JSON.stringify(UNSAFE_DETAILS);
                // Details render inline as humanText(JSON.stringify(details)).
                expect(text).toContain(details);
                for (const message of [
                    "uploading artifact",
                    "artifact uploaded",
                ]) {
                    const line = text
                        .split("\n")
                        .find((candidate) => candidate.includes(message));
                    expect(
                        line,
                        `${message} line missing under ${terminalLabel(terminal)}`,
                    ).toBeDefined();
                    expect(line as string).toContain(details);
                }
                // Values survive verbatim with no terminal controls.
                expect(text).toContain(UNSAFE_API_KEY);
                expect(text).toContain(UNSAFE_TOKEN);
                expectControlFree(text);
                expect(result.stdoutBytes()).toBe("");
            } finally {
                await rm(workspace, { recursive: true, force: true });
            }
        }
    });
});

describe("scripted scenarios: emit-order and dimension contracts", () => {
    test("interleaved raw and agent streams preserve byte and emit order", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "ralphie-scn-"));
        try {
            const result = await runNoninteractiveCommand({
                args: argsFor("default", workspace),
                terminal: NONINTERACTIVE_TERMINAL,
                scenario: "interleaved-streams",
            });
            const text = result.stderrBytes();
            const order = [
                INTERLEAVED_RAW[0],
                INTERLEAVED_RAW[1],
                INTERLEAVED_TEXT[0],
                INTERLEAVED_RAW[2],
                INTERLEAVED_TEXT[1],
                INTERLEAVED_RAW[3],
                INTERLEAVED_TEXT[2],
                INTERLEAVED_RAW[4],
            ];
            const positions = order.map((part) => text.indexOf(part));
            for (let index = 1; index < positions.length; index += 1) {
                const previous = positions[index - 1] as number;
                const current = positions[index] as number;
                expect(previous).toBeGreaterThanOrEqual(0);
                expect(current).toBeGreaterThan(previous);
            }
            // Consecutive raw chunks stay contiguous in the byte stream.
            expect(text).toContain(
                `${INTERLEAVED_RAW[0]}${INTERLEAVED_RAW[1]}`,
            );
            // Progress emits interleave between the raw chunks.
            expect(text.indexOf("assembling")).toBeGreaterThan(
                text.indexOf(INTERLEAVED_RAW[3]),
            );
            expect(text.indexOf("assembled")).toBeGreaterThan(
                text.indexOf(INTERLEAVED_RAW[4]),
            );
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    test("thinking, assistant, toolcall, and tool execution streams interleave", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "ralphie-scn-"));
        try {
            const result = await runNoninteractiveCommand({
                args: argsFor("default", workspace),
                terminal: NONINTERACTIVE_TERMINAL,
                scenario: "thinking-tools",
            });
            const text = result.stderrBytes();
            expect(text).toContain(
                "Let me look at the entry point and its imports.",
            );
            expect(text).toContain(" The module boundary looks clean.");
            expect(text).toContain("│  find *.ts in /workspace");
            // Streaming thinking is compact-surface only; it never lands in
            // the human transcript.
            expect(text).not.toContain("We need to inspect");
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    test("lifecycle boundaries render in order and reopen the transcript session", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "ralphie-scn-"));
        try {
            const result = await runNoninteractiveCommand({
                args: argsFor("default", workspace),
                terminal: NONINTERACTIVE_TERMINAL,
                scenario: "lifecycle",
            });
            const text = result.stderrBytes();
            expect(text).toContain(
                "↻ compacting context · context window nearing capacity",
            );
            expect(text).toContain("↻ context compaction done");
            expect(text).toContain("↻ retrying OpenCode request · attempt 1/3");
            expect(text).toContain("OpenCode retry failed");
            expect(text).toContain("OpenCode retry succeeded");
            expect(text).toContain("↻ retrying context summary · attempt 1/2");
            expect(text).toContain("↻ retrying context summary");
            expect(text).toContain("↻ context summary finished");
            // `agent_end` with willRetry closes the session as retrying, and
            // the next `agent_start` opens a fresh transcript session.
            expect(text).toContain("╰─ retrying…");
            expect(text).toContain("╰─ settled");
            expect(text.split("╭─ OpenCode · Task · session-1")).toHaveLength(
                3,
            );
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    test("repeated live progress refreshes leave completed breadcrumbs undisturbed", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "ralphie-scn-"));
        try {
            const { strategy } = await runInteractiveCommand({
                workspace,
                scenario: "breadcrumb-refresh",
            });
            const durable = stripTerminalControls(durableBytes(strategy));
            const breadcrumbRows = durable
                .split("\n")
                .filter((line) => isBreadcrumbRow(line));
            // The three explicit breadcrumbs survive exactly once each.
            expect(breadcrumbRows).toHaveLength(3);
            // The live region repainted repeatedly over the completed rows.
            expect(strategy.clearCount()).toBeGreaterThanOrEqual(5);
            expect(
                strategy.ops().filter((op) => op.kind === "paint").length,
            ).toBeGreaterThanOrEqual(10);
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    test("long output is bounded in live rows and marked truncated", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "ralphie-scn-"));
        try {
            const result = await runNoninteractiveCommand({
                args: argsFor("default", workspace),
                terminal: NONINTERACTIVE_TERMINAL,
                scenario: "long-output",
            });
            const text = result.stderrBytes();
            expect(text).toContain(
                `✦ assistant done · ${LONG_TEXT.length} chars · truncated`,
            );
            expect(text).toContain("long output handled");
            const toolLine = text
                .split("\n")
                .find((line) => line.includes("$ echo"));
            expect(toolLine).toBeDefined();
            expect(toolLine).toContain("…");
            expect((toolLine as string).length).toBeLessThanOrEqual(80);

            const { strategy } = await runInteractiveCommand({
                workspace,
                scenario: "long-output",
            });
            expect(strategy.peakRegionRows()).toBeLessThanOrEqual(3);
            expect(strategy.currentRegion().length).toBeLessThanOrEqual(3);
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    test("narrow terminals with wide graphemes never split or wrap a row", async () => {
        for (const width of [80, 40, 24, 12, 8]) {
            const workspace = await mkdtemp(join(tmpdir(), "ralphie-scn-"));
            try {
                const { strategy } = await runInteractiveCommand({
                    workspace,
                    scenario: "wide-grapheme",
                    width,
                });
                const region = strategy.currentRegion();
                expect(region.length).toBeLessThanOrEqual(3);
                for (const row of region) {
                    expect(
                        Bun.stringWidth(stripTerminalControls(row)),
                    ).toBeLessThanOrEqual(width);
                }
                if (region.length > 0) {
                    const meter = new PhysicalRowMeter(width);
                    meter.feed(regionBytes(region));
                    expect(meter.rows()).toBe(region.length);
                }
                expect(strategy.peakRegionRows()).toBeLessThanOrEqual(3);
                // The wide-grapheme text survives intact in the transcript.
                const durable = stripTerminalControls(durableBytes(strategy));
                expect(durable).toContain(WIDE_TEXT);
            } finally {
                await rm(workspace, { recursive: true, force: true });
            }
        }
    });

    test("verbose mode surfaces unsafe detail values that plain mode omits", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "ralphie-scn-"));
        try {
            const verboseRun = await runNoninteractiveCommand({
                args: argsFor("verbose", workspace),
                terminal: NONINTERACTIVE_TERMINAL,
                scenario: "verbose-unsafe",
            });
            expect(verboseRun.stderrBytes()).toContain(UNSAFE_API_KEY);
            expect(verboseRun.stderrBytes()).toContain(UNSAFE_TOKEN);

            const plainRun = await runNoninteractiveCommand({
                args: argsFor("default", workspace),
                terminal: NONINTERACTIVE_TERMINAL,
                scenario: "verbose-unsafe",
            });
            expect(plainRun.stderrBytes()).not.toContain(UNSAFE_API_KEY);
            expect(plainRun.stderrBytes()).not.toContain(UNSAFE_TOKEN);
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    test("credential-like content split across chunk boundaries reassembles intact", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "ralphie-scn-"));
        try {
            const result = await runNoninteractiveCommand({
                args: argsFor("default", workspace),
                terminal: NONINTERACTIVE_TERMINAL,
                scenario: "split-credentials",
            });
            const text = result.stderrBytes();
            expect(text).toContain(`Bearer ${CREDENTIAL_TEXT}`);
            expect(text).toContain(CREDENTIAL_RAW);

            // Interactively the same tokens survive in the durable transcript.
            const { strategy } = await runInteractiveCommand({
                workspace,
                scenario: "split-credentials",
            });
            const durable = stripTerminalControls(durableBytes(strategy));
            expect(durable).toContain(`Bearer ${CREDENTIAL_TEXT}`);
            expect(durable).toContain(CREDENTIAL_RAW);
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    test("abort path disposes the coordinator cleanly without throwing", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "ralphie-scn-"));
        try {
            const { strategy } = await runInteractiveCommand({
                workspace,
                scenario: "abort",
            });
            // The scenario aborts its own run through the harness signal;
            // the run still completes and the controller restores the
            // terminal surface during disposal.
            expect(strategy.output().length).toBeGreaterThan(0);
            const kinds = strategy.ops().map((op) => op.kind);
            expect(kinds).toContain("restore");
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    test("pre-aborted input signal completes without throwing", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "ralphie-scn-"));
        try {
            const result = await runNoninteractiveCommand({
                args: argsFor("default", workspace),
                terminal: NONINTERACTIVE_TERMINAL,
                scenario: "abort",
                preAborted: true,
            });
            // Nothing was emitted before the aborted signal was observed.
            expect(result.stderrBytes()).toBe("");
            expect(result.stdoutBytes()).toBe("");
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    test("a throwing fake workflow still disposes and propagates the original error", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "ralphie-scn-"));
        let disposedKinds: readonly string[] = [];
        try {
            await expect(
                runInteractiveCommand({
                    workspace,
                    scenario: "completion",
                    workflowError: new Error("simulated workflow failure"),
                    onDisposed: (strategy) => {
                        disposedKinds = strategy.ops().map((op) => op.kind);
                    },
                }),
            ).rejects.toThrow("simulated workflow failure");
            // The coordinator still disposed the region cleanly.
            expect(disposedKinds).toContain("restore");
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });
});

describe("scripted scenarios: determinism", () => {
    test("human modes emit identical bytes for two independent runs of every scenario", async () => {
        for (const scenario of SCENARIO_NAMES) {
            const first = await mkdtemp(join(tmpdir(), "ralphie-det-"));
            const second = await mkdtemp(join(tmpdir(), "ralphie-det-"));
            try {
                const runOne = await runNoninteractiveCommand({
                    args: argsFor("default", first),
                    terminal: NONINTERACTIVE_TERMINAL,
                    scenario,
                });
                const runTwo = await runNoninteractiveCommand({
                    args: argsFor("default", second),
                    terminal: NONINTERACTIVE_TERMINAL,
                    scenario,
                });
                expect(runOne.stderrBytes()).toBe(runTwo.stderrBytes());
                expect(runOne.stderrBytes().length).toBeGreaterThan(0);
                expect(runOne.stdoutBytes()).toBe("");
            } finally {
                await rm(first, { recursive: true, force: true });
                await rm(second, { recursive: true, force: true });
            }
        }
    });

    test("verbose and quiet modes are byte-identical across runs", async () => {
        for (const mode of ["verbose", "quiet"] as const) {
            for (const scenario of SCENARIO_NAMES) {
                const first = await mkdtemp(join(tmpdir(), "ralphie-det-"));
                const second = await mkdtemp(join(tmpdir(), "ralphie-det-"));
                try {
                    const runOne = await runNoninteractiveCommand({
                        args: argsFor(mode, first),
                        terminal: NONINTERACTIVE_TERMINAL,
                        scenario,
                    });
                    const runTwo = await runNoninteractiveCommand({
                        args: argsFor(mode, second),
                        terminal: NONINTERACTIVE_TERMINAL,
                        scenario,
                    });
                    expect(runOne.stderrBytes()).toBe(runTwo.stderrBytes());
                    expect(runOne.stderrBytes().length).toBeGreaterThan(0);
                } finally {
                    await rm(first, { recursive: true, force: true });
                    await rm(second, { recursive: true, force: true });
                }
            }
        }
    });

    test("interactive output is byte-identical across two runs of every scenario", async () => {
        for (const scenario of SCENARIO_NAMES) {
            const first = await mkdtemp(join(tmpdir(), "ralphie-det-"));
            const second = await mkdtemp(join(tmpdir(), "ralphie-det-"));
            try {
                const runOne = await runInteractiveCommand({
                    workspace: first,
                    scenario,
                });
                const runTwo = await runInteractiveCommand({
                    workspace: second,
                    scenario,
                });
                expect(runOne.strategy.output()).toBe(runTwo.strategy.output());
                expect(runOne.strategy.output().length).toBeGreaterThan(0);
            } finally {
                await rm(first, { recursive: true, force: true });
                await rm(second, { recursive: true, force: true });
            }
        }
    });

    test("json mode differs only in the masked per-run metadata", async () => {
        for (const scenario of SCENARIO_NAMES) {
            const first = await mkdtemp(join(tmpdir(), "ralphie-det-"));
            const second = await mkdtemp(join(tmpdir(), "ralphie-det-"));
            try {
                const runOne = await runNoninteractiveCommand({
                    args: argsFor("json", first),
                    terminal: NONINTERACTIVE_TERMINAL,
                    scenario,
                });
                const runTwo = await runNoninteractiveCommand({
                    args: argsFor("json", second),
                    terminal: NONINTERACTIVE_TERMINAL,
                    scenario,
                });
                expect(maskRunMeta(runOne.stdoutBytes())).toBe(
                    maskRunMeta(runTwo.stdoutBytes()),
                );
                expect(runOne.stderrBytes()).toBe("");
                expect(runTwo.stderrBytes()).toBe("");
            } finally {
                await rm(first, { recursive: true, force: true });
                await rm(second, { recursive: true, force: true });
            }
        }
    });
});

describe("scripted scenarios: smoke coverage through both harnesses", () => {
    for (const scenario of SCENARIO_NAMES) {
        test(`interactive smoke: ${scenario}`, async () => {
            const workspace = await mkdtemp(join(tmpdir(), "ralphie-smoke-"));
            try {
                const { strategy } = await runInteractiveCommand({
                    workspace,
                    scenario,
                });
                expect(strategy.output().length).toBeGreaterThan(0);
            } finally {
                await rm(workspace, { recursive: true, force: true });
            }
        });

        test(`noninteractive smoke: ${scenario} across every output mode`, async () => {
            for (const mode of OUTPUT_MODES) {
                const workspace = await mkdtemp(
                    join(tmpdir(), "ralphie-smoke-"),
                );
                try {
                    const result = await runNoninteractiveCommand({
                        args: argsFor(mode, workspace),
                        terminal: NONINTERACTIVE_TERMINAL,
                        scenario,
                    });
                    expect(
                        result.stdoutBytes().length +
                            result.stderrBytes().length,
                    ).toBeGreaterThan(0);
                } finally {
                    await rm(workspace, { recursive: true, force: true });
                }
            }
        });
    }
});

/**
 * The GH-180 unredacted label contract, asserted uniformly across every
 * human-readable mode through one shared helper.
 *
 * - Labels verbatim: the fixture's repository path, issue number/title,
 *   progress stage label, activity label, and tool name appear exactly
 *   (substring equality) in the rendered output of the modes that render
 *   them.
 * - Lossless: `stripTerminalControls` is the only normalization; no value
 *   is redacted, elided, masked, or replaced.
 * - Channels per mode: the repository path and issue number/title ride on
 *   the shared failure/needs-attention progress lines, so every mode renders
 *   them; stage and activity labels live in the interactive display context
 *   (footer and activity surface) only, per "display-context-only"; tool
 *   names appear in the transcript and activity rows of interactive and
 *   plain modes. Quiet mode suppresses transcript/tool content by contract,
 *   so it carries no tool, stage, or activity label to preserve.
 */
type LabelMode = "interactive" | "plain" | "quiet";

const expectLabelLossless = (
    output: string,
    scenario: ScenarioName,
    mode: LabelMode,
): void => {
    // The raw renderer bytes feed in; stripping terminal controls here must
    // be the single normalization that reveals the verbatim values.
    const clean = stripTerminalControls(output);
    const tag = `${scenario}/${mode} label contract`;

    // Repository path, issue number, and issue title: carried by the shared
    // failure epilogue, so every human-readable mode renders them on the
    // failed and needs-attention lines.
    for (const [label, value] of [
        ["repository path", LABEL_REPOSITORY],
        ["issue number", `#${LABEL_ISSUE.number}`],
        ["issue title", LABEL_ISSUE.title],
    ] as const) {
        expect(clean, `${tag} ${label} verbatim`).toContain(value);
    }

    if (mode === "interactive") {
        // Display-context-only labels: the interactive footer and activity
        // surface render the stage label, the activity label, and the
        // tool-derived activity label; they never leak into durable rows.
        expect(clean, `${tag} stage label verbatim`).toContain(
            "Running verification",
        );
        expect(clean, `${tag} activity label verbatim`).toContain("Waiting");
        expect(clean, `${tag} tool activity label verbatim`).toContain(
            "Using bash",
        );
    }

    if (mode !== "quiet") {
        // Tool names surface in transcript and activity rows; quiet mode has
        // no tool content by contract.
        expect(clean, `${tag} tool name verbatim`).toContain("bash");
    }

    // No redaction, masking, or elision placeholder may replace any value.
    expect(clean, `${tag} no redaction placeholder`).not.toContain(
        "[REDACTED]",
    );
    expect(clean, `${tag} no mask placeholder`).not.toContain("***");
};

describe("command runtime display: GH-180 unredacted label contract", () => {
    test("interactive mode renders repository, issue, stage, activity, and tool labels verbatim", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "ralphie-labels-"));
        try {
            const { strategy } = await runInteractiveCommand({
                workspace,
                scenario: "split-credentials",
            });
            // The captured surface (live paints included) preserves every
            // label the interactive mode renders.
            expectLabelLossless(
                strategy.output(),
                "split-credentials",
                "interactive",
            );
            // The repository path and issue labels also survive in the
            // durable scrollback bytes after the region settles.
            const durable = stripTerminalControls(durableBytes(strategy));
            expect(durable).toContain(LABEL_REPOSITORY);
            expect(durable).toContain(`#${LABEL_ISSUE.number}`);
            expect(durable).toContain(LABEL_ISSUE.title);
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    test("plain/CI and verbose modes render repository, issue, and tool labels verbatim", async () => {
        for (const terminal of NONINTERACTIVE_TERMINALS) {
            for (const mode of ["default", "verbose"] as const) {
                const workspace = await mkdtemp(
                    join(tmpdir(), "ralphie-labels-"),
                );
                try {
                    const result = await runNoninteractiveCommand({
                        args: argsFor(mode, workspace),
                        terminal,
                        scenario: "split-credentials",
                    });
                    expectLabelLossless(
                        result.stderrBytes(),
                        "split-credentials",
                        "plain",
                    );
                } finally {
                    await rm(workspace, { recursive: true, force: true });
                }
            }
        }
    });

    test("quiet mode keeps repository and issue labels verbatim for every scenario", async () => {
        for (const scenario of SCENARIO_NAMES) {
            const workspace = await mkdtemp(join(tmpdir(), "ralphie-labels-"));
            try {
                const result = await runNoninteractiveCommand({
                    args: argsFor("quiet", workspace),
                    terminal: NONINTERACTIVE_TERMINAL,
                    scenario,
                });
                // Failure and needs-attention lines are the only quiet
                // content; the epilogue labels survive them verbatim,
                // including the issue title on the needs-attention line.
                expectLabelLossless(result.stderrBytes(), scenario, "quiet");
            } finally {
                await rm(workspace, { recursive: true, force: true });
            }
        }
    });

    test("credential content split across writeRaw and text_delta boundaries reassembles contiguously in durable output", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "ralphie-labels-"));
        try {
            // Interactive: the durable (non-paint) stream keeps the adjacent
            // chunks contiguous, in emit order, with nothing injected between
            // them.
            const { strategy } = await runInteractiveCommand({
                workspace,
                scenario: "split-credentials",
            });
            const durable = stripTerminalControls(durableBytes(strategy));
            expect(durable).toContain(`Bearer ${CREDENTIAL_TEXT}`);
            expect(durable).toContain(CREDENTIAL_RAW);
            expect(durable.indexOf(`Bearer ${CREDENTIAL_TEXT}`)).toBeLessThan(
                durable.indexOf(CREDENTIAL_RAW),
            );

            // Plain and verbose (plain with details) reassemble the same way
            // in the append-only stderr bytes.
            for (const terminal of NONINTERACTIVE_TERMINALS) {
                for (const mode of ["default", "verbose"] as const) {
                    const result = await runNoninteractiveCommand({
                        args: argsFor(mode, workspace),
                        terminal,
                        scenario: "split-credentials",
                    });
                    const text = result.stderrBytes();
                    expect(text).toContain(`Bearer ${CREDENTIAL_TEXT}`);
                    expect(text).toContain(CREDENTIAL_RAW);
                    expect(
                        text.indexOf(`Bearer ${CREDENTIAL_TEXT}`),
                    ).toBeLessThan(text.indexOf(CREDENTIAL_RAW));
                }
            }
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    test("interactive width clipping shortens live rows only; scrollback keeps the full values", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "ralphie-labels-"));
        try {
            for (const width of [12, 8]) {
                const { strategy, paintWidths } = await runInteractiveCommand({
                    workspace,
                    scenario: "split-credentials",
                    width,
                });
                // Live region rows stay clipped and unwrapped at the active
                // width (never spilling onto a second physical row).
                expectFramesFit(strategy, paintWidths);
                // Once the region settles, the durable scrollback preserves
                // the credential-split content and the label values in full,
                // even though the live rows were visually shortened.
                const durable = stripTerminalControls(durableBytes(strategy));
                expect(durable).toContain(`Bearer ${CREDENTIAL_TEXT}`);
                expect(durable).toContain(CREDENTIAL_RAW);
                expect(durable).toContain(LABEL_REPOSITORY);
                expect(durable).toContain(`#${LABEL_ISSUE.number}`);
                expect(durable).toContain(LABEL_ISSUE.title);
            }
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });
});