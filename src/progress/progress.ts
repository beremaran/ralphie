import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import {
    redactSensitiveText,
    redactSensitiveValue,
} from "../shared/redaction.ts";
import { cyan, dim, green, red, yellow } from "./colors.ts";

export type ProgressStage =
    | "run"
    | "workspace-preparation"
    | "workspace-cleanup"
    | "github-authentication"
    | "git-verification"
    | "remote-safety"
    | "repository-discovery"
    | "repository-preparation"
    | "issue-discovery"
    | "pi-runtime"
    | "issue-planning"
    | "issue-execution"
    | "issue-queue"
    | "complexity-assessment"
    | "implementation"
    | "change-staging"
    | "resolution-verification"
    | "review"
    | "review-fix"
    | "review-exhaustion"
    | "checkout-restore"
    | "commit-message"
    | "commit"
    | "push"
    | "decomposition"
    | "issue-creation"
    | "issue-closure";

export type ProgressStatus =
    | "started"
    | "succeeded"
    | "failed"
    | "skipped"
    | "info";

export type ProgressRenderMode = "interactive" | "plain" | "json" | "quiet";

export type ProgressIssue = {
    readonly number: number;
    readonly title: string;
};

export type ProgressUpdate = {
    readonly stage: ProgressStage;
    readonly status: ProgressStatus;
    readonly message: string;
    readonly repository?: string;
    readonly issue?: ProgressIssue;
    readonly current?: number;
    readonly total?: number;
    readonly attempt?: number;
    readonly maxAttempts?: number;
    readonly details?: Readonly<Record<string, unknown>>;
};

export type ProgressEvent = ProgressUpdate & {
    readonly runId: string;
    readonly timestamp: string;
};

export type ProgressReporterService = {
    readonly emit: (update: ProgressUpdate) => Promise<void>;
    /** Stop writing durable events while continuing to render progress. */
    readonly stopPersisting: () => Promise<void>;
};

export type ProgressRendererOptions = {
    readonly mode: ProgressRenderMode;
    readonly verbose: boolean;
    readonly write?: (text: string) => void;
    readonly width?: () => number;
    readonly colors?: boolean;
    readonly now?: () => Date;
    readonly runId?: string;
    /** Optional durable, redacted JSON Lines audit log. */
    readonly eventLogPath?: string;
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
        case "info":
            return cyan("•");
    }
};

const formatDetails = (
    details: Readonly<Record<string, unknown>> | undefined,
): string => (details === undefined ? "" : ` ${JSON.stringify(details)}`);

const CLEAR_LIVE_LINE = "\r\x1b[2K";

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

const progressIdentity = (event: ProgressEvent): string =>
    `${event.stage}:${event.issue?.number ?? ""}:${event.attempt ?? ""}`;

const makeProgressEvent = (
    update: ProgressUpdate,
    runId: string,
    timestamp: Date,
): ProgressEvent => ({
    ...update,
    message: redactSensitiveText(update.message),
    ...(update.details === undefined
        ? {}
        : {
              details: redactSensitiveValue(update.details) as Readonly<
                  Record<string, unknown>
              >,
          }),
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
    verbose,
    colors = verbose,
    write = (text) => process.stderr.write(text),
    width = () => process.stderr.columns ?? 80,
    now = () => new Date(),
    runId = crypto.randomUUID(),
    eventLogPath,
}: ProgressRendererOptions): ProgressReporterService => {
    const activeProgress: ActiveProgress[] = [];
    let liveLineVisible = false;
    let persistEvents = true;

    const renderLine = (event: ProgressEvent): string => {
        const scope = event.repository
            ? ` ${dim(`[${event.repository}]`)}`
            : "";
        const issue = event.issue ? ` ${cyan(`#${event.issue.number}`)}` : "";
        const position =
            event.current !== undefined && event.total !== undefined
                ? ` ${dim(`[${event.current}/${event.total}]`)}`
                : "";
        const attempt =
            event.attempt !== undefined && event.maxAttempts !== undefined
                ? ` ${dim(`(${event.attempt}/${event.maxAttempts})`)}`
                : "";
        const details = verbose ? formatDetails(event.details) : "";
        const status = statusSymbol(event.status, colors);
        return `${status}${scope}${position}${attempt}${issue} ${event.message}${details}`;
    };

    const clearLiveLine = () => {
        if (!liveLineVisible) return;
        write(CLEAR_LIVE_LINE);
        liveLineVisible = false;
    };

    const renderLiveLine = () => {
        const active = activeProgress.at(-1);
        if (active === undefined) return;
        write(clipToWidth(active.line, width()));
        liveLineVisible = true;
    };

    const appendLine = (line: string) => {
        clearLiveLine();
        write(`${line}\n`);
        renderLiveLine();
    };

    const removeActive = (identity: string): ActiveProgress | undefined => {
        for (let index = activeProgress.length - 1; index >= 0; index -= 1) {
            if (activeProgress[index]?.identity !== identity) continue;
            return activeProgress.splice(index, 1)[0];
        }
        return undefined;
    };

    const persistEvent = (event: ProgressEvent): void => {
        if (eventLogPath === undefined || !persistEvents) return;
        mkdirSync(dirname(eventLogPath), { recursive: true });
        appendFileSync(eventLogPath, `${JSON.stringify(event)}\n`, "utf8");
    };

    const renderInteractiveEvent = (
        event: ProgressEvent,
        line: string,
        emittedAt: Date,
    ): void => {
        if (event.status === "started") {
            clearLiveLine();
            removeActive(progressIdentity(event));
            activeProgress.push({
                identity: progressIdentity(event),
                line,
                startedAt: emittedAt.getTime(),
            });
            renderLiveLine();
            return;
        }

        const terminalRunEvent =
            event.stage === "run" &&
            (event.status === "succeeded" || event.status === "failed");
        const settled =
            event.status === "succeeded" ||
            event.status === "failed" ||
            event.status === "skipped";
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
                write(`${JSON.stringify(event)}\n`);
                return;
            }
            if (mode === "quiet" && event.status !== "failed") {
                return;
            }

            const line = renderLine(event);
            if (mode !== "interactive") {
                write(`${line}\n`);
                return;
            }

            renderInteractiveEvent(event, line, emittedAt);
        },
        stopPersisting: async () => {
            persistEvents = false;
        },
    };
};

export const makeProgressRecorder = (
    events: ProgressUpdate[],
): ProgressReporterService => ({
    emit: async (event) => {
        events.push(event);
    },
    stopPersisting: async () => {},
});