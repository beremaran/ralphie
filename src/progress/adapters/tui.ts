import type {
    BoxRenderable,
    CliRenderer,
    ScrollBoxRenderable,
    SelectRenderable,
    StyledText,
    TextChunk,
    TextRenderable,
} from "@opentui/core";

import type {
    AgentEventContext,
    AgentSessionEvent,
    AgentEventListener,
} from "../../agent/ports.ts";
import type {
    RunControl,
    RunControlSelection,
    RunEventLog,
} from "../../run/ports.ts";
import type {
    ProgressEvent,
    ProgressReporterService,
    ProgressUpdate,
} from "../ports.ts";
import {
    createDisplayState,
    progressStageLabel,
    reduceAgentSessionEvent,
    reduceProgressUpdate,
    type DisplayModel,
    type DisplayQueueIssue,
    type DisplayQueueStatus,
    type DisplayState,
} from "./display-state.ts";
import { contentText, toolTarget } from "./tool-line.ts";
import type {
    ProgressCoordinator,
    ProgressCoordinatorOptions,
} from "./coordinator.ts";

const oneLine = (value: string): string => value.replace(/\s+/g, " ").trim();

const preview = (value: string, limit = 120): string =>
    value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;

/** Compose styled text from colored chunks and plain strings. */
const styled = (
    mod: TuiModule,
    ...parts: ReadonlyArray<TextChunk | string>
): StyledText =>
    new mod.StyledText(
        parts.flatMap((part) =>
            typeof part === "string"
                ? mod.stringToStyledText(part).chunks
                : [part],
        ),
    );

const MAX_TRANSCRIPT_LINES = 400;
const MAX_STREAM_CHARACTERS = 20_000;
const SPINNER_FRAMES = [
    "⠋",
    "⠙",
    "⠹",
    "⠸",
    "⠼",
    "⠴",
    "⠦",
    "⠧",
    "⠇",
    "⠏",
] as const;
const SPINNER_INTERVAL_MS = 120;
const PAUSE_HINT = "p pause · s stop · q quit";
const RESUME_HINT = "p resume · s stop · q quit";
const NAVIGATION_HINT = "m model · [ ] issue · ↑↓";
const PICKER_HINT = "↑↓ move · Tab pane · Enter apply · Esc cancel";
const PICKER_COLORS = {
    backgroundColor: "#16161e",
    focusedBackgroundColor: "#1a1b26",
    textColor: "#c0caf5",
    focusedTextColor: "#c0caf5",
    selectedBackgroundColor: "#2f334d",
    selectedTextColor: "#c0caf5",
    descriptionColor: "#565f89",
    selectedDescriptionColor: "#7aa2f7",
} as const;

const QUEUE_STATUS_STYLES: Readonly<
    Record<
        DisplayQueueStatus,
        { readonly glyph: string; readonly color: string }
    >
> = {
    queued: { glyph: "○", color: "#565f89" },
    active: { glyph: "▶", color: "#7aa2f7" },
    completed: { glyph: "✓", color: "#9ece6a" },
    failed: { glyph: "✗", color: "#f7768e" },
    "needs-attention": { glyph: "⚠", color: "#e0af68" },
    skipped: { glyph: "−", color: "#565f89" },
};

type TuiModule = typeof import("@opentui/core");

/** `undefined` is the run-level transcript: everything not tied to a queue issue. */
type TranscriptKey = number | undefined;

type TranscriptLine = {
    content: StyledText | string;
    node?: TextRenderable;
};

type Transcript = {
    readonly lines: Array<TranscriptLine>;
    stream?: {
        readonly kind: "text" | "thinking";
        buffer: string;
        readonly line: TranscriptLine;
    };
};

type Ui = {
    readonly mod: TuiModule;
    readonly renderer: CliRenderer;
    readonly root: {
        title: string | undefined;
        readonly add: (child: unknown) => unknown;
    };
    readonly header: TextRenderable;
    readonly sidebar: ScrollBoxRenderable;
    readonly sidebarRows: Map<TranscriptKey, TextRenderable>;
    readonly controlHint: TextRenderable;
    readonly transcript: ScrollBoxRenderable;
    readonly status: TextRenderable;
    readonly pickerOverlay: BoxRenderable;
    readonly modelList: SelectRenderable;
    readonly levelList: SelectRenderable;
};

const elapsedLabel = (startedAt: number | undefined, now: number): string => {
    if (startedAt === undefined) return "";
    const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
    const minutes = Math.floor(seconds / 60);
    return minutes === 0
        ? `${seconds}s`
        : `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
};

export type TuiCoordinatorOptions = ProgressCoordinatorOptions;

/** `[`/`]` and Ctrl+Left/Right move through the issue list. */
const issueNavigation = (key: {
    readonly ctrl?: boolean;
    readonly name?: string;
}): -1 | 0 | 1 => {
    if (key.name === "[") return -1;
    if (key.name === "]") return 1;
    if (key.ctrl !== true) return 0;
    if (key.name === "left") return -1;
    if (key.name === "right") return 1;
    return 0;
};

const createLiveRenderer = async (): Promise<CliRenderer> => {
    const { createCliRenderer } = await import("@opentui/core");
    return await createCliRenderer({
        stdin: process.stdin,
        stdout: process.stdout,
        exitOnCtrlC: false,
        exitSignals: [],
        targetFps: 30,
    });
};

/**
 * Full-screen OpenTUI coordinator: a sidebar lists every discovered issue and
 * a transcript pane follows the selected issue's session. The renderer is
 * created lazily so plain, JSON, and help paths never load the native module.
 */
export const makeTuiProgressCoordinator = (
    options: TuiCoordinatorOptions,
): ProgressCoordinator => {
    const now = options.now ?? (() => new Date());
    const eventLog: RunEventLog | undefined = options.eventLog;
    const runId = options.runId ?? crypto.randomUUID();
    let state: DisplayState = createDisplayState();
    let ui: Ui | undefined;
    let disposed = false;
    let spinnerIndex = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    const queued: Array<() => void> = [];

    const transcripts = new Map<TranscriptKey, Transcript>();
    let selected: TranscriptKey = undefined;
    let activeIssue: TranscriptKey = undefined;
    let followActive = true;
    // The queue starts held so the first issue never races the renderer.
    let paused = true;
    let stopRequested = false;
    let modelPickerOpen = false;
    let pickedSelection: RunControlSelection | undefined;
    const resumeWaiters: Array<() => void> = [];

    const withUi = (run: (current: Ui) => void): void => {
        if (disposed) return;
        if (ui === undefined) {
            queued.push(() => withUi(run));
            return;
        }
        run(ui);
    };

    const transcriptFor = (key: TranscriptKey): Transcript => {
        const existing = transcripts.get(key);
        if (existing !== undefined) return existing;
        const created: Transcript = { lines: [] };
        transcripts.set(key, created);
        return created;
    };

    const unmountLine = (current: Ui, line: TranscriptLine): void => {
        if (line.node === undefined) return;
        current.transcript.remove(line.node);
        line.node.destroy();
        line.node = undefined;
    };

    const trimTranscript = (current: Ui, transcript: Transcript): void => {
        while (transcript.lines.length > MAX_TRANSCRIPT_LINES) {
            const oldest = transcript.lines.shift();
            if (oldest === undefined) break;
            unmountLine(current, oldest);
        }
    };

    const mountLine = (current: Ui, line: TranscriptLine): void => {
        const node = new current.mod.TextRenderable(current.renderer, {
            content: line.content,
            width: "100%",
            wrapMode: "word",
        });
        line.node = node;
        current.transcript.add(node);
    };

    const appendLine = (
        current: Ui,
        key: TranscriptKey,
        content: StyledText | string,
    ): TranscriptLine => {
        const transcript = transcriptFor(key);
        const line: TranscriptLine = { content };
        transcript.lines.push(line);
        if (key === selected) mountLine(current, line);
        trimTranscript(current, transcript);
        return line;
    };

    const mountTranscript = (current: Ui, key: TranscriptKey): void => {
        for (const line of transcriptFor(key).lines) {
            if (line.node === undefined) mountLine(current, line);
        }
    };

    const unmountTranscript = (current: Ui, key: TranscriptKey): void => {
        const transcript = transcripts.get(key);
        if (transcript === undefined) return;
        for (const line of transcript.lines) unmountLine(current, line);
    };

    const sidebarRowId = (key: TranscriptKey): string =>
        key === undefined ? "tui-sidebar-run" : `tui-sidebar-issue-${key}`;

    const sidebarRowContent = (
        current: Ui,
        key: TranscriptKey,
        issue: DisplayQueueIssue | undefined,
    ): StyledText => {
        const mod = current.mod;
        const marker = key === selected ? mod.fg("#7aa2f7")("▌ ") : "  ";
        if (issue === undefined) {
            return styled(mod, marker, mod.fg("#7aa2f7")(mod.bold("Run")));
        }
        const status = QUEUE_STATUS_STYLES[issue.status];
        const title = key === selected ? mod.bold(issue.title) : issue.title;
        return styled(
            mod,
            marker,
            mod.fg(status.color)(`${status.glyph} `),
            mod.fg("#565f89")(`#${issue.number} `),
            title,
        );
    };

    const paintSidebar = (current: Ui): void => {
        const entries: Array<DisplayQueueIssue | undefined> = [
            undefined,
            ...state.queue,
        ];
        for (const issue of entries) {
            const key: TranscriptKey = issue?.number;
            let row = current.sidebarRows.get(key);
            if (row === undefined) {
                row = new current.mod.TextRenderable(current.renderer, {
                    id: sidebarRowId(key),
                    content: "",
                    width: "100%",
                    height: 1,
                    wrapMode: "none",
                    paddingLeft: 1,
                    paddingRight: 1,
                });
                row.onMouseDown = () => {
                    if (ui !== undefined) selectTranscript(ui, key, true);
                };
                current.sidebar.add(row);
                current.sidebarRows.set(key, row);
            }
            row.content = sidebarRowContent(current, key, issue);
        }
        current.sidebar.scrollChildIntoView(sidebarRowId(selected));
    };

    const selectTranscript = (
        current: Ui,
        key: TranscriptKey,
        userInitiated: boolean,
    ): void => {
        if (userInitiated) followActive = key === activeIssue;
        if (key === selected) {
            paintSidebar(current);
            return;
        }
        unmountTranscript(current, selected);
        selected = key;
        mountTranscript(current, key);
        paintSidebar(current);
        current.renderer.requestRender();
    };

    const endStreamFor = (key: TranscriptKey): void => {
        transcriptFor(key).stream = undefined;
    };

    const executingIssue = (): boolean =>
        activeIssue !== undefined &&
        state.queue.some(
            (entry) =>
                entry.number === activeIssue && entry.status === "active",
        );

    const spinnerFrame = (): string =>
        paused && !stopRequested
            ? "⏸"
            : (SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length] ?? "⠋");

    const controlStatus = (
        current: Ui,
        separator: TextChunk,
    ): ReadonlyArray<TextChunk | string> => {
        const mod = current.mod;
        if (stopRequested) {
            return [separator, mod.fg("#f7768e")("stopping after this issue")];
        }
        if (!paused) return [];
        return [
            separator,
            mod.fg("#e0af68")(
                executingIssue() ? "pausing after this issue" : "paused",
            ),
        ];
    };

    const renderStatus = (current: Ui): void => {
        const mod = current.mod;
        const frame = spinnerFrame();
        const separator = mod.fg("#565f89")(" › ");
        const parts: Array<TextChunk | string> = [mod.fg("#e0af68")(frame)];
        if (state.issue !== undefined) {
            parts.push(
                mod.fg("#565f89")(
                    ` [${state.issue.current}/${state.issue.total}]`,
                ),
                mod.fg("#7aa2f7")(` #${state.issue.number} `),
                state.issue.title,
            );
        }
        if (state.stage !== undefined) {
            parts.push(separator, progressStageLabel(state.stage));
        }
        if (state.activityLabel !== "") {
            parts.push(separator, mod.fg("#9ece6a")(state.activityLabel));
        }
        const elapsed = elapsedLabel(state.stageStartedAt, now().getTime());
        if (elapsed !== "") {
            parts.push(mod.fg("#565f89")(` · ${elapsed}`));
        }
        parts.push(...controlStatus(current, separator));
        current.status.content = styled(mod, ...parts);
    };

    const renderHeader = (current: Ui): void => {
        const mod = current.mod;
        const detail = state.repository ?? "ralphie";
        const model = activeModelReference();
        const variant = activeVariant();
        current.header.content = styled(
            mod,
            mod.fg("#7aa2f7")(mod.bold("ralphie")),
            mod.fg("#565f89")(" · "),
            detail,
            ...(model === undefined
                ? []
                : [
                      mod.fg("#565f89")(" · "),
                      mod.fg("#bb9af7")(model),
                      ...(variant === undefined
                          ? []
                          : [mod.fg("#565f89")(` · ${variant}`)]),
                  ]),
        );
        current.root.title = ` ralphie · ${detail} `;
    };

    const renderControlHint = (current: Ui): void => {
        current.controlHint.content = styled(
            current.mod,
            current.mod.fg("#565f89")(
                paused && !stopRequested ? RESUME_HINT : PAUSE_HINT,
            ),
        );
    };

    const refreshStatus = (): void => {
        withUi((current) => {
            renderStatus(current);
            renderHeader(current);
            renderControlHint(current);
            current.renderer.requestRender();
        });
    };

    const quit = options.quit ?? (() => process.kill(process.pid, "SIGINT"));

    const releaseQueueWaiters = (): void => {
        for (const resolve of resumeWaiters.splice(0)) resolve();
    };

    const togglePause = (): void => {
        if (stopRequested) return;
        paused = !paused;
        if (!paused) releaseQueueWaiters();
        refreshStatus();
    };

    const requestStop = (): void => {
        stopRequested = true;
        // A paused workflow is blocked on waitForQueue; release it so the
        // stop request is observed and the run can drain.
        releaseQueueWaiters();
        refreshStatus();
    };

    const dispatchControlKey = (name: string | undefined): boolean => {
        if (name === "q") {
            quit();
            return true;
        }
        if (name === "p") {
            togglePause();
            return true;
        }
        if (name === "s") {
            requestStop();
            return true;
        }
        return false;
    };

    const control: RunControl = {
        waitForQueue: () => {
            if (!paused || stopRequested) return Promise.resolve();
            return new Promise((resolve) => {
                resumeWaiters.push(resolve);
            });
        },
        stopAfterCurrent: () => stopRequested,
        issueSelection: () => pickedSelection,
    };

    const activeModelReference = (): string | undefined => {
        if (pickedSelection !== undefined) {
            return `${pickedSelection.model.providerID}/${pickedSelection.model.modelID}`;
        }
        return state.model === undefined
            ? undefined
            : `${state.model.provider}/${state.model.id}`;
    };

    const activeVariant = (): string | undefined =>
        pickedSelection !== undefined
            ? pickedSelection.variant
            : state.model?.variant;

    const currentPickerModel = (current: Ui): DisplayModel | undefined =>
        state.models[current.modelList.getSelectedIndex()];

    const pickerLevelOptions = (
        model: DisplayModel | undefined,
    ): Array<{ readonly name: string; readonly description: string }> => [
        { name: "default", description: "" },
        ...(model?.thinkingLevels ?? []).map((level) => ({
            name: level,
            description: "",
        })),
    ];

    const selectedLevelIndex = (model: DisplayModel | undefined): number => {
        if (model === undefined) return 0;
        if (activeModelReference() !== `${model.provider}/${model.id}`) {
            return 0;
        }
        const variant = activeVariant();
        if (variant === undefined) return 0;
        const index = model.thinkingLevels.indexOf(variant);
        return index < 0 ? 0 : index + 1;
    };

    const refreshLevelOptions = (current: Ui): void => {
        const model = currentPickerModel(current);
        current.levelList.options = pickerLevelOptions(model);
        current.levelList.setSelectedIndex(selectedLevelIndex(model));
    };

    const closeModelPicker = (current: Ui): void => {
        if (!modelPickerOpen) return;
        modelPickerOpen = false;
        current.pickerOverlay.visible = false;
        current.transcript.focus();
        current.renderer.requestRender();
    };

    const openModelPicker = (current: Ui): void => {
        if (state.models.length === 0) {
            appendLine(
                current,
                undefined,
                styled(
                    current.mod,
                    current.mod.fg("#565f89")(
                        "• Model catalog is not available yet.",
                    ),
                ),
            );
            current.renderer.requestRender();
            return;
        }
        modelPickerOpen = true;
        current.modelList.options = state.models.map((model) => ({
            name: model.name,
            description: `${model.provider}/${model.id}`,
        }));
        const reference = activeModelReference();
        const index = state.models.findIndex(
            (model) => `${model.provider}/${model.id}` === reference,
        );
        current.modelList.setSelectedIndex(index >= 0 ? index : 0);
        refreshLevelOptions(current);
        current.pickerOverlay.visible = true;
        current.modelList.focus();
        current.renderer.requestRender();
    };

    const applyModelPick = (current: Ui): void => {
        const model = currentPickerModel(current);
        if (model === undefined) {
            closeModelPicker(current);
            return;
        }
        const levelIndex = current.levelList.getSelectedIndex();
        const variant =
            levelIndex <= 0 ? undefined : model.thinkingLevels[levelIndex - 1];
        pickedSelection = {
            model: { providerID: model.provider, modelID: model.id },
            ...(variant === undefined ? {} : { variant }),
        };
        closeModelPicker(current);
        refreshStatus();
    };

    const togglePickerPane = (current: Ui): void => {
        if (current.modelList.focused) {
            current.levelList.focus();
            return;
        }
        current.modelList.focus();
    };

    const dispatchModelPickerKey = (key: {
        readonly ctrl?: boolean;
        readonly name?: string;
        readonly preventDefault?: () => void;
    }): boolean => {
        if (key.ctrl !== true && key.name === "m") {
            key.preventDefault?.();
            withUi(modelPickerOpen ? closeModelPicker : openModelPicker);
            return true;
        }
        if (!modelPickerOpen) return false;
        if (key.name === "escape") {
            key.preventDefault?.();
            withUi(closeModelPicker);
            return true;
        }
        if (key.name === "tab") {
            key.preventDefault?.();
            withUi(togglePickerPane);
            return true;
        }
        // Up/Down/Enter reach the focused Select inside the picker.
        return true;
    };

    const dispatchKey = (key: unknown): void => {
        const parsed = key as {
            readonly ctrl?: boolean;
            readonly name?: string;
            readonly preventDefault?: () => void;
        };
        if (parsed.ctrl === true && parsed.name === "c") {
            quit();
            return;
        }
        if (dispatchModelPickerKey(parsed)) return;
        if (parsed.ctrl !== true && dispatchControlKey(parsed.name)) {
            parsed.preventDefault?.();
            return;
        }
        const direction = issueNavigation(parsed);
        if (direction === 0) return;
        parsed.preventDefault?.();
        navigateIssues(direction);
    };

    const toolStartLine = (current: Ui, event: AgentSessionEvent): StyledText =>
        styled(
            current.mod,
            current.mod.fg("#7dcfff")("│ "),
            current.mod.fg("#7dcfff")(
                toolTarget(
                    (event as { toolName?: unknown }).toolName,
                    (event as { args?: unknown }).args,
                ),
            ),
        );

    const toolEndLine = (current: Ui, event: AgentSessionEvent): StyledText => {
        const mod = current.mod;
        const name = String(
            (event as { toolName?: unknown }).toolName ?? "tool",
        );
        if ((event as { isError?: unknown }).isError !== true) {
            return styled(
                mod,
                mod.fg("#565f89")("│ "),
                mod.fg("#9ece6a")("✓ "),
                mod.fg("#565f89")(`${name} done`),
            );
        }
        const detail = contentText((event as { result?: unknown }).result);
        const suffix =
            detail === undefined || detail.trim() === ""
                ? ""
                : `: ${preview(oneLine(detail), 160)}`;
        return styled(
            mod,
            mod.fg("#565f89")("│ "),
            mod.fg("#f7768e")("✗ "),
            mod.fg("#f7768e")(`${name} failed${suffix}`),
        );
    };

    const streamContent = (
        mod: TuiModule,
        kind: "text" | "thinking",
        buffer: string,
    ): StyledText | string =>
        kind === "thinking"
            ? styled(mod, mod.fg("#e0af68")("✦ "), mod.fg("#565f89")(buffer))
            : buffer;

    const streamDelta = (kind: "text" | "thinking", delta: string): void => {
        // Capture the issue now: callbacks may run after the renderer is
        // ready, by which time the active issue could have advanced.
        const key = activeIssue;
        withUi((current) => {
            const transcript = transcriptFor(key);
            const streaming = transcript.stream;
            if (streaming === undefined || streaming.kind !== kind) {
                const buffer = delta.slice(-MAX_STREAM_CHARACTERS);
                const line = appendLine(
                    current,
                    key,
                    streamContent(current.mod, kind, buffer),
                );
                transcript.stream = { kind, buffer, line };
                current.renderer.requestRender();
                return;
            }
            streaming.buffer += delta;
            if (streaming.buffer.length > MAX_STREAM_CHARACTERS) {
                streaming.buffer = streaming.buffer.slice(
                    -MAX_STREAM_CHARACTERS,
                );
            }
            const content = streamContent(current.mod, kind, streaming.buffer);
            streaming.line.content = content;
            if (streaming.line.node !== undefined) {
                streaming.line.node.content = content;
            }
            current.renderer.requestRender();
        });
    };

    const onToolStart = (event: AgentSessionEvent): void => {
        const key = activeIssue;
        withUi((current) => {
            endStreamFor(key);
            appendLine(current, key, toolStartLine(current, event));
        });
        refreshStatus();
    };

    const onToolEnd = (event: AgentSessionEvent): void => {
        const key = activeIssue;
        withUi((current) => {
            endStreamFor(key);
            appendLine(current, key, toolEndLine(current, event));
        });
        refreshStatus();
    };

    const onAgentStart = (context: AgentEventContext): void => {
        const key = activeIssue;
        withUi((current) => {
            endStreamFor(key);
            appendLine(
                current,
                key,
                styled(
                    current.mod,
                    current.mod.fg("#7aa2f7")("╭─ "),
                    current.mod.fg("#7aa2f7")(
                        current.mod.bold(
                            `pi · ${context.title ?? context.sessionID}`,
                        ),
                    ),
                ),
            );
        });
        refreshStatus();
    };

    const onAgentEnd = (): void => {
        const key = activeIssue;
        withUi((current) => {
            endStreamFor(key);
            appendLine(
                current,
                key,
                styled(current.mod, current.mod.fg("#565f89")("╰─ done")),
            );
        });
        refreshStatus();
    };

    const onMessageUpdate = (event: AgentSessionEvent): void => {
        const update = (
            event as {
                assistantMessageEvent?: {
                    type?: unknown;
                    delta?: unknown;
                };
            }
        ).assistantMessageEvent;
        if (update?.type === "text_delta" && typeof update.delta === "string") {
            streamDelta("text", update.delta);
            return;
        }
        if (
            update?.type === "thinking_delta" &&
            typeof update.delta === "string"
        ) {
            streamDelta("thinking", update.delta);
            return;
        }
        if (update?.type === "text_end" || update?.type === "thinking_end") {
            const key = activeIssue;
            withUi(() => endStreamFor(key));
            refreshStatus();
        }
    };

    const handleAgentEvent = (
        event: AgentSessionEvent,
        context: AgentEventContext,
    ): void => {
        const type = (event as { type?: unknown }).type;
        state = reduceAgentSessionEvent(state, event, context, now);
        if (type === "tool_execution_start") return onToolStart(event);
        if (type === "tool_execution_end") return onToolEnd(event);
        if (type === "agent_start") return onAgentStart(context);
        if (type === "agent_end") return onAgentEnd();
        if (type === "message_update") return onMessageUpdate(event);
    };

    const persist = (update: ProgressUpdate): void => {
        if (eventLog === undefined) return;
        const event: ProgressEvent = {
            ...update,
            runId,
            timestamp: now().toISOString(),
        };
        eventLog.append(event);
    };

    const progressLine = (
        current: Ui,
        update: ProgressUpdate,
    ): StyledText | undefined => {
        const mod = current.mod;
        const label =
            update.issue === undefined ? "" : ` #${update.issue.number}`;
        switch (update.status) {
            case "started":
                return undefined;
            case "succeeded":
                return styled(
                    mod,
                    mod.fg("#9ece6a")("✓"),
                    mod.fg("#565f89")(label),
                    ` ${update.message}`,
                );
            case "failed":
                return styled(
                    mod,
                    mod.fg("#f7768e")("✗"),
                    mod.fg("#565f89")(label),
                    " ",
                    mod.fg("#f7768e")(update.message),
                );
            case "skipped":
                return styled(
                    mod,
                    mod.fg("#565f89")(`−${label} ${update.message}`),
                );
            case "needs-attention":
                return styled(
                    mod,
                    mod.fg("#e0af68")("⚠"),
                    mod.fg("#565f89")(label),
                    " ",
                    mod.fg("#e0af68")(update.message),
                );
            case "info":
                return styled(
                    mod,
                    mod.fg("#565f89")(`•${label} ${update.message}`),
                );
        }
    };

    const transcriptKeyFor = (update: ProgressUpdate): TranscriptKey => {
        const issueNumber = update.issue?.number;
        return issueNumber !== undefined &&
            state.queue.some((entry) => entry.number === issueNumber)
            ? issueNumber
            : undefined;
    };

    const handleProgress = (update: ProgressUpdate): void => {
        state = reduceProgressUpdate(state, update, now);
        const key = transcriptKeyFor(update);
        // Only an issue that starts executing becomes the followed issue;
        // skipped or needs-attention events keep the current view.
        if (
            key !== undefined &&
            update.stage === "issue-execution" &&
            update.status === "started"
        ) {
            activeIssue = key;
        }
        withUi((current) => {
            const line = progressLine(current, update);
            if (line !== undefined) appendLine(current, key, line);
            paintSidebar(current);
            if (followActive && activeIssue !== selected) {
                selectTranscript(current, activeIssue, false);
            }
            renderStatus(current);
            renderHeader(current);
            current.renderer.requestRender();
        });
    };

    const navigateIssues = (direction: -1 | 1): void => {
        const keys: Array<TranscriptKey> = [
            undefined,
            ...state.queue.map(({ number }) => number),
        ];
        const index = keys.indexOf(selected);
        const next = (index + direction + keys.length) % keys.length;
        withUi((current) => selectTranscript(current, keys[next], true));
    };

    const readyPromise = (async () => {
        const mod = await import("@opentui/core");
        const renderer = await (options.createRenderer ?? createLiveRenderer)();
        if (disposed) {
            renderer.destroy();
            return;
        }
        const root = new mod.BoxRenderable(renderer, {
            id: "tui-root",
            flexDirection: "column",
            width: "100%",
            height: "100%",
            borderStyle: "rounded",
            borderColor: "#3b4261",
            title: " ralphie ",
            titleAlignment: "left",
        });
        const header = new mod.TextRenderable(renderer, {
            id: "tui-header",
            content: "",
            height: 1,
            width: "100%",
            wrapMode: "none",
            paddingLeft: 1,
            paddingRight: 1,
        });
        const body = new mod.BoxRenderable(renderer, {
            id: "tui-body",
            flexDirection: "row",
            flexGrow: 1,
            width: "100%",
        });
        const sidebarPane = new mod.BoxRenderable(renderer, {
            id: "tui-sidebar-pane",
            flexDirection: "column",
            width: 28,
            minWidth: 18,
            maxWidth: 36,
            border: ["right"],
            borderStyle: "single",
            borderColor: "#3b4261",
        });
        const sidebar = new mod.ScrollBoxRenderable(renderer, {
            id: "tui-sidebar",
            flexGrow: 1,
            width: "100%",
            scrollY: true,
            contentOptions: { minHeight: 0 },
        });
        const controlHint = new mod.TextRenderable(renderer, {
            id: "tui-sidebar-control-hint",
            content: styled(
                mod,
                mod.fg("#565f89")(
                    paused && !stopRequested ? RESUME_HINT : PAUSE_HINT,
                ),
            ),
            height: 1,
            width: "100%",
            wrapMode: "none",
            paddingLeft: 1,
            paddingRight: 1,
        });
        const navigationHint = new mod.TextRenderable(renderer, {
            id: "tui-sidebar-navigation-hint",
            content: styled(mod, mod.fg("#565f89")(NAVIGATION_HINT)),
            height: 1,
            width: "100%",
            wrapMode: "none",
            paddingLeft: 1,
            paddingRight: 1,
        });
        const transcript = new mod.ScrollBoxRenderable(renderer, {
            id: "tui-transcript",
            flexGrow: 1,
            stickyScroll: true,
            stickyStart: "bottom",
            paddingLeft: 1,
            paddingRight: 1,
            contentOptions: { minHeight: 0 },
        });
        const status = new mod.TextRenderable(renderer, {
            id: "tui-status",
            content: "",
            height: 1,
            width: "100%",
            wrapMode: "none",
            paddingLeft: 1,
            paddingRight: 1,
        });
        const pickerOverlay = new mod.BoxRenderable(renderer, {
            id: "tui-model-picker-overlay",
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            justifyContent: "center",
            alignItems: "center",
            zIndex: 20,
            visible: false,
        });
        const pickerBox = new mod.BoxRenderable(renderer, {
            id: "tui-model-picker",
            flexDirection: "column",
            width: 68,
            maxWidth: "94%",
            height: 15,
            maxHeight: "90%",
            borderStyle: "rounded",
            borderColor: "#3b4261",
            backgroundColor: "#16161e",
            title: " Select model ",
            titleAlignment: "left",
            paddingLeft: 1,
            paddingRight: 1,
        });
        const pickerHint = new mod.TextRenderable(renderer, {
            id: "tui-model-picker-hint",
            content: styled(mod, mod.fg("#565f89")(PICKER_HINT)),
            height: 1,
            width: "100%",
            wrapMode: "none",
        });
        const pickerRow = new mod.BoxRenderable(renderer, {
            id: "tui-model-picker-row",
            flexDirection: "row",
            flexGrow: 1,
            width: "100%",
        });
        const modelColumn = new mod.BoxRenderable(renderer, {
            id: "tui-model-picker-models",
            flexDirection: "column",
            flexGrow: 1,
            minWidth: 0,
        });
        const levelColumn = new mod.BoxRenderable(renderer, {
            id: "tui-model-picker-levels",
            flexDirection: "column",
            width: 24,
        });
        const modelHeader = new mod.TextRenderable(renderer, {
            id: "tui-model-picker-models-header",
            content: styled(mod, mod.fg("#565f89")("Models")),
            height: 1,
            width: "100%",
            wrapMode: "none",
        });
        const levelHeader = new mod.TextRenderable(renderer, {
            id: "tui-model-picker-levels-header",
            content: styled(mod, mod.fg("#565f89")("Thinking level")),
            height: 1,
            width: "100%",
            wrapMode: "none",
        });
        const modelList = new mod.SelectRenderable(renderer, {
            id: "tui-model-list",
            flexGrow: 1,
            width: "100%",
            options: [],
            showScrollIndicator: true,
            wrapSelection: true,
            ...PICKER_COLORS,
        });
        const levelList = new mod.SelectRenderable(renderer, {
            id: "tui-level-list",
            flexGrow: 1,
            width: "100%",
            options: [],
            showDescription: false,
            showScrollIndicator: true,
            wrapSelection: true,
            ...PICKER_COLORS,
        });
        pickerBox.add(pickerHint);
        pickerBox.add(pickerRow);
        pickerRow.add(modelColumn);
        pickerRow.add(levelColumn);
        modelColumn.add(modelHeader);
        modelColumn.add(modelList);
        levelColumn.add(levelHeader);
        levelColumn.add(levelList);
        pickerOverlay.add(pickerBox);
        renderer.root.add(root);
        root.add(header);
        root.add(body);
        body.add(sidebarPane);
        sidebarPane.add(sidebar);
        sidebarPane.add(controlHint);
        sidebarPane.add(navigationHint);
        body.add(transcript);
        body.add(pickerOverlay);
        root.add(status);
        // Rows select on click; keep events from moving focus off the
        // transcript, which owns Up/Down/PgUp/PgDn scrolling.
        sidebar.focusable = false;
        ui = {
            mod,
            renderer,
            root,
            header,
            sidebar,
            sidebarRows: new Map(),
            controlHint,
            transcript,
            status,
            pickerOverlay,
            modelList,
            levelList,
        };
        transcript.focus();
        modelList.on("selectionChanged", () => {
            if (ui !== undefined) refreshLevelOptions(ui);
        });
        modelList.on("itemSelected", () => {
            if (ui !== undefined) applyModelPick(ui);
        });
        levelList.on("itemSelected", () => {
            if (ui !== undefined) applyModelPick(ui);
        });
        renderer.keyInput.on("keypress", dispatchKey);
        renderHeader(ui);
        renderStatus(ui);
        renderControlHint(ui);
        paintSidebar(ui);
        renderer.requestRender();
        timer = setInterval(() => {
            if (disposed) return;
            spinnerIndex += 1;
            refreshStatus();
        }, SPINNER_INTERVAL_MS);
        timer.unref?.();
        for (const run of queued.splice(0)) run();
    })();

    const progress: ProgressReporterService = {
        emit: async (update) => {
            if (disposed) return;
            persist(update);
            handleProgress(update);
        },
    };

    const piListener: AgentEventListener = (event, context) => {
        if (disposed) return;
        handleAgentEvent(event, context);
    };

    return {
        progress,
        piListener,
        control,
        ready: readyPromise.catch(() => undefined),
        dispose: async () => {
            if (disposed) return;
            disposed = true;
            if (timer !== undefined) clearInterval(timer);
            await readyPromise.catch(() => undefined);
            ui?.renderer.destroy();
            ui = undefined;
        },
    };
};