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
    /** Paint a footer at the current cursor position (assumed line start). */
    readonly paintFooter: (text: string) => void;
    /** Erase the currently visible footer without touching content. */
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
    /** Width used to clip footer text before it reaches a terminal strategy. */
    readonly width?: () => number;
    /** Footer refresh cadence; forwarded to the footer view scheduler. */
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
    /** Current terminal width, sampled for every footer paint and resize. */
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
 * the terminal stream boundary tracker, keeps a sticky footer that is cleared
 * before content output and restored only at safe line boundaries, and defers
 * durable progress lines while a transcript fragment is open mid-line so
 * progress can never merge with, overwrite, or falsely close the fragment.
 * Footer bytes are only ever emitted through the strategy's footer surface.
 */
export type TerminalOutputController = ProgressOutput & {
    /** Replace the footer content; safe draws are scheduled and coalesced. */
    readonly setFooter: (line: string) => void;
    /** True while a footer is currently painted on screen. */
    readonly isFooterVisible: () => boolean;
    /** Coalesce a footer repaint for display-state changes. */
    readonly invalidate: () => void;
};

const CLEAR_LINE = "\r\x1b[2K";

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
    strategy = makeDefaultTerminalOutputStrategy(write),
    footer,
    width = footer?.width ?? (() => process.stderr.columns ?? 80),
    resize,
    onResize,
    subscribeResize,
}: TerminalOutputControllerOptions): TerminalOutputController => {
    const boundary = makeTerminalStreamBoundaryTracker();
    const interactive = mode === "interactive";
    let footerTarget: string | undefined;
    let footerRendered: string | undefined;
    let footerShown = false;
    let resizePending = false;
    let disposed = false;
    const pendingLines: string[] = [];

    const footerContent = (): string | undefined =>
        footer?.footerLine === undefined ? footerTarget : footer.footerLine();

    const clearVisibleFooter = (): void => {
        if (!footerShown) return;
        strategy.clearFooter();
        footerShown = false;
        footerRendered = undefined;
    };

    /** Strict clear-before-draw: replacement repaints always erase first. */
    const renderFooter = (
        content: string | undefined,
        force = false,
        clippedContent?: string,
    ): void => {
        const clipped =
            clippedContent ??
            (content === undefined ? undefined : clipFooter(content, width()));
        if (clipped === undefined || clipped === "") {
            clearVisibleFooter();
            return;
        }
        if (!force && footerShown && footerRendered === clipped) return;
        clearVisibleFooter();
        strategy.paintFooter(clipped);
        footerShown = true;
        footerRendered = clipped;
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
                  renderFooter(footerContent());
              },
              intervalMs: footer?.intervalMs,
              timer: footer?.timer,
          })
        : undefined;

    const invalidate = (): void => {
        if (!interactive || disposed) return;
        scheduler?.invalidate();
    };

    const restoreFooter = (): void => {
        if (!interactive || !boundary.isRedrawSafe()) return;
        const needsRedraw = resizePending || !footerShown;
        resizePending = false;
        if (needsRedraw) renderFooter(footerContent());
    };

    const afterContentWrite = (): void => {
        if (!interactive) return;
        flushPending();
        restoreFooter();
    };

    /** Repaint at the new width, but never insert bytes into an unsafe stream. */
    const handleResize = (): void => {
        if (disposed) return;
        resizePending = true;
        const content = footerContent();
        const clipped =
            content === undefined ? undefined : clipFooter(content, width());
        clearVisibleFooter();
        if (!boundary.isRedrawSafe()) return;
        resizePending = false;
        renderFooter(content, true, clipped);
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
        clearVisibleFooter();
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
            renderFooter(footerContent());
        },
        appendLine: (line, liveLine) => {
            if (disposed) return;
            if (liveLine !== undefined) footerTarget = liveLine;
            writeDurableLine(line);
        },
        writeLine: writeDurableLine,
        writeTranscript: (text) => {
            if (text.length === 0 || disposed) return;
            clearVisibleFooter();
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
        isFooterVisible: () => footerShown,
        invalidate,
        dispose: () => {
            if (disposed) return;
            disposed = true;
            scheduler?.dispose();
            unregisterResize();
            ensureLineBoundary();
            for (const line of pendingLines) strategy.write(`${line}\n`);
            pendingLines.length = 0;
            if (footerShown) strategy.write("\n");
            footerTarget = undefined;
            footerShown = false;
            footerRendered = undefined;
            resizePending = false;
            boundary.reset();
            strategy.restore?.();
        },
    };
};