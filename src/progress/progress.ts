import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { stripTerminalControls } from "../shared/terminal.ts";
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
    | "opencode-runtime"
    | "issue-planning"
    | "issue-execution"
    | "issue-queue"
    | "grounding"
    | "issue-grounding"
    | "complexity-assessment"
    | "implementation"
    | "change-staging"
    | "verification"
    | "verification-fix"
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
    | "issue-relationships"
    | "issue-closure"
    | "maintenance-observation"
    | "maintenance-planning"
    | "maintenance-validation"
    | "maintenance-action"
    | "maintenance-mutation"
    | "maintenance-replan"
    | "maintenance-outcome"
    | "maintenance-recovery"
    | "pr-gate"
    | "notification-recovery"
    | "pipeline-remote-read"
    | "pipeline-observation"
    | "pipeline-diagnostics"
    | "pipeline-repair"
    | "pipeline-commit-message"
    | "pipeline-commit"
    | "pipeline-push"
    | "pipeline-reconcile"
    | "pipeline-final-verification"
    | "pipeline-resume"
    | "pipeline-outcome";

export type ProgressStatus =
    | "started"
    | "succeeded"
    | "failed"
    | "skipped"
    | "needs-attention"
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
    /** Write streamed agent output without allowing an interactive status line to corrupt it. */
    readonly writeRaw?: (text: string) => void;
    /** Stop writing durable events while continuing to render progress. */
    readonly stopPersisting: () => Promise<void>;
};

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
    readonly verbose: boolean;
    readonly write?: (text: string) => void;
    readonly output?: ProgressOutput;
    readonly width?: () => number;
    readonly colors?: boolean;
    readonly now?: () => Date;
    readonly runId?: string;
    /** Optional durable JSON Lines audit log. */
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

const formatDetails = (
    details: Readonly<Record<string, unknown>> | undefined,
): string =>
    details === undefined ? "" : ` ${humanText(JSON.stringify(details))}`;

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
    verbose,
    colors = verbose,
    write = (text) => process.stderr.write(text),
    output: configuredOutput,
    width = () => process.stderr.columns ?? 80,
    now = () => new Date(),
    runId = crypto.randomUUID(),
    eventLogPath,
}: ProgressRendererOptions): ProgressReporterService => {
    const output =
        configuredOutput ??
        makeProgressOutput({
            mode,
            write,
        });
    const activeProgress: ActiveProgress[] = [];
    let persistEvents = true;

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
        // Quiet mode surfaces failures and needs-attention events only; those
        // events must carry their full payload so reporting never elides
        // supplied values (GH-180 unredacted output contract).
        const details =
            verbose || mode === "quiet" ? formatDetails(event.details) : "";
        const status = statusSymbol(event.status, colors);
        return `${status}${scope}${position}${attempt}${issue} ${humanText(event.message)}${details}`;
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
        writeRaw: (text) => {
            if (mode === "quiet" || mode === "json") return;
            output.writeTranscript(stripTerminalControls(text));
        },
        emit: async (update) => {
            const emittedAt = now();
            const event = makeProgressEvent(update, runId, emittedAt);
            persistEvent(event);

            if (mode === "json") {
                output.writeLine(JSON.stringify(event));
                return;
            }
            if (
                mode === "quiet" &&
                event.status !== "failed" &&
                event.status !== "needs-attention"
            ) {
                return;
            }

            const line = renderLine(event);
            if (mode !== "interactive") {
                output.writeLine(line);
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

export {
    DISPLAY_ACTIVITY_LABELS,
    PROGRESS_STAGE_LABELS,
    activityLabelFor,
    createDisplayState,
    initialDisplayState,
    progressStageLabel,
    reduceDisplayState,
    reduceAgentSessionEvent,
    reduceProgressUpdate,
    updateDisplayState,
    updateDisplayStateFromAgent,
    updateDisplayStateFromProgress,
} from "./display-state.ts";
export type {
    DisplayActivity,
    DisplayClock,
    DisplayIssue,
    DisplayReviewAttempt,
    DisplayState,
    DisplayStateOptions,
    DisplayTimestamp,
} from "./display-state.ts";
export {
    createTerminalBoundaryTracker,
    createTerminalStreamBoundaryTracker,
    makeTerminalBoundaryTracker,
    makeTerminalStreamBoundaryTracker,
} from "./terminal-stream-boundary.ts";
export type {
    TerminalBoundaryState,
    TerminalBoundaryTracker,
    TerminalStreamBoundaryState,
    TerminalStreamBoundaryTracker,
} from "./terminal-stream-boundary.ts";
export {
    clipFooter,
    makeFooterRefreshScheduler,
    renderFooter,
} from "./footer.ts";
export type {
    FooterRefreshScheduler,
    FooterRefreshSchedulerOptions,
    FooterTimer,
    FooterViewOptions,
} from "./footer.ts";
export {
    INTERACTIVE_FOOTER_LAYOUT_STRATEGY,
    INTERACTIVE_FOOTER_USES_RESERVED_ROW,
    INTERACTIVE_FOOTER_USES_SCROLL_REGION,
    INTERACTIVE_REGION_MAX_ROWS,
    makeDefaultTerminalOutputStrategy,
    makeDurableBreadcrumbStrategy,
    makeDurableBreadcrumbTerminalOutputStrategy,
    makeInteractiveTerminalOutputStrategy,
    makeTerminalOutputController,
} from "./terminal-controller.ts";
export type {
    InteractiveFooterLayoutStrategy,
    TerminalFooterOptions,
    TerminalOutputController,
    TerminalOutputControllerOptions,
    TerminalOutputStrategy,
    TerminalResizeListener,
    TerminalResizeSubscription,
} from "./terminal-controller.ts";
export {
    DEFAULT_BREADCRUMB_THRESHOLD,
    arbitrateBreadcrumbCandidates,
    breadcrumbCandidateFor,
    breadcrumbCandidateFromDisplayState,
    breadcrumbForDisplayState,
    breadcrumbLabelFor,
    breadcrumbLabelForDisplayState,
    canonicalBreadcrumbKey,
    createBreadcrumbCandidate,
    createBreadcrumbLabel,
    createBreadcrumbPolicy,
    createBreadcrumbPolicyState,
    evaluateBreadcrumbCandidate,
    initialBreadcrumbPolicyState,
    displayContextBreadcrumbLabel,
    makeBreadcrumbCandidate,
    makeBreadcrumbLabel,
    makeBreadcrumbCadencePolicy,
    makeBreadcrumbPolicy,
    makeBreadcrumbPolicyEngine,
    normalizeBreadcrumbKey,
    normalizeBreadcrumbLabel,
    prepareBreadcrumbCandidate,
    prepareBreadcrumbLabel,
    reduceBreadcrumbPolicy,
    renderBreadcrumb,
    renderBreadcrumbCandidate,
    renderBreadcrumbLabel,
    renderBreadcrumbLine,
} from "./breadcrumb.ts";
export type {
    ApprovedBreadcrumbCandidate,
    BreadcrumbCandidate,
    BreadcrumbCandidateInput,
    BreadcrumbLabel,
    BreadcrumbLabelCandidate,
    BreadcrumbPolicy,
    BreadcrumbRenderOptions,
    BreadcrumbRenderResult,
    BreadcrumbPolicyConfiguration,
    BreadcrumbPolicyDecision,
    BreadcrumbPolicyOptions,
    BreadcrumbPolicyResult,
    BreadcrumbPolicyState,
    NormalizedBreadcrumb,
    BreadcrumbArbitrationCandidate,
    BreadcrumbArbitrationResult,
    BreadcrumbCandidateKind,
} from "./breadcrumb.ts";
export {
    makeDisplayCoordinator,
    makeProgressCoordinator,
} from "./coordinator.ts";
export {
    ACTIVITY_REGISTRY_LIMIT,
    ACTIVITY_SNAPSHOT_ROWS,
    MAX_FAILURE_DETAIL_LENGTH,
    activityKindForTool,
    activitySnapshotOperations,
    activityTargetForTool,
    createActivityState,
    findActivityOperation,
    formatActivityOperation,
    reduceActivityEvent,
    reduceActivityUpdate,
    renderActivitySnapshot,
    updateActivityFromProgress,
} from "./activity.ts";
export type {
    ActivityClock,
    ActivityKind,
    ActivityOperation,
    ActivityRenderOptions,
    ActivityState,
    ActivityStateOptions,
    ActivityStatus,
    ActivityUpdate,
} from "./activity.ts";
export type {
    ProgressCoordinator,
    ProgressCoordinatorOptions,
} from "./coordinator.ts";