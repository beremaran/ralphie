import { describe, expect, test } from "bun:test";

import type { DisplayState } from "../../src/progress/display-state.ts";
import {
    breadcrumbCandidateFor,
    breadcrumbLabelFor,
    prepareBreadcrumbCandidate,
    renderBreadcrumbLine,
} from "../../src/progress/breadcrumb-label.ts";
import type { BreadcrumbLabelCandidate } from "../../src/progress/breadcrumb-label.ts";
import type { PiSessionEvent } from "../../src/pi/client.ts";
import { makePiTranscriptRenderer } from "../../src/progress/transcript.ts";

const context = {
    sessionID: "session-1",
    directory: "/workspace/repository",
    title: "Task",
};

const event = (value: unknown): PiSessionEvent => value as PiSessionEvent;

const displayState: DisplayState = {
    repository: "owner/repo",
    issue: { current: 2, total: 5, number: 42, title: "Breadcrumb work" },
    stage: "implementation",
    reviewAttempt: { current: 1, total: 3 },
    activity: "tool",
    activityLabel: "Using bash",
};

describe("breadcrumb labels", () => {
    test("derives a label only from current display context and activity", () => {
        expect(breadcrumbLabelFor(displayState)).toBe(
            "[owner/repo] [2/5] #42 Breadcrumb work Review 1/3 › Implementing changes › Using bash",
        );
        expect(breadcrumbLabelFor(displayState)).not.toContain("tool output");
    });

    test("redacts before rendering and canonical-key generation", () => {
        const first = breadcrumbCandidateFor({
            ...displayState,
            activityLabel: "Using Bearer super-secret",
        });
        const second = breadcrumbCandidateFor({
            ...displayState,
            activityLabel: "Using Bearer another-secret",
        });

        expect(first.label).toContain("Using Bearer [REDACTED]");
        expect(first.canonicalKey).toContain("Using Bearer [REDACTED]");
        expect(second.canonicalKey).toBe(first.canonicalKey);
        expect(first.label).not.toContain("super-secret");
        expect(first.canonicalKey).not.toContain("super-secret");
    });

    test("normalizes whitespace and terminal controls before deriving a stable key", () => {
        const first = breadcrumbCandidateFor({
            ...displayState,
            repository: "\u001b[31m  owner/repo  \u001b[0m",
            activityLabel: "\n\tUsing bash  ",
        });
        const second = breadcrumbCandidateFor({
            ...displayState,
            activityLabel: "Using bash",
        });

        expect(first.label).toBe(second.label);
        expect(first.canonicalKey).toBe(second.canonicalKey);
    });

    test("rejects candidates without display-context provenance", () => {
        const unapproved = {
            label: "raw tool output",
            canonicalKey: "raw tool output",
        } as unknown as BreadcrumbLabelCandidate;

        expect(() => prepareBreadcrumbCandidate(unapproved)).toThrow(
            "created from display context",
        );
    });

    test("renders one subdued sanitized line", () => {
        const candidate = breadcrumbCandidateFor({
            activity: "tool",
            activityLabel: "Using Bearer super-secret",
        });

        expect(renderBreadcrumbLine(candidate, { colors: true })).toBe(
            "│  \u001b[90m› Using Bearer [REDACTED]\u001b[0m\n",
        );
    });
});

describe("breadcrumb transcript insertion", () => {
    test("resumes an incomplete stream through the transcript boundary", () => {
        let output = "";
        const render = makePiTranscriptRenderer({
            write: (text) => {
                output += text;
            },
        });

        render(
            event({
                type: "message_update",
                assistantMessageEvent: {
                    type: "text_delta",
                    contentIndex: 1,
                    delta: "before",
                },
            }),
            context,
        );
        const prepared = render.insertBreadcrumb(
            breadcrumbCandidateFor({
                activity: "tool",
                activityLabel: "Using Bearer super-secret",
            }),
        );
        render(
            event({
                type: "message_update",
                assistantMessageEvent: {
                    type: "text_delta",
                    contentIndex: 1,
                    delta: "after",
                },
            }),
            context,
        );
        render(event({ type: "agent_end", willRetry: false }), context);

        expect(prepared.canonicalKey).toBe("› Using Bearer [REDACTED]");
        expect(output).toBe(
            "╭─ Pi · Task · session-1\n" +
                "│\n" +
                "│  ✦ assistant before\n" +
                "│  › Using Bearer [REDACTED]\n" +
                "│    after\n" +
                "╰─ done\n",
        );
        expect(output).not.toContain("super-secret");
        expect(output).not.toContain("beforeafter");
    });
});