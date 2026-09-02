import { describe, expect, test } from "bun:test";

import type { PiEventContext, PiSessionEvent } from "../../src/pi/client.ts";
import {
    ACTIVITY_REGISTRY_LIMIT,
    ACTIVITY_SNAPSHOT_ROWS,
    MAX_FAILURE_DETAIL_LENGTH,
    createActivityState,
    formatActivityOperation,
    reduceActivityEvent,
    reduceActivityUpdate,
    renderActivitySnapshot,
    updateActivityFromProgress,
    type ActivityClock,
    type ActivityOperation,
    type ActivityState,
} from "../../src/progress/activity.ts";
import { stripTerminalControls } from "../../src/shared/redaction.ts";
import type { ProgressUpdate } from "../../src/progress/progress.ts";

const context: PiEventContext = {
    sessionID: "session-1",
    directory: "/workspace/repository",
};

const clock = (start: number): { now: ActivityClock; tick: () => void } => {
    let current = start;
    return {
        now: () => current,
        tick: () => {
            current += 1;
        },
    };
};

const piEvent = (event: object): PiSessionEvent => event as PiSessionEvent;

const toolStart = (toolCallId: string, toolName: string, args: object = {}) =>
    piEvent({
        type: "tool_execution_start",
        toolCallId,
        toolName,
        args,
    });

const toolEnd = (
    toolCallId: string,
    toolName: string,
    result: unknown,
    isError = false,
) =>
    piEvent({
        type: "tool_execution_end",
        toolCallId,
        toolName,
        result,
        isError,
    });

const op = (state: ActivityState, id: string): ActivityOperation | undefined =>
    state.operations.find((entry) => entry.id === id);

describe("activity formatting", () => {
    test("renders a running operation as label, target, and status", () => {
        const state = reduceActivityUpdate(undefined, {
            id: "call-1",
            kind: "read",
            label: "read",
            target: "src/foo.ts:1-40",
            status: "running",
        });
        const operation = op(state, "call-1")!;
        expect(operation.status).toBe("running");
        expect(formatActivityOperation(operation)).toBe(
            "◐ read src/foo.ts:1-40",
        );
    });

    test("renders concise success rows", () => {
        const state = reduceActivityUpdate(undefined, {
            id: "call-1",
            kind: "shell",
            label: "bash",
            target: "bun run check",
            status: "succeeded",
        });
        expect(formatActivityOperation(op(state, "call-1")!)).toBe(
            "✓ bash bun run check",
        );
    });

    test("renders actionable failure rows with bounded detail", () => {
        const state = reduceActivityUpdate(undefined, {
            id: "call-1",
            kind: "shell",
            label: "bash",
            target: "bun run check",
            status: "failed",
            detail: "exit status 1",
        });
        expect(formatActivityOperation(op(state, "call-1")!)).toBe(
            "✗ bash bun run check — exit status 1",
        );
    });

    test("bounds failure detail to a maximum length", () => {
        const state = reduceActivityUpdate(undefined, {
            id: "call-1",
            kind: "tool",
            label: "grep",
            target: "src",
            status: "failed",
            detail: `error: ${"x".repeat(500)}`,
        });
        const detail = op(state, "call-1")!.detail!;
        expect(Array.from(detail).length).toBeLessThanOrEqual(
            MAX_FAILURE_DETAIL_LENGTH + 1,
        );
        expect(detail.endsWith("…")).toBe(true);
    });

    test("omits empty targets and renders colored rows without leaked escapes", () => {
        const plain = reduceActivityUpdate(undefined, {
            id: "call-1",
            kind: "shell",
            label: "bash",
            status: "running",
        });
        const plainLine = formatActivityOperation(op(plain, "call-1")!);
        expect(plainLine).toBe("◐ bash");
        const colored = formatActivityOperation(op(plain, "call-1")!, {
            colors: true,
        });
        expect(stripTerminalControls(colored)).toBe(plainLine);
    });
});

describe("activity width clipping", () => {
    test("clips long paths to a single physical row", () => {
        const state = reduceActivityUpdate(undefined, {
            id: "call-1",
            kind: "read",
            label: "read",
            target: `${"a".repeat(20)}/${"b".repeat(40)}/very/long/file.ts:1-200`,
            status: "running",
        });
        const line = formatActivityOperation(op(state, "call-1")!, {
            width: 20,
        });
        expect(line.endsWith("…")).toBe(true);
        expect(Bun.stringWidth(line)).toBeLessThanOrEqual(20);
    });

    test("clips long shell commands without wrapping", () => {
        const state = reduceActivityUpdate(undefined, {
            id: "call-1",
            kind: "shell",
            label: "bash",
            target: `echo ${Array.from({ length: 60 }, (_, i) => `arg${i}`).join(" ")}`,
            status: "running",
        });
        for (const width of [10, 30, 60]) {
            const line = formatActivityOperation(op(state, "call-1")!, {
                width,
            });
            expect(line.includes("\n")).toBe(false);
            expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
        }
    });

    test("measures CJK and emoji by display width", () => {
        const state = reduceActivityUpdate(undefined, {
            id: "call-1",
            kind: "read",
            label: "read",
            target: "日本語の長いファイルパス/濡れた道/🚀🚀🚀/file.ts",
            status: "running",
        });
        for (const width of [12, 25, 80]) {
            const line = formatActivityOperation(op(state, "call-1")!, {
                width,
            });
            expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
        }
    });

    test("collapses to an ellipsis at a one-column width", () => {
        const state = reduceActivityUpdate(undefined, {
            id: "call-1",
            kind: "tool",
            label: "bash",
            target: "anything",
            status: "running",
        });
        expect(
            formatActivityOperation(op(state, "call-1")!, { width: 1 }),
        ).toBe("…");
        expect(
            Bun.stringWidth(
                formatActivityOperation(op(state, "call-1")!, { width: 0 }),
            ),
        ).toBeLessThanOrEqual(1);
    });
});

describe("activity sanitization", () => {
    test("strips ANSI and control characters from stored and rendered text", () => {
        const state = reduceActivityUpdate(undefined, {
            id: "call-1",
            kind: "shell",
            label: "\x1b[31mbash\x1b[0m",
            target: "git status\r\n\u0007\x1b[2K",
            status: "running",
        });
        const operation = op(state, "call-1")!;
        expect(operation.label).toBe("bash");
        expect(operation.target).toBe("git status");
        expect(formatActivityOperation(operation)).not.toContain("\u001b");
        expect(formatActivityOperation(operation)).not.toContain("\u0007");
    });

    test("redacts sensitive tokens in commands and targets", () => {
        const state = reduceActivityUpdate(undefined, {
            id: "call-1",
            kind: "shell",
            label: "bash",
            target: "curl -H 'Authorization: Bearer github_pat_abc_DEF_123' https://example.test",
            status: "running",
        });
        const line = formatActivityOperation(op(state, "call-1")!);
        expect(line).not.toContain("github_pat_abc_DEF_123");
        expect(line).toContain("[REDACTED]");
    });

    test("collapses multi-line commands and whitespace to one line", () => {
        const state = reduceActivityUpdate(undefined, {
            id: "call-1",
            kind: "shell",
            label: "bash",
            target: "bun install\n  --frozen-lockfile\n&& bun run check",
            status: "running",
        });
        const line = formatActivityOperation(op(state, "call-1")!);
        expect(line.includes("\n")).toBe(false);
        expect(line.replace(/\s+/g, " ")).toBe(line);
    });
});

describe("activity repeated keys", () => {
    test("repeated updates replace the same operation instead of appending rows", () => {
        const time = clock(100);
        let state = reduceActivityUpdate(
            undefined,
            {
                id: "call-1",
                kind: "tool",
                label: "read",
                target: "src/a.ts",
                status: "running",
            },
            time.now,
        );
        time.tick();
        for (let i = 0; i < 5; i += 1) {
            state = reduceActivityEvent(
                state,
                toolStart("call-1", "read", {
                    file_path: `src/a-${i}.ts`,
                }),
                time.now,
            );
            time.tick();
        }
        expect(state.operations).toHaveLength(1);
        expect(op(state, "call-1")!.target).toBe("src/a-4.ts");
        expect(op(state, "call-1")!.order).toBe(0);
    });

    test("settling a row does not create a second row", () => {
        const time = clock(100);
        let state = reduceActivityEvent(
            undefined,
            toolStart("call-1", "bash", { command: "bun run check" }),
            time.now,
        );
        time.tick();
        state = reduceActivityEvent(
            state,
            toolEnd("call-1", "bash", {
                content: [{ type: "text", text: "done" }],
            }),
            time.now,
        );
        expect(state.operations).toHaveLength(1);
        expect(op(state, "call-1")!.status).toBe("succeeded");
    });
});

describe("activity success and failure states", () => {
    test("a failing tool call renders an actionable failure row", () => {
        const state = reduceActivityEvent(
            undefined,
            toolEnd(
                "call-1",
                "bash",
                {
                    content: [
                        {
                            type: "text",
                            text: "Command failed with exit code 2",
                        },
                    ],
                },
                true,
            ),
        );
        const operation = op(state, "call-1")!;
        expect(operation.status).toBe("failed");
        expect(formatActivityOperation(operation)).toBe(
            "✗ bash — Command failed with exit code 2",
        );
    });

    test("failure detail is bounded even when the result is enormous", () => {
        const state = reduceActivityEvent(
            undefined,
            toolEnd(
                "call-1",
                "read",
                {
                    content: [{ type: "text", text: "z".repeat(10_000) }],
                },
                true,
            ),
        );
        const operation = op(state, "call-1")!;
        expect(operation.detail?.length).toBeLessThanOrEqual(
            MAX_FAILURE_DETAIL_LENGTH + 1,
        );
        expect(operation.detail?.endsWith("…")).toBe(true);
    });

    test("progress updates map started/failed/needs-attention states", () => {
        const time = clock(100);
        const base: ProgressUpdate = {
            stage: "verification",
            status: "started",
            message: "Running verification...",
            repository: "owner/repo",
        };
        let state = updateActivityFromProgress(undefined, base, time.now);
        time.tick();
        state = updateActivityFromProgress(
            state,
            { ...base, status: "failed", message: "Tests failed: 3 failures" },
            time.now,
        );
        const operation = op(state, "verification::")!;
        expect(operation.kind).toBe("progress");
        expect(operation.status).toBe("failed");
        expect(formatActivityOperation(operation)).toBe(
            "✗ Running verification — Tests failed: 3 failures",
        );
    });
});

describe("activity event reduction", () => {
    test("keys tool calls, reads, and searches by call id with correct kinds", () => {
        const time = clock(100);
        const events = [
            toolStart("call-1", "bash", { command: "git status" }),
            toolStart("call-2", "read", {
                file_path: "src/index.ts",
                offset: 10,
                limit: 5,
            }),
            toolStart("call-3", "grep", { pattern: "TODO", path: "src" }),
            toolStart("call-4", "write", {
                file_path: "notes.md",
                content: "a\nb\nc",
            }),
            piEvent({
                type: "bash_execution_update",
                id: "bash-1",
                delta: "out",
            }),
        ];
        let state = createActivityState();
        for (const event of events) {
            state = reduceActivityEvent(state, event, time.now);
            time.tick();
        }
        expect(op(state, "call-1")).toMatchObject({
            kind: "shell",
            label: "bash",
            target: "git status",
            status: "running",
        });
        expect(op(state, "call-2")).toMatchObject({
            kind: "read",
            label: "read",
            target: "src/index.ts:10-14",
            status: "running",
        });
        expect(op(state, "call-3")).toMatchObject({
            kind: "read",
            label: "grep",
            target: "/TODO/ in src",
            status: "running",
        });
        expect(op(state, "call-4")).toMatchObject({
            kind: "tool",
            label: "write",
            target: "notes.md (3 lines)",
            status: "running",
        });
        expect(op(state, "bash:bash-1")).toMatchObject({
            kind: "shell",
            label: "bash",
            status: "running",
        });
    });

    test("bash execution updates upsert a single shell row", () => {
        const time = clock(100);
        let state = createActivityState();
        for (let i = 0; i < 4; i += 1) {
            state = reduceActivityEvent(
                state,
                piEvent({
                    type: "bash_execution_update",
                    id: "bash-1",
                    delta: `chunk${i}`,
                }),
                time.now,
            );
            time.tick();
        }
        expect(state.operations).toHaveLength(1);
        expect(op(state, "bash:bash-1")!.status).toBe("running");
    });

    test("tracks thinking and lifecycle work as bounded rows", () => {
        const time = clock(100);
        const state = [
            piEvent({
                type: "message_update",
                message: { role: "assistant", content: [] },
                assistantMessageEvent: {
                    type: "thinking_start",
                    contentIndex: 0,
                    partial: { content: [] },
                },
            }),
            piEvent({
                type: "message_update",
                message: { role: "assistant", content: [] },
                assistantMessageEvent: {
                    type: "thinking_end",
                    contentIndex: 0,
                    content: "secret",
                    partial: { content: [] },
                },
            }),
            piEvent({ type: "compaction_start", reason: "threshold" }),
            piEvent({
                type: "compaction_end",
                reason: "threshold",
                result: undefined,
                aborted: false,
                willRetry: false,
            }),
            piEvent({
                type: "auto_retry_start",
                attempt: 1,
                maxAttempts: 3,
                delayMs: 100,
                errorMessage: "timeout",
            }),
            piEvent({
                type: "auto_retry_end",
                success: false,
                attempt: 3,
                finalError: "upstream refused",
            }),
            piEvent({ type: "agent_start" }),
            piEvent({ type: "agent_end", messages: [], willRetry: false }),
        ].reduce(
            (current, event) => reduceActivityEvent(current, event, time.now),
            createActivityState({ maxOperations: 20 }),
        );
        expect(op(state, "thinking")!.status).toBe("succeeded");
        expect(op(state, "compaction")).toMatchObject({
            kind: "lifecycle",
            status: "succeeded",
        });
        expect(op(state, "retry")).toMatchObject({
            kind: "lifecycle",
            label: "Retrying Pi request",
            status: "failed",
            detail: "upstream refused",
        });
        expect(op(state, "agent")).toMatchObject({
            kind: "lifecycle",
            status: "succeeded",
        });
    });

    test("keeps assistant response text and lossless JSON out of the view", () => {
        const time = clock(100);
        let state = createActivityState();
        state = reduceActivityEvent(
            state,
            piEvent({
                type: "message_update",
                message: {
                    role: "assistant",
                    content: [
                        { type: "text", text: "I will now fix the bug." },
                    ],
                },
                assistantMessageEvent: {
                    type: "text_delta",
                    contentIndex: 0,
                    delta: "I will now fix the bug.",
                    partial: { content: [] },
                },
            }),
            time.now,
        );
        time.tick();
        state = reduceActivityEvent(
            state,
            piEvent({
                type: "message_start",
                message: {
                    role: "assistant",
                    content: [{ type: "text", text: "Assistant prose" }],
                },
            }),
            time.now,
        );
        time.tick();
        state = reduceActivityEvent(
            state,
            piEvent({
                type: "message_end",
                message: {
                    role: "assistant",
                    content: [{ type: "text", text: "Assistant prose" }],
                },
            }),
            time.now,
        );
        time.tick();
        state = reduceActivityEvent(
            state,
            piEvent({
                type: "message_update",
                message: {
                    role: "assistant",
                    content: [
                        {
                            type: "toolCall",
                            id: "call-9",
                            name: "grep",
                            arguments: { pattern: "TODO", path: "src" },
                        },
                    ],
                },
                assistantMessageEvent: {
                    type: "toolcall_end",
                    contentIndex: 0,
                    toolCall: {
                        type: "toolCall",
                        id: "call-9",
                        name: "grep",
                        arguments: { pattern: "TODO", path: "src" },
                    },
                    partial: { content: [] },
                },
            }),
            time.now,
        );
        expect(op(state, "call-9")?.target).toBe("/TODO/ in src");
        const serialized = JSON.stringify(state.operations);
        expect(serialized).not.toContain("I will now fix the bug.");
        expect(serialized).not.toContain("Assistant prose");
        expect(serialized).not.toContain("lossless");
    });

    test("ignores events the view does not track", () => {
        const state = reduceActivityEvent(
            undefined,
            piEvent({ type: "queue_update", steering: [], followUp: [] }),
        );
        const other = reduceActivityEvent(
            state,
            piEvent({ type: "thinking_level_changed", level: "high" }),
        );
        expect(other.operations).toEqual([]);
        const settled = reduceActivityEvent(
            other,
            piEvent({ type: "session_info_changed", name: "task" }),
        );
        expect(settled.operations).toEqual([]);
    });
});

describe("activity messages via message_update tool calls", () => {
    test("keys streamed tool calls by their call id", () => {
        const time = clock(100);
        let state = createActivityState();
        state = reduceActivityEvent(
            state,
            piEvent({
                type: "message_update",
                message: {
                    role: "assistant",
                    content: [
                        {
                            type: "toolCall",
                            id: "call-7",
                            name: "read",
                            arguments: { file_path: "src/foo.ts" },
                        },
                    ],
                },
                assistantMessageEvent: {
                    type: "toolcall_start",
                    contentIndex: 0,
                    partial: {
                        content: [
                            {
                                type: "toolCall",
                                id: "call-7",
                                name: "read",
                                arguments: { file_path: "src/foo.ts" },
                            },
                        ],
                    },
                },
            }),
            time.now,
        );
        time.tick();
        state = reduceActivityEvent(
            state,
            toolEnd("call-7", "read", { content: [] }),
            time.now,
        );
        expect(state.operations).toHaveLength(1);
        expect(op(state, "call-7")!.status).toBe("succeeded");
        expect(op(state, "call-7")!.target).toBe("src/foo.ts");
    });
});

describe("activity snapshots", () => {
    const buildState = (): ActivityState => {
        const time = clock(100);
        let state = createActivityState();
        for (let i = 0; i < 6; i += 1) {
            state = reduceActivityUpdate(
                state,
                {
                    id: `op-${i}`,
                    kind: "tool",
                    label: "tool",
                    target: `target-${i}`,
                    status: "succeeded",
                },
                time.now,
            );
            time.tick();
        }
        return state;
    };

    test("contains no more than three physical rows", () => {
        const state = buildState();
        const snapshot = renderActivitySnapshot(state, { width: 20 });
        expect(snapshot).toHaveLength(ACTIVITY_SNAPSHOT_ROWS);
        expect(snapshot).toHaveLength(3);
        for (const row of snapshot) {
            expect(row.includes("\n")).toBe(false);
            expect(Bun.stringWidth(row)).toBeLessThanOrEqual(20);
        }
    });

    test("shows running operations first, then the most recent settled", () => {
        const time = clock(100);
        let state = createActivityState();
        state = reduceActivityUpdate(
            state,
            { id: "old", kind: "tool", label: "old", status: "succeeded" },
            time.now,
        );
        time.tick();
        state = reduceActivityUpdate(
            state,
            {
                id: "live",
                kind: "shell",
                label: "bash",
                target: "bun test",
                status: "running",
            },
            time.now,
        );
        time.tick();
        state = reduceActivityUpdate(
            state,
            { id: "new", kind: "tool", label: "new", status: "succeeded" },
            time.now,
        );
        const snapshot = renderActivitySnapshot(state);
        expect(snapshot[0]).toBe("◐ bash bun test");
        expect(snapshot[1]).toBe("✓ new");
        expect(snapshot[2]).toBe("✓ old");
    });

    test("respects an explicit maxRows bound", () => {
        const state = buildState();
        expect(renderActivitySnapshot(state, { maxRows: 1 })).toHaveLength(1);
        expect(renderActivitySnapshot(state, { maxRows: 0 })).toHaveLength(1);
    });

    test("bounds the registry and evicts oldest settled operations", () => {
        const time = clock(100);
        let state = createActivityState({ maxOperations: 4 });
        for (let i = 0; i < 8; i += 1) {
            state = reduceActivityUpdate(
                state,
                {
                    id: `op-${i}`,
                    kind: "tool",
                    label: "tool",
                    status: "succeeded",
                },
                time.now,
            );
            time.tick();
        }
        expect(state.operations).toHaveLength(4);
        expect(op(state, "op-0")).toBeUndefined();
        expect(op(state, "op-4")).toBeDefined();
    });

    test("default registry limit retains at most the exported constant", () => {
        const time = clock(100);
        let state = createActivityState();
        for (let i = 0; i < ACTIVITY_REGISTRY_LIMIT + 10; i += 1) {
            state = reduceActivityUpdate(
                state,
                {
                    id: `op-${i}`,
                    kind: "tool",
                    label: "tool",
                    status: "running",
                },
                time.now,
            );
            time.tick();
        }
        expect(state.operations.length).toBeLessThanOrEqual(
            ACTIVITY_REGISTRY_LIMIT,
        );
    });
});

describe("activity full pipeline", () => {
    test("a long bash run stays on one row across updates until it settles", () => {
        const time = clock(100);
        let state = reduceActivityEvent(
            undefined,
            toolStart("call-1", "bash", {
                command: "bun run check && bun run build ".repeat(8),
            }),
            time.now,
        );
        for (let i = 0; i < 3; i += 1) {
            time.tick();
            state = reduceActivityEvent(
                state,
                piEvent({
                    type: "tool_execution_update",
                    toolCallId: "call-1",
                    toolName: "bash",
                    args: {
                        command: "bun run check && bun run build ".repeat(8),
                    },
                    partialResult: {
                        content: [{ type: "text", text: `chunk ${i}` }],
                    },
                }),
                time.now,
            );
        }
        expect(state.operations).toHaveLength(1);
        time.tick();
        state = reduceActivityEvent(
            state,
            toolEnd("call-1", "bash", {
                content: [{ type: "text", text: "ok" }],
            }),
            time.now,
        );
        expect(op(state, "call-1")!.status).toBe("succeeded");
        const row = formatActivityOperation(op(state, "call-1")!, {
            width: 16,
        });
        expect(row.includes("\n")).toBe(false);
        expect(Bun.stringWidth(row)).toBeLessThanOrEqual(16);
        expect(context.sessionID).toBe("session-1");
    });
});