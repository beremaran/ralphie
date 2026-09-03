import { describe, expect, test } from "bun:test";

import type { DisplayState } from "../../src/progress/display-state.ts";
import {
    breadcrumbCandidateFor,
    breadcrumbLabelFor,
    canonicalBreadcrumbKey,
    prepareBreadcrumbCandidate,
    renderBreadcrumbLine,
} from "../../src/progress/breadcrumb-label.ts";
import type { BreadcrumbLabelCandidate } from "../../src/progress/breadcrumb-label.ts";
import type { AgentSessionEvent } from "../../src/opencode/client.ts";
import { makeAgentTranscriptRenderer } from "../../src/progress/transcript.ts";

const context = {
    sessionID: "session-1",
    directory: "/workspace/repository",
    title: "Task",
};

const event = (value: unknown): AgentSessionEvent => value as AgentSessionEvent;

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

    test("preserves token-like values in labels, keys, and rendering", () => {
        const first = breadcrumbCandidateFor({
            ...displayState,
            activityLabel: "Using Bearer first-secret",
        });
        const second = breadcrumbCandidateFor({
            ...displayState,
            activityLabel: "Using Bearer second-secret",
        });

        expect(first.label).toContain("Using Bearer first-secret");
        expect(first.canonicalKey).toContain("Using Bearer first-secret");
        expect(second.label).toContain("Using Bearer second-secret");
        expect(second.canonicalKey).toContain("Using Bearer second-secret");
        expect(second.canonicalKey).not.toBe(first.canonicalKey);
    });

    test("retains token-like repository and issue title content in the full label", () => {
        const candidate = breadcrumbCandidateFor({
            ...displayState,
            repository: "owner/repo?token=private-value",
            issue: {
                current: 2,
                total: 5,
                number: 42,
                title: "Bearer private-value",
            },
        });

        expect(candidate.label).toBe(
            "[owner/repo?token=private-value] [2/5] #42 Bearer private-value Review 1/3 › Implementing changes › Using bash",
        );
        expect(candidate.canonicalKey).toBe(candidate.label);
    });

    test("treats distinct token values as distinct canonical keys", () => {
        const withPrivateValue = breadcrumbCandidateFor({
            ...displayState,
            repository: "owner/repo?token=private-value",
        });
        const withPublicValue = breadcrumbCandidateFor({
            ...displayState,
            repository: "owner/repo?token=public-value",
        });

        expect(canonicalBreadcrumbKey(withPrivateValue.label)).not.toBe(
            canonicalBreadcrumbKey(withPublicValue.label),
        );
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

    test("renders one subdued normalized line", () => {
        const candidate = breadcrumbCandidateFor({
            activity: "tool",
            activityLabel: "Using Bearer super-secret",
        });

        expect(renderBreadcrumbLine(candidate, { colors: true })).toBe(
            "│  \u001b[90m› Using Bearer super-secret\u001b[0m\n",
        );
    });
});

describe("breadcrumb transcript insertion", () => {
    test("resumes an incomplete stream through the transcript boundary", () => {
        let output = "";
        const render = makeAgentTranscriptRenderer({
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

        expect(prepared.canonicalKey).toBe("› Using Bearer super-secret");
        expect(output).toBe(
            "╭─ OpenCode · Task · session-1\n" +
                "│\n" +
                "│  ✦ assistant before\n" +
                "│  › Using Bearer super-secret\n" +
                "│    after\n" +
                "╰─ done\n",
        );
        expect(output).toContain("super-secret");
        expect(output).not.toContain("beforeafter");
    });
});