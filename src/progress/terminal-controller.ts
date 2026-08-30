import type { ProgressOutput, ProgressRenderMode } from "./progress.ts";
import { makeFooterRefreshScheduler, type FooterTimer } from "./footer.ts";
import { makeTerminalStreamBoundaryTracker } from "./terminal-stream-boundary.ts";

/**
 * Terminal primitives the controller drives.
 *
 * Splitting the footer surface from the content surface lets tests (and later
 * cursor-reserved-row strategies) prove that footer bytes never enter the
 * transcript or durable scrollback stream.
 */
export type TerminalOutputStrategy = {
    /** Emit arbitrary content bytes (transcript, durable progress lines). */
    readonly write: (text: string) => void;
    /** Paint a footer at the current cursor position (assumed line start). */
    readonly paintFooter: (text: string) => void;
    /** Erase the currently visible footer without touching content. */
    readonly clearFooter: () => void;
};

/** State-driven footer content plus the refresh cadence. */
export type TerminalFooterOptions = {
    /**
     * Optional live renderer for display-state-driven footers. When absent the
     * controller uses the explicit lines supplied through beginLive, appendLine
     * and setFooter.
     */
    readonly footerLine?: () => string | undefined;
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

/** Default strategy: every surface writes to the same byte sink. */
export const makeDefaultTerminalOutputStrategy = (
    write: (text: string) => void,
): TerminalOutputStrategy => ({
    write,
    paintFooter: write,
    clearFooter: () => write(CLEAR_LINE),
});

export const makeTerminalOutputController = ({
    mode,
    write = (text) => process.stderr.write(text),
    strategy = makeDefaultTerminalOutputStrategy(write),
    footer,
}: TerminalOutputControllerOptions): TerminalOutputController => {
    const boundary = makeTerminalStreamBoundaryTracker();
    const interactive = mode === "interactive";
    let footerTarget: string | undefined;
    let footerRendered: string | undefined;
    let footerShown = false;
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
    const renderFooter = (content: string | undefined): void => {
        if (content === undefined || content === "") return;
        if (footerShown && footerRendered === content) return;
        clearVisibleFooter();
        strategy.paintFooter(content);
        footerShown = true;
        footerRendered = content;
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
                  if (disposed) return;
                  if (!boundary.isRedrawSafe()) return;
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
        renderFooter(footerContent());
    };

    const afterContentWrite = (): void => {
        if (!interactive) return;
        flushPending();
        restoreFooter();
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
            ensureLineBoundary();
            for (const line of pendingLines) strategy.write(`${line}\n`);
            pendingLines.length = 0;
            if (footerShown) strategy.write("\n");
            footerShown = false;
            footerRendered = undefined;
        },
    };
};