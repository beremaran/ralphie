import type {
    CliRenderer,
    ScrollBoxRenderable,
    StyledText,
    TextChunk,
    TextRenderable,
} from "@opentui/core";

import type {
    AgentEventContext,
    AgentSessionEvent,
    AgentEventListener,
} from "../../agent/ports.ts";
import type { RunEventLog } from "../../run/ports.ts";
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

type TuiModule = typeof import("@opentui/core");

type Ui = {
    readonly mod: TuiModule;
    readonly renderer: CliRenderer;
    readonly root: {
        title: string | undefined;
        readonly add: (child: unknown) => unknown;
    };
    readonly header: TextRenderable;
    readonly scroll: ScrollBoxRenderable;
    readonly status: TextRenderable;
    readonly lines: Array<TextRenderable>;
};

type StreamState = {
    readonly node: TextRenderable;
    readonly kind: "text" | "thinking";
    buffer: string;
};

const elapsedLabel = (startedAt: number | undefined, now: number): string => {
    if (startedAt === undefined) return "";
    const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
    const minutes = Math.floor(seconds / 60);
    return minutes === 0
        ? `${seconds}s`
        : `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
};

export type TuiCoordinatorOptions = ProgressCoordinatorOptions & {
    /** Test seam: build the renderer instead of creating a live one. */
    readonly createRenderer?: () => Promise<CliRenderer>;
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
 * Full-screen OpenTUI coordinator: streamed transcript, activity status, and
 * progress in one terminal application. The renderer is created lazily so
 * plain, JSON, and help paths never load the native module.
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
    let stream: StreamState | undefined;
    let spinnerIndex = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    const queued: Array<() => void> = [];

    const withUi = (run: (current: Ui) => void): void => {
        if (disposed) return;
        if (ui === undefined) {
            queued.push(() => withUi(run));
            return;
        }
        run(ui);
    };

    const appendLine = (current: Ui, content: StyledText | string): void => {
        const node = new current.mod.TextRenderable(current.renderer, {
            content,
            width: "100%",
            wrapMode: "word",
        });
        current.scroll.add(node);
        current.lines.push(node);
        while (current.lines.length > MAX_TRANSCRIPT_LINES) {
            const oldest = current.lines.shift();
            if (oldest === undefined) break;
            current.scroll.remove(oldest);
            oldest.destroy();
        }
    };

    const renderStatus = (current: Ui): void => {
        const mod = current.mod;
        const frame =
            SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length] ?? "⠋";
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
        current.status.content = styled(mod, ...parts);
    };

    const renderHeader = (current: Ui): void => {
        const mod = current.mod;
        const detail = state.repository ?? "ralphie";
        current.header.content = styled(
            mod,
            mod.fg("#7aa2f7")(mod.bold("ralphie")),
            mod.fg("#565f89")(" · "),
            detail,
        );
        current.root.title = ` ralphie · ${detail} `;
    };

    const refreshStatus = (): void => {
        withUi((current) => {
            renderStatus(current);
            renderHeader(current);
            current.renderer.requestRender();
        });
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

    const trimLines = (current: Ui): void => {
        while (current.lines.length > MAX_TRANSCRIPT_LINES) {
            const oldest = current.lines.shift();
            if (oldest === undefined) break;
            current.scroll.remove(oldest);
            oldest.destroy();
        }
    };

    const streamContent = (
        mod: TuiModule,
        kind: "text" | "thinking",
        buffer: string,
    ): StyledText | string =>
        kind === "thinking"
            ? styled(mod, mod.fg("#e0af68")("✦ "), mod.fg("#565f89")(buffer))
            : buffer;

    const startStream = (
        current: Ui,
        kind: "text" | "thinking",
        delta: string,
    ): void => {
        stream = undefined;
        const node = new current.mod.TextRenderable(current.renderer, {
            content: streamContent(current.mod, kind, delta),
            width: "100%",
            wrapMode: "word",
        });
        current.scroll.add(node);
        current.lines.push(node);
        stream = { node, kind, buffer: delta };
        trimLines(current);
    };

    const continueStream = (
        current: Ui,
        kind: "text" | "thinking",
        delta: string,
    ): void => {
        if (stream === undefined) return;
        stream.buffer = `${stream.buffer}${delta}`;
        if (stream.buffer.length > MAX_STREAM_CHARACTERS) {
            stream.buffer = stream.buffer.slice(-MAX_STREAM_CHARACTERS);
        }
        stream.node.content = streamContent(current.mod, kind, stream.buffer);
    };

    const streamDelta = (kind: "text" | "thinking", delta: string): void => {
        withUi((current) => {
            if (stream === undefined || stream.kind !== kind) {
                startStream(current, kind, delta);
            } else {
                continueStream(current, kind, delta);
            }
            current.renderer.requestRender();
        });
    };

    const onToolStart = (event: AgentSessionEvent): void => {
        stream = undefined;
        withUi((current) => appendLine(current, toolStartLine(current, event)));
        refreshStatus();
    };

    const onToolEnd = (event: AgentSessionEvent): void => {
        stream = undefined;
        withUi((current) => appendLine(current, toolEndLine(current, event)));
        refreshStatus();
    };

    const onAgentStart = (context: AgentEventContext): void => {
        stream = undefined;
        withUi((current) =>
            appendLine(
                current,
                styled(
                    current.mod,
                    current.mod.fg("#7aa2f7")("╭─ "),
                    current.mod.fg("#7aa2f7")(
                        current.mod.bold(
                            `pi · ${context.title ?? context.sessionID}`,
                        ),
                    ),
                ),
            ),
        );
        refreshStatus();
    };

    const onAgentEnd = (): void => {
        stream = undefined;
        withUi((current) =>
            appendLine(
                current,
                styled(current.mod, current.mod.fg("#565f89")("╰─ done")),
            ),
        );
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
            stream = undefined;
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

    const handleProgress = (update: ProgressUpdate): void => {
        state = reduceProgressUpdate(state, update, now);
        withUi((current) => {
            const line = progressLine(current, update);
            if (line !== undefined) appendLine(current, line);
            refreshStatus();
        });
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
        const scroll = new mod.ScrollBoxRenderable(renderer, {
            id: "tui-transcript",
            flexGrow: 1,
            width: "100%",
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
        renderer.root.add(root);
        root.add(header);
        root.add(scroll);
        root.add(status);
        ui = { mod, renderer, root, header, scroll, status, lines: [] };
        renderer.keyInput.on("keypress", (key) => {
            const parsed = key as {
                readonly ctrl?: boolean;
                readonly name?: string;
            };
            if (parsed.ctrl === true && parsed.name === "c") {
                process.kill(process.pid, "SIGINT");
            }
        });
        renderHeader(ui);
        renderStatus(ui);
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