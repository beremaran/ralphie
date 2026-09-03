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
    PiEventContext,
    PiEventListener,
    PiSessionEvent,
} from "../../src/opencode/client.ts";
import type { OpenCodeProviderConfig } from "../../src/opencode/config.ts";
import type {
    OpenCodeRuntime,
    OpenCodeService,
} from "../../src/opencode/server.ts";
import {
    makeProgressCoordinator,
    type ProgressCoordinatorOptions,
} from "../../src/progress/coordinator.ts";
import type { FooterTimer } from "../../src/progress/footer.ts";
import type { RalphieRuntime } from "../../src/runtime.ts";
import { stripTerminalControls } from "../../src/shared/terminal.ts";
import type { WorkflowOptions } from "../../src/workflow.ts";
import {
    makeRecordingStrategy,
    PhysicalRowMeter,
    regionBytes,
    type RecordingStrategy,
} from "../shared/physical-row-meter.ts";

/**
 * End-to-end display regression through the real command runtime
 * (`runCommand`): real coordinator wiring, real mode resolution, and a fake
 * Pi service replaying a scripted session. Physical rows are measured with a
 * terminal emulator, never from newline counts.
 */

const context: PiEventContext = {
    sessionID: "session-1",
    directory: "/workspace/owner/repository",
    title: "Task",
};

const asEvent = (value: unknown): PiSessionEvent => value as PiSessionEvent;

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
        partialResult: { content: "intermediate tool output" },
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

const ASSISTANT_DELTAS = [
    "The first ",
    "framework ",
    "assembles ",
    "services ",
    "explicitly.",
];

/** Run one bounded bash + read cycle against the coordinator listener. */
const runToolCycle = (
    listener: PiEventListener,
    cycle: number,
    command: string,
): void => {
    const id = `tool-${cycle}`;
    listener(toolStart(id, "bash", { command }), context);
    for (let index = 0; index < 5; index += 1) {
        listener(toolUpdate(id, "bash"), context);
    }
    listener(
        toolEnd(id, "bash", { content: `output ${cycle}` }, false),
        context,
    );
    listener(
        toolStart(`read-${cycle}`, "read", {
            path: `/workspace/owner/repository/src/file-${cycle}.ts`,
        }),
        context,
    );
    listener(
        toolEnd(`read-${cycle}`, "read", { content: "source" }, false),
        context,
    );
};

/** Deterministic Pi + progress script exercised identically in every mode. */
const runScriptedSession = async (
    listener: PiEventListener,
    progress: RalphieRuntime["progress"],
    settle: (() => void) | undefined = undefined,
): Promise<void> => {
    listener(asEvent({ type: "agent_start" }), context);
    listener(
        asEvent({
            type: "message_update",
            assistantMessageEvent: {
                type: "text_start",
                contentIndex: 0,
            },
        }),
        context,
    );
    for (const delta of ASSISTANT_DELTAS) {
        listener(textDelta(delta), context);
    }
    for (let cycle = 0; cycle < 4; cycle += 1) {
        settle?.();
        runToolCycle(
            listener,
            cycle,
            `echo cycle ${cycle} step ${"x".repeat(90)}`,
        );
    }
    listener(toolStart("fail-1", "grep", { pattern: "needle" }), context);
    listener(
        toolEnd(
            "fail-1",
            "grep",
            {
                content:
                    "error: no matches found in the repository tree at all",
            },
            true,
        ),
        context,
    );
    await progress.emit({
        stage: "implementation",
        status: "started",
        message: "writing change",
    });
    await progress.emit({
        stage: "implementation",
        status: "succeeded",
        message: "change written",
    });
    await progress.emit({
        stage: "verification",
        status: "failed",
        message: "verification gate failed",
        details: { verify: "bun run check" },
    });
    listener(asEvent({ type: "agent_settled" }), context);
    settle?.();
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

/** Fake Pi service whose session replay is scripted by the fake workflow. */
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

/**
 * Interactive harness around the real command runtime: a fake TTY stderr
 * drives mode selection and resize while the coordinator routes its bytes
 * into a recording strategy so region rows and physical rows are observable.
 */
const runInteractiveCommand = async ({
    workspace,
    onSession,
}: {
    readonly workspace: string;
    readonly onSession: (session: DisplaySession) => Promise<void> | void;
}): Promise<void> => {
    const strategy = makeRecordingStrategy();
    const timer = makeFakeTimer();
    const samples: number[] = [];
    const fakeStderr = makeFakeStderr(80);
    const originalDescriptor = Object.getOwnPropertyDescriptor(
        process,
        "stderr",
    );
    Object.defineProperty(process, "stderr", {
        value: fakeStderr,
        configurable: true,
    });
    let listener: PiEventListener | undefined;
    try {
        const factories: CommandFactories = {
            makeCoordinator: (options: ProgressCoordinatorOptions) =>
                makeProgressCoordinator({
                    ...options,
                    strategy,
                    footer: { timer },
                }),
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
                const piListener = listener as PiEventListener;
                const settle = (): void => {
                    timer.run();
                    samples.push(strategy.currentRegion().length);
                };
                await runScriptedSession(piListener, runtime.progress, settle);
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
                width: 80,
            } satisfies CliTerminalInfo,
            output: makeCapture(),
            factories,
        });
    } finally {
        if (originalDescriptor !== undefined) {
            Object.defineProperty(process, "stderr", originalDescriptor);
        } else {
            delete (process as { stderr?: unknown }).stderr;
        }
    }
};

/** Noninteractive harness: plain/CI, JSON, and quiet modes need no TTY. */
const runNoninteractiveCommand = async ({
    args,
    terminal,
}: {
    readonly args: readonly string[];
    readonly terminal: CliTerminalInfo;
}): Promise<ReturnType<typeof makeCapture>> => {
    const capture = makeCapture();
    let listener: PiEventListener | undefined;
    await runCommand([...args], {
        terminal,
        output: capture,
        factories: {
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
                await runScriptedSession(
                    listener as PiEventListener,
                    runtime.progress,
                );
                return noopSummary;
            },
        },
    });
    return capture;
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
                    expect(clean).toContain("verification gate failed");

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
                onSession: ({ strategy, settle }) => {
                    const narrow = 12;
                    const fakeStderr = process.stderr as unknown as {
                        readonly setWidth: (width: number) => void;
                        readonly emitResize: () => void;
                    };
                    fakeStderr.setWidth(narrow);
                    fakeStderr.emitResize();
                    settle();

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
                },
            });
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });
});

describe("command runtime display: noninteractive fallback", () => {
    const terminal: CliTerminalInfo = {
        isInteractive: false,
        isCI: true,
        width: 80,
    };

    test("plain/CI output is deterministic, append-only, and control-free", async () => {
        const first = await mkdtemp(join(tmpdir(), "ralphie-plain-"));
        const second = await mkdtemp(join(tmpdir(), "ralphie-plain-"));
        try {
            const runOne = await runNoninteractiveCommand({
                args: ["owner/repository", "--workspace", first],
                terminal,
            });
            const runTwo = await runNoninteractiveCommand({
                args: ["owner/repository", "--workspace", second],
                terminal,
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
                args: [
                    "owner/repository",
                    "--output",
                    "json",
                    "--workspace",
                    workspace,
                ],
                terminal,
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
            // Structured progress values and Pi payloads stay lossless.
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
                args: [
                    "owner/repository",
                    "--output",
                    "quiet",
                    "--workspace",
                    workspace,
                ],
                terminal,
            });

            const text = result.stderrBytes();
            expect(text).not.toContain("╭─");
            expect(text).not.toContain(ASSISTANT_DELTAS.join(""));
            expect(text).not.toContain("change written");
            expect(text).toContain("✗");
            expect(text).toContain("verification gate failed");
            expect(text).not.toContain("\x1b");
            expect(result.stdoutBytes()).toBe("");
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });
});