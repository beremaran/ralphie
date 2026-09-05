import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    runCommand,
    type CliTerminalInfo,
    type CommandOutput,
    type CommandRuntime,
} from "../../src/command.ts";
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
    makeProgressCoordinator,
    type ProgressCoordinatorOptions,
} from "../../src/progress/coordinator.ts";
import type {
    ProgressReporterService,
    ProgressUpdate,
} from "../../src/progress/progress.ts";
import { RalphieExitCode } from "../../src/process/exit-code.ts";
import type { RalphieRuntime } from "../../src/runtime.ts";
import { stripTerminalControls } from "../../src/shared/terminal.ts";
import type { WorkflowOptions } from "../../src/workflow.ts";
import {
    LABEL_ISSUE,
    LABEL_REPOSITORY,
    VERIFICATION_FAILURE_MESSAGE,
    VERIFICATION_NEEDS_ATTENTION_MESSAGE,
} from "../shared/scripted-scenarios.ts";

/**
 * Noninteractive output-mode cleanup matrix (issue #428): the noninteractive
 * counterpart of the real-PTY lifecycle suite. Three scripted lifecycle
 * sequences (normal completion, a mid-session abort through `input.signal`,
 * and an early plain-Error failure before any settlement) run through the
 * real `runCommand` boundary in every noninteractive output mode
 * (default/redirected plain, CI-resolved plain, json, quiet, verbose) and
 * must satisfy the documented output invariants: append-only control-free
 * human streams, JSONL-only structured stdout in json mode, minimal quiet
 * output, and no bytes on either stream after `runCommand` settles or
 * throws. Everything stays offline with fake agent/runtime/workflow
 * factories, exactly like the reference display harness.
 */

/** Fixed clock so every progress timestamp is byte-identical across runs. */
const FIXED_NOW = () => new Date("2026-01-01T00:00:00.000Z");
const FIXED_NOW_ISO = "2026-01-01T00:00:00.000Z";

const context: AgentEventContext = {
    sessionID: "session-1",
    directory: "/workspace/owner/repository",
    title: "Task",
};

const asEvent = (value: unknown): AgentSessionEvent =>
    value as AgentSessionEvent;

const noopSummary = undefined as never;

const makeCapture = (): CommandOutput & {
    readonly stdoutBytes: () => string;
    readonly stderrBytes: () => string;
} => {
    let stdout = "";
    let stderr = "";
    return {
        stdout: (text) => {
            stdout += text;
        },
        stderr: (text) => {
            stderr += text;
        },
        stdoutBytes: () => stdout,
        stderrBytes: () => stderr,
    };
};

type Capture = ReturnType<typeof makeCapture>;

/** Fake agent service whose session replay is scripted by the fake workflow. */
const makeFakePi = (): OpenCodeService => {
    const runtime = {
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
        start: async () => runtime,
    };
};

/**
 * The three lifecycle sequences, table-driven: every row is one scripted
 * sequence that shares the same played steps except for its ending. Adding a
 * sequence is a single row entry here.
 */
type SequenceEnding = "settle" | "abort" | "fail";

type SequenceRow = {
    readonly id: "completion" | "abort" | "early-failure";
    /** How the fake workflow ends after the shared steps have played. */
    readonly ending: SequenceEnding;
    /** Streamed assistant deltas, mode-invariant like the shared scenarios. */
    readonly deltas: readonly string[];
};

const SEQUENCE_ROWS: readonly SequenceRow[] = [
    {
        id: "completion",
        ending: "settle",
        deltas: [
            "The noninteractive driver settles ",
            "every progress stage and the ",
            "agent session on the run boundary.",
        ],
    },
    {
        id: "abort",
        ending: "abort",
        deltas: [
            "The noninteractive driver is interrupted ",
            "mid-session by the aborted signal ",
            "before the run settles.",
        ],
    },
    {
        id: "early-failure",
        ending: "fail",
        deltas: [
            "The noninteractive driver is cut short ",
            "by an unhandled workflow error ",
            "before the run settles.",
        ],
    },
];

const EARLY_FAILURE_MESSAGE = "simulated early workflow failure";

/**
 * The five mode/terminal inputs, table-driven: adding a mode is a single row
 * entry here. Human modes write to stderr; json owns stdout.
 */
type ModeCase = {
    readonly id: "plain" | "ci" | "json" | "quiet" | "verbose";
    readonly terminal: CliTerminalInfo;
    readonly args: readonly string[];
};

const REDIRECTED_TERMINAL: CliTerminalInfo = {
    isInteractive: false,
    isCI: false,
    width: 80,
};

const CI_TERMINAL: CliTerminalInfo = {
    isInteractive: false,
    isCI: true,
    width: 80,
};

const MODE_CASES: readonly ModeCase[] = [
    { id: "plain", terminal: REDIRECTED_TERMINAL, args: [] },
    { id: "ci", terminal: CI_TERMINAL, args: [] },
    { id: "json", terminal: CI_TERMINAL, args: ["--output", "json"] },
    { id: "quiet", terminal: CI_TERMINAL, args: ["--output", "quiet"] },
    { id: "verbose", terminal: CI_TERMINAL, args: ["--output", "verbose"] },
];

/** Human-readable modes assert append-only byte-identical runs. */
const HUMAN_MODE_IDS: ReadonlySet<ModeCase["id"]> = new Set([
    "plain",
    "ci",
    "quiet",
    "verbose",
]);

/** The needs-attention update proves quiet mode surfaces handled attention. */
const NEEDS_ATTENTION_UPDATE: ProgressUpdate = {
    stage: "verification",
    status: "needs-attention",
    message: VERIFICATION_NEEDS_ATTENTION_MESSAGE,
    repository: LABEL_REPOSITORY,
    issue: LABEL_ISSUE,
    details: { verify: "bun run check" },
};

const VERIFICATION_FAILED_UPDATE: ProgressUpdate = {
    stage: "verification",
    status: "failed",
    message: VERIFICATION_FAILURE_MESSAGE,
    repository: LABEL_REPOSITORY,
    issue: LABEL_ISSUE,
    details: { verify: "bun run check" },
};

const RUN_INFO_UPDATE: ProgressUpdate = {
    stage: "run",
    status: "info",
    message: "noninteractive lifecycle run started",
};

const IMPLEMENTATION_SUCCEEDED_UPDATE: ProgressUpdate = {
    stage: "implementation",
    status: "succeeded",
    message: "lifecycle scenario implemented",
};

const agentStart = asEvent({ type: "agent_start" });
const agentSettled = asEvent({ type: "agent_settled" });

const textDelta = (delta: string): AgentSessionEvent =>
    asEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
    });

const toolProbe = {
    start: asEvent({
        type: "tool_execution_start",
        toolCallId: "lifecycle-probe",
        toolName: "bash",
        args: { command: "echo lifecycle probe" },
    }),
    update: asEvent({
        type: "tool_execution_update",
        toolCallId: "lifecycle-probe",
        toolName: "bash",
        partialResult: { content: "lifecycle tick" },
    }),
    end: asEvent({
        type: "tool_execution_end",
        toolCallId: "lifecycle-probe",
        toolName: "bash",
        result: { content: "lifecycle probe output" },
        isError: false,
    }),
};

/** One deterministic logical step of a cleanup sequence. */
type CleanupStep =
    | { readonly kind: "event"; readonly event: AgentSessionEvent }
    | { readonly kind: "progress"; readonly update: ProgressUpdate }
    | { readonly kind: "abort" }
    | { readonly kind: "fail" };

/**
 * The shared scripted body: the run opens, the agent session streams and
 * closes its transcript line, a bash tool cycle completes, and every stage
 * reports a terminal status. No `started` progress events: the plain/CI
 * renderer would show their `◐` status symbol as durable rows, and the
 * documented noninteractive invariant is a zero `◐` byte stream.
 */
const lifecyclePrefix = (row: SequenceRow): CleanupStep[] => [
    { kind: "progress", update: RUN_INFO_UPDATE },
    { kind: "event", event: agentStart },
    {
        kind: "event",
        event: asEvent({
            type: "message_update",
            assistantMessageEvent: { type: "text_start", contentIndex: 0 },
        }),
    },
    ...row.deltas.map((delta) => ({
        kind: "event" as const,
        event: textDelta(delta),
    })),
    {
        kind: "event",
        event: asEvent({
            type: "message_update",
            assistantMessageEvent: { type: "text_end", contentIndex: 0 },
        }),
    },
    { kind: "event", event: toolProbe.start },
    { kind: "event", event: toolProbe.update },
    { kind: "event", event: toolProbe.update },
    { kind: "event", event: toolProbe.end },
    { kind: "progress", update: IMPLEMENTATION_SUCCEEDED_UPDATE },
    { kind: "progress", update: VERIFICATION_FAILED_UPDATE },
    { kind: "progress", update: NEEDS_ATTENTION_UPDATE },
];

const stepsFor = (row: SequenceRow): readonly CleanupStep[] => {
    switch (row.ending) {
        case "settle":
            return [
                ...lifecyclePrefix(row),
                { kind: "event", event: agentSettled },
            ];
        case "abort":
            return [...lifecyclePrefix(row), { kind: "abort" }];
        case "fail":
            return [...lifecyclePrefix(row), { kind: "fail" }];
    }
};

/** The ordered progress updates a sequence emits, for JSON assertions. */
const progressUpdatesFor = (row: SequenceRow): readonly ProgressUpdate[] =>
    stepsFor(row)
        .filter(
            (
                step,
            ): step is Extract<CleanupStep, { readonly kind: "progress" }> =>
                step.kind === "progress",
        )
        .map((step) => step.update);

/** The agent-event record count a sequence emits, for JSON assertions. */
const eventCountFor = (row: SequenceRow): number =>
    stepsFor(row).filter((step) => step.kind === "event").length;

const playLifecycleSteps = async (
    row: SequenceRow,
    deps: {
        readonly listener: AgentEventListener;
        readonly progress: ProgressReporterService;
        readonly abort: () => void;
        readonly signal: AbortSignal;
    },
): Promise<void> => {
    for (const step of stepsFor(row)) {
        if (deps.signal.aborted) return;
        switch (step.kind) {
            case "event":
                deps.listener(step.event, context);
                break;
            case "progress":
                await deps.progress.emit(step.update);
                break;
            case "abort":
                deps.abort();
                break;
            case "fail":
                throw new Error(EARLY_FAILURE_MESSAGE);
        }
    }
};

type CellRun = {
    readonly error: unknown;
    readonly exitCode: number | undefined;
    readonly capture: Capture;
};

/**
 * Drive one (sequence, mode) cell through the real `runCommand` boundary:
 * the run's own AbortController is passed as `input.signal`, and the fake
 * workflow plays the scripted steps then ends per the sequence row (return,
 * `signal.throwIfAborted()`, or a plain Error).
 */
const runCell = async (
    row: SequenceRow,
    modeCase: ModeCase,
    workspace: string,
): Promise<CellRun> => {
    const previousExitCode = process.exitCode;
    const capture = makeCapture();
    const controller = new AbortController();
    let listener: AgentEventListener | undefined;
    let error: unknown;
    try {
        await runCommand(
            [...modeCase.args, "owner/repository", "--workspace", workspace],
            {
                terminal: modeCase.terminal,
                output: capture,
                signal: controller.signal,
                factories: {
                    makeCoordinator: (options: ProgressCoordinatorOptions) =>
                        makeProgressCoordinator({
                            ...options,
                            now: FIXED_NOW,
                        }),
                    makeOpenCode: (
                        _config: OpenCodeProviderConfig,
                        eventListener,
                    ) => {
                        listener = eventListener;
                        return makeFakePi();
                    },
                    makeRuntime: ({ opencode, progress }) =>
                        ({ opencode, progress }) as unknown as CommandRuntime,
                    runWorkflow: async (
                        options: WorkflowOptions,
                        runtime: RalphieRuntime,
                    ) => {
                        await playLifecycleSteps(row, {
                            listener: listener as AgentEventListener,
                            progress: runtime.progress,
                            abort: () => controller.abort(),
                            signal: controller.signal,
                        });
                        // The abort sequence stops at this checkpoint, exactly
                        // like the production cancellation path.
                        options.signal?.throwIfAborted();
                        return noopSummary;
                    },
                },
            },
        );
    } catch (caught) {
        error = caught;
    }
    const exitCode = process.exitCode as number | undefined;
    process.exitCode = previousExitCode;
    return { error, exitCode, capture };
};

/** C0 cursor/erase/bell controls (except tab and newline), DEL, and C1. */
const TERMINAL_CONTROL_CODE =
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0080-\u009f]/;

/** Assert bytes are free of ESC, CR, and other cursor/erase/bell controls. */
const expectControlFree = (text: string): void => {
    expect(text).not.toContain("\x1b");
    expect(text).not.toContain("\r");
    expect(text).not.toMatch(TERMINAL_CONTROL_CODE);
    // stripTerminalControls must be an identity no-op on the captured bytes.
    expect(stripTerminalControls(text)).toBe(text);
};

/** The outcome every sequence must reach: settle, or throw, with the code. */
const expectOutcome = (run: CellRun, row: SequenceRow): void => {
    if (row.ending === "settle") {
        expect(run.error).toBeUndefined();
        expect(run.exitCode).toBe(RalphieExitCode.Success);
        return;
    }
    expect(run.error).toBeDefined();
    expect(run.exitCode).toBe(
        row.ending === "abort"
            ? RalphieExitCode.Cancelled
            : RalphieExitCode.Failure,
    );
};

/**
 * After `runCommand` has settled or thrown (and its dispose path has run),
 * no further bytes may land on either stream.
 */
const expectQuiescent = async (capture: Capture): Promise<void> => {
    const stdout = capture.stdoutBytes();
    const stderr = capture.stderrBytes();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(capture.stdoutBytes()).toBe(stdout);
    expect(capture.stderrBytes()).toBe(stderr);
};

/** Human modes: append-only, control-free, no footer/status-region residue. */
const expectCleanHumanOutput = (
    run: CellRun,
    row: SequenceRow,
    modeCase: ModeCase,
): void => {
    const text = run.capture.stderrBytes();
    expect(run.capture.stdoutBytes()).toBe("");
    expect(text.length).toBeGreaterThan(0);
    expect(text.endsWith("\n")).toBe(true);

    expectControlFree(text);
    // No footer/status-region artifacts: no live indicator, no erase bytes.
    expect(text).not.toContain("◐");
    expect(text).not.toContain("\r\x1b[2K");

    // Positive control: the transcript and progress rows landed in order,
    // including the agent session header and its settled outcome.
    expect(text).toContain("╭─ OpenCode · Task · session-1");
    expect(text).toContain(row.deltas.join(""));
    expect(text).toContain("✓ bash done");
    expect(text).toContain("✗");
    expect(text).toContain(VERIFICATION_FAILURE_MESSAGE);
    expect(text).toContain("⚠");
    expect(text).toContain(LABEL_ISSUE.title);
    expect(text).toContain(VERIFICATION_NEEDS_ATTENTION_MESSAGE);
    if (row.ending === "settle") {
        expect(text).toContain("╰─ settled");
    } else {
        // Interrupted/failed runs never settle the agent session.
        expect(text).not.toContain("╰─");
    }
    // Verbose shares the human renderer and adds the details payload; plain
    // and CI omit it.
    if (modeCase.id === "verbose") {
        expect(text).toContain('{"verify":"bun run check"}');
    } else {
        expect(text).not.toContain('{"verify":"bun run check"}');
    }
};

type JsonRecord = Readonly<Record<string, unknown>>;

type ProgressRecord = JsonRecord & {
    readonly stage: string;
    readonly status: string;
    readonly runId: string;
    readonly timestamp: string;
    readonly message: string;
};

const isOpenCodeEventRecord = (record: JsonRecord): boolean =>
    record.type === "opencode_event" &&
    typeof record.sessionID === "string" &&
    typeof record.directory === "string" &&
    typeof record.event === "object" &&
    record.event !== null;

const isProgressRecord = (record: JsonRecord): boolean =>
    typeof record.stage === "string" &&
    typeof record.status === "string" &&
    typeof record.runId === "string" &&
    typeof record.timestamp === "string" &&
    typeof record.message === "string";

const HUMAN_GLYPHS = [
    "╭",
    "╰",
    "│",
    "✓",
    "✗",
    "◐",
    "⚠",
    "↻",
    "✦",
    "›",
] as const;

/**
 * Json mode: stdout is JSONL-structured progress and opencode-event records
 * only — no human transcript, footer, header, or summary rows — and stderr
 * stays empty.
 */
const expectCleanJsonOutput = (run: CellRun, row: SequenceRow): void => {
    expect(run.capture.stderrBytes()).toBe("");
    const stdout = run.capture.stdoutBytes();
    expect(stdout.length).toBeGreaterThan(0);
    expect(stdout.endsWith("\n")).toBe(true);
    expectControlFree(stdout);
    for (const glyph of HUMAN_GLYPHS) {
        expect(
            stdout.includes(glyph),
            `${row.id} json stdout contains human glyph ${JSON.stringify(glyph)}`,
        ).toBe(false);
    }

    // Every non-empty line parses as one complete JSON record.
    const lines = stdout.split("\n");
    expect(lines.at(-1)).toBe("");
    expect(lines.slice(0, -1)).not.toContain("");
    const records = lines
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as JsonRecord);

    // Every record is exactly one of the two documented shapes.
    const opencodeRecords: JsonRecord[] = [];
    const progressRecords: JsonRecord[] = [];
    for (const record of records) {
        if (isOpenCodeEventRecord(record)) {
            opencodeRecords.push(record);
            continue;
        }
        expect(
            isProgressRecord(record),
            `${row.id} emitted a record that is neither a progress event nor an opencode_event: ${JSON.stringify(record)}`,
        ).toBe(true);
        progressRecords.push(record);
    }
    expect(opencodeRecords.length).toBe(eventCountFor(row));

    // One lossless record per progress emit, one runId, fixed timestamps.
    const expected = progressUpdatesFor(row);
    expect(progressRecords.length).toBe(expected.length);
    const runIds = new Set<string>();
    for (const [index, update] of expected.entries()) {
        const record = progressRecords[index];
        expect(
            record,
            `${row.id} missing progress record ${index}`,
        ).toBeDefined();
        const actual = record as ProgressRecord;
        runIds.add(actual.runId);
        expect(actual.timestamp).toBe(FIXED_NOW_ISO);
        expect(actual).toEqual({
            ...update,
            runId: actual.runId,
            timestamp: actual.timestamp,
        });
    }
    expect(runIds.size).toBe(1);
};

/**
 * Quiet mode: only the documented `failed` and handled `needs-attention`
 * progression rows, with no started/succeeded/info rows and no transcript.
 */
const expectCleanQuietOutput = (run: CellRun, row: SequenceRow): void => {
    const text = run.capture.stderrBytes();
    expect(run.capture.stdoutBytes()).toBe("");
    expect(text.length).toBeGreaterThan(0);
    expect(text.endsWith("\n")).toBe(true);
    expectControlFree(text);
    expect(text).not.toContain("◐");

    // Exactly the two documented rows, in emit order.
    const lines = text.split("\n").filter((line) => line !== "");
    expect(lines.length).toBe(2);
    for (const line of lines) {
        expect(line.startsWith("✗") || line.startsWith("⚠")).toBe(true);
    }
    expect(text.indexOf(VERIFICATION_FAILURE_MESSAGE)).toBeLessThan(
        text.indexOf(VERIFICATION_NEEDS_ATTENTION_MESSAGE),
    );

    // The rows carry repository, issue, and message labels verbatim, so the
    // needs-attention update demonstrably surfaces.
    expect(text).toContain(
        `✗ [${LABEL_REPOSITORY}] #${LABEL_ISSUE.number} ${VERIFICATION_FAILURE_MESSAGE}`,
    );
    expect(text).toContain(
        `⚠ [${LABEL_REPOSITORY}] #${LABEL_ISSUE.number} ${LABEL_ISSUE.title} — ${VERIFICATION_NEEDS_ATTENTION_MESSAGE}`,
    );

    // No started/succeeded/info rows and no transcript text of any kind.
    expect(text).not.toContain(row.deltas.join(""));
    expect(text).not.toContain("noninteractive lifecycle run started");
    expect(text).not.toContain("lifecycle scenario implemented");
    expect(text).not.toContain("╭");
    expect(text).not.toContain("│");
    expect(text).not.toContain("✓ bash done");
};

const assertCleanCell = async (
    run: CellRun,
    row: SequenceRow,
    modeCase: ModeCase,
): Promise<void> => {
    expectOutcome(run, row);
    await expectQuiescent(run.capture);
    switch (modeCase.id) {
        case "json":
            expectCleanJsonOutput(run, row);
            return;
        case "quiet":
            expectCleanQuietOutput(run, row);
            return;
        default:
            expectCleanHumanOutput(run, row, modeCase);
    }
};

describe("noninteractive cleanup matrix: completion, abort, and early failure", () => {
    for (const row of SEQUENCE_ROWS) {
        for (const modeCase of MODE_CASES) {
            test(`${modeCase.id}/${row.id} stays clean through the dispose path`, async () => {
                const workspace = await mkdtemp(
                    join(tmpdir(), "ralphie-cleanup-"),
                );
                try {
                    const runOne = await runCell(row, modeCase, workspace);
                    await assertCleanCell(runOne, row, modeCase);
                    if (HUMAN_MODE_IDS.has(modeCase.id)) {
                        // Append-only: an identical second run emits identical
                        // stderr bytes on the same streams.
                        const runTwo = await runCell(row, modeCase, workspace);
                        await assertCleanCell(runTwo, row, modeCase);
                        expect(runTwo.capture.stderrBytes()).toBe(
                            runOne.capture.stderrBytes(),
                        );
                    }
                } finally {
                    await rm(workspace, { recursive: true, force: true });
                }
            });
        }
    }
});