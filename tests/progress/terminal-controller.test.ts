import { describe, expect, test } from "bun:test";

import {
    INTERACTIVE_REGION_MAX_ROWS,
    makeTerminalOutputController,
} from "../../src/progress/terminal-controller.ts";
import type {
    TerminalOutputStrategy,
    TerminalResizeSubscription,
} from "../../src/progress/terminal-controller.ts";
import {
    PhysicalRowMeter,
    makeRecordingStrategy,
    regionBytes,
} from "../shared/physical-row-meter.ts";

const CLEAR = "\r\x1b[2K";
const UP = "\x1b[1A";

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
        listenerCount: () => listeners.length,
    };
};

const makeFakeStrategy = (): TerminalOutputStrategy & {
    readonly output: () => string;
    readonly restoreCount: () => number;
} => {
    let bytes = "";
    let restoreCount = 0;
    return {
        write: (text) => {
            bytes += text;
        },
        paintFooter: (text) => {
            bytes += text;
        },
        clearFooter: () => {
            bytes += CLEAR;
        },
        restore: () => {
            restoreCount += 1;
            bytes += "[restore]";
        },
        output: () => bytes,
        restoreCount: () => restoreCount,
    };
};

/**
 * Interactive controller harness backed by a fake strategy and fake resize
 * source. `setFooter` drives the displayed
 * stage/status line through both the surface `setFooter` path and the
 * injected `footerLine` closure, mirroring the coordinator wiring.
 */
const makeHarness = (
    options: {
        readonly mode?: "interactive" | "plain" | "json";
        readonly width?: () => number;
        readonly footerLine?: () => string | undefined;
        readonly activityLines?: () => readonly string[] | undefined;
    } = {},
) => {
    const strategy = makeFakeStrategy();
    const resize = makeResizeSource();
    let footerTarget: string | undefined;
    const controller = makeTerminalOutputController({
        mode: options.mode ?? "interactive",
        strategy,
        width: options.width ?? (() => 80),
        footer: {
            footerLine: options.footerLine ?? (() => footerTarget),
            activityLines: options.activityLines,
        },
        resize,
    });
    return {
        controller,
        strategy,
        resize,
        output: () => strategy.output(),
        settle: () => controller.flush(),
        setFooter: (line: string) => {
            footerTarget = line;
            controller.setFooter(line);
        },
    };
};

describe("terminal output controller region", () => {
    test("repaints a one-row region in place", async () => {
        const { output, settle, setFooter } = makeHarness();
        setFooter("◐ working");
        await settle();
        expect(output()).toBe("◐ working");
        setFooter("✓ done");
        await settle();
        expect(output()).toBe(`◐ working${CLEAR}✓ done`);
        expect(output()).not.toContain(UP);
    });

    test("repaints a two-row region in place", async () => {
        let activity: string[] = [];
        const { controller, output, settle, setFooter } = makeHarness({
            activityLines: () => (activity.length === 0 ? undefined : activity),
        });
        setFooter("A");
        await settle();
        expect(output()).toBe("A");

        activity = ["run bash"];
        controller.invalidate();
        await settle();
        expect(output()).toBe(`A${CLEAR}run bash\nA`);

        activity = ["run read"];
        controller.invalidate();
        await settle();
        expect(output()).toBe(
            `A${CLEAR}run bash\nA${CLEAR}${UP}${CLEAR}run read\nA`,
        );
    });

    test("repaints a three-row region in place", async () => {
        let activity = ["bash", "read"];
        const { controller, output, settle, setFooter } = makeHarness({
            activityLines: () => activity,
        });
        setFooter("stage");
        await settle();
        expect(output()).toBe("bash\nread\nstage");

        activity = ["write", "grep"];
        controller.invalidate();
        await settle();
        expect(output()).toBe(
            `bash\nread\nstage${CLEAR}${UP}${CLEAR}${UP}${CLEAR}write\ngrep\nstage`,
        );
    });

    test("caps the region at three rows including the stage/status line", async () => {
        const activity = ["a", "b", "c", "d"];
        const { output, settle, setFooter } = makeHarness({
            activityLines: () => activity,
        });
        setFooter("status");
        await settle();
        expect(output()).toBe("a\nb\nstatus");
        expect(output()).not.toContain("c");
        expect(INTERACTIVE_REGION_MAX_ROWS).toBe(3);
    });

    test("renders only the bounded activity rows when no stage/status line exists", async () => {
        const activity = ["a", "b", "c", "d"];
        const { controller, output, settle } = makeHarness({
            activityLines: () => activity,
        });
        controller.invalidate();
        await settle();
        expect(output()).toBe("a\nb\nc");
    });

    test("clips every region row before it can wrap", async () => {
        const long = "x".repeat(120);
        const { output, settle, setFooter } = makeHarness({
            width: () => 20,
        });
        setFooter(long);
        await settle();
        expect(Bun.stringWidth(output())).toBeLessThanOrEqual(20);
        expect(output()).toEndWith("…");
        expect(output()).not.toContain("x".repeat(21));
        expect(output()).not.toContain("\n");
    });

    test("clips long activity rows to the terminal width", async () => {
        const activity = ["a".repeat(50), "b".repeat(50)];
        const { output, settle, setFooter } = makeHarness({
            width: () => 10,
            activityLines: () => activity,
        });
        setFooter("status");
        await settle();
        const painted = output();
        for (const row of painted.split("\n")) {
            expect(Bun.stringWidth(row)).toBeLessThanOrEqual(10);
        }
        expect(painted).not.toContain("a".repeat(11));
    });

    test("narrow terminals still fit one physical row per region line", async () => {
        const { output, settle, setFooter } = makeHarness({
            width: () => 2,
        });
        setFooter("abcd");
        await settle();
        expect(Bun.stringWidth(output())).toBeLessThanOrEqual(2);
        expect(output()).not.toContain("\n");
    });

    test("bounds a 100-character footer and activity by physical rows", async () => {
        for (const width of [12, 20, 80]) {
            const strategy = makeRecordingStrategy();
            const controller = makeTerminalOutputController({
                mode: "interactive",
                strategy,
                width: () => width,
                footer: {
                    activityLines: () => [
                        "activity row ".repeat(10),
                        "second activity row ".repeat(10),
                    ],
                },
                resize: makeResizeSource(),
            });

            controller.setFooter("f".repeat(100));
            controller.flush();

            const rows = strategy.currentRegion();
            expect(rows.length).toBeLessThanOrEqual(
                INTERACTIVE_REGION_MAX_ROWS,
            );
            expect(rows).toHaveLength(3);
            for (const row of rows) {
                expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width);
            }
            const meter = new PhysicalRowMeter(width);
            meter.feed(regionBytes(rows));
            expect(meter.peakRows()).toBe(rows.length);

            controller.dispose();
        }
    });

    test("clips long footer and activity rows with ellipses without wrapping", async () => {
        const width = 20;
        const strategy = makeRecordingStrategy();
        const controller = makeTerminalOutputController({
            mode: "interactive",
            strategy,
            width: () => width,
            footer: {
                activityLines: () => ["a".repeat(100), "b".repeat(100)],
            },
            resize: makeResizeSource(),
        });

        controller.setFooter("footer ".repeat(20));
        controller.flush();

        const rows = strategy.currentRegion();
        expect(rows).toHaveLength(3);
        for (const row of rows) {
            expect(row).toEndWith("…");
            expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width);
        }
        const meter = new PhysicalRowMeter(width);
        meter.feed(regionBytes(rows));
        expect(meter.peakRows()).toBe(3);

        controller.dispose();
    });

    test("defers region repaints while a transcript line is open", async () => {
        const { controller, output, settle, setFooter } = makeHarness();
        controller.writeTranscript("half");
        setFooter("F");
        await settle();
        expect(output()).toBe("half");
        controller.writeTranscript(" line\n");
        expect(output()).toBe("half line\nF");
        expect(output()).not.toContain(UP);
    });

    test("never inserts region bytes into a split control sequence", async () => {
        const { controller, output, settle, setFooter } = makeHarness();
        controller.writeTranscript("\x1b[31");
        setFooter("F");
        await settle();
        expect(output()).toBe("\x1b[31");
        controller.writeTranscript("mred\x1b[0m\n");
        expect(output()).toBe("\x1b[31mred\x1b[0m\nF");
    });

    test("defers both split CSI and OSC sequences while preserving bytes", async () => {
        const cases = [
            ["\x1b[31", "mred\x1b[0m\n"],
            ["\x1b]8;;https://example.test", "\x1b\\linked\x1b]8;;\x1b\\\n"],
        ] as const;

        for (const [open, close] of cases) {
            const { controller, output, settle, setFooter } = makeHarness();
            controller.writeTranscript(open);
            setFooter("F");
            await settle();
            expect(output()).toBe(open);

            controller.writeTranscript(close);
            expect(output()).toBe(`${open}${close}F`);
            controller.dispose();
        }
    });

    test("streamed assistant text is never overwritten by the region", async () => {
        const { controller, output, settle, setFooter } = makeHarness();
        setFooter("live");
        await settle();
        expect(output()).toBe("live");

        controller.writeTranscript("user text\nnext");
        expect(output()).toBe(`live${CLEAR}user text\nnext`);

        controller.writeTranscript(" complete\n");
        expect(output()).toBe(`live${CLEAR}user text\nnext complete\nlive`);
        expect(output()).toContain("user text\nnext complete\n");
    });

    test("completion removal shrinks the region and clears stale rows", async () => {
        let activity = ["a", "b"];
        const { controller, output, settle, setFooter } = makeHarness({
            activityLines: () => activity,
        });
        setFooter("S");
        await settle();
        expect(output()).toBe("a\nb\nS");

        activity = [];
        controller.invalidate();
        await settle();
        expect(output()).toBe(`a\nb\nS${CLEAR}${UP}${CLEAR}${UP}${CLEAR}S`);
    });

    test("replaces a failed row in place when the operation settles", async () => {
        let activity = ["✗ failed op"];
        const { controller, output, settle, setFooter } = makeHarness({
            activityLines: () => activity,
        });
        setFooter("S");
        await settle();
        expect(output()).toBe("✗ failed op\nS");

        activity = ["✓ settled op"];
        controller.invalidate();
        await settle();
        expect(output()).toBe(
            `✗ failed op\nS${CLEAR}${UP}${CLEAR}✓ settled op\nS`,
        );
    });

    test("repaints the region at the new width on resize", async () => {
        let currentWidth = 20;
        const { output, settle, setFooter, resize } = makeHarness({
            width: () => currentWidth,
        });
        setFooter("abcdefghijklmnop");
        await settle();
        expect(Bun.stringWidth(output())).toBeLessThanOrEqual(20);

        currentWidth = 6;
        resize.emit();
        const after = output();
        expect(after).toContain(CLEAR);
        const lastPaint = after.slice(after.lastIndexOf(CLEAR) + CLEAR.length);
        expect(Bun.stringWidth(lastPaint)).toBeLessThanOrEqual(6);
    });

    test("clears the old region before repainting after a mid-run resize", async () => {
        let currentWidth = 20;
        const strategy = makeRecordingStrategy();
        const resize = makeResizeSource();
        const controller = makeTerminalOutputController({
            mode: "interactive",
            strategy,
            width: () => currentWidth,
            footer: {
                activityLines: () => ["activity"],
            },
            resize,
        });

        controller.setFooter("footer content");
        controller.flush();
        expect(strategy.currentRegion()).toEqual([
            "activity",
            "footer content",
        ]);

        currentWidth = 6;
        resize.emit();

        expect(strategy.clearCount()).toBe(5);
        expect(strategy.currentRegion()).toEqual(["activ…", "foote…"]);
        for (const row of strategy.currentRegion()) {
            expect(Bun.stringWidth(row)).toBeLessThanOrEqual(currentWidth);
        }
        const meter = new PhysicalRowMeter(currentWidth);
        meter.feed(regionBytes(strategy.currentRegion()));
        expect(meter.peakRows()).toBe(2);

        controller.dispose();
    });

    test("resize during an open line defers until the line closes", async () => {
        let currentWidth = 40;
        const { controller, output, resize, settle, setFooter } = makeHarness({
            width: () => currentWidth,
        });
        controller.writeTranscript("partial");
        setFooter("status");
        await settle();
        expect(output()).toBe("partial");

        currentWidth = 10;
        resize.emit();
        expect(output()).toBe("partial");

        controller.writeTranscript("\n");
        const after = output();
        expect(after.startsWith("partial\n")).toBe(true);
        const paint = after.slice("partial\n".length);
        expect(Bun.stringWidth(paint)).toBeLessThanOrEqual(10);
    });

    test("disposal erases the region in place, settles the cursor, and restores the strategy", async () => {
        const activity = ["run bash", "run read"];
        const { output, settle, setFooter, controller, strategy, resize } =
            makeHarness({
                activityLines: () => activity,
            });
        setFooter("stage");
        await settle();
        expect(output()).toBe("run bash\nrun read\nstage");
        controller.writeTranscript("assistant text\n");
        expect(output()).toBe(
            `run bash\nrun read\nstage${CLEAR}${UP}${CLEAR}${UP}${CLEAR}` +
                "assistant text\nrun bash\nrun read\nstage",
        );

        setFooter("pending repaint");
        const beforeDispose = output();
        expect(output()).toBe(beforeDispose);
        controller.dispose();
        // The region is erased in place and the stream settles on a fresh
        // line, so no footer/status or activity fragment survives on the
        // final surface.
        expect(output()).toBe(
            `run bash\nrun read\nstage${CLEAR}${UP}${CLEAR}${UP}${CLEAR}` +
                "assistant text\nrun bash\nrun read\nstage" +
                `${CLEAR}${UP}${CLEAR}${UP}${CLEAR}\n[restore]`,
        );
        const afterFirstDispose = output();
        expect(afterFirstDispose).not.toContain("pending repaint");
        controller.flush();
        expect(output()).toBe(afterFirstDispose);
        expect(strategy.restoreCount()).toBe(1);
        expect(resize.listenerCount()).toBe(0);
        // Double disposal is harmless: a second dispose writes no bytes.
        controller.dispose();
        expect(output()).toBe(afterFirstDispose);
        expect(strategy.restoreCount()).toBe(1);
        // A disposed controller ignores further region updates entirely.
        setFooter("stale");
        resize.emit();
        controller.invalidate();
        controller.flush();
        expect(output()).toBe(afterFirstDispose);
    });

    test("disposal flushes lines deferred by an open transcript line", async () => {
        const { controller, output } = makeHarness();
        controller.writeTranscript("partial");
        controller.writeLine("deferred durable");
        expect(output()).toBe("partial");

        controller.dispose();
        expect(output()).toBe("partial\ndeferred durable\n[restore]");
    });
});

describe("dispose safety", () => {
    test("double dispose is harmless: no bytes, no throw, later updates never repaint", async () => {
        const { controller, output, settle, setFooter } = makeHarness();
        setFooter("live");
        await settle();
        expect(output()).toBe("live");
        expect(controller.isFooterVisible()).toBe(true);

        controller.dispose();
        expect(controller.isFooterVisible()).toBe(false);
        const afterFirstDispose = output();

        // The second dispose throws nothing and writes no additional bytes.
        expect(() => controller.dispose()).not.toThrow();
        expect(output()).toBe(afterFirstDispose);
        expect(controller.isFooterVisible()).toBe(false);

        // Every later update path is inert for the region: durable lines may
        // flow, but the replaceable region can never be painted again.
        setFooter("stale");
        controller.invalidate();
        controller.writeLine("durable after dispose");
        controller.writeTranscript("stream after dispose");
        controller.beginLive("live after dispose");
        controller.appendLine("append after dispose", "live after dispose");
        controller.flush();
        expect(controller.isFooterVisible()).toBe(false);
        expect(output()).toBe(afterFirstDispose);
    });

    test("a pending footer timer is cancelled on dispose and cannot repaint", async () => {
        const { controller, output, settle, setFooter } = makeHarness();
        setFooter("live");
        await settle();
        expect(output()).toBe("live");

        // A repaint is pending when dispose runs: dispose cancels it.
        controller.invalidate();
        controller.dispose();
        const afterDispose = output();

        // The pending repaint never runs after dispose.
        controller.flush();
        expect(output()).toBe(afterDispose);
        expect(controller.isFooterVisible()).toBe(false);
    });

    test("an injected resize subscription is detached exactly once on dispose", async () => {
        const listeners: Array<() => void> = [];
        let unsubscribeCalls = 0;
        const resize: TerminalResizeSubscription & {
            readonly emit: () => void;
        } = {
            subscribe: (listener) => {
                listeners.push(listener);
                return () => {
                    unsubscribeCalls += 1;
                    const index = listeners.indexOf(listener);
                    if (index >= 0) listeners.splice(index, 1);
                };
            },
            emit: () => {
                for (const listener of [...listeners]) listener();
            },
        };
        const strategy = makeFakeStrategy();
        const controller = makeTerminalOutputController({
            mode: "interactive",
            strategy,
            resize,
        });
        // Paint a visible region so a stale resize would be observable.
        controller.setFooter("live");
        controller.flush();
        expect(strategy.output()).toBe("live");
        resize.emit();
        expect(strategy.output()).toBe(`live${CLEAR}live`);
        expect(listeners).toHaveLength(1);

        controller.dispose();
        expect(unsubscribeCalls).toBe(1);
        expect(listeners).toHaveLength(0);
        expect(controller.isFooterVisible()).toBe(false);
        const afterDispose = strategy.output();

        // The second dispose does not unsubscribe again.
        controller.dispose();
        expect(unsubscribeCalls).toBe(1);

        // Emitting resize after dispose writes nothing: the listener is gone.
        resize.emit();
        expect(strategy.output()).toBe(afterDispose);
    });

    test("the default resize listener is removed from process.stderr on dispose", async () => {
        const before = process.stderr.listenerCount("resize");
        const strategy = makeFakeStrategy();
        const controller = makeTerminalOutputController({
            mode: "interactive",
            strategy,
        });
        expect(process.stderr.listenerCount("resize")).toBe(before + 1);

        controller.dispose();
        expect(process.stderr.listenerCount("resize")).toBe(before);

        controller.dispose();
        expect(process.stderr.listenerCount("resize")).toBe(before);
    });
});

describe("append-only surfaces emit no cursor controls", () => {
    for (const mode of ["plain", "json"] as const) {
        test(`${mode} mode stays append-only even through region calls`, async () => {
            const strategy = makeFakeStrategy();
            const controller = makeTerminalOutputController({
                mode,
                strategy,
                footer: {
                    activityLines: () => ["a", "b", "c"],
                },
            });
            controller.beginLive("live");
            controller.appendLine("durable line", "live line");
            controller.setFooter("footer");
            controller.writeTranscript("assistant text");
            controller.invalidate();
            controller.dispose();
            const output = strategy.output();
            expect(output).toBe("durable line\nassistant text\n[restore]");
            expect(output).not.toContain("\x1b");
            expect(output).not.toContain("\r");
        });
    }
});

describe("region visibility", () => {
    test("isFooterVisible tracks the painted region", async () => {
        const { controller, settle, setFooter } = makeHarness();
        expect(controller.isFooterVisible()).toBe(false);
        setFooter("A");
        expect(controller.isFooterVisible()).toBe(false);
        await settle();
        expect(controller.isFooterVisible()).toBe(true);
        controller.dispose();
        expect(controller.isFooterVisible()).toBe(false);
    });

    test("surface setFooter paints when no footerLine is injected", async () => {
        const strategy = makeFakeStrategy();
        const controller = makeTerminalOutputController({
            mode: "interactive",
            strategy,
        });
        controller.setFooter("direct");
        expect(strategy.output()).toBe("");
        controller.flush();
        expect(strategy.output()).toBe("direct");
        // Dispose detaches the default process.stderr resize listener.
        controller.dispose();
    });
});