import { describe, expect, test } from "bun:test";

import {
    makeTerminalOutputController,
    type TerminalOutputStrategy,
} from "../../src/progress/terminal-controller.ts";
import type { FooterTimer } from "../../src/progress/footer.ts";

const CLEAR_LINE = "\r\x1b[2K";

const makeFakeSink = (): {
    readonly write: (text: string) => void;
    output: string;
} => {
    let output = "";
    return {
        write: (text) => {
            output += text;
        },
        get output() {
            return output;
        },
    };
};

const makeRecordingStrategy = (): {
    readonly strategy: TerminalOutputStrategy;
    readonly content: string[];
    readonly footers: string[];
    readonly clears: number;
    readonly events: string[];
} => {
    const content: string[] = [];
    const footers: string[] = [];
    const events: string[] = [];
    let clears = 0;
    return {
        strategy: {
            write: (text) => {
                content.push(text);
                events.push(`write:${text}`);
            },
            paintFooter: (text) => {
                footers.push(text);
                events.push(`paint:${text}`);
            },
            clearFooter: () => {
                clears += 1;
                events.push("clear");
            },
        },
        get content() {
            return content;
        },
        get footers() {
            return footers;
        },
        get clears() {
            return clears;
        },
        get events() {
            return events;
        },
    };
};

const makeFakeTimer = (): {
    readonly timer: FooterTimer;
    readonly scheduled: Array<() => void>;
} => {
    const scheduled: Array<() => void> = [];
    return {
        timer: {
            schedule: (callback) => {
                scheduled.push(callback);
                return scheduled.length;
            },
            cancel: () => {},
        },
        get scheduled() {
            return scheduled;
        },
    };
};

describe("terminal output controller", () => {
    test("forwards token deltas immediately through the content surface", () => {
        const recording = makeRecordingStrategy();
        const controller = makeTerminalOutputController({
            mode: "interactive",
            strategy: recording.strategy,
        });

        controller.beginLive("◐ Working...");
        expect(controller.isFooterVisible()).toBeTrue();

        // Three separate transcript events arrive synchronously.
        controller.writeTranscript("The");
        expect(controller.isFooterVisible()).toBeFalse();
        controller.writeTranscript(" quick");
        controller.writeTranscript(" brown\n");

        expect(recording.content.join("")).toBe("The quick brown\n");
        expect(controller.isFooterVisible()).toBeTrue();
    });

    test("forwards token deltas without touching the footer scheduler", () => {
        const { timer, scheduled } = makeFakeTimer();
        const recording = makeRecordingStrategy();
        const controller = makeTerminalOutputController({
            mode: "interactive",
            strategy: recording.strategy,
            footer: { timer },
        });

        controller.writeTranscript("a");
        controller.writeTranscript("b");
        controller.writeTranscript("c\n");

        expect(recording.content.join("")).toBe("abc\n");
        expect(scheduled).toHaveLength(0);
        controller.dispose();
    });

    test("clears a visible footer before transcript output", () => {
        const sink = makeFakeSink();
        const controller = makeTerminalOutputController({
            mode: "interactive",
            write: sink.write,
        });

        controller.beginLive("◐ Working...");
        controller.writeTranscript("> ");

        expect(sink.output).toBe(`◐ Working...${CLEAR_LINE}> `);
        expect(controller.isFooterVisible()).toBeFalse();
        controller.dispose();
    });

    test("suppresses the footer while a transcript line is partial", () => {
        const sink = makeFakeSink();
        const controller = makeTerminalOutputController({
            mode: "interactive",
            write: sink.write,
        });

        controller.beginLive("◐ Working...");
        controller.writeTranscript("partial");
        controller.writeTranscript(" line");

        // Mid-line: no footer restore, only the original clear.
        expect(sink.output).toBe(`◐ Working...${CLEAR_LINE}partial line`);
        expect(controller.isFooterVisible()).toBeFalse();
        controller.dispose();
    });

    test("restores the footer only at a safe line boundary", () => {
        const sink = makeFakeSink();
        const controller = makeTerminalOutputController({
            mode: "interactive",
            write: sink.write,
        });

        controller.beginLive("◐ Working...");
        controller.writeTranscript("partial");
        controller.writeTranscript(" line");
        controller.writeTranscript("\n");

        expect(sink.output).toBe(
            `◐ Working...${CLEAR_LINE}partial line\n◐ Working...`,
        );
        expect(controller.isFooterVisible()).toBeTrue();
        controller.dispose();
    });

    test("defers durable progress until a mid-line fragment completes", () => {
        const sink = makeFakeSink();
        const controller = makeTerminalOutputController({
            mode: "interactive",
            write: sink.write,
        });

        controller.writeTranscript("partial");
        controller.appendLine("• Still working.", "◐ Implementing...");
        expect(sink.output).toBe("partial");
        controller.writeTranscript(" token");
        controller.writeTranscript("\n");

        // The fragment bytes stay contiguous; progress appears after it ends
        // and never merges with, overwrites, or falsely closes the fragment.
        expect(sink.output).toBe(
            "partial token\n• Still working.\n◐ Implementing...",
        );
        controller.dispose();
    });

    test("interleaves durable progress immediately at a safe boundary", () => {
        const sink = makeFakeSink();
        const controller = makeTerminalOutputController({
            mode: "interactive",
            write: sink.write,
        });

        controller.writeTranscript("ready\n");
        controller.appendLine("• Progress.", "◐ Working...");

        expect(sink.output).toBe("ready\n• Progress.\n◐ Working...");
        controller.dispose();
    });

    test("does not split a control sequence with interleaved progress", () => {
        const sink = makeFakeSink();
        const controller = makeTerminalOutputController({
            mode: "interactive",
            write: sink.write,
        });

        controller.beginLive("◐ Working...");
        controller.writeTranscript("\x1b[31");
        controller.appendLine("• Progress.", "◐ Working...");
        controller.writeTranscript("m");
        controller.writeTranscript("done\n");

        // The SGR split is held by the boundary tracker: the progress line is
        // deferred until "m" closes the sequence, then flushed in order.
        expect(sink.output).toBe(
            `◐ Working...${CLEAR_LINE}\x1b[31` +
                `m• Progress.\n◐ Working...` +
                `${CLEAR_LINE}done\n◐ Working...`,
        );
        controller.dispose();
    });

    test("does not paint the footer while a control string is open", () => {
        const sink = makeFakeSink();
        const controller = makeTerminalOutputController({
            mode: "interactive",
            write: sink.write,
        });

        controller.beginLive("◐ Working...");
        controller.writeTranscript("\x1b]0;title");
        expect(sink.output).toBe(`◐ Working...${CLEAR_LINE}\x1b]0;title`);
        expect(controller.isFooterVisible()).toBeFalse();

        controller.writeTranscript("\x07");
        expect(sink.output).toBe(
            `◐ Working...${CLEAR_LINE}\x1b]0;title\x07◐ Working...`,
        );
        controller.dispose();
    });

    test("restores a replaced footer only after a safe boundary", () => {
        const sink = makeFakeSink();
        const controller = makeTerminalOutputController({
            mode: "interactive",
            write: sink.write,
        });

        controller.beginLive("◐ Old");
        controller.writeTranscript("mid");
        controller.setFooter("◐ New");
        expect(sink.output).toBe(`◐ Old${CLEAR_LINE}mid`);
        expect(controller.isFooterVisible()).toBeFalse();

        controller.writeTranscript(" line\n");
        expect(sink.output).toBe(`◐ Old${CLEAR_LINE}mid line\n◐ New`);
        controller.dispose();
    });

    test("keeps footer bytes out of the content and durable surfaces", () => {
        const recording = makeRecordingStrategy();
        const { timer, scheduled } = makeFakeTimer();
        const controller = makeTerminalOutputController({
            mode: "interactive",
            strategy: recording.strategy,
            footer: { timer },
        });

        controller.beginLive("◐ Working...");
        controller.writeTranscript("partial");
        controller.writeTranscript(" token\n");
        controller.setFooter("◐ New...");
        scheduled[0]?.();

        expect(recording.content.join("")).toBe("partial token\n");
        expect(recording.footers).toEqual([
            "◐ Working...",
            "◐ Working...",
            "◐ New...",
        ]);
        expect(recording.clears).toBe(2);
        controller.dispose();
    });

    test("clears a visible footer before every replacement repaint", () => {
        const recording = makeRecordingStrategy();
        const { timer, scheduled } = makeFakeTimer();
        const controller = makeTerminalOutputController({
            mode: "interactive",
            strategy: recording.strategy,
            footer: { timer },
        });

        controller.beginLive("◐ First");
        controller.beginLive("◐ Second");
        controller.setFooter("✓ Finished");
        controller.setFooter("✓ Finished");
        scheduled[0]?.();

        expect(recording.events).toEqual([
            "paint:◐ First",
            "clear",
            "paint:◐ Second",
            "clear",
            "paint:✓ Finished",
        ]);
        controller.dispose();
    });
});

describe("terminal output controller scheduler", () => {
    test("coalesces footer repaints through the fake timer", () => {
        const sink = makeFakeSink();
        const { timer, scheduled } = makeFakeTimer();
        const controller = makeTerminalOutputController({
            mode: "interactive",
            write: sink.write,
            footer: { timer },
        });

        controller.setFooter("A");
        controller.setFooter("B");
        controller.setFooter("C");

        expect(scheduled).toHaveLength(1);
        // Content changes coalesce: nothing is painted until the flush.
        expect(sink.output).toBe("");
        scheduled[0]?.();
        expect(sink.output).toBe("C");
        controller.dispose();
    });

    test("refreshes a state-driven footer through the scheduler", () => {
        const sink = makeFakeSink();
        const { timer, scheduled } = makeFakeTimer();
        let line = "◐ One";
        const controller = makeTerminalOutputController({
            mode: "interactive",
            write: sink.write,
            footer: { footerLine: () => line, timer },
        });

        controller.invalidate();
        scheduled[0]?.();
        expect(sink.output).toBe("◐ One");

        line = "◐ Two";
        controller.invalidate();
        expect(scheduled).toHaveLength(2);
        scheduled[1]?.();

        expect(sink.output).toBe(`◐ One${CLEAR_LINE}◐ Two`);
        controller.dispose();
    });

    test("scheduler repaints suppress the footer while the stream is unsafe", () => {
        const sink = makeFakeSink();
        const { timer, scheduled } = makeFakeTimer();
        const controller = makeTerminalOutputController({
            mode: "interactive",
            write: sink.write,
            footer: { timer },
        });

        controller.beginLive("◐ Working...");
        controller.writeTranscript("partial");
        scheduled[0]?.();

        expect(sink.output).toBe(`◐ Working...${CLEAR_LINE}partial`);
        expect(controller.isFooterVisible()).toBeFalse();

        controller.writeTranscript("\n");
        expect(sink.output).toBe(
            `◐ Working...${CLEAR_LINE}partial\n◐ Working...`,
        );
        controller.dispose();
    });
});

describe("terminal output controller modes", () => {
    test("plain mode stays append-only without footer bytes or deferral", () => {
        const sink = makeFakeSink();
        const controller = makeTerminalOutputController({
            mode: "plain",
            write: sink.write,
        });

        controller.beginLive("◐ ...");
        controller.writeTranscript("partial");
        controller.appendLine("• Progress.");
        controller.writeLine("Done.");

        expect(sink.output).toBe("partial\n• Progress.\nDone.\n");
        expect(sink.output).not.toContain("\r");
        expect(sink.output).not.toContain("\x1b");
        controller.dispose();
    });

    test("dispose finishes a partial fragment and rolls past the footer", () => {
        const sink = makeFakeSink();
        const controller = makeTerminalOutputController({
            mode: "interactive",
            write: sink.write,
        });

        controller.beginLive("◐ Working...");
        controller.writeTranscript("partial");
        controller.dispose();
        controller.dispose();

        expect(sink.output).toBe(`◐ Working...${CLEAR_LINE}partial\n`);
    });

    test("dispose rolls past a visible footer at a safe boundary", () => {
        const sink = makeFakeSink();
        const controller = makeTerminalOutputController({
            mode: "interactive",
            write: sink.write,
        });

        controller.beginLive("◐ Working...");
        controller.dispose();

        expect(sink.output).toBe("◐ Working...\n");
    });

    test("dispose flushes deferred progress lines in order", () => {
        const sink = makeFakeSink();
        const controller = makeTerminalOutputController({
            mode: "interactive",
            write: sink.write,
        });

        controller.writeTranscript("partial");
        controller.appendLine("• First.");
        controller.appendLine("• Second.");

        controller.dispose();

        expect(sink.output).toBe("partial\n• First.\n• Second.\n");
        expect(controller.isFooterVisible()).toBeFalse();
    });

    test("plain dispose finishes a partial line without control bytes", () => {
        const sink = makeFakeSink();
        const controller = makeTerminalOutputController({
            mode: "plain",
            write: sink.write,
        });

        controller.writeTranscript("unfinished");
        controller.dispose();

        expect(sink.output).toBe("unfinished\n");
    });
});