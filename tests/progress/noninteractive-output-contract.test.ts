import { describe, expect, test } from "bun:test";

import type {
    SessionEvent,
    SessionEventContext,
} from "../../src/harness/ports.ts";
import { makeProgressCoordinator } from "../../src/progress/adapters/coordinator.ts";
import type { ProgressRenderMode } from "../../src/progress/adapters/progress.ts";
import type { ProgressUpdate } from "../../src/progress/ports.ts";
import { stripTerminalControls } from "../../src/shared/terminal.ts";

const FIXED_TIMESTAMP = "2026-09-09T00:00:00.000Z";
const RUN_ID = "fixed-output-run";
const ASSISTANT_TOKEN = "ghx_0123456789abcdef0123456789abcdef";

const context: SessionEventContext = {
    sessionID: "output-session",
    directory: "/workspace/owner/repository",
    harness: "pi",
    title: "Output contract",
};

const sessionEvents = (): readonly SessionEvent[] => [
    { type: "session_started" },
    {
        type: "assistant_text",
        kind: "text",
        text: `Bearer ${ASSISTANT_TOKEN.slice(0, 18)}`,
        done: false,
    },
    {
        type: "assistant_text",
        kind: "text",
        text: ASSISTANT_TOKEN.slice(18),
        done: false,
    },
    {
        type: "tool_call",
        callId: "tool-1",
        name: "contract-tool",
        input: {
            command: "echo output contract",
            zero: 0,
            flag: false,
            empty: "",
            array: [],
            object: {},
        },
    },
    {
        type: "tool_result",
        callId: "tool-1",
        name: "contract-tool",
        output: "tool result",
        isError: false,
    },
    {
        type: "tool_call",
        callId: "tool-2",
        name: "failing-tool",
        input: {},
    },
    {
        type: "tool_result",
        callId: "tool-2",
        name: "failing-tool",
        output: "tool-failure-marker",
        isError: true,
    },
    { type: "assistant_text", kind: "text", text: "", done: true },
    {
        type: "usage",
        inputTokens: 12,
        outputTokens: 34,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
    },
    { type: "error", message: "session-error-marker" },
    { type: "session_finished" },
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
    });

    for (const event of sessionEvents()) {
        coordinator.sessionListener(event, context);
    }

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

const isSessionEventRecord = (record: JsonRecord): boolean =>
    record.type === "session_event" &&
    record.sessionID === context.sessionID &&
    record.directory === context.directory &&
    record.harness === context.harness &&
    record.title === context.title &&
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
        expect(first.stderr).toContain("╭─ pi · Output contract");
        expect(first.stderr).toContain("│  contract-tool ");
        expect(first.stderr).toContain("│  ✓ contract-tool done");
        expect(first.stderr).toContain(
            "│  ✗ failing-tool failed: tool-failure-marker",
        );
        expect(first.stderr).toContain("│  ✗ session-error-marker");
        expect(first.stderr).toContain("╰─ done");
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
            sessionEvents().length + progressUpdates().length,
        );
        const progressRecords = records.filter(isProgressRecord);
        const eventRecords = records.filter(isSessionEventRecord);
        expect(progressRecords).toHaveLength(progressUpdates().length);
        expect(eventRecords).toHaveLength(sessionEvents().length);

        for (const record of records) {
            expect(
                isProgressRecord(record) || isSessionEventRecord(record),
            ).toBe(true);
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
            ...sessionEvents(),
        ]);

        const assistantDeltas = eventRecords
            .map((record) => record.event as SessionEvent)
            .flatMap((event) =>
                event.type === "assistant_text" ? [event.text] : [],
            )
            .join("");
        expect(assistantDeltas).toBe(`Bearer ${ASSISTANT_TOKEN}`);
        for (const glyph of humanGlyphs) {
            expect(first.stdout).not.toContain(glyph);
        }
    });
});