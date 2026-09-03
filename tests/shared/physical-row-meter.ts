import type { TerminalOutputStrategy } from "../../src/progress/terminal-controller.ts";

/**
 * Physical-row measurement primitives for the display regression suite.
 *
 * A terminal emulator interprets the exact bytes a controller emits (clear
 * lines `\r\x1b[2K`, cursor-up `\x1b[1A`, newlines, and ANSI/OSC sequences)
 * and reports how many physical rows the cursor actually occupies. Newline
 * counts are misleading for interactive output because region repaints erase
 * and re-paint in place; the emulator is the source of truth for the
 * three-row interactive region cap and for "rows never wrap under a narrow
 * terminal" guarantees.
 */

export const CLEAR_LINE = "\r\x1b[2K";
export const CURSOR_UP = "\x1b[1A";

/** One observable terminal-surface operation emitted by a strategy. */
export type StrategyOp =
    | { readonly kind: "write"; readonly text: string }
    | { readonly kind: "paint"; readonly text: string }
    | { readonly kind: "clear" }
    | { readonly kind: "restore" };

/**
 * Strategy recorder used to observe the replaceable interactive region
 * independent of the surrounding byte stream.
 */
export type RecordingStrategy = TerminalOutputStrategy & {
    readonly output: () => string;
    /** Rows painted in the most recent region repaint (current visible region). */
    readonly currentRegion: () => readonly string[];
    /** Highest number of rows the interactive region ever occupied. */
    readonly peakRegionRows: () => number;
    /** Total erase-row operations emitted (region repaints). */
    readonly clearCount: () => number;
    readonly ops: () => readonly StrategyOp[];
};

export const makeRecordingStrategy = (): RecordingStrategy => {
    let bytes = "";
    const paints: string[] = [];
    let regionStart = 0;
    let peak = 0;
    const ops: StrategyOp[] = [];

    const trackRegion = (): void => {
        const painted = paints.length - regionStart;
        if (painted > peak) peak = painted;
    };

    return {
        write: (text) => {
            bytes += text;
            ops.push({ kind: "write", text });
        },
        paintFooter: (text) => {
            bytes += text;
            paints.push(text);
            ops.push({ kind: "paint", text });
            trackRegion();
        },
        clearFooter: () => {
            bytes += CLEAR_LINE;
            ops.push({ kind: "clear" });
            regionStart = paints.length;
        },
        restore: () => {
            ops.push({ kind: "restore" });
        },
        output: () => bytes,
        currentRegion: () => paints.slice(regionStart),
        peakRegionRows: () => peak,
        clearCount: () => ops.filter((op) => op.kind === "clear").length,
        ops: () => ops,
    };
};

const graphemeSegmenter = new Intl.Segmenter(undefined, {
    granularity: "grapheme",
});

const isCsiFinal = (code: number): boolean => code >= 0x40 && code <= 0x7e;
const isCsiParam = (code: number): boolean => code >= 0x30 && code <= 0x3f;
const isCsiIntermediate = (code: number): boolean =>
    code >= 0x20 && code <= 0x2f;

/**
 * A minimal ECMA-48 terminal emulator. It tracks the cursor row and column,
 * erases and cursor motions only; SGR/OSC and other display-modifying
 * sequences are consumed without moving the cursor.
 */
export class PhysicalRowMeter {
    readonly width: number;
    private cursorRow = 0;
    private cursorCol = 0;
    private peakRow = 0;
    /** Cursor sits in the right margin after a full-width row (delayed wrap). */
    private pendingWrap = false;

    constructor(width = 80) {
        this.width = Math.max(1, Math.floor(width));
    }

    /** The physical row the cursor currently occupies (0-based). */
    readonly row = (): number => this.cursorRow;

    /** Physical rows currently occupied, counting from the top row. */
    readonly rows = (): number => this.cursorRow + 1;

    /** Highest row index the cursor ever reached during this trace. */
    readonly peakRowIndex = (): number => this.peakRow;

    /** Highest physical row count ever occupied during this trace. */
    readonly peakRows = (): number => this.peakRow + 1;

    private readonly advance = (rows: number): void => {
        this.cursorRow += rows;
        if (this.cursorRow > this.peakRow) this.peakRow = this.cursorRow;
    };

    private readonly placeCharacter = (characterWidth: number): void => {
        if (this.pendingWrap) {
            this.pendingWrap = false;
            this.advance(1);
            this.cursorCol = 0;
        }
        this.cursorCol += characterWidth;
        if (this.cursorCol > this.width) {
            // Overflow drops the remaining columns on the next row.
            this.cursorCol = 0;
            this.advance(1);
            return;
        }
        if (this.cursorCol === this.width) {
            // Full-width row: the wrap is deferred until the next printable.
            this.pendingWrap = true;
        }
    };

    private readonly consumeCsi = (text: string, start: number): number => {
        let index = start + 2;
        let parameters = "";
        while (index < text.length && isCsiParam(text.charCodeAt(index))) {
            parameters += text[index];
            index += 1;
        }
        while (
            index < text.length &&
            isCsiIntermediate(text.charCodeAt(index))
        ) {
            index += 1;
        }
        if (index >= text.length) return text.length;
        const final = text.charCodeAt(index);
        if (!isCsiFinal(final)) return index + 1;
        this.applyCsiMotion(parameters, text[index] as string);
        return index + 1;
    };

    private readonly applyCsiMotion = (
        parameters: string,
        final: string,
    ): void => {
        const firstParameter = Number(parameters.split(";")[0]) || 1;
        switch (final) {
            case "A":
                this.cursorRow = Math.max(0, this.cursorRow - firstParameter);
                return;
            case "B":
                this.advance(firstParameter);
                return;
            case "C":
                this.placeCharacter(firstParameter);
                return;
            case "D":
                this.cursorCol = Math.max(0, this.cursorCol - firstParameter);
                this.pendingWrap = false;
                return;
            case "G": {
                const column = firstParameter - 1;
                this.cursorCol = Math.max(0, Math.min(this.width - 1, column));
                this.pendingWrap = false;
                return;
            }
            case "H":
            case "f": {
                const [rowValue = 1, columnValue = 1] = parameters
                    .split(";")
                    .map((value) => Number(value));
                this.cursorRow = Math.max(0, (rowValue || 1) - 1);
                this.cursorCol = Math.max(0, (columnValue || 1) - 1);
                this.pendingWrap = false;
                return;
            }
            default:
                // Erase (J/K), SGR (m), and every other CSI final neither
                // moves the cursor down nor across.
                return;
        }
    };

    /** Consume OSC through BEL or ST (ESC \). Non-movable sequence. */
    private readonly consumeOsc = (text: string, start: number): number => {
        for (let index = start + 2; index < text.length; index += 1) {
            if (text.charCodeAt(index) === 0x07) return index + 1;
            if (
                text.charCodeAt(index) === 0x1b &&
                text.charCodeAt(index + 1) === 0x5c
            ) {
                return index + 2;
            }
        }
        return text.length;
    };

    /** Consume DCS/SOS/PM/APC string controls through ST (ESC \). */
    private readonly consumeStringControl = (
        text: string,
        start: number,
    ): number => {
        for (let index = start + 2; index < text.length; index += 1) {
            if (
                text.charCodeAt(index) === 0x1b &&
                text.charCodeAt(index + 1) === 0x5c
            ) {
                return index + 2;
            }
        }
        return text.length;
    };

    private readonly consumeEscape = (text: string, start: number): number => {
        // `start` points at the ESC byte; the sequence starts one byte later.
        const first = text.charCodeAt(start + 1);
        if (first === 0x5b) return this.consumeCsi(text, start);
        if (first === 0x5d) return this.consumeOsc(text, start);
        if (
            first === 0x50 ||
            first === 0x58 ||
            first === 0x5e ||
            first === 0x5f
        ) {
            return this.consumeStringControl(text, start);
        }
        if (
            first === 0x28 ||
            first === 0x29 ||
            first === 0x2a ||
            first === 0x2b
        ) {
            // Designate character set: intermediate + final.
            return Math.min(text.length, start + 3);
        }
        return start + 2;
    };

    private readonly consumeCharacter = (
        text: string,
        index: number,
    ): number => {
        const code = text.charCodeAt(index);
        if (code === 0x1b) return this.consumeEscape(text, index);
        if (code === 0x0a) {
            this.advance(1);
            this.cursorCol = 0;
            this.pendingWrap = false;
            return index + 1;
        }
        if (code === 0x0d) {
            this.cursorCol = 0;
            this.pendingWrap = false;
            return index + 1;
        }
        if (code === 0x08) {
            this.cursorCol = Math.max(0, this.cursorCol - 1);
            this.pendingWrap = false;
            return index + 1;
        }
        if (code === 0x09) {
            this.placeCharacter(8 - (this.cursorCol % 8));
            return index + 1;
        }
        if (code <= 0x1f || code === 0x7f) return index + 1;

        const character = text[index] ?? "";
        const characterWidth = Bun.stringWidth(character);
        if (characterWidth === 0) return index + 1;
        this.placeCharacter(characterWidth);
        return index + 1;
    };

    /** Consume a raw byte chunk exactly as a terminal would render it. */
    readonly feed = (text: string): void => {
        let index = 0;
        while (index < text.length) {
            index = this.consumeCharacter(text, index);
        }
    };

    readonly reset = (): void => {
        this.cursorRow = 0;
        this.cursorCol = 0;
        this.peakRow = 0;
        this.pendingWrap = false;
    };
}

/** Feed a recorded strategy's operations into a fresh meter. */
export const measureStrategyBytes = (
    strategy: RecordingStrategy,
    width: number,
): PhysicalRowMeter => {
    const meter = new PhysicalRowMeter(width);
    meter.feed(strategy.output());
    return meter;
};

/** Render region rows exactly as the controller paints them (no trailing LF). */
export const regionBytes = (rows: readonly string[]): string => rows.join("\n");