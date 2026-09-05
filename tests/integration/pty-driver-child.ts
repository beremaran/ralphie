/**
 * Child entry point for the PTY driver integration tests.
 *
 * Invoked inside a real PTY by `launchPtyCommand` as
 * `bun <path>/pty-driver-child.ts --workspace <dir> [--scenario <name>]`.
 * It runs `runCommand` with the real interactive output coordinator and
 * injected fake agent-service, runtime, and workflow factories, so the
 * driver exercises the production command wiring end to end without ever
 * touching an agent server, GitHub, or a live repository.
 *
 * Scenarios:
 * - `smoke` (default): the deterministic scenario session from the #195
 *   coverage tracks — one long assistant text stream (ASCII run, wide
 *   graphemes, embedded control bytes, a ZWJ grapheme split across a delta
 *   boundary) plus the full lifecycle milestone script (compaction,
 *   auto-retry, summarization retry, a failing tool execution, and the
 *   ordinary close). After `PTY_ACTIVE` the stream stays open across exactly
 *   two driver resizes; the closing tool end + `agent_end` fire only after
 *   the second resize, then the stream finalizes exactly once and the
 *   progress sequence settles. Every milestone is written to stdout (which
 *   is the PTY) so the driver synchronizes on explicit markers.
 * - `completion`, `interrupt`, `failure`: lifecycle-cleanup scripts. All
 *   mid-run milestones are appended to the workspace event log ONLY, never
 *   to stdout: writing to the PTY while the interactive region is painted
 *   would unbalance the controller's cursor bookkeeping and leave residue
 *   the cleanup tests exist to rule out. Instead the child writes exactly
 *   three stdout lines after `runCommand` has fully returned and disposed —
 *   `PTY_DISPOSED`, `PTY_QUIESCENT`, and the final durable `PTY_POST_DISPOSE`
 *   — and holds the process alive until the driver's SIGUSR1 release, so the
 *   driver can prove pending timers, post-dispose events, a double dispose,
 *   and a post-settle resize all write zero bytes.
 */

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { runCommand, type CommandFactories } from "../../src/command.ts";
import type {
    AgentEventContext,
    AgentEventListener,
    AgentSessionEvent,
} from "../../src/opencode/client.ts";
import type { OpenCodeProviderConfig } from "../../src/opencode/config.ts";
import type {
    OpenCodeRuntime,
    OpenCodeService,
} from "../../src/opencode/server.ts";
import {
    breadcrumbCandidateFor,
    DEFAULT_BREADCRUMB_THRESHOLD,
} from "../../src/progress/breadcrumb.ts";
import {
    makeProgressCoordinator,
    type ProgressCoordinator,
    type ProgressCoordinatorOptions,
} from "../../src/progress/coordinator.ts";
import type {
    ProgressIssue,
    ProgressUpdate,
} from "../../src/progress/progress.ts";
import type { TerminalOutputController } from "../../src/progress/terminal-controller.ts";
import type { RalphieRuntime } from "../../src/runtime.ts";
import type { WorkflowOptions } from "../../src/workflow.ts";

/** Marker written after the interactive footer paints for the first time. */
export const FOOTER_MARKER = "PTY_FOOTER";
/** Marker written once the long agent stream is open. */
export const ACTIVE_MARKER = "PTY_ACTIVE";
export const RESIZE_MARKER_PREFIX = "PTY_RESIZED:";
export const DONE_MARKER = "PTY_DONE";
/** Marker written exactly once after the stream closes (resize gate passed). */
export const STREAM_FINALIZED_MARKER = "PTY_STREAM_FINALIZED";
/** Marker written after the progress sequence settles; the run is over. */
export const SCENARIO_DONE_MARKER = "PTY_SCENARIO_DONE";
/**
 * Post-run markers (lifecycle scenarios only). `POST_DISPOSE_MARKER` is the
 * final durable stdout line, written only after `runCommand` has fully
 * returned and disposed; `DISPOSED_MARKER` and `QUIESCENT_MARKER` bracket the
 * zero-byte windows the driver asserts on.
 */
export const DISPOSED_MARKER = "PTY_DISPOSED";
export const QUIESCENT_MARKER = "PTY_QUIESCENT";
export const POST_DISPOSE_MARKER = "PTY_POST_DISPOSE";
/** Workspace event-log name recording every milestone the child logs. */
export const EVENT_LOG_NAME = "pty-driver-events.jsonl";
/**
 * Deterministic scenario options for the PTY fixture: terminal geometry,
 * issue identity and retry position, and the rendered-line cadence
 * threshold. The child records a `config` event-log milestone with these so
 * the driver can assert the scenario ran with exactly the parsed options.
 */
export type PtyScenarioOptions = {
    readonly columns: number;
    readonly rows: number;
    readonly issueCurrent: number;
    readonly issueTotal: number;
    readonly issueNumber: number;
    readonly repository: string;
    readonly attempt: number;
    readonly maxAttempts: number;
    readonly threshold: number;
};
/**
 * Durable failure line emitted only AFTER the driver resizes the PTY: at 60
 * columns it wraps, which the screen oracle proves.
 */
export const LONG_FAILURE_MESSAGE =
    "verification gate failed — after the PTY resize this durable line wraps at sixty columns, proving the terminal reflowed.";
/** Seconds the child waits for the driver's three actions before bailing. */
export const DRIVER_ACTIONS_TIMEOUT_MS = 60_000;

export const CHILD_SCENARIOS = [
    "smoke",
    "completion",
    "interrupt",
    "failure",
] as const;
export type ChildScenario = (typeof CHILD_SCENARIOS)[number];
/** The lifecycle-cleanup scripts, each with its own outcome path. */
export type LifecycleScenario = "completion" | "interrupt" | "failure";

/** Live-only progress messages: fine on the painted region, never durable. */
export const LIFECYCLE_MESSAGES = {
    runStarted: "Lifecycle run started",
    groundingStarted: "Examining the lifecycle premise",
    implementationStarted: "Implementing the lifecycle scenario",
    implementationSucceeded: "Lifecycle scenario implemented",
    groundingSucceeded: "Lifecycle premise validated",
    verificationSucceeded: "Lifecycle verification passed",
} as const;

/** Streamed assistant deltas per lifecycle script; the tail is the last. */
export const LIFECYCLE_STREAM_DELTAS: Record<
    LifecycleScenario,
    readonly string[]
> = {
    completion: [
        "The lifecycle driver settles every",
        " progress stage and the agent",
        " session on a real PTY.",
    ],
    interrupt: [
        "The lifecycle driver is interrupted",
        " mid-stream by the PTY SIGINT",
        " before the run settles.",
    ],
    failure: [
        "The lifecycle driver is cut short",
        " by a mid-stream failure",
        " before the run settles.",
    ],
};

/**
 * Post-dispose quiescence window: comfortably longer than the footer refresh
 * scheduler's 100-125 ms window so a leaked timer would have to fire.
 */
export const FOOTER_REPAINT_QUIESCE_MS = 400;

/**
 * Distinctive credential literal for credential-placement coverage.
 *
 * The token must appear only inside `tool_execution_update.partialResult.content`
 * and inside one (negative) `thinking_delta` content — never in tool args,
 * progress messages, breadcrumb labels, assistant text deltas, or command
 * targets. The visible surface (transcript, activity rows, footer, breadcrumbs)
 * stays credential-free while the lossless JSON event stream still contains it.
 */
export const FAKE_TOKEN = "rk_s3cret_pty_9f3d_token";

const ZWJ = "\u200d";
/** The wide-grapheme pair split across a delta boundary (D6 | D7 below). */
const WIDE_ZWJ_FIRST = `👩${ZWJ}`;
const WIDE_ZWJ_SECOND = "💻";

/**
 * The deterministic smoke scenario's long assistant text stream.
 *
 * The concatenated deltas are one continuous assistant message: an ASCII run,
 * a wide-grapheme run (CJK and emoji, every character `Bun.stringWidth >= 2`),
 * raw control bytes inside the deltas (an SGR `\x1b[31m` run, an OSC hyperlink
 * `\x1b]8;;https://example.invalid\x07…\x07`, BEL `\x07`, and backspace `\x08`),
 * and deltas that end mid-line with no trailing newline. The message totals
 * 139 UTF-16 units, within the coordinator's 140-unit per-stream render
 * budget (`STREAM_OUTPUT_LIMIT` in `src/progress/transcript.ts`), so the
 * entire message renders and the stream ends mid-line.
 *
 * Control bytes: the transcript sanitizer (`stripTerminalControls`) removes SGR,
 * OSC, BEL, and backspace for display, so the deltas carry them without any
 * terminal side effect; the two control-byte lines keep their ASCII labels
 * ("SGR", "OSC x", "BEL BS") visible on screen.
 *
 * Wide-grapheme split: delta 6 ends with `👩\u200d` (the leading surrogate pair
 * and the ZWJ joiner) and delta 7 begins with `💻`, so the `👩\u200d💻` grapheme
 * is split across two consecutive deltas. The renderer writes both fragments
 * verbatim and the terminal re-joins them, so a mid-line split streams
 * seamlessly. KNOWN PRESENTATION DEFECT (documented, intentionally not fixed
 * here — the #195 coverage children own coordinator fixes): when a wide
 * grapheme straddles a wrap or reflow boundary during a live resize, the
 * terminal can display the glyph split across two cells or rows. This fixture
 * deliberately exercises that path; the PTY screen oracle coverage tracks it.
 *
 * Volume calibration: through the real coordinator at the default 100x30
 * geometry the session renders ~39 visible transcript rows (the 11 streamed
 * lines, session header, lifecycle milestone lines, and tool rows), so the
 * cumulative volume crosses every configured `PtyScenarioOptions.threshold`
 * in the practical range up to and including `DEFAULT_BREADCRUMB_THRESHOLD`
 * (30), and the breadcrumb crossing count scales inversely with the threshold
 * (fewer crossings at larger thresholds), which is how a later child proves
 * cadence changes.
 */
export const buildScenarioStreamDeltas = (
    _options: PtyScenarioOptions,
): readonly string[] => [
    "PTY scenario\n", //            13 — ASCII run opener
    "agent run\n", //               11
    "ASCII run\n", //               10 — explicit ASCII run
    "graphemes\n", //               10
    "（漢字） 🎉\n", //                8 — wide graphemes: CJK + emoji
    `ZWJ ${WIDE_ZWJ_FIRST}`, //      7 — ends INSIDE the ZWJ grapheme
    `${WIDE_ZWJ_SECOND} SGR\u001b[31mred\u001b[0m\n`, // 19 — completes the pair
    "OSC \u001b]8;;https://example.invalid\u0007x\u0007\n", // 35 — OSC hyperlink + BEL
    "BEL\u0007 BS\u0008\n", //       9 — literal BEL + backspace bytes
    "mid-line\n", //                 9
    "finalize", //                   8 — ends mid-line, no trailing newline
];

/**
 * Thinking block emitted right after `agent_start`: one (negative)
 * `thinking_delta` carries `FAKE_TOKEN` in its content. Thinking streams are
 * routed to the compact activity surface only and are never written into the
 * human transcript, so the token never reaches the visible surface.
 */
export const scenarioThinkingEvents = (): readonly AgentSessionEvent[] => [
    asEvent({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
    }),
    asEvent({
        type: "message_update",
        assistantMessageEvent: {
            type: "thinking_delta",
            contentIndex: 0,
            delta: `negative example: keep ${FAKE_TOKEN} out of visible output`,
        },
    }),
    asEvent({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_end", contentIndex: 0 },
    }),
];

/**
 * The canonical lifecycle milestone script, in the exact order the PTY
 * coverage tracks share (see the issue's requirement list):
 *
 * 1. `compaction_start` then `compaction_end`;
 * 2. `auto_retry_start` then `auto_retry_end`;
 * 3. `summarization_retry_scheduled` then `summarization_retry_attempt_start`
 *    then `summarization_retry_finished`;
 * 4. one failing tool execution — `tool_execution_start`, three
 *    `tool_execution_update`s (the first carries `FAKE_TOKEN` inside
 *    `partialResult.content` only), then `tool_execution_end` with
 *    `isError: true`;
 * 5. the closing `tool_execution_end` (ordinary result, `isError: false`) and
 *    `agent_end`.
 *
 * The last {@link SCENARIO_CLOSE_EVENT_COUNT} events are the stream close:
 * the smoke child keeps the stream open across the driver's two resizes and
 * only then emits them, finalizing the session exactly once.
 */
export const scenarioLifecycleEvents = (): readonly AgentSessionEvent[] => [
    asEvent({
        type: "compaction_start",
        reason: "context window exceeded while the PTY scenario session streamed its long deterministic transcript across every lifecycle milestone before the resize gate admitted two driver resizes and the stream finalized exactly once",
    }),
    asEvent({ type: "compaction_end" }),
    asEvent({ type: "auto_retry_start", attempt: 2, maxAttempts: 3 }),
    asEvent({ type: "auto_retry_end", success: true }),
    asEvent({
        type: "summarization_retry_scheduled",
        attempt: 1,
        maxAttempts: 2,
    }),
    asEvent({ type: "summarization_retry_attempt_start" }),
    asEvent({ type: "summarization_retry_finished" }),
    asEvent({
        type: "tool_execution_start",
        toolCallId: "pty-gate",
        toolName: "bash",
        args: { command: "printf 'verification gate output sample line\\n'" },
    }),
    asEvent({
        type: "tool_execution_update",
        toolCallId: "pty-gate",
        toolName: "bash",
        partialResult: {
            content: `gate tick 0 — ${FAKE_TOKEN} — stream the secret, never render it`,
        },
    }),
    asEvent({
        type: "tool_execution_update",
        toolCallId: "pty-gate",
        toolName: "bash",
        partialResult: { content: "gate tick 1" },
    }),
    asEvent({
        type: "tool_execution_update",
        toolCallId: "pty-gate",
        toolName: "bash",
        partialResult: { content: "gate tick 2" },
    }),
    asEvent({
        type: "tool_execution_end",
        toolCallId: "pty-gate",
        toolName: "bash",
        result: {
            content:
                "gate verification failed: the resize gate rejected the stream before finalization, so the fixture reports a mid-stream failure and keeps the transcript open for the driver to resize again afterwards",
        },
        isError: true,
    }),
    asEvent({
        type: "tool_execution_end",
        toolCallId: "pty-probe",
        toolName: "bash",
        result: { content: "pty probe output" },
        isError: false,
    }),
    asEvent({ type: "agent_end", willRetry: false }),
];

/** Number of trailing lifecycle events that close the stream. */
export const SCENARIO_CLOSE_EVENT_COUNT = 2;

const TOOL_UPDATES = 6;

const asEvent = (value: unknown): AgentSessionEvent =>
    value as AgentSessionEvent;

const delay = (milliseconds: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));

type EventLogEntry =
    | {
          readonly kind: "progress";
          readonly stage: string;
          readonly status: string;
          readonly message: string;
          readonly repository?: string;
          readonly issue?: ProgressIssue;
          readonly current?: number;
          readonly total?: number;
          readonly attempt?: number;
          readonly maxAttempts?: number;
      }
    | { readonly kind: "agent"; readonly type: string }
    | { readonly kind: "marker"; readonly name: string }
    | {
          readonly kind: "resize";
          readonly columns: number;
          readonly rows: number;
      }
    | { readonly kind: "input"; readonly line: string }
    | { readonly kind: "signal"; readonly name: string }
    | { readonly kind: "active" }
    | { readonly kind: "settled" }
    | { readonly kind: "run_failed"; readonly message: string }
    | { readonly kind: "done" }
    | { readonly kind: "config"; readonly options: PtyScenarioOptions };

type ChildRalphieRuntime = RalphieRuntime & {
    readonly dispose?: () => Promise<void>;
};

const LIFECYCLE_PROGRESS_STARTS = [
    {
        stage: "grounding",
        status: "started",
        message: LIFECYCLE_MESSAGES.groundingStarted,
    },
    {
        stage: "implementation",
        status: "started",
        message: LIFECYCLE_MESSAGES.implementationStarted,
    },
] as const satisfies ReadonlyArray<ProgressUpdate>;

export type RunPtyDriverChildOptions = {
    /** The run's AbortSignal, wired exactly as `runCli` wires SIGINT. */
    readonly signal?: AbortSignal;
};

/** The CLI options the PTY child declares (see `parsePtyScenarioArgs`). */
const scenarioCliOptions = {
    workspace: { type: "string" },
    columns: { type: "string" },
    rows: { type: "string" },
    "issue-current": { type: "string" },
    "issue-total": { type: "string" },
    "issue-number": { type: "string" },
    repository: { type: "string" },
    attempt: { type: "string" },
    "max-attempts": { type: "string" },
    threshold: { type: "string" },
    scenario: { type: "string" },
} as const;

const asScenarioPositiveInt = (
    values: Record<string, unknown>,
    name: string,
    fallback: number,
): number => {
    const raw = values[name];
    if (raw === undefined) return fallback;
    if (typeof raw !== "string") {
        throw new Error(`Option --${name} requires an integer value.`);
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(
            `Option --${name} requires a positive integer, got ${JSON.stringify(raw)}.`,
        );
    }
    return value;
};

const asScenarioRepository = (values: Record<string, unknown>): string => {
    const raw = values.repository;
    if (raw === undefined) return "owner/repository";
    if (typeof raw !== "string") {
        throw new Error("Option --repository requires a string value.");
    }
    const repository = raw.trim();
    if (repository.length === 0) {
        throw new Error("Option --repository requires a non-empty value.");
    }
    return repository;
};

/**
 * Parse the PTY fixture's deterministic scenario CLI options. `--workspace`
 * and `--scenario` are declared (the child already consumes them) but are not
 * part of the returned options. Defaults reproduce the fixture's current
 * behavior exactly: a 100x30 terminal, issue 1 of 1 on #423 for
 * `owner/repository`, attempt 1 of 3, and the default breadcrumb cadence.
 */
export const parsePtyScenarioArgs = (
    args: readonly string[],
): PtyScenarioOptions => {
    const parsed = parseArgs({
        args: [...args],
        options: scenarioCliOptions,
        allowPositionals: true,
        strict: true,
    });
    const values = parsed.values as Record<string, unknown>;
    return {
        columns: asScenarioPositiveInt(values, "columns", 100),
        rows: asScenarioPositiveInt(values, "rows", 30),
        issueCurrent: asScenarioPositiveInt(values, "issue-current", 1),
        issueTotal: asScenarioPositiveInt(values, "issue-total", 1),
        issueNumber: asScenarioPositiveInt(values, "issue-number", 423),
        repository: asScenarioRepository(values),
        attempt: asScenarioPositiveInt(values, "attempt", 1),
        maxAttempts: asScenarioPositiveInt(values, "max-attempts", 3),
        threshold: asScenarioPositiveInt(
            values,
            "threshold",
            DEFAULT_BREADCRUMB_THRESHOLD,
        ),
    };
};

/**
 * Coordinator seam for the deterministic scenario: every coordinator built
 * for the child run gets the configured rendered-line cadence threshold.
 */
export const makeScenarioCoordinator =
    (
        base: (options: ProgressCoordinatorOptions) => ProgressCoordinator,
        threshold: number,
    ): ((options: ProgressCoordinatorOptions) => ProgressCoordinator) =>
    (options) =>
        base({ ...options, renderedLineThreshold: threshold });

/**
 * The smoke workflow's deterministic progress emission, derived entirely
 * from the parsed scenario options so unit tests and the real PTY fixture
 * agree on every payload.
 *
 * The first three updates open the run with a repository scope, an issue
 * carrying `[current/total]`, and a review `(attempt/maxAttempts)`; the
 * last is the nested leaf (`implementation/started`) that stays current
 * while the agent stream is open at resize time. The final three settle
 * implementation, then grounding, then verification with the long durable
 * failure message. Every update carries the same context fields so the
 * display reducer keeps repository, issue, and review attempt stable for
 * the single issue the fixture runs (one issue throughout).
 */
export const scenarioProgressUpdates = (
    options: PtyScenarioOptions,
): readonly ProgressUpdate[] => {
    const issue = {
        number: options.issueNumber,
        title: "PTY scenario issue",
    } as const;
    const context = {
        repository: options.repository,
        issue,
        current: options.issueCurrent,
        total: options.issueTotal,
        attempt: options.attempt,
        maxAttempts: options.maxAttempts,
    } as const;
    return [
        {
            stage: "run",
            status: "info",
            message: "PTY driver run started",
            ...context,
        },
        {
            stage: "grounding",
            status: "started",
            message: "Examining the PTY driver premise",
            ...context,
        },
        {
            stage: "implementation",
            status: "started",
            message: "Implementing the PTY driver",
            ...context,
        },
        {
            stage: "implementation",
            status: "succeeded",
            message: "PTY driver implemented",
            ...context,
        },
        {
            stage: "grounding",
            status: "succeeded",
            message: "PTY driver premise validated",
            ...context,
        },
        {
            stage: "verification",
            status: "failed",
            message: LONG_FAILURE_MESSAGE,
            ...context,
        },
    ] as const satisfies ReadonlyArray<ProgressUpdate>;
};

export const runPtyDriverChild = async (
    workspace: string,
    scenario: ChildScenario = "smoke",
    scenarioOptions: PtyScenarioOptions = parsePtyScenarioArgs([]),
    options: RunPtyDriverChildOptions = {},
): Promise<void> => {
    const eventLogPath = join(workspace, EVENT_LOG_NAME);
    const log = (entry: EventLogEntry): void => {
        appendFileSync(eventLogPath, `${JSON.stringify(entry)}\n`, "utf8");
    };
    // Record the parsed scenario configuration as the first milestone so
    // later scenario fixtures can assert determinism and the effective
    // rendered-line cadence against exactly what the child received.
    log({ kind: "config", options: scenarioOptions });
    const markersOnPty = process.env.RALPHIE_PTY_MARKERS !== "event-log";
    const emitMarker = (text: string): void => {
        if (markersOnPty) process.stdout.write(`${text}\n`);
    };

    const context: AgentEventContext = {
        sessionID: "pty-driver-session",
        directory: workspace,
        title: "Task",
    };

    let agentListener: AgentEventListener | undefined;
    let coordinator: ProgressCoordinator | undefined;
    let controller: TerminalOutputController | undefined;
    let runtime: ChildRalphieRuntime | undefined;

    /** Fake agent service: only the event listener is ever used. */
    const makeFakeAgentService = (): OpenCodeService => {
        const opencodeRuntime = {
            url: "http://127.0.0.1:1",
            client: {
                session: {
                    create: async () => ({ data: { id: context.sessionID } }),
                    prompt: async () => ({ data: { info: {}, parts: [] } }),
                },
                close: () => {},
            },
            close: async () => {},
        } as unknown as OpenCodeRuntime;
        return {
            start: async () => opencodeRuntime,
        };
    };

    /**
     * Resize gate: the smoke stream stays open until exactly two `resize`
     * events arrive on `process.stderr`. Every resize is logged and emitted
     * as `PTY_RESIZED:<WxH>`; synchronization is marker-based, never sleeps.
     * Returns a promise that resolves once the second resize has arrived.
     */
    const waitForDriverResizes = (): Promise<void> => {
        let resizeCount = 0;
        let release: () => void = () => {};
        const completed = new Promise<void>((resolve) => {
            release = resolve;
        });
        process.stderr.on("resize", () => {
            const columns = process.stderr.columns;
            const rows = process.stderr.rows;
            log({ kind: "resize", columns, rows });
            emitMarker(`${RESIZE_MARKER_PREFIX}${columns}x${rows}`);
            resizeCount += 1;
            if (resizeCount >= 2) release();
        });
        return completed;
    };

    const waitForFinalizationRelease = (): Promise<void> => {
        if (markersOnPty) return Promise.resolve();
        return new Promise<void>((resolve) => {
            process.once("SIGUSR1", () => resolve());
        });
    };

    const openAgentStream = async (
        listener: AgentEventListener,
        deltas: readonly string[],
    ): Promise<void> => {
        listener(asEvent({ type: "agent_start" }), context);
        listener(
            asEvent({
                type: "message_update",
                assistantMessageEvent: {
                    type: "text_start",
                    contentIndex: 0,
                },
            }),
            context,
        );
        for (const delta of deltas) {
            listener(
                asEvent({
                    type: "message_update",
                    assistantMessageEvent: {
                        type: "text_delta",
                        contentIndex: 0,
                        delta,
                    },
                }),
                context,
            );
            log({ kind: "agent", type: "text_delta" });
            await delay(15);
        }
    };

    const runSmokeWorkflow = async (
        _options: WorkflowOptions,
        smokeRuntime: RalphieRuntime,
    ): Promise<never> => {
        const listener = agentListener as AgentEventListener;
        const { progress } = smokeRuntime;
        const scenarioUpdates = scenarioProgressUpdates(scenarioOptions);

        // Nested progress updates: run opens, then implementation starts
        // beneath grounding. The leaf stays current while the agent stream
        // is open at resize time; the settlement sequence runs later.
        for (const update of scenarioUpdates.slice(0, 3)) {
            log({ kind: "progress", ...update });
            await progress.emit({ ...update });
        }
        emitMarker(FOOTER_MARKER);
        log({ kind: "marker", name: FOOTER_MARKER });

        // Open the agent session: the deterministic scenario script. The
        // thinking block carries the negative FAKE_TOKEN delta, then the one
        // long assistant text stream opens and stays open across everything.
        const emitAgentEvent = (event: AgentSessionEvent): void => {
            listener(event, context);
            log({
                kind: "agent",
                type:
                    event.type === "message_update"
                        ? (event.assistantMessageEvent.type as string)
                        : event.type,
            });
        };
        emitAgentEvent(asEvent({ type: "agent_start" }));
        for (const event of scenarioThinkingEvents()) {
            emitAgentEvent(event);
            await delay(15);
        }
        emitAgentEvent(
            asEvent({
                type: "message_update",
                assistantMessageEvent: {
                    type: "text_start",
                    contentIndex: 0,
                },
            }),
        );
        for (const delta of buildScenarioStreamDeltas(scenarioOptions)) {
            emitAgentEvent(
                asEvent({
                    type: "message_update",
                    assistantMessageEvent: {
                        type: "text_delta",
                        contentIndex: 0,
                        delta,
                    },
                }),
            );
            await delay(20);
        }

        // Every lifecycle milestone, through the failing tool execution. The
        // stream stays open here: the close events are held for the gate.
        const script = scenarioLifecycleEvents();
        const openEvents = script.slice(0, -SCENARIO_CLOSE_EVENT_COUNT);
        const closeEvents = script.slice(-SCENARIO_CLOSE_EVENT_COUNT);
        for (const event of openEvents) {
            emitAgentEvent(event);
            await delay(20);
        }
        emitMarker(ACTIVE_MARKER);
        log({ kind: "active" });

        // Hold the stream open until the driver resizes twice; synchronize
        // on markers, never sleeps. If the driver never arrives, bail loudly
        // and leave the stream open (the marker fails the driver test).
        let finalizeTimeout: ReturnType<typeof setTimeout> | undefined;
        const armFinalizeTimeout = (): void => {
            finalizeTimeout = setTimeout(() => {
                emitMarker("PTY_DRIVER_ACTIONS_TIMEOUT");
            }, DRIVER_ACTIONS_TIMEOUT_MS);
        };
        armFinalizeTimeout();

        // Finalize exactly once (idempotent guard): emit the close events,
        // stream-finalized marker, settle progress, then the done markers.
        let finalized = false;
        const finalizeStream = async (): Promise<void> => {
            if (finalized) return;
            finalized = true;
            if (finalizeTimeout !== undefined) clearTimeout(finalizeTimeout);
            for (const event of closeEvents) {
                emitAgentEvent(event);
            }
            emitMarker(STREAM_FINALIZED_MARKER);
            log({ kind: "marker", name: STREAM_FINALIZED_MARKER });
            for (const update of scenarioUpdates.slice(3)) {
                log({ kind: "progress", ...update });
                await progress.emit({ ...update });
            }
            emitMarker(DONE_MARKER);
            log({ kind: "marker", name: DONE_MARKER });
            emitMarker(SCENARIO_DONE_MARKER);
            log({ kind: "marker", name: SCENARIO_DONE_MARKER });
            log({ kind: "done" });
        };

        const finalizationRelease = waitForFinalizationRelease();
        await waitForDriverResizes();
        await finalizationRelease;
        const postFinalizationRelease = waitForFinalizationRelease();
        await finalizeStream();
        await postFinalizationRelease;

        return undefined as never;
    };

    /**
     * Lifecycle scripts never write milestones to the PTY while the run is
     * live (see the module comment): the driver synchronizes on the raw
     * transcript/footer fragments instead and reads the event log.
     */
    const settleCompletionWorkflow = async (
        listener: AgentEventListener,
        progress: RalphieRuntime["progress"],
    ): Promise<never> => {
        listener(
            asEvent({
                type: "tool_execution_start",
                toolCallId: "lifecycle-probe",
                toolName: "bash",
                args: { command: "echo lifecycle probe" },
            }),
            context,
        );
        log({ kind: "agent", type: "tool_execution_start" });
        for (let index = 0; index < TOOL_UPDATES; index += 1) {
            listener(
                asEvent({
                    type: "tool_execution_update",
                    toolCallId: "lifecycle-probe",
                    toolName: "bash",
                    partialResult: { content: `lifecycle tick ${index}` },
                }),
                context,
            );
            log({ kind: "agent", type: "tool_execution_update" });
            await delay(15);
        }
        listener(
            asEvent({
                type: "tool_execution_end",
                toolCallId: "lifecycle-probe",
                toolName: "bash",
                result: { content: "lifecycle probe output" },
                isError: false,
            }),
            context,
        );
        listener(asEvent({ type: "agent_end", willRetry: false }), context);
        log({ kind: "agent", type: "agent_end" });

        for (const update of [
            {
                stage: "implementation",
                status: "succeeded",
                message: LIFECYCLE_MESSAGES.implementationSucceeded,
            },
            {
                stage: "grounding",
                status: "succeeded",
                message: LIFECYCLE_MESSAGES.groundingSucceeded,
            },
            {
                stage: "verification",
                status: "succeeded",
                message: LIFECYCLE_MESSAGES.verificationSucceeded,
            },
        ] as const) {
            log({ kind: "progress", ...update });
            await progress.emit({ ...update });
        }
        log({ kind: "settled" });
        return undefined as never;
    };

    const runLifecycleWorkflow = async (
        workflowOptions: WorkflowOptions,
        childRuntime: RalphieRuntime,
    ): Promise<never> => {
        const listener = agentListener as AgentEventListener;
        const { progress } = childRuntime;
        const lifecycle = scenario as LifecycleScenario;

        await progress.emit({
            stage: "run",
            status: "info",
            message: LIFECYCLE_MESSAGES.runStarted,
        });
        log({
            kind: "progress",
            stage: "run",
            status: "info",
            message: LIFECYCLE_MESSAGES.runStarted,
        });
        for (const update of LIFECYCLE_PROGRESS_STARTS) {
            log({ kind: "progress", ...update });
            await progress.emit({ ...update });
        }
        log({ kind: "marker", name: FOOTER_MARKER });

        // Open the transcript stream; it stays open until the per-scenario
        // outcome, matching "a command that ends mid-stream".
        await openAgentStream(listener, LIFECYCLE_STREAM_DELTAS[lifecycle]);
        log({ kind: "marker", name: ACTIVE_MARKER });

        if (lifecycle === "completion") {
            return settleCompletionWorkflow(listener, progress);
        }

        if (lifecycle === "interrupt") {
            // The fake workflow reaches a `throwIfAborted` checkpoint, exactly
            // like the production `checkCancellation` path, and stops.
            const runSignal = workflowOptions.signal;
            if (runSignal === undefined) {
                throw new Error("interrupt scenario requires a run signal");
            }
            await new Promise<void>((resolve) => {
                if (runSignal.aborted) {
                    resolve();
                    return;
                }
                runSignal.addEventListener("abort", () => resolve(), {
                    once: true,
                });
            });
            runSignal.throwIfAborted();
            return undefined as never;
        }

        // failure: a plain Error mid-stream, before any settlement.
        log({
            kind: "run_failed",
            message: "simulated mid-stream workflow failure",
        });
        throw new Error("simulated mid-stream workflow failure");
    };

    /**
     * After `runCommand` has fully returned and disposed, prove the run is
     * quiescent: pending footer timers, re-fired fake events, and a double
     * dispose must all write zero bytes, then write the final durable marker.
     */
    const settleLifecycleRun = async (runError: unknown): Promise<void> => {
        if (runError !== undefined) {
            log({
                kind: "run_failed",
                message:
                    runError instanceof Error
                        ? runError.message
                        : String(runError),
            });
        }
        emitMarker(DISPOSED_MARKER);
        log({ kind: "marker", name: DISPOSED_MARKER });

        // 1. A pending footer refresh timer must not repaint: wait past the
        //    scheduler window before anything else touches the terminal.
        await delay(FOOTER_REPAINT_QUIESCE_MS);

        // 2. Re-fire the fake sources through the disposed coordinator and
        //    controller: progress, agent events, and breadcrumbs stay no-ops.
        const probe: ProgressUpdate = {
            stage: "verification",
            status: "info",
            message: "post-dispose progress probe",
        };
        await runtime?.progress.emit(probe);
        coordinator?.piListener(asEvent({ type: "agent_start" }), context);
        coordinator?.insertBreadcrumb?.(
            breadcrumbCandidateFor(coordinator.getDisplayState()),
        );
        await delay(FOOTER_REPAINT_QUIESCE_MS);
        emitMarker(QUIESCENT_MARKER);
        log({ kind: "marker", name: QUIESCENT_MARKER });

        // 3. Double dispose is harmless: `runCommand` already disposed both
        //    once; dispose each again and expect no throw and no new bytes.
        await coordinator?.dispose();
        controller?.dispose();

        emitMarker(POST_DISPOSE_MARKER);
        log({ kind: "marker", name: POST_DISPOSE_MARKER });
    };

    const factories: CommandFactories = {
        makeCoordinator: makeScenarioCoordinator(
            (madeOptions: ProgressCoordinatorOptions) => {
                const made = makeProgressCoordinator({
                    ...madeOptions,
                    onController: (madeController) => {
                        controller = madeController;
                    },
                });
                coordinator = made;
                return made;
            },
            scenarioOptions.threshold,
        ),
        makeOpenCode: (_config: OpenCodeProviderConfig, eventListener) => {
            agentListener = eventListener;
            return makeFakeAgentService();
        },
        makeRuntime: ({ opencode, progress }) => {
            runtime = { opencode, progress } as unknown as ChildRalphieRuntime;
            return runtime;
        },
        runWorkflow: (
            workflowOptions: WorkflowOptions,
            childRuntime: RalphieRuntime,
        ) =>
            (scenario === "smoke" ? runSmokeWorkflow : runLifecycleWorkflow)(
                workflowOptions,
                childRuntime,
            ),
    };

    if (scenario === "smoke") {
        await runCommand(
            [scenarioOptions.repository, "--workspace", workspace],
            { factories },
        );
        return;
    }

    let runError: unknown;
    try {
        await runCommand(
            [scenarioOptions.repository, "--workspace", workspace],
            {
                factories,
                signal: options.signal,
            },
        );
    } catch (error) {
        runError = error;
    }
    await settleLifecycleRun(runError);
};

if (import.meta.main) {
    const args = Bun.argv.slice(2);
    const workspaceIndex = args.indexOf("--workspace");
    const workspace = args[workspaceIndex + 1];
    if (workspaceIndex < 0 || workspace === undefined) {
        process.stdout.write("PTY_CHILD_MISSING_WORKSPACE\n");
        process.exit(2);
    }
    const scenarioIndex = args.indexOf("--scenario");
    const scenarioValue =
        scenarioIndex < 0 ? undefined : args[scenarioIndex + 1];
    const scenario: ChildScenario =
        scenarioValue === undefined
            ? "smoke"
            : (scenarioValue as ChildScenario);
    if (!CHILD_SCENARIOS.includes(scenario)) {
        process.stdout.write(
            `PTY_CHILD_UNKNOWN_SCENARIO: ${String(scenarioValue)}\n`,
        );
        process.exit(2);
    }
    const scenarioOptions = parsePtyScenarioArgs(args);

    const eventLogPath = join(workspace, EVENT_LOG_NAME);
    const abortController = new AbortController();
    const onInterrupt = (): void => {
        appendFileSync(
            eventLogPath,
            `${JSON.stringify({ kind: "signal", name: "SIGINT" })}\n`,
            "utf8",
        );
        abortController.abort();
    };
    if (scenario === "interrupt") process.on("SIGINT", onInterrupt);
    try {
        await runPtyDriverChild(workspace, scenario, scenarioOptions, {
            signal: abortController.signal,
        });
    } catch (error) {
        process.stdout.write(
            `PTY_CHILD_FAILED: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        throw error;
    } finally {
        if (scenario === "interrupt")
            process.removeListener("SIGINT", onInterrupt);
    }
    if (scenario === "smoke") {
        // The PTY stdin never closes while the relay holds the master, so an
        // open 'data' listener would keep this process alive forever. Exit
        // explicitly; runCommand has already set the success exit code.
        process.exit(0);
    }

    // Lifecycle scenarios: `POST_DISPOSE` was the final byte of the run. The
    // driver performs its post-settle resize probe while this process is
    // still alive (so SIGWINCH reaches a live, listener-less process), then
    // releases it with SIGUSR1. A 30 s backlog timer guarantees the relay is
    // reaped even if the driver never signals.
    const exitCode = process.exitCode ?? 0;
    await new Promise<void>((resolve) => {
        process.once("SIGUSR1", () => resolve());
        setTimeout(() => resolve(), 30_000);
    });
    process.exit(exitCode);
}