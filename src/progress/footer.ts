import {
    progressStageLabel,
    type DisplayState,
    type DisplayTimestamp,
} from "./display-state.ts";

const ANSI_SEQUENCE =
    /\u001b(?:\](?:(?!\u0007|\u001b\\)[\s\S])*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~])/g;
const ANSI_TOKEN = new RegExp(`(${ANSI_SEQUENCE.source})`, "g");
const ANSI_ONLY = new RegExp(`^${ANSI_SEQUENCE.source}$`);

const clean = (value: string): string =>
    value
        .replace(ANSI_SEQUENCE, "")
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

type FooterUnit = { readonly text: string; readonly width: number };

const footerUnits = (text: string): FooterUnit[] => {
    const units: FooterUnit[] = [];
    const segmenter = new Intl.Segmenter(undefined, {
        granularity: "grapheme",
    });
    for (const token of text.split(ANSI_TOKEN)) {
        if (ANSI_ONLY.test(token)) {
            units.push({ text: token, width: 0 });
            continue;
        }
        for (const { segment } of segmenter.segment(token)) {
            units.push({ text: segment, width: Bun.stringWidth(segment) });
        }
    }
    return units;
};

const terminalClosuresFor = (text: string): string => {
    let sgrActive = false;
    let hyperlinkActive = false;
    for (const sequence of text.matchAll(ANSI_SEQUENCE)) {
        const value = sequence[0];
        if (value.startsWith("\x1b[")) sgrActive = true;
        const hyperlink = /^\x1b\]8;[^;]*;(.*?)(?:\x07|\x1b\\)$/s.exec(value);
        if (hyperlink) hyperlinkActive = (hyperlink[1] ?? "").length > 0;
    }
    return `${hyperlinkActive ? "\x1b]8;;\x1b\\" : ""}${sgrActive ? "\x1b[0m" : ""}`;
};

/** Clip styled text without splitting an ANSI sequence or a Unicode grapheme. */
export const clipFooter = (text: string, width: number): string => {
    const available = Math.floor(width);
    if (!Number.isFinite(available) || available <= 0) return "";
    if (Bun.stringWidth(text) <= available) return text;
    if (available === 1) return "…";

    const target = available - Bun.stringWidth("…");
    let result = "";
    let used = 0;
    for (const unit of footerUnits(text)) {
        if (used + unit.width > target) break;
        result += unit.text;
        used += unit.width;
    }
    return `${result}…${terminalClosuresFor(result)}`;
};

export type FooterViewOptions = {
    readonly now?: () => DisplayTimestamp;
    readonly width?: () => number;
    readonly color?: (text: string) => string;
    readonly indicator?: string | (() => string);
};

const milliseconds = (value: DisplayTimestamp): number => {
    const result =
        value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isFinite(result) ? result : Date.now();
};

const elapsed = (startedAt: number, now: number): string => {
    const seconds = Math.floor(Math.max(0, now - startedAt) / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return minutes === 0 ? `${remainder}s` : `${minutes}m ${remainder}s`;
};

const appendIssue = (parts: string[], state: DisplayState): void => {
    if (!state.issue) return;
    parts.push(`[${state.issue.current}/${state.issue.total}]`);
    parts.push(`#${state.issue.number}`);
    const title = clean(state.issue.title);
    if (title) parts.push(title);
};

/** Pure, terminal-safe presentation of the current leaf workflow state. */
export const renderFooter = (
    state: DisplayState,
    options: FooterViewOptions = {},
): string => {
    const indicator = clean(
        typeof options.indicator === "function"
            ? options.indicator()
            : (options.indicator ?? "◐"),
    );
    const parts = [indicator];
    if (state.repository) parts.push(`[${clean(state.repository)}]`);
    appendIssue(parts, state);
    if (state.reviewAttempt) {
        parts.push(
            `Review ${state.reviewAttempt.current}/${state.reviewAttempt.total}`,
        );
    }
    if (state.stage) parts.push(`› ${progressStageLabel(state.stage)}`);
    const activity = clean(state.activityLabel);
    if (activity) parts.push(`› ${activity}`);
    if (state.stageStartedAt !== undefined) {
        const now = milliseconds(options.now?.() ?? Date.now());
        parts.push(`· ${elapsed(state.stageStartedAt, now)}`);
    }
    const line = parts.filter(Boolean).join(" ");
    return clipFooter(
        options.color?.(line) ?? line,
        options.width?.() ?? process.stderr.columns ?? 80,
    );
};

export type FooterTimer = {
    readonly schedule: (callback: () => void, delayMs: number) => unknown;
    readonly cancel: (handle: unknown) => void;
};

export type FooterRefreshScheduler = {
    readonly invalidate: () => void;
    readonly flush: () => void;
    readonly dispose: () => void;
};

export type FooterRefreshSchedulerOptions = {
    readonly repaint: () => void;
    readonly intervalMs?: number;
    readonly timer?: FooterTimer;
};

const nativeTimer: FooterTimer = {
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Coalesce footer-only invalidations; transcript writes never pass through here. */
export const makeFooterRefreshScheduler = ({
    repaint,
    intervalMs = 100,
    timer = nativeTimer,
}: FooterRefreshSchedulerOptions): FooterRefreshScheduler => {
    let pending: unknown;
    let scheduled = false;
    let dirty = false;
    let disposed = false;

    const flush = (): void => {
        if (disposed || !dirty) return;
        if (scheduled) timer.cancel(pending);
        pending = undefined;
        scheduled = false;
        dirty = false;
        repaint();
    };
    return {
        invalidate: () => {
            if (disposed) return;
            dirty = true;
            if (scheduled) return;
            scheduled = true;
            pending = timer.schedule(
                flush,
                Math.max(100, Math.min(125, intervalMs)),
            );
        },
        flush,
        dispose: () => {
            disposed = true;
            dirty = false;
            if (scheduled) timer.cancel(pending);
            pending = undefined;
            scheduled = false;
        },
    };
};