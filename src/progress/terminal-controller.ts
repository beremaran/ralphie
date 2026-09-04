import type { ProgressOutput, ProgressRenderMode } from "./progress.ts";
import {
    clipFooter,
    makeFooterRefreshScheduler,
    type FooterTimer,
} from "./footer.ts";
import { makeTerminalStreamBoundaryTracker } from "./terminal-stream-boundary.ts";

/**
 * Terminal primitives the controller drives.
 *
 * Splitting the footer surface from the content surface lets strategies own
 * cursor, reserved-row, and scroll-region mechanics without exposing those
 * mechanics to the transcript or progress renderer.
 */
export type TerminalOutputStrategy = {
    /** Emit arbitrary content bytes (transcript, durable progress lines). */
    readonly write: (text: string) => void;
    /** Paint a region row at the current cursor position (assumed line start). */
    readonly paintFooter: (text: string) => void;
    /** Erase the row at the current cursor position without touching content. */
    readonly clearFooter: () => void;
    /** Restore cursor and scroll state when the controller is disposed. */
    readonly restore: () => void;
};

/** Injectable source of terminal resize notifications. */
export type TerminalResizeSubscription = {
    readonly subscribe: (listener: () => void) => () => void;
};

export type TerminalResizeListener = (listener: () => void) => () => void;

/** State-driven footer content plus the refresh cadence. */
export type TerminalFooterOptions = {
    /**
     * Optional live renderer for display-state-driven footers. When absent the
     * controller uses the explicit lines supplied through beginLive, appendLine
     * and setFooter.
     */
    readonly footerLine?: () => string | undefined;
    /**
     * Optional bounded one-line activity rows rendered beneath the stage/status
     * line. Rows share the single replaceable interactive region with the
     * footer, whose total height never exceeds
     * {@link INTERACTIVE_REGION_MAX_ROWS} terminal rows.
     */
    readonly activityLines?: () => readonly string[] | undefined;
    /** Width used to clip region rows before they reach a terminal strategy. */
    readonly width?: () => number;
    /** Region refresh cadence; forwarded to the footer view scheduler. */
    readonly intervalMs?: number;
    /** Injectable timer for deterministic scheduler tests. */
    readonly timer?: FooterTimer;
};

export type TerminalOutputControllerOptions = {
    readonly mode: ProgressRenderMode;
    readonly write?: (text: string) => void;
    /** Replace the terminal surface primitives (defaults mirror stderr writes). */
    readonly strategy?: TerminalOutputStrategy;
    readonly footer?: TerminalFooterOptions;
    /** Current terminal width, sampled for every region paint and resize. */
    readonly width?: () => number;
    /** Injectable resize source; defaults to the interactive stderr stream. */
    readonly resize?: TerminalResizeSubscription | TerminalResizeListener;
    /** Compatibility alias for resize, useful when wiring an event source. */
    readonly onResize?: TerminalResizeListener;
    /** Compatibility alias for resize subscription wiring. */
    readonly subscribeResize?: TerminalResizeListener;
};

/**
 * The terminal output controller.
 *
 * A drop-in `ProgressOutput` that arbitrates every transcript/raw write with
 * the terminal stream boundary tracker and owns one replaceable interactive
 * region below the streamed content. The region holds the sticky stage/status
 * line plus the bounded activity view rows; its total height never exceeds
 * {@link INTERACTIVE_REGION_MAX_ROWS} terminal rows, each row is clipped
 * before it can wrap, and every replacement repaint erases the region in
 * place before redrawing it. Repaints are deferred while a transcript
 * fragment is open mid-line or a control sequence is incomplete, so region
 * bytes can never merge with, overwrite, or falsely close the fragment.
 * Region bytes are only ever emitted through the strategy's footer surface.
 */
export type TerminalOutputController = ProgressOutput & {
    /** Replace the footer content; safe draws are scheduled and coalesced. */
    readonly setFooter: (line: string) => void;
    /** True while the replaceable region is currently painted on screen. */
    readonly isFooterVisible: () => boolean;
    /** Coalesce a region repaint for display-state changes. */
    readonly invalidate: () => void;
};

const CLEAR_LINE = "\r\x1b[2K";
const CURSOR_UP = "\x1b[1A";

/**
 * Total height of the replaceable interactive region, including the
 * stage/status line: the footer plus at most this many terminal rows overall.
 */
export const INTERACTIVE_REGION_MAX_ROWS = 3;

/**
 * Locked interactive footer layout strategy (issue #313).
 *
 * Terminal-level evidence from the PTY streaming-stress fixture (high-rate
 * transcript/progress writes, narrow and dynamic resize, split/partial ANSI
 * input) and the PTY lifecycle fixture (normal completion, Ctrl-C/SIGINT,
 * failure, repeated cleanup) supports only the inline
 * durable-transcript-breadcrumbs layout. A reserved bottom row or DECSTBM
 * scroll region stays disabled: the controller repaints the replaceable
 * region in place below streamed content and never emits scroll-region or
 * absolute cursor-addressing sequences.
 */
export const INTERACTIVE_FOOTER_LAYOUT_STRATEGY =
    "durable-transcript-breadcrumbs" as const;
export type InteractiveFooterLayoutStrategy =
    typeof INTERACTIVE_FOOTER_LAYOUT_STRATEGY;
export const INTERACTIVE_FOOTER_USES_SCROLL_REGION = false as const;
export const INTERACTIVE_FOOTER_USES_RESERVED_ROW = false as const;

/** Default strategy: durable breadcrumb/content bytes share one byte sink. */
export const makeDefaultTerminalOutputStrategy = (
    write: (text: string) => void,
): TerminalOutputStrategy => ({
    write,
    paintFooter: write,
    clearFooter: () => write(CLEAR_LINE),
    restore: () => {},
});

/** Explicit name for the conservative, durable default strategy. */
export const makeDurableBreadcrumbStrategy = makeDefaultTerminalOutputStrategy;
export const makeDurableBreadcrumbTerminalOutputStrategy =
    makeDefaultTerminalOutputStrategy;

/**
 * Locked interactive default: the durable-transcript-breadcrumbs strategy.
 * Kept as a distinct export so a future reserved-row or scroll-region
 * strategy cannot silently become the default without updating the layout
 * lock and its regression coverage.
 */
export const makeInteractiveTerminalOutputStrategy =
    makeDurableBreadcrumbTerminalOutputStrategy;

const nativeResizeSubscription: TerminalResizeSubscription = {
    subscribe: (listener) => {
        process.stderr.on("resize", listener);
        return () => process.stderr.removeListener("resize", listener);
    },
};

const resizeSubscriptionFor = (
    resize: TerminalResizeSubscription | TerminalResizeListener | undefined,
    onResize: TerminalResizeListener | undefined,
): TerminalResizeListener => {
    if (resize !== undefined) {
        return typeof resize === "function"
            ? resize
            : (listener) => resize.subscribe(listener);
    }
    return (
        onResize ?? ((listener) => nativeResizeSubscription.subscribe(listener))
    );
};

export const makeTerminalOutputController = ({
    mode,
    write = (text) => process.stderr.write(text),
    strategy = makeInteractiveTerminalOutputStrategy(write),
    footer,
    width = footer?.width ?? (() => process.stderr.columns ?? 80),
    resize,
    onResize,
    subscribeResize,
}: TerminalOutputControllerOptions): TerminalOutputController => {
    const boundary = makeTerminalStreamBoundaryTracker();
    const interactive = mode === "interactive";
    let footerTarget: string | undefined;
    /** Rows currently painted on screen inside the replaceable region. */
    let regionRows: string[] = [];
    let regionShown = false;
    let resizePending = false;
    let disposed = false;
    const pendingLines: string[] = [];

    const footerContent = (): string | undefined =>
        footer?.footerLine === undefined ? footerTarget : footer.footerLine();

    /**
     * Append clipped, non-empty rows until the region reaches its height cap.
     */
    const appendClippedRows = (
        rows: string[],
        source: readonly string[],
        columnWidth: number,
    ): void => {
        for (const line of source) {
            if (rows.length >= INTERACTIVE_REGION_MAX_ROWS) return;
            const clipped = clipFooter(line, columnWidth);
            if (clipped !== "") rows.push(clipped);
        }
    };

    /**
     * Compose the replaceable region: the clipped stage/status line plus the
     * bounded activity rows, capped at {@link INTERACTIVE_REGION_MAX_ROWS}
     * terminal rows in total. Every row is clipped so it can never wrap.
     */
    const regionContent = (): string[] => {
        const columnWidth = width();
        const rows: string[] = [];
        const statusRow = footerContent();
        if (statusRow !== undefined && statusRow !== "") {
            rows.push(clipFooter(statusRow, columnWidth));
        }
        const activity = footer?.activityLines;
        if (activity === undefined) return rows;
        const activityRows = activity();
        if (activityRows !== undefined) {
            appendClippedRows(rows, activityRows, columnWidth);
        }
        return rows;
    };

    /**
     * Erase the visible region in place. The cursor rests on the last region
     * row, so each row is cleared and the cursor stepped up to the previous
     * row; afterwards the cursor sits on the cleared top region row just
     * below the streamed content.
     */
    const clearRegion = (): void => {
        if (!regionShown) return;
        const height = regionRows.length;
        for (let index = 0; index < height; index += 1) {
            strategy.clearFooter();
            if (index < height - 1) strategy.write(CURSOR_UP);
        }
        regionShown = false;
        regionRows = [];
    };

    /** Paint the region below the content; the last row keeps the cursor. */
    const paintRegion = (rows: readonly string[]): void => {
        rows.forEach((row, index) => {
            strategy.paintFooter(row);
            if (index < rows.length - 1) strategy.write("\n");
        });
    };

    /** Strict clear-before-draw: replacement repaints always erase first. */
    const renderRegion = (force = false): void => {
        const rows = regionContent();
        if (
            !force &&
            regionShown &&
            rows.length === regionRows.length &&
            rows.every((row, index) => row === regionRows[index])
        ) {
            return;
        }
        clearRegion();
        if (rows.length === 0) return;
        paintRegion(rows);
        regionShown = true;
        regionRows = rows;
    };

    const flushPending = (): void => {
        while (pendingLines.length > 0 && boundary.isRedrawSafe()) {
            const line = pendingLines.shift() as string;
            strategy.write(`${line}\n`);
            boundary.write(`${line}\n`);
        }
    };

    const scheduler = interactive
        ? makeFooterRefreshScheduler({
              repaint: () => {
                  if (disposed || !boundary.isRedrawSafe()) return;
                  renderRegion();
              },
              intervalMs: footer?.intervalMs,
              timer: footer?.timer,
          })
        : undefined;

    const invalidate = (): void => {
        if (!interactive || disposed) return;
        scheduler?.invalidate();
    };

    const restoreRegion = (): void => {
        if (!interactive || !boundary.isRedrawSafe()) return;
        const needsRedraw = resizePending || !regionShown;
        resizePending = false;
        if (needsRedraw) renderRegion(true);
    };

    const afterContentWrite = (): void => {
        if (!interactive) return;
        flushPending();
        restoreRegion();
    };

    /** Repaint at the new width, but never insert bytes into an unsafe stream. */
    const handleResize = (): void => {
        if (disposed) return;
        resizePending = true;
        clearRegion();
        if (!boundary.isRedrawSafe()) return;
        resizePending = false;
        renderRegion(true);
    };

    /** Close an open control sequence and finish a partial line. */
    const ensureLineBoundary = (): void => {
        if (boundary.hasOpenControlSequence()) {
            strategy.write("\x18");
            boundary.write("\x18");
        }
        if (!boundary.isRedrawSafe()) {
            strategy.write("\n");
            boundary.write("\n");
        }
    };

    const writeDurableLine = (line: string): void => {
        if (disposed) return;
        if (interactive && !boundary.isRedrawSafe()) {
            pendingLines.push(line);
            invalidate();
            return;
        }
        clearRegion();
        if (!interactive) ensureLineBoundary();
        strategy.write(`${line}\n`);
        boundary.write(`${line}\n`);
        if (interactive) afterContentWrite();
    };

    const resizeListener = resizeSubscriptionFor(
        resize,
        onResize ?? subscribeResize,
    );
    const unregisterResize = interactive
        ? resizeListener(handleResize)
        : () => {};

    return {
        beginLive: (line) => {
            if (disposed) return;
            footerTarget = line;
            if (!interactive) return;
            invalidate();
            if (!boundary.isRedrawSafe()) return;
            flushPending();
            renderRegion();
        },
        appendLine: (line, liveLine) => {
            if (disposed) return;
            if (liveLine !== undefined) footerTarget = liveLine;
            writeDurableLine(line);
        },
        writeLine: writeDurableLine,
        writeTranscript: (text) => {
            if (text.length === 0 || disposed) return;
            clearRegion();
            strategy.write(text);
            boundary.write(text);
            afterContentWrite();
        },
        setFooter: (line) => {
            if (disposed) return;
            footerTarget = line;
            if (!interactive) return;
            invalidate();
        },
        isFooterVisible: () => regionShown,
        invalidate,
        dispose: () => {
            if (disposed) return;
            disposed = true;
            scheduler?.dispose();
            unregisterResize();
            ensureLineBoundary();
            for (const line of pendingLines) strategy.write(`${line}\n`);
            pendingLines.length = 0;
            if (regionShown) {
                // Erase the live region in place so no footer/status or
                // activity fragment survives on the final screen, then settle
                // the cursor on a fresh line below the durable content.
                clearRegion();
                strategy.write("\n");
            }
            footerTarget = undefined;
            regionShown = false;
            regionRows = [];
            resizePending = false;
            boundary.reset();
            strategy.restore?.();
        },
    };
};