import { describe, expect, test } from "bun:test";

import type {
    AgentEventContext,
    AgentSessionEvent,
} from "../../src/opencode/client.ts";
import {
    DISPLAY_ACTIVITY_LABELS,
    PROGRESS_STAGE_LABELS,
    createDisplayState,
    progressStageLabel,
    reduceAgentSessionEvent,
    reduceProgressUpdate,
    type DisplayClock,
} from "../../src/progress/display-state.ts";
import type { ProgressStage } from "../../src/progress/progress.ts";

const context: AgentEventContext = {
    sessionID: "session-1",
    directory: "/workspace/repository",
    title: "Task",
};

const at =
    (value: string): DisplayClock =>
    () =>
        value;

const piEvent = (event: object): AgentSessionEvent =>
    event as AgentSessionEvent;

const baseProgress = {
    stage: "issue-execution" as const,
    status: "started" as const,
    message: "Executing issue...",
    repository: "owner/repo",
    issue: { number: 13, title: "Display state" },
    current: 1,
    total: 3,
};

describe("display state", () => {
    test("has a neutral initial state", () => {
        expect(createDisplayState()).toEqual({
            activity: "waiting",
            activityLabel: DISPLAY_ACTIVITY_LABELS.waiting,
        });
    });

    test("provides a label for every progress stage", () => {
        const stages = Object.keys(PROGRESS_STAGE_LABELS) as ProgressStage[];
        expect(stages).toHaveLength(34);
        for (const stage of stages) {
            expect(PROGRESS_STAGE_LABELS[stage]).not.toBe("");
        }
        expect(PROGRESS_STAGE_LABELS.grounding).toBe(
            "Checking issue readiness",
        );
        expect(PROGRESS_STAGE_LABELS["complexity-assessment"]).toBe(
            "Assessing complexity",
        );
        expect(PROGRESS_STAGE_LABELS["resolution-verification"]).toBe(
            "Verifying resolution",
        );
        expect(PROGRESS_STAGE_LABELS["pr-gate"]).toBe("Waiting for PR checks");
    });

    test("reduces the grounding needs-attention stage to waiting activity", () => {
        const state = reduceProgressUpdate(undefined, {
            stage: "grounding",
            status: "needs-attention",
            message: "Issue needs attention.",
            issue: { number: 13, title: "Display state" },
            current: 1,
            total: 3,
        });

        expect(state).toMatchObject({
            stage: "grounding",
            activity: "waiting",
            activityLabel: "Waiting",
            issue: { current: 1, total: 3, number: 13 },
        });
    });

    test("does not invent or overwrite a global step total", () => {
        const issueState = reduceProgressUpdate(undefined, baseProgress);
        const state = reduceProgressUpdate(issueState, {
            stage: "run",
            status: "info",
            message: "Run started.",
            current: 1,
            total: 28,
        });
        expect(state.issue).toEqual(issueState.issue);
    });

    test("retains issue, queue, repository, and review context in nested stages", () => {
        const first = reduceProgressUpdate(
            undefined,
            {
                ...baseProgress,
                attempt: 2,
                maxAttempts: 5,
            },
            at("2026-08-24T01:02:03.000Z"),
        );
        const nested = reduceProgressUpdate(
            first,
            {
                stage: "implementation",
                status: "started",
                message: "Implementing...",
                issue: baseProgress.issue,
            },
            at("2026-08-24T01:02:04.000Z"),
        );

        expect(nested).toMatchObject({
            repository: "owner/repo",
            issue: {
                current: 1,
                total: 3,
                number: 13,
                title: "Display state",
            },
            reviewAttempt: { current: 2, total: 5 },
            stage: "implementation",
            stageStartedAt: Date.parse("2026-08-24T01:02:04.000Z"),
        });
    });

    test("maps agent startup, thinking, response, tool, compaction, retry, and waiting activity", () => {
        let state = reduceProgressUpdate(undefined, baseProgress, at("now"));
        state = reduceAgentSessionEvent(
            state,
            piEvent({ type: "agent_start" }),
            context,
        );
        expect(state.activity).toBe("thinking");

        state = reduceAgentSessionEvent(
            state,
            piEvent({
                type: "message_update",
                assistantMessageEvent: { type: "thinking_delta", delta: "..." },
            }),
            context,
        );
        expect(state.activity).toBe("thinking");

        state = reduceAgentSessionEvent(
            state,
            piEvent({
                type: "message_update",
                assistantMessageEvent: { type: "text_delta", delta: "answer" },
            }),
            context,
        );
        expect(state.activity).toBe("responding");

        state = reduceAgentSessionEvent(
            state,
            piEvent({
                type: "tool_execution_start",
                toolCallId: "tool-1",
                toolName: "bash",
                args: {},
            }),
            context,
        );
        expect(state).toMatchObject({
            activity: "tool",
            activityLabel: "Using bash",
        });

        state = reduceAgentSessionEvent(
            state,
            piEvent({ type: "compaction_start", reason: "threshold" }),
            context,
        );
        expect(state.activity).toBe("compacting");

        state = reduceAgentSessionEvent(
            state,
            piEvent({
                type: "auto_retry_start",
                attempt: 1,
                maxAttempts: 2,
                delayMs: 10,
                errorMessage: "temporary",
            }),
            context,
        );
        expect(state.activity).toBe("retrying");

        state = reduceAgentSessionEvent(
            state,
            piEvent({ type: "agent_settled" }),
            context,
        );
        expect(state).toMatchObject({
            activity: "waiting",
            activityLabel: "Waiting",
        });
    });

    test("retains review attempt metadata through agent events", () => {
        const state = reduceProgressUpdate(undefined, {
            ...baseProgress,
            attempt: 3,
            maxAttempts: 5,
        });
        const next = reduceAgentSessionEvent(
            state,
            piEvent({ type: "turn_start" }),
            context,
        );
        expect(next.reviewAttempt).toEqual({ current: 3, total: 5 });
    });

    test("resets review attempt metadata when the issue changes", () => {
        const first = reduceProgressUpdate(undefined, {
            ...baseProgress,
            attempt: 3,
            maxAttempts: 5,
        });
        const next = reduceProgressUpdate(first, {
            stage: "issue-execution",
            status: "started",
            message: "Executing next issue...",
            issue: { number: 14, title: "Next issue" },
            current: 2,
            total: 3,
        });
        const nested = reduceProgressUpdate(next, {
            stage: "implementation",
            status: "started",
            message: "Implementing next issue...",
            issue: { number: 14, title: "Next issue" },
        });

        expect(next.reviewAttempt).toBeUndefined();
        expect(nested.reviewAttempt).toBeUndefined();
    });

    test("uses event timestamps before the injectable clock", () => {
        const state = reduceProgressUpdate(
            undefined,
            {
                ...baseProgress,
                timestamp: "2026-08-24T01:02:03.000Z",
            } as never,
            () => {
                throw new Error("clock should not be used");
            },
        );
        expect(state.stageStartedAt).toBe(
            Date.parse("2026-08-24T01:02:03.000Z"),
        );
    });

    test("preserves token-like repository, issue, and activity text", () => {
        const state = reduceProgressUpdate(undefined, {
            ...baseProgress,
            repository: "owner/repo?token=private-value",
            issue: {
                number: 13,
                title: "Bearer private-value",
            },
        });
        const next = reduceAgentSessionEvent(
            state,
            piEvent({
                type: "tool_execution_start",
                toolCallId: "tool-1",
                toolName: "\u001b[31mBearer private-value\u001b[0m",
                args: {},
            }),
            context,
        );

        expect(next.repository).toBe("owner/repo?token=private-value");
        expect(next.issue?.title).toBe("Bearer private-value");
        expect(next.activityLabel).toBe("Using Bearer private-value");
    });

    test("keeps distinct token values distinct in display state", () => {
        const first = reduceProgressUpdate(undefined, {
            ...baseProgress,
            repository: "owner/repo?token=first-secret",
            issue: { number: 13, title: "Bearer first-secret" },
        });
        const second = reduceProgressUpdate(undefined, {
            ...baseProgress,
            repository: "owner/repo?token=second-secret",
            issue: { number: 13, title: "Bearer second-secret" },
        });

        expect(first.repository).toBe("owner/repo?token=first-secret");
        expect(second.repository).toBe("owner/repo?token=second-secret");
        expect(first.issue?.title).toBe("Bearer first-secret");
        expect(second.issue?.title).toBe("Bearer second-secret");
        expect(first).not.toEqual(second);
    });

    test("removes terminal controls at the display-state boundary", () => {
        const state = reduceProgressUpdate(undefined, {
            ...baseProgress,
            repository: "\u001b[31mowner/repo\u001b[0m\r\nforged\u009b2J",
            issue: {
                number: 13,
                title: "title\u0007\nsecond line\u009b3J",
            },
        });
        const next = reduceAgentSessionEvent(
            state,
            piEvent({
                type: "tool_execution_start",
                toolCallId: "tool-1",
                toolName: "read\u001b[2J\nforged",
                args: {},
            }),
            context,
        );

        expect(state.repository).toBe("owner/repo forged");
        expect(state.issue?.title).toBe("title second line");
        expect(next.activityLabel).toBe("Using read forged");
        expect(progressStageLabel(next.stage!)).toBe("Executing issue");
        expect(state.repository).not.toContain("\u009b");
        expect(state.issue?.title).not.toContain("\u009b");
    });
});