import { describe, expect, test } from "bun:test";
import type { Octokit } from "octokit";
import type { PiClient } from "../../src/pi/client.ts";

import {
    IssueArtifactKind,
    makeIssueArtifactStore,
} from "../../src/issues/artifacts.ts";
import type { ComplexityAssessmentService } from "../../src/issues/complexity.ts";
import { ComplexityLevel } from "../../src/issues/decisions.ts";
import { makeDryRunIssueExecutorService } from "../../src/issues/dry-run-executor.ts";
import {
    IssueExecutionOutcomeKind,
    type IssueExecutionContext,
} from "../../src/issues/execution.ts";
import {
    makeProgressRecorder,
    type ProgressUpdate,
} from "../../src/progress/progress.ts";

const context = (number: number): IssueExecutionContext => ({
    issue: {
        number,
        title: "Dry-run issue",
        url: `issue/${number}`,
        body: "Assess this issue.",
        labels: [],
    },
    repository: "owner/repository",
    repositoryPath: "/workspace/repository",
    targetBranch: "main",
    workspace: "/workspace",
    runId: "dry-run",
    octokit: {} as Octokit,
    pi: {} as PiClient,
    piSelection: { agent: "build" },
    piDiagnostics: { record: () => undefined, list: () => [] },
    repositoryInvariant: {
        capture: async () => ({ branch: "main", head: "abc123" }),
        verify: async () => {},
    },
});

const run = async (complexity: ComplexityLevel, events: ProgressUpdate[]) => {
    const artifacts = await makeIssueArtifactStore(42);
    const artifactStore = { forIssue: async () => artifacts };
    const assessment: ComplexityAssessmentService = {
        assess: async () => ({
            sessionID: "complexity-session",
            decision: { complexity, rationale: "dry-run test" },
        }),
    };
    const executor = makeDryRunIssueExecutorService(
        artifactStore,
        assessment,
        makeProgressRecorder(events),
    );
    const result = await executor.execute(context(42));
    return { result, artifacts };
};

describe("dry-run issue executor", () => {
    test.each([ComplexityLevel.Level2, ComplexityLevel.Level4])(
        "assesses complexity %s, reports routing, and never invokes mutation executors",
        async (complexity) => {
            const events: ProgressUpdate[] = [];
            const outcome = await run(complexity, events);
            expect(outcome.result.kind).toBe(IssueExecutionOutcomeKind.Skipped);
            if (outcome.result.kind === IssueExecutionOutcomeKind.Skipped) {
                expect(outcome.result.reason).toContain(
                    `complexity ${complexity}/5`,
                );
            }
            expect(events.at(-1)?.message).toContain("Dry run would route");
            expect(
                await outcome.artifacts.read(
                    IssueArtifactKind.ComplexityDecision,
                ),
            ).toEqual({
                complexity,
                rationale: "dry-run test",
            });
        },
    );
});