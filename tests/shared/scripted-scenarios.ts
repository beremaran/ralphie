import type {
    AgentEventContext,
    AgentEventListener,
    AgentSessionEvent,
} from "../../src/opencode/client.ts";
import type {
    ProgressRenderMode,
    ProgressReporterService,
    ProgressUpdate,
} from "../../src/progress/progress.ts";

/**
 * Deterministic, mode-parametric scripted agent sessions for the command
 * runtime integration harness.
 *
 * Every scenario is a fixed, ordered list of logical steps (agent events,
 * progress emits, raw chunks, lifecycle hooks). The exact same step list is
 * played for every output mode, so outputs across modes are comparable and two
 * independent runs of the same (scenario, mode) pair produce identical bytes
 * (no UUIDs or clocks are embedded; the harness injects a fixed `now`).
 */

export const ASSISTANT_DELTAS = [
    "The first ",
    "framework ",
    "assembles ",
    "services ",
    "explicitly.",
];

export const VERIFICATION_FAILURE_MESSAGE = "verification gate failed";

/** Needs-attention epilogue message so quiet-mode runs emit both symbols. */
export const VERIFICATION_NEEDS_ATTENTION_MESSAGE =
    "verification needs attention";

/**
 * The fixture's repository path, carried by progress updates exactly as the
 * real executors do. Every human-readable mode renders it verbatim inside the
 * progress-line scope marker (`[…]`), per the GH-180 unredacted contract.
 */
export const LABEL_REPOSITORY = "/workspace/owner/repository";

/**
 * The fixture's issue number/title, carried by progress updates exactly as
 * the real executors do. Every human-readable mode renders the number on
 * every failure/needs-attention line and the title on needs-attention lines,
 * verbatim.
 */
export const LABEL_ISSUE = {
    number: 7,
    title: "Keep display label values verbatim",
} as const;

/** Raw writeRaw chunks for the interleaved-streams scenario, in emit order. */
export const INTERLEAVED_RAW = [
    "fetching metadata ",
    "chunk A ",
    "chunk B ",
    "chunk C\n",
    "stream complete\n",
] as const;

/** Assistant text deltas for the interleaved-streams scenario, in emit order. */
export const INTERLEAVED_TEXT = [
    "inspecting the repository tree and its layout to plan the change",
    " then deciding where the seam goes",
    " and applying the change",
] as const;

/** Credential-like token split across adjacent `text_delta` boundaries. */
export const CREDENTIAL_TEXT = "ghx_0123456789abcdef0123456789abcdef";

/** Credential-like token split across adjacent `writeRaw` chunk boundaries. */
export const CREDENTIAL_RAW = "sk-proj-0123456789ABCDEF0123456789AbcDEF";

/** Unsafe detail values surfaced only when `--output verbose` is on. */
export const UNSAFE_API_KEY = "sk-proj-0123456789ABCDEF0123456789abcDEF";
export const UNSAFE_TOKEN = "Bearer ghx_0123456789abcdef";
export const UNSAFE_DETAILS = {
    apiKey: UNSAFE_API_KEY,
    authorization: UNSAFE_TOKEN,
};

/** Assistant text several times wider than the default terminal width. */
export const LONG_TEXT =
    "deterministic scenario steps for comparable bytes in every output mode "
        .repeat(4)
        .trimEnd();

/** Tool command argument several times wider than the default terminal width. */
export const LONG_COMMAND = `echo ${"x".repeat(320)}`;

/** Tool result content several times wider than the default terminal width. */
export const LONG_RESULT = { content: "output ".repeat(40) };

/** Progress message several times wider than the default terminal width. */
export const LONG_PROGRESS =
    "verifying the long output path across the full pipeline and its seams "
        .repeat(4)
        .trimEnd();

/** Wide-grapheme content: CJK, emoji, and combining sequences. */
export const WIDE_TEXT =
    "漢字のレイアウト検査 e\u0301\u0301lision 🎉 絵文字 🚀✨";
export const WIDE_COMMAND = "echo ワイド文字列テスト 🎉 e\u0301 完了 ✨";

/** Progress messages for the wide-grapheme scenario. */
export const WIDE_PROGRESS_STARTED = "多バイト文字の進捗メッセージ 🎉 幅確認";
export const WIDE_PROGRESS_DONE = "幅確認完了 ✨";

/** Width the resize scenario switches to mid-run. */
export const RESIZE_TARGET_WIDTH = 12;

const asEvent = (value: unknown): AgentSessionEvent =>
    value as AgentSessionEvent;

const agentStartEvent = asEvent({ type: "agent_start" });
const agentSettledEvent = asEvent({ type: "agent_settled" });

const messageUpdate = (assistantMessageEvent: unknown): AgentSessionEvent =>
    asEvent({ type: "message_update", assistantMessageEvent });

const textStart = (contentIndex = 0): AgentSessionEvent =>
    messageUpdate({ type: "text_start", contentIndex });

const textDelta = (delta: string, contentIndex = 0): AgentSessionEvent =>
    messageUpdate({ type: "text_delta", contentIndex, delta });

const textEnd = (contentIndex = 0): AgentSessionEvent =>
    messageUpdate({ type: "text_end", contentIndex });

const thinkingStart = (contentIndex = 0): AgentSessionEvent =>
    messageUpdate({ type: "thinking_start", contentIndex });

const thinkingDelta = (delta: string, contentIndex = 0): AgentSessionEvent =>
    messageUpdate({ type: "thinking_delta", contentIndex, delta });

const thinkingEnd = (contentIndex = 0): AgentSessionEvent =>
    messageUpdate({ type: "thinking_end", contentIndex });

const toolcallDelta = (
    toolCallId: string,
    toolName: string,
    args: unknown,
): AgentSessionEvent =>
    messageUpdate({
        type: "toolcall_delta",
        contentIndex: 0,
        partial: {
            content: [
                {
                    type: "toolCall",
                    id: toolCallId,
                    name: toolName,
                    arguments: args,
                },
            ],
        },
    });

const toolStart = (toolCallId: string, toolName: string, args: unknown) =>
    asEvent({ type: "tool_execution_start", toolCallId, toolName, args });

const toolUpdate = (toolCallId: string, toolName: string) =>
    asEvent({
        type: "tool_execution_update",
        toolCallId,
        toolName,
        partialResult: { content: "intermediate tool output" },
    });

const toolEnd = (
    toolCallId: string,
    toolName: string,
    result: unknown,
    isError: boolean,
) =>
    asEvent({
        type: "tool_execution_end",
        toolCallId,
        toolName,
        result,
        isError,
    });

const compactionStart = (reason: string) =>
    asEvent({ type: "compaction_start", reason });

const compactionEnd = (aborted: boolean) =>
    asEvent({ type: "compaction_end", aborted });

const autoRetryStart = (attempt: number, maxAttempts: number) =>
    asEvent({ type: "auto_retry_start", attempt, maxAttempts });

const autoRetryEnd = (success: boolean) =>
    asEvent({ type: "auto_retry_end", success });

const summaryRetryScheduled = (attempt: number, maxAttempts: number) =>
    asEvent({ type: "summarization_retry_scheduled", attempt, maxAttempts });

const summaryRetryAttemptStart = asEvent({
    type: "summarization_retry_attempt_start",
});

const summaryRetryFinished = asEvent({ type: "summarization_retry_finished" });

const agentEnd = (willRetry: boolean) =>
    asEvent({ type: "agent_end", willRetry });

const progress = (update: ProgressUpdate): ScenarioStep => ({
    kind: "progress",
    update,
});
const raw = (text: string): ScenarioStep => ({ kind: "raw", text });
const event = (event: AgentSessionEvent): ScenarioStep => ({
    kind: "event",
    event,
});
const settle = { kind: "settle" } as const;
const resize = (width: number): ScenarioStep => ({ kind: "resize", width });
const breadcrumb = { kind: "breadcrumb" } as const;
const abort = { kind: "abort" } as const;

/** One deterministic logical step of a scripted scenario. */
export type ScenarioStep =
    | { readonly kind: "event"; readonly event: AgentSessionEvent }
    | { readonly kind: "progress"; readonly update: ProgressUpdate }
    | { readonly kind: "raw"; readonly text: string }
    | { readonly kind: "settle" }
    | { readonly kind: "resize"; readonly width: number }
    | { readonly kind: "breadcrumb" }
    | { readonly kind: "abort" };

export const SCENARIO_NAMES = [
    "completion",
    "interleaved-streams",
    "thinking-tools",
    "lifecycle",
    "abort",
    "breadcrumb-refresh",
    "long-output",
    "wide-grapheme",
    "verbose-unsafe",
    "split-credentials",
    "resize",
] as const;

export type ScenarioName = (typeof SCENARIO_NAMES)[number];

/** One bounded bash + read cycle, matching the historical baseline script. */
const runToolCycle = (cycle: number): ScenarioStep[] => {
    const id = `tool-${cycle}`;
    return [
        event(
            toolStart(id, "bash", {
                command: `echo cycle ${cycle} step ${"x".repeat(90)}`,
            }),
        ),
        ...Array.from({ length: 5 }, () => event(toolUpdate(id, "bash"))),
        event(toolEnd(id, "bash", { content: `output ${cycle}` }, false)),
        event(
            toolStart(`read-${cycle}`, "read", {
                path: `/workspace/owner/repository/src/file-${cycle}.ts`,
            }),
        ),
        event(toolEnd(`read-${cycle}`, "read", { content: "source" }, false)),
    ];
};

/** Baseline completion path: agent_settled then the workflow returns. */
const completionScenario = (): ScenarioStep[] => [
    event(agentStartEvent),
    event(textStart()),
    ...ASSISTANT_DELTAS.map((delta) => event(textDelta(delta))),
    ...Array.from({ length: 4 }, (_, cycle) => [
        settle,
        ...runToolCycle(cycle),
    ]).flat(1),
    event(toolStart("fail-1", "grep", { pattern: "needle" })),
    event(
        toolEnd(
            "fail-1",
            "grep",
            {
                content:
                    "error: no matches found in the repository tree at all",
            },
            true,
        ),
    ),
    progress({
        stage: "implementation",
        status: "started",
        message: "writing change",
    }),
    progress({
        stage: "implementation",
        status: "succeeded",
        message: "change written",
    }),
    ...FAILURE_EPILOGUE,
    event(agentSettledEvent),
    settle,
];

/**
 * Shared failure epilogue so quiet-mode runs always emit bytes: one failed
 * event and one needs-attention event, both carrying details whose values
 * the unredacted output contract preserves verbatim. The epilogue also
 * carries the fixture's repository path and issue number/title, so every
 * human-readable mode surfaces those display-context labels verbatim on the
 * failure and needs-attention lines (mirroring the real executors, which
 * attach `repository` and `issue` to progress events).
 */
const FAILURE_EPILOGUE: ScenarioStep[] = [
    progress({
        stage: "verification",
        status: "failed",
        message: VERIFICATION_FAILURE_MESSAGE,
        repository: LABEL_REPOSITORY,
        issue: LABEL_ISSUE,
        details: { verify: "bun run check" },
    }),
    progress({
        stage: "verification",
        status: "needs-attention",
        message: VERIFICATION_NEEDS_ATTENTION_MESSAGE,
        repository: LABEL_REPOSITORY,
        issue: LABEL_ISSUE,
        details: { verify: "bun run check" },
    }),
];

/** Partial raw chunks interleaved with agent text/tool deltas and progress. */
const interleavedStreamsScenario = (): ScenarioStep[] => [
    event(agentStartEvent),
    raw(INTERLEAVED_RAW[0]),
    raw(INTERLEAVED_RAW[1]),
    event(textStart()),
    event(textDelta(INTERLEAVED_TEXT[0])),
    raw(INTERLEAVED_RAW[2]),
    event(toolStart("raw-1", "bash", { command: "echo raw-interleave" })),
    event(textDelta(INTERLEAVED_TEXT[1])),
    raw(INTERLEAVED_RAW[3]),
    event(toolUpdate("raw-1", "bash")),
    progress({
        stage: "implementation",
        status: "started",
        message: "assembling",
    }),
    event(toolUpdate("raw-1", "bash")),
    event(textDelta(INTERLEAVED_TEXT[2])),
    event(toolEnd("raw-1", "bash", { content: "raw interleave" }, false)),
    raw(INTERLEAVED_RAW[4]),
    progress({
        stage: "implementation",
        status: "succeeded",
        message: "assembled",
    }),
    event(textEnd()),
    event(agentSettledEvent),
    ...FAILURE_EPILOGUE,
];

/** Thinking/assistant/toolcall streams interleaved with tool execution. */
const thinkingToolsScenario = (): ScenarioStep[] => [
    event(agentStartEvent),
    event(thinkingStart()),
    event(thinkingDelta("We need to inspect ")),
    event(toolStart("find-1", "find", { pattern: "*.ts", path: "/workspace" })),
    event(thinkingDelta("the repository layout first.")),
    event(toolUpdate("find-1", "find")),
    event(textStart()),
    event(toolcallDelta("tc-1", "bash", { command: "cat src/index.ts" })),
    event(textDelta("Let me look at the entry point and its imports.")),
    event(toolUpdate("find-1", "find")),
    event(thinkingEnd()),
    event(textDelta(" The module boundary looks clean.")),
    event(toolEnd("find-1", "find", { content: "src/index.ts" }, false)),
    event(textEnd()),
    event(agentSettledEvent),
    ...FAILURE_EPILOGUE,
];

/** Lifecycle boundaries, including `agent_end` with `willRetry: true`. */
const lifecycleScenario = (): ScenarioStep[] => [
    event(agentStartEvent),
    event(textStart()),
    event(textDelta("Working through a dense turn with lifecycle boundaries.")),
    event(textEnd()),
    event(compactionStart("context window nearing capacity")),
    event(compactionEnd(false)),
    event(autoRetryStart(1, 3)),
    event(autoRetryEnd(false)),
    event(autoRetryStart(2, 3)),
    event(autoRetryEnd(true)),
    event(summaryRetryScheduled(1, 2)),
    event(summaryRetryAttemptStart),
    event(toolStart("life-1", "bash", { command: "echo lifecycle" })),
    event(toolUpdate("life-1", "bash")),
    event(toolEnd("life-1", "bash", { content: "ok" }, false)),
    event(summaryRetryFinished),
    event(agentEnd(true)),
    event(agentStartEvent),
    event(textStart()),
    event(textDelta("Retrying with a shorter context.")),
    event(textEnd()),
    event(agentSettledEvent),
    ...FAILURE_EPILOGUE,
];

/** Abort path: the harness aborts the run via `deps.abort` at the end. */
const abortScenario = (): ScenarioStep[] => [
    event(agentStartEvent),
    event(textStart()),
    event(textDelta("Starting the aborted run session.")),
    event(textEnd()),
    event(toolStart("abort-1", "bash", { command: "echo abort" })),
    event(toolUpdate("abort-1", "bash")),
    event(toolEnd("abort-1", "bash", { content: "abort" }, false)),
    event(agentSettledEvent),
    ...FAILURE_EPILOGUE,
    abort,
];

/** Completed breadcrumbs followed by repeated started->succeeded cycles. */
const breadcrumbRefreshScenario = (): ScenarioStep[] => [
    event(agentStartEvent),
    event(textStart()),
    event(textDelta("First change lands on the existing path.")),
    event(textEnd()),
    event(toolStart("seed-1", "bash", { command: "echo breadcrumb-seed" })),
    event(toolUpdate("seed-1", "bash")),
    event(toolEnd("seed-1", "bash", { content: "seeded" }, false)),
    breadcrumb,
    breadcrumb,
    breadcrumb,
    settle,
    ...Array.from({ length: 5 }, (_, index) => {
        const gate = index + 1;
        return [
            progress({
                stage: "verification",
                status: "started",
                message: `running gate ${gate}`,
            }),
            progress({
                stage: "verification",
                status: "succeeded",
                message: `gate ${gate} passed`,
            }),
            settle,
        ];
    }).flat(1),
    event(agentSettledEvent),
    settle,
    ...FAILURE_EPILOGUE,
];

/** Assistant text, tool arguments/results, and progress messages much wider than the terminal. */
const longOutputScenario = (): ScenarioStep[] => [
    event(agentStartEvent),
    event(textStart()),
    event(textDelta(LONG_TEXT)),
    event(textEnd()),
    event(toolStart("long-1", "bash", { command: LONG_COMMAND })),
    event(toolUpdate("long-1", "bash")),
    event(toolUpdate("long-1", "bash")),
    event(toolEnd("long-1", "bash", LONG_RESULT, false)),
    progress({
        stage: "implementation",
        status: "started",
        message: LONG_PROGRESS,
    }),
    progress({
        stage: "implementation",
        status: "succeeded",
        message: "long output handled",
    }),
    event(agentSettledEvent),
    ...FAILURE_EPILOGUE,
];

/** Wide graphemes (CJK, emoji, combining sequences) at narrow widths. */
const wideGraphemeScenario = (): ScenarioStep[] => [
    event(agentStartEvent),
    event(textStart()),
    event(textDelta(WIDE_TEXT)),
    event(textEnd()),
    event(toolStart("wide-1", "bash", { command: WIDE_COMMAND })),
    event(toolUpdate("wide-1", "bash")),
    event(toolUpdate("wide-1", "bash")),
    event(
        toolEnd(
            "wide-1",
            "bash",
            { content: "幅の広い出力結果 🚀 漢字 ✨" },
            false,
        ),
    ),
    progress({
        stage: "implementation",
        status: "started",
        message: WIDE_PROGRESS_STARTED,
    }),
    progress({
        stage: "implementation",
        status: "succeeded",
        message: WIDE_PROGRESS_DONE,
    }),
    event(agentSettledEvent),
    ...FAILURE_EPILOGUE,
];

/** Verbose output with credential-like detail values. */
const verboseUnsafeScenario = (): ScenarioStep[] => [
    event(agentStartEvent),
    event(textStart()),
    event(textDelta("Authenticating against the artifact registry.")),
    event(textEnd()),
    event(
        toolStart("unsafe-1", "bash", {
            command: "upload the artifact bundle",
        }),
    ),
    event(toolUpdate("unsafe-1", "bash")),
    event(toolEnd("unsafe-1", "bash", { content: "uploaded" }, false)),
    progress({
        stage: "implementation",
        status: "started",
        message: "uploading artifact",
        details: UNSAFE_DETAILS,
    }),
    progress({
        stage: "implementation",
        status: "succeeded",
        message: "artifact uploaded",
        details: UNSAFE_DETAILS,
    }),
    progress({
        stage: "implementation",
        status: "needs-attention",
        message: "artifact upload requires attention",
        details: UNSAFE_DETAILS,
    }),
    event(agentSettledEvent),
    ...FAILURE_EPILOGUE,
];

/** Credential-like tokens split across writeRaw and text_delta boundaries. */
const splitCredentialsScenario = (): ScenarioStep[] => [
    event(agentStartEvent),
    event(textStart()),
    event(textDelta("Bearer ")),
    event(textDelta(CREDENTIAL_TEXT)),
    raw("sk-proj-"),
    raw("0123456789ABCDEF0123456789AbcDEF"),
    event(textEnd()),
    event(toolStart("split-1", "bash", { command: "echo split" })),
    event(toolEnd("split-1", "bash", { content: "split" }, false)),
    event(agentSettledEvent),
    ...FAILURE_EPILOGUE,
];

/** Mid-run terminal resize, started wide and continued at the narrow width. */
const resizeScenario = (): ScenarioStep[] => [
    event(agentStartEvent),
    event(textStart()),
    event(textDelta("Starting at the wide width for the first cycle.")),
    event(textEnd()),
    event(toolStart("resize-0", "bash", { command: "echo pre-resize" })),
    event(toolUpdate("resize-0", "bash")),
    event(toolEnd("resize-0", "bash", { content: "pre" }, false)),
    settle,
    resize(RESIZE_TARGET_WIDTH),
    settle,
    event(toolStart("resize-1", "bash", { command: "echo post-resize" })),
    event(toolUpdate("resize-1", "bash")),
    event(toolEnd("resize-1", "bash", { content: "post" }, false)),
    progress({
        stage: "verification",
        status: "started",
        message: "checking the narrow region",
    }),
    progress({
        stage: "verification",
        status: "succeeded",
        message: "narrow region verified",
    }),
    event(agentSettledEvent),
    settle,
    ...FAILURE_EPILOGUE,
];

const scriptFor = (name: ScenarioName): ScenarioStep[] => {
    switch (name) {
        case "completion":
            return completionScenario();
        case "interleaved-streams":
            return interleavedStreamsScenario();
        case "thinking-tools":
            return thinkingToolsScenario();
        case "lifecycle":
            return lifecycleScenario();
        case "abort":
            return abortScenario();
        case "breadcrumb-refresh":
            return breadcrumbRefreshScenario();
        case "long-output":
            return longOutputScenario();
        case "wide-grapheme":
            return wideGraphemeScenario();
        case "verbose-unsafe":
            return verboseUnsafeScenario();
        case "split-credentials":
            return splitCredentialsScenario();
        case "resize":
            return resizeScenario();
    }
};

/** Runtime hooks the harness wires into a played scenario. */
export type ScriptedScenarioDeps = {
    readonly listener: AgentEventListener;
    readonly context: AgentEventContext;
    readonly progress: ProgressReporterService;
    /** Flush the interactive refresh timer and observe the live region. */
    readonly settle?: () => void;
    /** Insert one breadcrumb derived from the coordinator's display state. */
    readonly insertBreadcrumb?: () => void;
    /** Resize the fake terminal surface to a new width. */
    readonly resize?: (width: number) => void;
    /** Abort the run's AbortController mid-scenario. */
    readonly abort?: () => void;
    /** Signal checked between steps so pre-aborted runs stop immediately. */
    readonly signal?: AbortSignal;
};

/**
 * Play one scenario: the same logical steps, in the same order, for every
 * mode. `mode` is accepted so callers can record which output mode the
 * playback belongs to; the step list itself is mode-invariant.
 */
export const playScriptedScenario = async (
    name: ScenarioName,
    mode: ProgressRenderMode,
    deps: ScriptedScenarioDeps,
): Promise<void> => {
    void mode;
    for (const step of scriptFor(name)) {
        if (deps.signal !== undefined && deps.signal.aborted) return;
        switch (step.kind) {
            case "event":
                deps.listener(step.event, deps.context);
                break;
            case "progress":
                await deps.progress.emit(step.update);
                break;
            case "raw":
                deps.progress.writeRaw?.(step.text);
                break;
            case "settle":
                deps.settle?.();
                break;
            case "resize":
                deps.resize?.(step.width);
                break;
            case "breadcrumb":
                deps.insertBreadcrumb?.();
                break;
            case "abort":
                deps.abort?.();
                break;
        }
    }
};

/** The ordered progress emits of a scenario, for JSON-matrix assertions. */
export const progressEmitsFor = (
    name: ScenarioName,
): readonly ProgressUpdate[] =>
    scriptFor(name)
        .filter(
            (
                step,
            ): step is Extract<ScenarioStep, { readonly kind: "progress" }> =>
                step.kind === "progress",
        )
        .map((step) => step.update);

/** The ordered agent events of a scenario, for JSON-matrix assertions. */
export const eventEmitsFor = (
    name: ScenarioName,
): readonly AgentSessionEvent[] =>
    scriptFor(name)
        .filter(
            (step): step is Extract<ScenarioStep, { readonly kind: "event" }> =>
                step.kind === "event",
        )
        .map((step) => step.event);