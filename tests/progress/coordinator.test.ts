import { describe, expect, test } from "bun:test";

import type {
    AgentEventContext,
    AgentSessionEvent,
} from "../../src/opencode/client.ts";
import { makeProgressCoordinator } from "../../src/progress/coordinator.ts";
import type { FooterTimer } from "../../src/progress/footer.ts";
import { INTERACTIVE_REGION_MAX_ROWS } from "../../src/progress/terminal-controller.ts";
import type { TerminalOutputStrategy } from "../../src/progress/terminal-controller.ts";

const CLEAR = "\r\x1b[2K";

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

type StrategyRecorder = TerminalOutputStrategy & {
    readonly output: () => string;
    /** Rows painted in the final region repaint (the current visible region). */
    readonly finalRegion: () => string[];
};

const makeStrategyRecorder = (): StrategyRecorder => {
    let bytes = "";
    const paints: string[] = [];
    let lastClearIndex = -1;
    return {
        write: (text) => {
            bytes += text;
        },
        paintFooter: (text) => {
            bytes += text;
            paints.push(text);
        },
        clearFooter: () => {
            bytes += CLEAR;
            lastClearIndex = paints.length - 1;
        },
        restore: () => {},
        output: () => bytes,
        finalRegion: () => paints.slice(lastClearIndex + 1),
    };
};

type InteractiveHarness = ReturnType<typeof makeInteractiveHarness>;

/**
 * Coordinator harness in interactive mode backed by a fake strategy, fake
 * resize source, and fake refresh timer, mirroring `command.ts` wiring.
 */
const makeInteractiveHarness = (
    options: { readonly verbose?: boolean } = {},
) => {
    const strategy = makeStrategyRecorder();
    const timer = makeFakeTimer();
    const resize = makeResizeSource();
    let fallback = "";
    const coordinator = makeProgressCoordinator({
        mode: "interactive",
        verbose: options.verbose ?? false,
        colors: false,
        width: () => 80,
        strategy,
        resize,
        footer: { timer },
        write: (text) => {
            fallback += text;
        },
    });
    return {
        coordinator,
        strategy,
        timer,
        resize,
        fallback: () => fallback,
        settle: () => timer.run(),
    };
};

const makeBoundedCapture = (mode: "plain" | "json" | "quiet") => {
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
    return {
        coordinator,
        output: () => output,
    };
};

const toolStart = (toolCallId: string, toolName: string, args: unknown) =>
    asEvent({
        type: "tool_execution_start",
        toolCallId,
        toolName,
        args,
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

describe("coordinator activity wiring", () => {
    test("repeated tool updates replace one activity row and emit one transcript outcome", async () => {
        const { coordinator, strategy, settle } = makeInteractiveHarness();
        coordinator.listener(asEvent({ type: "agent_start" }), context);
        coordinator.listener(
            toolStart("tool-1", "bash", { command: "echo work" }),
            context,
        );
        for (let index = 0; index < 5; index += 1) {
            coordinator.listener(
                asEvent({
                    type: "tool_execution_update",
                    toolCallId: "tool-1",
                    toolName: "bash",
                    partialResult: { content: `chunk ${index} ` },
                }),
                context,
            );
        }
        coordinator.listener(
            toolEnd("tool-1", "bash", { content: "final output" }, false),
            context,
        );
        settle();
        await coordinator.dispose();

        const output = strategy.output();
        // The transcript records the call and one bounded outcome row only.
        expect(output).toContain("│  $ echo work");
        expect(output).toContain("│  ✓ bash done");
        expect(output.split("✓ bash done")).toHaveLength(2);
        expect(output).not.toContain("chunk");
        expect(output).not.toContain("final output");
        // The activity view keeps a single row for the repeated tool.
        const region = strategy.finalRegion();
        expect(region.filter((row) => row.includes("bash"))).toHaveLength(1);
        expect(region.length).toBeLessThanOrEqual(INTERACTIVE_REGION_MAX_ROWS);
    });

    test("missing or empty ids never crash or grow the activity registry", async () => {
        const { coordinator, strategy, settle } = makeInteractiveHarness();
        coordinator.listener(asEvent({ type: "agent_start" }), context);
        coordinator.listener(
            toolStart("", "bash", { command: "echo missing" }),
            context,
        );
        coordinator.listener(
            asEvent({
                type: "tool_execution_update",
                toolCallId: "",
                toolName: "bash",
                partialResult: { content: "x".repeat(200) },
            }),
            context,
        );
        coordinator.listener(
            toolEnd("", "bash", { content: "x".repeat(200) }, false),
            context,
        );
        for (let index = 0; index < 5; index += 1) {
            coordinator.listener(
                asEvent({
                    type: "bash_execution_update",
                    delta: `chunk ${index}`,
                }),
                context,
            );
        }
        coordinator.listener(asEvent({ type: "agent_settled" }), context);
        settle();
        await coordinator.dispose();

        const output = strategy.output();
        expect(output).toContain("│  ✓ bash done");
        expect(output.split("✓ bash done")).toHaveLength(2);
        expect(output).not.toContain("chunk");
        expect(output).not.toContain("x".repeat(10));
        const region = strategy.finalRegion();
        expect(region.length).toBeLessThanOrEqual(INTERACTIVE_REGION_MAX_ROWS);
    });

    test("interleaved assistant text is never cleared or corrupted by the region", async () => {
        const { coordinator, strategy, settle } = makeInteractiveHarness();
        coordinator.listener(asEvent({ type: "agent_start" }), context);
        coordinator.listener(
            asEvent({
                type: "message_update",
                assistantMessageEvent: {
                    type: "text_start",
                    contentIndex: 0,
                },
            }),
            context,
        );
        for (const delta of [
            "first ",
            "second ",
            "third ",
            "fourth ",
            "fifth",
        ]) {
            coordinator.listener(textDelta(delta), context);
        }
        // Intermediate activity updates arrive while the response streams.
        coordinator.listener(
            toolStart("tool-2", "grep", { pattern: "needle" }),
            context,
        );
        coordinator.listener(textDelta(" tail"), context);
        coordinator.listener(
            toolEnd("tool-2", "grep", { content: "match" }, false),
            context,
        );
        coordinator.listener(
            asEvent({
                type: "message_update",
                assistantMessageEvent: {
                    type: "text_end",
                    contentIndex: 0,
                },
            }),
            context,
        );
        settle();
        await coordinator.dispose();

        const output = strategy.output();
        const block = "first second third fourth fifth";
        // The whole streamed response survives intact and exactly once.
        expect(output.split(block)).toHaveLength(2);
        expect(output).toContain(" tail");
        expect(output.indexOf(" tail")).toBeGreaterThan(output.indexOf(block));
        const blockStart = output.indexOf(block);
        const blockEnd = blockStart + block.length;
        expect(output.slice(blockStart, blockEnd)).not.toContain(CLEAR);
        expect(output).not.toContain("\u0007");
    });

    test("tool success maps to a bounded activity row and one summary", async () => {
        const { coordinator, strategy, settle } = makeInteractiveHarness();
        coordinator.listener(
            toolStart("t1", "bash", { command: "echo ok" }),
            context,
        );
        coordinator.listener(
            toolEnd("t1", "bash", { content: "ok" }, false),
            context,
        );
        settle();
        await coordinator.dispose();

        const output = strategy.output();
        expect(output).toContain("│  ✓ bash done");
        expect(output).not.toContain("✓ bash failed");
        const region = strategy.finalRegion();
        expect(region.join("\n")).toContain("✓ bash echo ok");
        for (const row of region) {
            expect(row.length).toBeLessThanOrEqual(80);
        }
        expect(region.length).toBeLessThanOrEqual(INTERACTIVE_REGION_MAX_ROWS);
    });

    test("tool failure maps to a bounded sanitized activity row and summary", async () => {
        const { coordinator, strategy, settle } = makeInteractiveHarness();
        coordinator.listener(
            toolStart("t1", "grep", { pattern: "needle" }),
            context,
        );
        coordinator.listener(
            toolEnd(
                "t1",
                "grep",
                {
                    content:
                        "error: no matches for a very long pattern description that keeps going",
                },
                true,
            ),
            context,
        );
        settle();
        await coordinator.dispose();

        const output = strategy.output();
        expect(output).toContain(
            "✗ grep failed — error: no matches for a very long pattern",
        );
        // The failure summary is a single bounded line.
        const summary = output
            .split("\n")
            .find((line) => line.includes("✗ grep failed"));
        expect(summary).toBeDefined();
        expect((summary as string).length).toBeLessThanOrEqual(160);
        expect(output).not.toContain("✓ grep");

        const region = strategy.finalRegion();
        const failedRow = region.find((row) => row.includes("✗ grep"));
        expect(failedRow?.includes("no matches")).toBe(true);
        expect((failedRow ?? "").length).toBeLessThanOrEqual(80);
        for (const row of region) {
            expect(row.length).toBeLessThanOrEqual(80);
        }
        expect(region.length).toBeLessThanOrEqual(INTERACTIVE_REGION_MAX_ROWS);
    });

    test("active progress changes map to compact progress rows", async () => {
        const { coordinator, strategy, settle } = makeInteractiveHarness();
        const update = {
            stage: "implementation" as const,
            issue: { number: 7, title: "Fix bug" },
            current: 3,
            total: 5,
        };
        await coordinator.progress.emit({
            ...update,
            status: "started" as const,
            message: "writing fix",
        });
        await coordinator.progress.emit({
            ...update,
            status: "succeeded" as const,
            message: "fix written",
        });
        settle();
        await coordinator.dispose();

        const output = strategy.output();
        // Settled milestone remains a durable row.
        expect(output).toContain("fix written");
        // The compact region shows the leaf stage, never the raw message.
        const region = strategy.finalRegion();
        expect(region.join("\n")).toContain("Implementing changes");
        expect(region.join("\n")).not.toContain("writing fix");
        expect(region.length).toBeLessThanOrEqual(INTERACTIVE_REGION_MAX_ROWS);
    });

    test("verbose mode does not expand the interactive live row count", async () => {
        const { coordinator, strategy, settle } = makeInteractiveHarness({
            verbose: true,
        });
        coordinator.listener(asEvent({ type: "agent_start" }), context);
        for (let index = 0; index < 3; index += 1) {
            coordinator.listener(
                toolStart(`t${index}`, "bash", { command: `echo ${index}` }),
                context,
            );
            coordinator.listener(
                toolEnd(`t${index}`, "bash", { content: `${index}` }, false),
                context,
            );
        }
        await coordinator.progress.emit({
            stage: "implementation",
            status: "started",
            message: "writing",
            details: { attempt: 1, mode: "full" },
        });
        await coordinator.progress.emit({
            stage: "implementation",
            status: "succeeded",
            message: "fix written",
            details: { attempt: 1, mode: "full" },
        });
        settle();
        await coordinator.dispose();

        const output = strategy.output();
        // Verbose durable rows may carry details…
        expect(output).toContain('"attempt":1');
        expect(output).toContain("fix written");
        // …but the live region never grows beyond the shared row cap.
        expect(strategy.finalRegion().length).toBeLessThanOrEqual(
            INTERACTIVE_REGION_MAX_ROWS,
        );
        for (const row of strategy.finalRegion()) {
            expect(row.length).toBeLessThanOrEqual(80);
        }
    });

    test("interactive mode routes through the replaceable region and never the fallback sink", async () => {
        const { coordinator, strategy, settle, fallback } =
            makeInteractiveHarness();
        coordinator.listener(asEvent({ type: "agent_start" }), context);
        coordinator.listener(
            toolStart("t1", "bash", { command: "echo hi" }),
            context,
        );
        coordinator.listener(
            toolEnd("t1", "bash", { content: "hi" }, false),
            context,
        );
        settle();
        await coordinator.dispose();

        // All content flows through the strategy surface, not the `write` sink.
        expect(strategy.output()).toContain("│  $ echo hi");
        expect(fallback()).toBe("");
        const lastPaint = strategy.finalRegion();
        expect(lastPaint.length).toBeGreaterThan(0);
    });
});

describe("coordinator mode-specific contracts", () => {
    test("plain mode stays append-only with no cursor controls", async () => {
        const { coordinator, output } = makeBoundedCapture("plain");
        coordinator.listener(asEvent({ type: "agent_start" }), context);
        coordinator.listener(textDelta("hello world"), context);
        coordinator.listener(
            toolStart("p1", "bash", { command: "echo hi" }),
            context,
        );
        coordinator.listener(
            toolEnd("p1", "bash", { content: "hi" }, false),
            context,
        );
        await coordinator.progress.emit({
            stage: "implementation",
            status: "succeeded",
            message: "done now",
        });
        coordinator.listener(asEvent({ type: "agent_settled" }), context);
        await coordinator.dispose();

        const text = output();
        expect(text).toContain("╭─ OpenCode · Task · session-1");
        expect(text).toContain("hello world");
        expect(text).toContain("│  $ echo hi");
        expect(text).toContain("│  ✓ bash done");
        expect(text).toContain("done now");
        expect(text).not.toContain("\u001b");
        expect(text).not.toContain("\r");
    });

    test("json mode emits only lossless structured records", async () => {
        const { coordinator, output } = makeBoundedCapture("json");
        coordinator.listener(asEvent({ type: "agent_start" }), context);
        coordinator.listener(
            toolStart("j1", "bash", { command: "echo hi", secret: "value" }),
            context,
        );
        await coordinator.progress.emit({
            stage: "implementation",
            status: "succeeded",
            message: "done",
        });
        coordinator.listener(asEvent({ type: "agent_settled" }), context);
        await coordinator.dispose();

        const records = output()
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
        expect(records.length).toBeGreaterThan(0);
        for (const record of records) {
            expect(
                record.type === "opencode_event" || record.stage !== undefined,
            ).toBe(true);
        }
        // No human transcript rows and no cursor controls.
        expect(output()).not.toContain("╭─");
        expect(output()).not.toContain("│  $ echo hi");
        expect(output()).not.toContain("\u001b");
        // Structured payloads stay lossless.
        expect(output()).toContain('"command":"echo hi"');
        expect(output()).toContain('"secret":"value"');
    });

    test("quiet mode suppresses routine transcript and progress", async () => {
        const { coordinator, output } = makeBoundedCapture("quiet");
        coordinator.listener(asEvent({ type: "agent_start" }), context);
        coordinator.listener(textDelta("hidden"), context);
        await coordinator.progress.emit({
            stage: "implementation",
            status: "succeeded",
            message: "routine",
        });
        await coordinator.progress.emit({
            stage: "implementation",
            status: "failed",
            message: "boom",
        });
        await coordinator.dispose();

        const text = output();
        expect(text).not.toContain("╭─");
        expect(text).not.toContain("hidden");
        expect(text).not.toContain("routine");
        expect(text).toContain("✗");
        expect(text).toContain("boom");
    });
});