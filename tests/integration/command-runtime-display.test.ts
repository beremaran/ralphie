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
    makeRecordingStrategy,
    PhysicalRowMeter,
    regionBytes,
    type RecordingStrategy,
} from "../shared/physical-row-meter.ts";
import {
    ASSISTANT_DELTAS,
    CREDENTIAL_RAW,
    CREDENTIAL_TEXT,
    INTERLEAVED_RAW,
    INTERLEAVED_TEXT,
    LONG_TEXT,
    RESIZE_TARGET_WIDTH,
    SCENARIO_NAMES,
    UNSAFE_API_KEY,
    UNSAFE_TOKEN,
    VERIFICATION_FAILURE_MESSAGE,
    WIDE_TEXT,
    playScriptedScenario,
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
}): Promise<{ readonly strategy: RecordingStrategy }> => {
    const strategy = makeRecordingStrategy();
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
                    strategy,
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
                    await onSession({ strategy, timer, settle, samples });
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
        onDisposed?.(strategy);
    }
    return { strategy };
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
});

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