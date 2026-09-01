import { describe, expect, test } from "bun:test";
import type { Octokit } from "octokit";
import type { PiClient } from "../../src/pi/client.ts";

import { makePiSessionDiagnostics } from "../../src/agent/task-session.ts";
import {
    type GroundingDecision,
    GroundingDisposition,
    NeedsAttentionReason,
} from "../../src/issues/decisions.ts";
import type { IssueExecutionContext } from "../../src/issues/execution.ts";
import { makeGroundingAssessmentService } from "../../src/issues/grounding.ts";
import {
    makeProgressRecorder,
    type ProgressUpdate,
} from "../../src/progress/progress.ts";

const assistantInfo = (structured: unknown) => ({
    id: "message-1",
    sessionID: "session-1",
    role: "assistant" as const,
    time: { created: 0, completed: 1 },
    parentID: "message-0",
    modelID: "test-model",
    providerID: "test-provider",
    mode: "test",
    agent: "build",
    path: { cwd: "/workspace/repo", root: "/workspace/repo" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    structured,
});

describe("issue grounding", () => {
    test("returns a schema-validated external-dependency deferral", async () => {
        const events: ProgressUpdate[] = [];
        let verified = false;
        const decision: GroundingDecision = {
            disposition: GroundingDisposition.NeedsAttention,
            reason: NeedsAttentionReason.ExternalDependency,
            summary: "Issue #41 is still required.",
            evidence: ["The issue body says it depends on #41."],
            questions: ["Complete #41 before retrying this issue."],
        };
        const client = {
            session: {
                create: async () => ({ data: { id: "session-1" } }),
                prompt: async () => ({
                    data: { info: assistantInfo(decision), parts: [] },
                }),
            },
        } as unknown as PiClient;
        const context: IssueExecutionContext = {
            issue: {
                number: 42,
                title: "Dependent work",
                url: "issue/42",
                body: "Depends on #41.",
                labels: [],
            },
            repository: "owner/repo",
            repositoryPath: "/workspace/repo",
            targetBranch: "main",
            workspace: "/workspace",
            runId: "run-1",
            octokit: {} as Octokit,
            pi: client,
            piSelection: { agent: "build" },
            piDiagnostics: makePiSessionDiagnostics(),
            repositoryInvariant: {
                capture: async () => ({ branch: "main", head: "abc123" }),
                verify: async () => {
                    verified = true;
                },
            },
        };

        const result = await makeGroundingAssessmentService(
            makeProgressRecorder(events),
        ).assess(context);

        expect(result).toEqual({ sessionID: "session-1", decision });
        expect(verified).toBe(true);
        expect(events.map(({ stage, status }) => ({ stage, status }))).toEqual([
            { stage: "grounding", status: "started" },
            { stage: "grounding", status: "succeeded" },
        ]);
        expect(events[0]?.details).toMatchObject({
            agentWorkSkipped: false,
        });
        expect(events[1]?.details).toMatchObject({
            agentWorkSkipped: false,
            sessionID: "session-1",
        });
    });
});