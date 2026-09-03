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
 * - `smoke` (default): the original smoke script from the PTY fixture work —
 *   the scripted agent stream stays open across the driver's resize, typed
 *   input, and SIGINT, then settles. Every milestone is written to stdout
 *   (which is the PTY) so the driver synchronizes on explicit markers.
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

import {
    runCommand,
    type CommandFactories,
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
import { breadcrumbCandidateFor } from "../../src/progress/breadcrumb.ts";
import {
    makeProgressCoordinator,
    type ProgressCoordinator,
    type ProgressCoordinatorOptions,
} from "../../src/progress/coordinator.ts";
import type { ProgressUpdate } from "../../src/progress/progress.ts";
import type { TerminalOutputController } from "../../src/progress/terminal-controller.ts";
import type { RalphieRuntime } from "../../src/runtime.ts";
import type { WorkflowOptions } from "../../src/workflow.ts";

/** Marker written after the interactive footer paints for the first time. */
export const FOOTER_MARKER = "PTY_FOOTER";
/** Marker written once the long agent stream is open. */
export const ACTIVE_MARKER = "PTY_ACTIVE";
export const RESIZE_MARKER_PREFIX = "PTY_RESIZED:";
export const INPUT_MARKER_PREFIX = "PTY_INPUT:";
export const SIGINT_MARKER = "PTY_SIGINT";
export const DONE_MARKER = "PTY_DONE";
/**
 * Post-run markers (lifecycle scenarios only). `POST_DISPOSE_MARKER` is the
 * final durable stdout line, written only after `runCommand` has fully
 * returned and disposed; `DISPOSED_MARKER` and `QUIESCENT_MARKER` bracket the
 * zero-byte windows the driver asserts on.
 */
export const DISPOSED_MARKER = "PTY_DISPOSED";
export const QUIESCENT_MARKER = "PTY_QUIESCENT";
export const POST_DISPOSE_MARKER = "PTY_POST_DISPOSE";
/** Line the smoke test types into the PTY; the child must receive it. */
export const INPUT_LINE = "hello pty terminal";
export const EVENT_LOG_NAME = "pty-driver-events.jsonl";
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

const STREAM_DELTAS = [
    "The PTY driver ",
    "streams a partial ",
    "agent transcript ",
    "line across the ",
    "resize, the typed ",
    "input, and SIGINT.",
];
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
    | { readonly kind: "done" };

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

export const runPtyDriverChild = async (
    workspace: string,
    scenario: ChildScenario = "smoke",
    options: RunPtyDriverChildOptions = {},
): Promise<void> => {
    const eventLogPath = join(workspace, EVENT_LOG_NAME);
    const log = (entry: EventLogEntry): void => {
        appendFileSync(eventLogPath, `${JSON.stringify(entry)}\n`, "utf8");
    };
    const emitMarker = (text: string): void => {
        process.stdout.write(`${text}\n`);
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

    const driverActions = (): Promise<void> => {
        let resizeSeen = false;
        let inputSeen = false;
        let sigintSeen = false;
        let release: () => void = () => {};
        const completed = new Promise<void>((resolve) => {
            release = resolve;
        });
        const maybeRelease = (): void => {
            if (resizeSeen && inputSeen && sigintSeen) release();
        };

        process.stderr.on("resize", () => {
            const columns = process.stderr.columns;
            const rows = process.stderr.rows;
            log({ kind: "resize", columns, rows });
            resizeSeen = true;
            emitMarker(`${RESIZE_MARKER_PREFIX}${columns}x${rows}`);
            maybeRelease();
        });
        const handleInputLine = (line: string): void => {
            if (line.length === 0) return;
            log({ kind: "input", line });
            if (line !== INPUT_LINE) return;
            inputSeen = true;
            emitMarker(`${INPUT_MARKER_PREFIX}${line}`);
            maybeRelease();
        };
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk: string | Uint8Array) => {
            const text =
                typeof chunk === "string"
                    ? chunk
                    : Buffer.from(chunk).toString("utf8");
            for (const line of text.split("\n")) handleInputLine(line);
        });
        process.on("SIGINT", () => {
            log({ kind: "signal", name: "SIGINT" });
            sigintSeen = true;
            emitMarker(SIGINT_MARKER);
            maybeRelease();
        });
        return completed;
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

        await progress.emit({
            stage: "run",
            status: "info",
            message: "PTY driver run started",
            details: { workspace },
        });
        log({
            kind: "progress",
            stage: "run",
            status: "info",
            message: "PTY driver run started",
        });
        // Nested progress updates: implementation starts beneath grounding.
        for (const update of [
            {
                stage: "grounding",
                status: "started",
                message: "Examining the PTY driver premise",
            },
            {
                stage: "implementation",
                status: "started",
                message: "Implementing the PTY driver",
            },
        ] as const) {
            log({ kind: "progress", ...update });
            await progress.emit({ ...update });
        }
        emitMarker(FOOTER_MARKER);
        log({ kind: "marker", name: FOOTER_MARKER });

        // Agent events: an agent session with a long, deliberately open stream.
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
        for (const delta of STREAM_DELTAS) {
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
            await delay(20);
        }
        listener(
            asEvent({
                type: "tool_execution_start",
                toolCallId: "pty-probe",
                toolName: "bash",
                args: { command: "echo pty probe" },
            }),
            context,
        );
        log({ kind: "agent", type: "tool_execution_start" });
        for (let index = 0; index < TOOL_UPDATES; index += 1) {
            listener(
                asEvent({
                    type: "tool_execution_update",
                    toolCallId: "pty-probe",
                    toolName: "bash",
                    partialResult: { content: `probe tick ${index}` },
                }),
                context,
            );
            log({ kind: "agent", type: "tool_execution_update" });
            await delay(20);
        }
        emitMarker(ACTIVE_MARKER);
        log({ kind: "active" });

        // Hold the stream open until the driver has resized, typed, and
        // delivered SIGINT; synchronize on explicit markers, never sleeps.
        const actionsTimeout = setTimeout(() => {
            emitMarker("PTY_DRIVER_ACTIONS_TIMEOUT");
        }, DRIVER_ACTIONS_TIMEOUT_MS);
        await driverActions();
        clearTimeout(actionsTimeout);

        // Close the long stream and settle the nested progress updates.
        listener(
            asEvent({
                type: "tool_execution_end",
                toolCallId: "pty-probe",
                toolName: "bash",
                result: { content: "pty probe output" },
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
                message: "PTY driver implemented",
            },
            {
                stage: "grounding",
                status: "succeeded",
                message: "PTY driver premise validated",
            },
            {
                stage: "verification",
                status: "failed",
                message: LONG_FAILURE_MESSAGE,
            },
        ] as const) {
            log({ kind: "progress", ...update });
            await progress.emit({ ...update });
        }

        emitMarker(DONE_MARKER);
        log({ kind: "done" });
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
        ...(scenario === "smoke"
            ? {}
            : {
                  makeCoordinator: (
                      madeOptions: ProgressCoordinatorOptions,
                  ) => {
                      const made = makeProgressCoordinator({
                          ...madeOptions,
                          onController: (madeController) => {
                              controller = madeController;
                          },
                      });
                      coordinator = made;
                      return made;
                  },
              }),
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
        await runCommand(["owner/repository", "--workspace", workspace], {
            factories,
        });
        return;
    }

    let runError: unknown;
    try {
        await runCommand(["owner/repository", "--workspace", workspace], {
            factories,
            signal: options.signal,
        });
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
        await runPtyDriverChild(workspace, scenario, {
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