import { stripTerminalControls } from "../../shared/terminal.ts";
import type {
    ProgressEvent,
    ProgressReporterService,
    ProgressStatus,
    ProgressUpdate,
} from "../ports.ts";
import { type RunEventLog } from "../../run/ports.ts";
import { cyan, dim, green, red, yellow } from "./colors.ts";

export type ProgressRenderMode = "interactive" | "plain" | "json";

/**
 * Shared output primitives used by progress and transcript renderers.
 *
 * Keeping line ownership here lets a coordinator route both streams through
 * one sink without making the transcript know about the progress service.
 */
export type ProgressOutput = {
    readonly beginLive: (line: string) => void;
    readonly appendLine: (line: string, liveLine?: string) => void;
    readonly writeLine: (line: string) => void;
    readonly writeTranscript: (text: string) => void;
    readonly dispose: () => void;
};

export type ProgressRendererOptions = {
    readonly mode: ProgressRenderMode;
    readonly write?: (text: string) => void;
    readonly output?: ProgressOutput;
    readonly width?: () => number;
    readonly colors?: boolean;
    readonly now?: () => Date;
    readonly runId?: string;
    /** Optional run audit sink for already-stamped progress events. */
    readonly eventLog?: RunEventLog;
};

const statusSymbol = (status: ProgressStatus, colors: boolean): string => {
    if (!colors) {
        switch (status) {
            case "succeeded":
                return "✓";
            case "failed":
                return "✗";
            case "skipped":
                return "−";
            case "started":
                return "◐";
            case "needs-attention":
                return "⚠";
            case "info":
                return "•";
        }
    }
    switch (status) {
        case "succeeded":
            return green("✓");
        case "failed":
            return red("✗");
        case "skipped":
            return dim("−");
        case "started":
            return yellow("◐");
        case "needs-attention":
            return yellow("⚠");
        case "info":
            return cyan("•");
    }
};

type ProgressStyle = (render: (text: string) => string, text: string) => string;

const formatIssue = (event: ProgressEvent, style: ProgressStyle): string => {
    if (event.issue === undefined) return "";
    const number = style(cyan, `#${event.issue.number}`);
    if (event.status !== "needs-attention") return ` ${number}`;
    return ` ${number} ${style(dim, humanText(event.issue.title))} —`;
};

const CLEAR_LIVE_LINE = "\r\x1b[2K";
const ANSI_ESCAPE =
    /\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~])/g;

/** Collapse a single human progress line; controls never reach the sink. */
const humanText = (text: string): string =>
    stripTerminalControls(text).replace(/\s+/g, " ").trim();

const clipToWidth = (text: string, width: number): string => {
    const available = Math.max(1, width - 1);
    if (Bun.stringWidth(text) <= available) return text;
    if (available === 1) return "…";

    const contentWidth = available - Bun.stringWidth("…");
    let clipped = "";
    let used = 0;
    for (const character of text) {
        const characterWidth = Bun.stringWidth(character);
        if (used + characterWidth > contentWidth) break;
        clipped += character;
        used += characterWidth;
    }
    return `${clipped}…`;
};

/** Create the single line-aware sink shared by progress and agent output. */
export const makeProgressOutput = ({
    mode,
    write = mode === "json"
        ? (text) => process.stdout.write(text)
        : (text) => process.stderr.write(text),
}: {
    readonly mode: ProgressRenderMode;
    readonly write?: (text: string) => void;
}): ProgressOutput => {
    let liveLineVisible = false;
    let rawLineOpen = false;

    const clearLiveLine = (): void => {
        if (!liveLineVisible) return;
        if (mode === "interactive") write(CLEAR_LIVE_LINE);
        liveLineVisible = false;
    };

    const finishRawLine = (): void => {
        if (!rawLineOpen) return;
        write("\n");
        rawLineOpen = false;
    };

    const renderLiveLine = (line: string): void => {
        if (mode !== "interactive") return;
        write(line);
        liveLineVisible = true;
    };

    return {
        beginLive: (line) => {
            clearLiveLine();
            finishRawLine();
            renderLiveLine(line);
        },
        appendLine: (line, liveLine) => {
            clearLiveLine();
            finishRawLine();
            write(`${line}\n`);
            if (liveLine !== undefined) renderLiveLine(liveLine);
        },
        writeLine: (line) => {
            clearLiveLine();
            finishRawLine();
            write(`${line}\n`);
        },
        writeTranscript: (text) => {
            if (text.length === 0) return;
            clearLiveLine();
            write(text);
            rawLineOpen = !text.replace(ANSI_ESCAPE, "").endsWith("\n");
        },
        dispose: () => {
            if (rawLineOpen) {
                write("\n");
                rawLineOpen = false;
                return;
            }
            if (liveLineVisible) {
                write("\n");
                liveLineVisible = false;
            }
        },
    };
};

const progressIdentity = (event: ProgressEvent): string =>
    `${event.stage}:${event.issue?.number ?? ""}:${event.attempt ?? ""}`;

const makeProgressEvent = (
    update: ProgressUpdate,
    runId: string,
    timestamp: Date,
): ProgressEvent => ({
    ...update,
    runId,
    timestamp: timestamp.toISOString(),
});

type ActiveProgress = {
    readonly identity: string;
    readonly line: string;
    readonly startedAt: number;
};

export const makeProgressReporter = ({
    mode,
    colors = false,
    write = (text) => process.stderr.write(text),
    output: configuredOutput,
    width = () => process.stderr.columns ?? 80,
    now = () => new Date(),
    runId = crypto.randomUUID(),
    eventLog,
}: ProgressRendererOptions): ProgressReporterService => {
    const output =
        configuredOutput ??
        makeProgressOutput({
            mode,
            write,
        });
    const activeProgress: ActiveProgress[] = [];

    const renderLine = (event: ProgressEvent): string => {
        const style = (
            render: (text: string) => string,
            text: string,
        ): string => (colors ? render(text) : text);
        const scope = event.repository
            ? ` ${style(dim, `[${humanText(event.repository)}]`)}`
            : "";
        const issue = formatIssue(event, style);
        const position =
            event.current !== undefined && event.total !== undefined
                ? ` ${style(dim, `[${event.current}/${event.total}]`)}`
                : "";
        const attempt =
            event.attempt !== undefined && event.maxAttempts !== undefined
                ? ` ${style(dim, `(${event.attempt}/${event.maxAttempts})`)}`
                : "";
        const status = statusSymbol(event.status, colors);
        return `${status}${scope}${position}${attempt}${issue} ${humanText(event.message)}`;
    };

    const appendLine = (line: string) => {
        const active = activeProgress.at(-1);
        output.appendLine(
            line,
            active === undefined
                ? undefined
                : clipToWidth(active.line, width()),
        );
    };

    const removeActive = (identity: string): ActiveProgress | undefined => {
        for (let index = activeProgress.length - 1; index >= 0; index -= 1) {
            if (activeProgress[index]?.identity !== identity) continue;
            return activeProgress.splice(index, 1)[0];
        }
        return undefined;
    };

    const persistEvent = (event: ProgressEvent): void => {
        eventLog?.append(event);
    };

    const renderInteractiveEvent = (
        event: ProgressEvent,
        line: string,
        emittedAt: Date,
    ): void => {
        if (event.status === "started") {
            removeActive(progressIdentity(event));
            activeProgress.push({
                identity: progressIdentity(event),
                line,
                startedAt: emittedAt.getTime(),
            });
            output.beginLive(clipToWidth(line, width()));
            return;
        }

        const terminalRunEvent =
            event.stage === "run" &&
            (event.status === "succeeded" ||
                event.status === "failed" ||
                event.status === "needs-attention");
        const settled =
            event.status === "succeeded" ||
            event.status === "failed" ||
            event.status === "skipped" ||
            event.status === "needs-attention";
        const active = settled
            ? removeActive(progressIdentity(event))
            : undefined;
        if (terminalRunEvent) activeProgress.length = 0;
        const duration =
            active === undefined
                ? ""
                : (() => {
                      const elapsedMs = Math.max(
                          0,
                          emittedAt.getTime() - active.startedAt,
                      );
                      const elapsedSec = (elapsedMs / 1000).toFixed(1);
                      const durationText = `(${elapsedSec}s)`;
                      return colors
                          ? ` ${dim(durationText)}`
                          : ` ${durationText}`;
                  })();
        appendLine(`${line}${duration}`);
    };

    return {
        emit: async (update) => {
            const emittedAt = now();
            const event = makeProgressEvent(update, runId, emittedAt);
            persistEvent(event);

            if (mode === "json") {
                output.writeLine(JSON.stringify(event));
                return;
            }
            const line = renderLine(event);
            if (mode !== "interactive") {
                output.writeLine(line);
                return;
            }

            renderInteractiveEvent(event, line, emittedAt);
        },
    };
};