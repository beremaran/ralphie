import { describe, expect, test } from "bun:test";

import {
    makeLiveRuntime,
    type IssueWorkflowRuntime,
    type MaintenanceRuntime,
    type PipelineDeliveryRuntime,
} from "../src/runtime.ts";
import { makeProgressRecorder } from "../src/progress/progress.ts";

const ISSUE_KEYS = [
    "progress",
    "runStateStore",
    "workspace",
    "githubClient",
    "githubIssues",
    "githubIssueMutations",
    "githubPullRequests",
    "githubNeedsAttentionNotification",
    "gitRepository",
    "gitRepositoryInvariant",
    "gitIssueCheckpoint",
    "gitIssueOperations",
    "parentCompletion",
    "issueArtifactStore",
    "pullRequestReviewCoordinator",
    "pipelineObservation",
    "issueExecutor",
    "dryRunIssueExecutor",
    "opencode",
] as const;

const MAINTENANCE_REQUIRED_KEYS = [
    "progress",
    "workspace",
    "githubClient",
    "gitRepository",
    "gitRepositoryInvariant",
    "commandRunner",
    "maintenanceSnapshot",
    "opencode",
] as const;

const PIPELINE_KEYS = [
    "progress",
    "workspace",
    "githubClient",
    "gitRepository",
    "opencode",
    "pipelineDeliveryLifecycle",
] as const;

describe("mode-local runtime seams", () => {
    test("constructs the issue workflow shape without unrelated placeholders", () => {
        const narrow: IssueWorkflowRuntime = {
            progress: {} as never,
            runStateStore: {} as never,
            workspace: {} as never,
            githubClient: {} as never,
            githubIssues: {} as never,
            githubIssueMutations: {} as never,
            githubPullRequests: {} as never,
            githubNeedsAttentionNotification: {} as never,
            gitRepository: {} as never,
            gitRepositoryInvariant: {} as never,
            gitIssueCheckpoint: {} as never,
            gitIssueOperations: {} as never,
            parentCompletion: {} as never,
            issueArtifactStore: {} as never,
            pullRequestReviewCoordinator: {} as never,
            pipelineObservation: {} as never,
            issueExecutor: {} as never,
            dryRunIssueExecutor: {} as never,
            opencode: {} as never,
        };

        expect(Object.keys(narrow).sort()).toEqual([...ISSUE_KEYS].sort());
        expect("pipelineDeliveryLifecycle" in narrow).toBe(false);
        expect("maintenanceSnapshot" in narrow).toBe(false);
    });

    test("constructs the maintenance shape without unrelated placeholders", () => {
        const narrow: MaintenanceRuntime = {
            progress: {} as never,
            workspace: {} as never,
            githubClient: {} as never,
            gitRepository: {} as never,
            gitRepositoryInvariant: {} as never,
            commandRunner: {} as never,
            maintenanceSnapshot: {} as never,
            opencode: {} as never,
        };

        for (const key of MAINTENANCE_REQUIRED_KEYS) {
            expect(narrow[key]).toBeDefined();
        }
        expect("pipelineDeliveryLifecycle" in narrow).toBe(false);
        expect("issueExecutor" in narrow).toBe(false);
        expect("githubIssues" in narrow).toBe(false);
    });

    test("constructs the pipeline delivery shape without unrelated placeholders", () => {
        const narrow: PipelineDeliveryRuntime = {
            progress: {} as never,
            workspace: {} as never,
            githubClient: {} as never,
            gitRepository: {} as never,
            opencode: {} as never,
            pipelineDeliveryLifecycle: {} as never,
        };

        expect(Object.keys(narrow).sort()).toEqual([...PIPELINE_KEYS].sort());
        expect("pipelineObservation" in narrow).toBe(false);
        expect("maintenanceSnapshot" in narrow).toBe(false);
    });

    test("centralized assembly satisfies every focused seam without projection", () => {
        const runtime = makeLiveRuntime({
            opencode: {
                start: async () => {
                    throw new Error(
                        "The agent must not start while assembling",
                    );
                },
            },
            progress: makeProgressRecorder([]),
        });
        const issue: IssueWorkflowRuntime = runtime;
        const maintenance: MaintenanceRuntime = runtime;
        const pipeline: PipelineDeliveryRuntime = runtime;

        for (const key of ISSUE_KEYS) {
            expect(issue[key]).toBe(runtime[key]);
        }
        for (const key of MAINTENANCE_REQUIRED_KEYS) {
            expect(maintenance[key]).toBe(runtime[key]);
        }
        for (const key of PIPELINE_KEYS) {
            expect(pipeline[key]).toBe(runtime[key]);
        }
    });
});