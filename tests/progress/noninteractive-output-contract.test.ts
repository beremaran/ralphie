import { describe, expect, test } from "bun:test";

import type {
    AgentEventContext,
    AgentSessionEvent,
} from "../../src/core/ports/agent.ts";
import { makeProgressCoordinator } from "../../src/adapters/progress/coordinator.ts";
import type { ProgressRenderMode } from "../../src/adapters/progress/progress.ts";
import type { ProgressUpdate } from "../../src/core/ports/progress.ts";
import { stripTerminalControls } from "../../src/shared/terminal.ts";

const FIXED_TIMESTAMP = "2026-09-09T00:00:00.000Z";
const RUN_ID = "fixed-output-run";
const ASSISTANT_TOKEN = "ghx_0123456789abcdef0123456789abcdef";

const context: AgentEventContext = {
    sessionID: "output-session",
    directory: "/workspace/owner/repository",
    title: "Output contract",
};

const asEvent = (value: unknown): AgentSessionEvent =>
    value as AgentSessionEvent;

const agentEvents = (): readonly AgentSessionEvent[] => [
    asEvent({ type: "agent_start" }),
    asEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_start", contentIndex: 0 },
    }),
    asEvent({
        type: "message_update",
        assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta: `Bearer ${ASSISTANT_TOKEN.slice(0, 18)}`,
        },
    }),
    asEvent({
        type: "message_update",
        assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta: ASSISTANT_TOKEN.slice(18),
        },
    }),
    asEvent({
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "contract-tool",
        args: {
            command: "echo output contract",
            zero: 0,
            flag: false,
            empty: "",
            array: [],
            object: {},
        },
    }),
    asEvent({
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: "contract-tool",
        result: {
            content: "tool result",
            zero: 0,
            flag: false,
            empty: "",
            array: [],
            object: {},
        },
        isError: false,
    }),
    asEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_end", contentIndex: 0 },
    }),
    asEvent({ type: "agent_end" }),
];

const richDetails: Readonly<Record<string, unknown>> = {
    zero: 0,
    flag: false,
    empty: "",
    array: [],
    object: {},
    nested: { zero: 0, flag: false, empty: "", array: [], object: {} },
    token: "Bearer detail-token-0123456789",
};

const progressUpdates = (): readonly ProgressUpdate[] => [
    {
        stage: "implementation",
        status: "started",
        message: "routine-start-marker",
        repository: "owner/repository",
        issue: { number: 17, title: "Output contract issue" },
        details: richDetails,
    },
    {
        stage: "implementation",
        status: "succeeded",
        message: "routine-success-marker",
        details: richDetails,
    },
    {
        stage: "verification",
        status: "failed",
        message: "failed-marker",
        repository: "owner/repository",
        issue: { number: 17, title: "Output contract issue" },
        details: richDetails,
    },
    {
        stage: "verification",
        status: "needs-attention",
        message: "needs-attention-marker",
        repository: "owner/repository",
        issue: { number: 17, title: "Output contract issue" },
        details: richDetails,
    },
];

type Capture = {
    stdout: string;
    stderr: string;
};

const play = async (mode: ProgressRenderMode): Promise<Capture> => {
    const capture: Capture = { stdout: "", stderr: "" };
    const coordinator = makeProgressCoordinator({
        mode,
        colors: false,
        runId: RUN_ID,
        now: () => new Date(FIXED_TIMESTAMP),
        write: (text) => {
            if (mode === "json") capture.stdout += text;
            else capture.stderr += text;
        },
        width: () => 80,
        breadcrumbThreshold: 10_000,
    });

    const events = agentEvents();
    coordinator.piListener(events[0] as AgentSessionEvent, context);
    coordinator.piListener(events[1] as AgentSessionEvent, context);
    coordinator.piListener(events[2] as AgentSessionEvent, context);
    coordinator.piListener(events[3] as AgentSessionEvent, context);
    coordinator.piListener(events[4] as AgentSessionEvent, context);
    coordinator.piListener(events[5] as AgentSessionEvent, context);
    coordinator.piListener(events[6] as AgentSessionEvent, context);
    coordinator.piListener(events[7] as AgentSessionEvent, context);

    for (const update of progressUpdates()) {
        await coordinator.progress.emit(update);
    }
    await coordinator.dispose();
    return capture;
};

const controlFree = (text: string): void => {
    expect(text).not.toContain("\x1b");
    expect(text).not.toContain("\r");
    expect(text).not.toMatch(
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0080-\u009f]/,
    );
    expect(stripTerminalControls(text)).toBe(text);
};

type JsonRecord = Readonly<Record<string, unknown>>;

const parseJsonLines = (stdout: string): readonly JsonRecord[] => {
    expect(stdout.endsWith("\n")).toBe(true);
    const lines = stdout.split("\n");
    expect(lines.at(-1)).toBe("");
    expect(lines.slice(0, -1)).not.toContain("");
    return lines.slice(0, -1).map((line) => JSON.parse(line) as JsonRecord);
};

const isAgentEventRecord = (record: JsonRecord): boolean =>
    record.type === "agent_event" &&
    record.sessionID === context.sessionID &&
    record.directory === context.directory &&
    typeof record.event === "object" &&
    record.event !== null;

const isProgressRecord = (record: JsonRecord): boolean =>
    typeof record.stage === "string" &&
    typeof record.status === "string" &&
    typeof record.message === "string" &&
    typeof record.runId === "string" &&
    typeof record.timestamp === "string";

const humanGlyphs = [
    "✓",
    "✗",
    "│",
    "╭─",
    "╰─",
    "↻",
    "◐",
    "⚠",
    "✦",
    "›",
] as const;

describe("deterministic noninteractive output contracts", () => {
    test("plain output is append-only, ordered, control-free, and lossless", async () => {
        const first = await play("plain");
        const second = await play("plain");
        expect(first).toEqual(second);
        expect(first.stdout).toBe("");
        controlFree(first.stderr);
        expect(first.stderr).toContain("routine-start-marker");
        expect(first.stderr).toContain("routine-success-marker");
        expect(first.stderr).toContain("failed-marker");
        expect(first.stderr).toContain("needs-attention-marker");
        expect(first.stderr).toContain(`Bearer ${ASSISTANT_TOKEN}`);
        // Human progress lines never render the structured details payload;
        // use --output json or the events.jsonl audit for the full record.
        const progressLine = first.stderr
            .split("\n")
            .find((line) => line.includes("routine-success-marker"));
        expect(progressLine).toBeDefined();
        expect(progressLine).not.toContain('"zero"');
        expect(progressLine).not.toContain('"flag"');
    });

    test("JSON output is strict JSON Lines with fixed metadata, event order, and lossless values", async () => {
        const first = await play("json");
        const second = await play("json");
        expect(first).toEqual(second);
        expect(first.stderr).toBe("");
        controlFree(first.stdout);

        const records = parseJsonLines(first.stdout);
        expect(records.length).toBe(
            agentEvents().length + progressUpdates().length,
        );
        const progressRecords = records.filter(isProgressRecord);
        const eventRecords = records.filter(isAgentEventRecord);
        expect(progressRecords).toHaveLength(progressUpdates().length);
        expect(eventRecords).toHaveLength(agentEvents().length);

        for (const record of records) {
            expect(isProgressRecord(record) || isAgentEventRecord(record)).toBe(
                true,
            );
            if (isProgressRecord(record)) {
                expect(record.runId).toBe(RUN_ID);
                expect(record.timestamp).toBe(FIXED_TIMESTAMP);
            }
        }
        expect(progressRecords).toEqual(
            progressUpdates().map((update) => ({
                ...update,
                runId: RUN_ID,
                timestamp: FIXED_TIMESTAMP,
            })),
        );
        expect(eventRecords.map((record) => record.event)).toEqual([
            ...agentEvents(),
        ]);

        const assistantDeltas = eventRecords
            .map((record) => record.event as AgentSessionEvent)
            .filter(
                (event) =>
                    event.type === "message_update" &&
                    event.assistantMessageEvent.type === "text_delta",
            )
            .map((event) => event.assistantMessageEvent.delta)
            .join("");
        expect(assistantDeltas).toBe(`Bearer ${ASSISTANT_TOKEN}`);
        for (const glyph of humanGlyphs) {
            expect(first.stdout).not.toContain(glyph);
        }
    });
});