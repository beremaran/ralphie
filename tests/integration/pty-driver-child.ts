/**
 * Child entry point for the PTY driver smoke tests.
 *
 * Invoked inside a real PTY by `launchPtyCommand` as
 * `bun <path>/pty-driver-child.ts --workspace <dir>`. It runs `runCommand`
 * with the real interactive output coordinator (default factory) and
 * injected fake agent-service, runtime, and workflow factories, so the
 * driver exercises the production command wiring end to end without ever
 * touching an agent server, GitHub, or a live repository.
 *
 * Communication with the driver is marker-based: every milestone is written
 * to stdout (which is the PTY), and the driver synchronizes on those
 * explicit markers instead of sleeping. Each milestone is also appended to
 * `<workspace>/pty-driver-events.jsonl`, which the tests read back.
 *
 * The fake workflow emits nested progress updates (grounding started, then
 * implementation started beneath it), plays a scripted agent session with a
 * long partial stream that stays open across the driver's resize, input, and
 * SIGINT delivery, and only closes the stream and settles progress once all
 * three driver actions have been observed.
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
    | { readonly kind: "done" };

type ChildRalphieRuntime = RalphieRuntime & {
    readonly dispose?: () => Promise<void>;
};

export const runPtyDriverChild = async (workspace: string): Promise<void> => {
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

    /** Fake agent service: only the event listener is ever used. */
    const makeFakeAgentService = (): OpenCodeService => {
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

    const runFakeWorkflow = async (
        _options: WorkflowOptions,
        runtime: RalphieRuntime,
    ): Promise<never> => {
        const listener = agentListener as AgentEventListener;
        const { progress } = runtime;

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

    const factories: CommandFactories = {
        makeOpenCode: (_config: OpenCodeProviderConfig, eventListener) => {
            agentListener = eventListener;
            return makeFakeAgentService();
        },
        makeRuntime: ({ opencode, progress }) =>
            ({ opencode, progress }) as unknown as ChildRalphieRuntime,
        runWorkflow:
            runFakeWorkflow as unknown as CommandFactories["runWorkflow"],
    };

    await runCommand(["owner/repository", "--workspace", workspace], {
        factories,
    });
};

if (import.meta.main) {
    const args = Bun.argv.slice(2);
    const workspaceIndex = args.indexOf("--workspace");
    const workspace = args[workspaceIndex + 1];
    if (workspaceIndex < 0 || workspace === undefined) {
        process.stdout.write("PTY_CHILD_MISSING_WORKSPACE\n");
        process.exit(2);
    }
    try {
        await runPtyDriverChild(workspace);
    } catch (error) {
        process.stdout.write(
            `PTY_CHILD_FAILED: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        throw error;
    }
    // The PTY stdin never closes while the relay holds the master, so an
    // open 'data' listener would keep this process alive forever. Exit
    // explicitly; runCommand has already set the success exit code.
    process.exit(0);
}