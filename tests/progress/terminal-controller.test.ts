import { describe, expect, test } from "bun:test";

import {
    INTERACTIVE_REGION_MAX_ROWS,
    makeTerminalOutputController,
} from "../../src/progress/terminal-controller.ts";
import type { TerminalOutputStrategy } from "../../src/progress/terminal-controller.ts";
import type { FooterTimer } from "../../src/progress/footer.ts";

const CLEAR = "\r\x1b[2K";
const UP = "\x1b[1A";

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

const makeFakeStrategy = (): TerminalOutputStrategy & {
    readonly output: () => string;
} => {
    let bytes = "";
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
            bytes += "[restore]";
        },
        output: () => bytes,
    };
};

type Harness = ReturnType<typeof makeHarness>;

/**
 * Interactive controller harness backed by a fake strategy, fake resize
 * source, and fake refresh timer. `setFooter` drives the displayed
 * stage/status line through both the surface `setFooter` path and the
 * injected `footerLine` closure, mirroring the coordinator wiring.
 */
const makeHarness = (
    options: {
        readonly mode?: "interactive" | "plain" | "json" | "quiet";
        readonly width?: () => number;
        readonly footerLine?: () => string | undefined;
        readonly activityLines?: () => readonly string[] | undefined;
    } = {},
) => {
    const strategy = makeFakeStrategy();
    const timer = makeFakeTimer();
    const resize = makeResizeSource();
    let footerTarget: string | undefined;
    const controller = makeTerminalOutputController({
        mode: options.mode ?? "interactive",
        strategy,
        width: options.width ?? (() => 80),
        footer: {
            footerLine: options.footerLine ?? (() => footerTarget),
            activityLines: options.activityLines,
            timer,
        },
        resize,
    });
    return {
        controller,
        strategy,
        timer,
        resize,
        output: () => strategy.output(),
        settle: () => timer.run(),
        setFooter: (line: string) => {
            footerTarget = line;
            controller.setFooter(line);
        },
    };
};

describe("terminal output controller region", () => {
    test("repaints a one-row region in place", () => {
        const { output, settle, setFooter } = makeHarness();
        setFooter("◐ working");
        settle();
        expect(output()).toBe("◐ working");
        setFooter("✓ done");
        settle();
        expect(output()).toBe(`◐ working${CLEAR}✓ done`);
        expect(output()).not.toContain(UP);
    });

    test("repaints a two-row region in place", () => {
        let activity: string[] = [];
        const { controller, output, settle, setFooter } = makeHarness({
            activityLines: () => (activity.length === 0 ? undefined : activity),
        });
        setFooter("A");
        settle();
        expect(output()).toBe("A");

        activity = ["run bash"];
        controller.invalidate();
        settle();
        expect(output()).toBe(`A${CLEAR}A\nrun bash`);

        activity = ["run read"];
        controller.invalidate();
        settle();
        expect(output()).toBe(
            `A${CLEAR}A\nrun bash${CLEAR}${UP}${CLEAR}A\nrun read`,
        );
    });

    test("repaints a three-row region in place", () => {
        let activity = ["bash", "read"];
        const { controller, output, settle, setFooter } = makeHarness({
            activityLines: () => activity,
        });
        setFooter("stage");
        settle();
        expect(output()).toBe("stage\nbash\nread");

        activity = ["write", "grep"];
        controller.invalidate();
        settle();
        expect(output()).toBe(
            `stage\nbash\nread${CLEAR}${UP}${CLEAR}${UP}${CLEAR}stage\nwrite\ngrep`,
        );
    });

    test("caps the region at three rows including the stage/status line", () => {
        const activity = ["a", "b", "c", "d"];
        const { output, settle, setFooter } = makeHarness({
            activityLines: () => activity,
        });
        setFooter("status");
        settle();
        expect(output()).toBe("status\na\nb");
        expect(output()).not.toContain("c");
        expect(INTERACTIVE_REGION_MAX_ROWS).toBe(3);
    });

    test("renders only the bounded activity rows when no stage/status line exists", () => {
        const activity = ["a", "b", "c", "d"];
        const { controller, output, settle } = makeHarness({
            activityLines: () => activity,
        });
        controller.invalidate();
        settle();
        expect(output()).toBe("a\nb\nc");
    });

    test("clips every region row before it can wrap", () => {
        const long = "x".repeat(120);
        const { output, settle, setFooter } = makeHarness({
            width: () => 20,
        });
        setFooter(long);
        settle();
        expect(Bun.stringWidth(output())).toBeLessThanOrEqual(20);
        expect(output()).toEndWith("…");
        expect(output()).not.toContain("x".repeat(21));
        expect(output()).not.toContain("\n");
    });

    test("clips long activity rows to the terminal width", () => {
        const activity = ["a".repeat(50), "b".repeat(50)];
        const { output, settle, setFooter } = makeHarness({
            width: () => 10,
            activityLines: () => activity,
        });
        setFooter("status");
        settle();
        const painted = output();
        for (const row of painted.split("\n")) {
            expect(Bun.stringWidth(row)).toBeLessThanOrEqual(10);
        }
        expect(painted).not.toContain("a".repeat(11));
    });

    test("narrow terminals still fit one physical row per region line", () => {
        const { output, settle, setFooter } = makeHarness({
            width: () => 2,
        });
        setFooter("abcd");
        settle();
        expect(Bun.stringWidth(output())).toBeLessThanOrEqual(2);
        expect(output()).not.toContain("\n");
    });

    test("defers region repaints while a transcript line is open", () => {
        const { controller, output, settle, setFooter } = makeHarness();
        controller.writeTranscript("half");
        setFooter("F");
        settle();
        expect(output()).toBe("half");
        controller.writeTranscript(" line\n");
        expect(output()).toBe("half line\nF");
        expect(output()).not.toContain(UP);
    });

    test("never inserts region bytes into a split control sequence", () => {
        const { controller, output, settle, setFooter } = makeHarness();
        controller.writeTranscript("\x1b[31");
        setFooter("F");
        settle();
        expect(output()).toBe("\x1b[31");
        controller.writeTranscript("mred\x1b[0m\n");
        expect(output()).toBe("\x1b[31mred\x1b[0m\nF");
    });

    test("streamed assistant text is never overwritten by the region", () => {
        const { controller, output, settle, setFooter } = makeHarness();
        setFooter("live");
        settle();
        expect(output()).toBe("live");

        controller.writeTranscript("user text\nnext");
        expect(output()).toBe(`live${CLEAR}user text\nnext`);

        controller.writeTranscript(" complete\n");
        expect(output()).toBe(`live${CLEAR}user text\nnext complete\nlive`);
        expect(output()).toContain("user text\nnext complete\n");
    });

    test("completion removal shrinks the region and clears stale rows", () => {
        let activity = ["a", "b"];
        const { controller, output, settle, setFooter } = makeHarness({
            activityLines: () => activity,
        });
        setFooter("S");
        settle();
        expect(output()).toBe("S\na\nb");

        activity = [];
        controller.invalidate();
        settle();
        expect(output()).toBe(`S\na\nb${CLEAR}${UP}${CLEAR}${UP}${CLEAR}S`);
    });

    test("replaces a failed row in place when the operation settles", () => {
        let activity = ["✗ failed op"];
        const { controller, output, settle, setFooter } = makeHarness({
            activityLines: () => activity,
        });
        setFooter("S");
        settle();
        expect(output()).toBe("S\n✗ failed op");

        activity = ["✓ settled op"];
        controller.invalidate();
        settle();
        expect(output()).toBe(
            `S\n✗ failed op${CLEAR}${UP}${CLEAR}S\n✓ settled op`,
        );
    });

    test("repaints the region at the new width on resize", () => {
        let currentWidth = 20;
        const { output, settle, setFooter, resize } = makeHarness({
            width: () => currentWidth,
        });
        setFooter("abcdefghijklmnop");
        settle();
        expect(Bun.stringWidth(output())).toBeLessThanOrEqual(20);

        currentWidth = 6;
        resize.emit();
        const after = output();
        expect(after).toContain(CLEAR);
        const lastPaint = after.slice(after.lastIndexOf(CLEAR) + CLEAR.length);
        expect(Bun.stringWidth(lastPaint)).toBeLessThanOrEqual(6);
    });

    test("resize during an open line defers until the line closes", () => {
        let currentWidth = 40;
        const { controller, output, resize, settle, setFooter } = makeHarness({
            width: () => currentWidth,
        });
        controller.writeTranscript("partial");
        setFooter("status");
        settle();
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

    test("disposal erases the region in place, settles the cursor, and restores the strategy", () => {
        const activity = ["run bash", "run read"];
        const { output, settle, setFooter, controller } = makeHarness({
            activityLines: () => activity,
        });
        setFooter("stage");
        settle();
        expect(output()).toBe("stage\nrun bash\nrun read");
        controller.writeTranscript("assistant text\n");
        expect(output()).toBe(
            `stage\nrun bash\nrun read${CLEAR}${UP}${CLEAR}${UP}${CLEAR}` +
                "assistant text\nstage\nrun bash\nrun read",
        );

        controller.dispose();
        // The region is erased in place and the stream settles on a fresh
        // line, so no footer/status or activity fragment survives on the
        // final surface.
        expect(output()).toBe(
            `stage\nrun bash\nrun read${CLEAR}${UP}${CLEAR}${UP}${CLEAR}` +
                "assistant text\nstage\nrun bash\nrun read" +
                `${CLEAR}${UP}${CLEAR}${UP}${CLEAR}\n[restore]`,
        );
        // Double disposal is harmless: a second dispose writes no bytes.
        const afterFirstDispose = output();
        controller.dispose();
        expect(output()).toBe(afterFirstDispose);
        // A disposed controller ignores further region updates entirely.
        setFooter("stale");
        controller.invalidate();
        settle();
        expect(output()).toBe(afterFirstDispose);
    });

    test("disposal flushes lines deferred by an open transcript line", () => {
        const { controller, output } = makeHarness();
        controller.writeTranscript("partial");
        controller.writeLine("deferred durable");
        expect(output()).toBe("partial");

        controller.dispose();
        expect(output()).toBe("partial\ndeferred durable\n[restore]");
    });
});

describe("append-only surfaces emit no cursor controls", () => {
    for (const mode of ["plain", "json", "quiet"] as const) {
        test(`${mode} mode stays append-only even through region calls`, () => {
            const strategy = makeFakeStrategy();
            const controller = makeTerminalOutputController({
                mode,
                strategy,
                footer: {
                    activityLines: () => ["a", "b", "c"],
                    timer: makeFakeTimer(),
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
    test("isFooterVisible tracks the painted region", () => {
        const { controller, settle, setFooter } = makeHarness();
        expect(controller.isFooterVisible()).toBe(false);
        setFooter("A");
        expect(controller.isFooterVisible()).toBe(false);
        settle();
        expect(controller.isFooterVisible()).toBe(true);
        controller.dispose();
        expect(controller.isFooterVisible()).toBe(false);
    });

    test("surface setFooter paints when no footerLine is injected", () => {
        const strategy = makeFakeStrategy();
        const timer = makeFakeTimer();
        const controller = makeTerminalOutputController({
            mode: "interactive",
            strategy,
            footer: { timer },
        });
        controller.setFooter("direct");
        expect(strategy.output()).toBe("");
        timer.run();
        expect(strategy.output()).toBe("direct");
    });
});