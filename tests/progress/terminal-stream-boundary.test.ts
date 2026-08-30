import { describe, expect, test } from "bun:test";

import { makeTerminalStreamBoundaryTracker } from "../../src/progress/terminal-stream-boundary.ts";

const initialState = {
    atLineBoundary: true,
    controlSequenceOpen: false,
    redrawSafe: true,
};

describe("terminal stream boundary tracking", () => {
    test("tracks visible partial lines and newline boundaries", () => {
        const tracker = makeTerminalStreamBoundaryTracker();

        expect(tracker.getState()).toEqual(initialState);
        tracker.write("partial");
        expect(tracker.getState()).toEqual({
            atLineBoundary: false,
            controlSequenceOpen: false,
            redrawSafe: false,
        });
        expect(tracker.isAtLineBoundary()).toBeFalse();
        expect(tracker.isRedrawSafe()).toBeFalse();

        tracker.write("\n");
        expect(tracker.getState()).toEqual(initialState);
        tracker.write("\n");
        expect(tracker.isSafeLineBoundary()).toBeTrue();
    });

    test("preserves CSI state across split chunks", () => {
        const tracker = makeTerminalStreamBoundaryTracker();

        tracker.write("line\n\u001b[31");
        expect(tracker.getState()).toEqual({
            atLineBoundary: true,
            controlSequenceOpen: true,
            redrawSafe: false,
        });

        tracker.write("m");
        expect(tracker.getState()).toEqual({
            atLineBoundary: true,
            controlSequenceOpen: false,
            redrawSafe: true,
        });
        tracker.write("visible");
        expect(tracker.isRedrawSafe()).toBeFalse();
    });

    test("preserves OSC state across chunks and accepts BEL termination", () => {
        const tracker = makeTerminalStreamBoundaryTracker();

        tracker.write("line\n\u001b]0;title");
        expect(tracker.isAtLineBoundary()).toBeTrue();
        expect(tracker.hasOpenControlSequence()).toBeTrue();
        expect(tracker.canRedraw()).toBeFalse();

        tracker.write("\u0007");
        expect(tracker.getState()).toEqual({
            atLineBoundary: true,
            controlSequenceOpen: false,
            redrawSafe: true,
        });
    });

    test("keeps a newline boundary but blocks redraw during a split SGR", () => {
        const tracker = makeTerminalStreamBoundaryTracker();

        tracker.write("\n\u001b[");
        expect(tracker.isAtLineBoundary()).toBeTrue();
        expect(tracker.isAtSafeLineBoundary()).toBeFalse();
        expect(tracker.isControlSequenceOpen()).toBeTrue();

        tracker.write("0m");
        expect(tracker.isAtSafeLineBoundary()).toBeTrue();
    });

    test.each([
        ["DCS", "P"],
        ["SOS", "X"],
        ["PM", "^"],
        ["APC", "_"],
    ])("handles %s with a split ST terminator", (_name, introducer) => {
        const tracker = makeTerminalStreamBoundaryTracker();

        tracker.write(`\n\u001b${introducer}payload\u001b`);
        expect(tracker.getState()).toEqual({
            atLineBoundary: true,
            controlSequenceOpen: true,
            redrawSafe: false,
        });

        tracker.write("\\");
        expect(tracker.getState()).toEqual({
            atLineBoundary: true,
            controlSequenceOpen: false,
            redrawSafe: true,
        });
    });

    test("does not treat control-string payload newlines as visible boundaries", () => {
        const tracker = makeTerminalStreamBoundaryTracker();

        tracker.write("visible\u001bPpayload\nmore");
        expect(tracker.getState()).toEqual({
            atLineBoundary: false,
            controlSequenceOpen: true,
            redrawSafe: false,
        });
        tracker.write("\u001b\\");
        expect(tracker.getState()).toEqual({
            atLineBoundary: false,
            controlSequenceOpen: false,
            redrawSafe: false,
        });
    });

    test("supports a completed ST and the 8-bit control-string forms", () => {
        const tracker = makeTerminalStreamBoundaryTracker();

        tracker.write("\n\u001bPpayload\u001b\\");
        expect(tracker.isRedrawSafe()).toBeTrue();

        tracker.write("\u009dtitle\u0007");
        tracker.write("\u0090dcs\u009c");
        tracker.write("\u0098sos\u009c");
        tracker.write("\u009epm\u009c");
        tracker.write("\u009fapc\u009c");
        expect(tracker.getState()).toEqual({
            atLineBoundary: true,
            controlSequenceOpen: false,
            redrawSafe: true,
        });
    });

    test("can reset an incomplete stream", () => {
        const tracker = makeTerminalStreamBoundaryTracker();

        tracker.write("partial\u001b]open");
        expect(tracker.isRedrawSafe()).toBeFalse();
        tracker.reset();

        expect(tracker.getState()).toEqual(initialState);
    });
});