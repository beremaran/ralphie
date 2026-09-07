import { stripTerminalControls } from "../shared/terminal.ts";
import {
    progressStageLabel,
    type DisplayState,
    type DisplayTimestamp,
} from "./display-state.ts";

const oneLine = (value: string): string =>
    stripTerminalControls(value).replace(/\s+/g, " ").trim();

/** Clip styled text without splitting a Unicode grapheme. */
export const clipFooter = (text: string, width: number): string => {
    const available = Math.floor(width);
    if (!Number.isFinite(available) || available <= 0) return "";
    if (Bun.stringWidth(stripTerminalControls(text)) <= available) return text;
    if (available === 1) return "…";

    const plain = stripTerminalControls(text);
    const target = available - Bun.stringWidth("…");
    const segmenter = new Intl.Segmenter(undefined, {
        granularity: "grapheme",
    });
    let result = "";
    let used = 0;
    for (const { segment } of segmenter.segment(plain)) {
        const segmentWidth = Bun.stringWidth(segment);
        if (used + segmentWidth > target) break;
        result += segment;
        used += segmentWidth;
    }
    const clipped = `${result}…`;
    if (!text.includes("\x1b")) return clipped;
    const prefixEnd = text.indexOf("m");
    const prefix =
        text.startsWith("\x1b[") && prefixEnd !== -1
            ? text.slice(0, prefixEnd + 1)
            : "";
    if (prefix === "") return clipped;
    const suffix = text.endsWith("\x1b[0m") ? "\x1b[0m" : "";
    return `${prefix}${clipped}${suffix}`;
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
    const title = oneLine(state.issue.title);
    if (title) parts.push(title);
};

/** Pure, terminal-safe presentation of the current leaf workflow state. */
export const renderFooter = (
    state: DisplayState,
    options: FooterViewOptions = {},
): string => {
    const indicator = oneLine(
        typeof options.indicator === "function"
            ? options.indicator()
            : (options.indicator ?? "◐"),
    );
    const parts = [indicator];
    if (state.repository) parts.push(`[${oneLine(state.repository)}]`);
    appendIssue(parts, state);
    if (state.reviewAttempt) {
        parts.push(
            `Review ${state.reviewAttempt.current}/${state.reviewAttempt.total}`,
        );
    }
    if (state.stage) parts.push(`› ${progressStageLabel(state.stage)}`);
    const activity = oneLine(state.activityLabel);
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

export type FooterRefreshScheduler = {
    readonly invalidate: () => void;
    readonly flush: () => void;
    readonly dispose: () => void;
};

export type FooterRefreshSchedulerOptions = {
    readonly repaint: () => void;
    readonly intervalMs?: number;
};

/** Coalesce footer-only invalidations; transcript writes never pass through here. */
export const makeFooterRefreshScheduler = ({
    repaint,
    intervalMs = 100,
}: FooterRefreshSchedulerOptions): FooterRefreshScheduler => {
    let pending: ReturnType<typeof setTimeout> | undefined;
    let scheduled = false;
    let dirty = false;
    let disposed = false;

    const flush = (): void => {
        if (disposed || !dirty) return;
        if (scheduled && pending !== undefined) clearTimeout(pending);
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
            pending = setTimeout(
                flush,
                Math.max(100, Math.min(125, intervalMs)),
            );
        },
        flush,
        dispose: () => {
            disposed = true;
            dirty = false;
            if (scheduled && pending !== undefined) clearTimeout(pending);
            pending = undefined;
            scheduled = false;
        },
    };
};