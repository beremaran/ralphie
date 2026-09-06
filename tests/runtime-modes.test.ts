import { describe, expect, test } from "bun:test";

import {
    makeLiveRuntime,
    toIssueWorkflowRuntime,
    toMaintenanceRuntime,
    toPipelineDeliveryRuntime,
    type IssueWorkflowRuntime,
    type MaintenanceRuntime,
    type PipelineDeliveryRuntime,
    type RalphieRuntime,
} from "../src/runtime.ts";
import { makeProgressRecorder } from "../src/progress/progress.ts";

const liveRuntime = (): RalphieRuntime =>
    makeLiveRuntime({
        opencode: {
            start: async () => {
                throw new Error("The agent must not start while projecting");
            },
        },
        progress: makeProgressRecorder([]),
    });

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
    test("projects the issue workflow shape without unrelated dependencies", () => {
        const runtime = liveRuntime();
        const narrow = toIssueWorkflowRuntime(runtime);

        expect(Object.keys(narrow).sort()).toEqual([...ISSUE_KEYS].sort());
        for (const key of ISSUE_KEYS) {
            expect(narrow[key]).toBe(runtime[key]);
        }
        expect("pipelineDeliveryLifecycle" in narrow).toBe(false);
        expect("pipelineDeliveryGit" in narrow).toBe(false);
        expect("maintenanceSnapshot" in narrow).toBe(false);
        expect("maintenanceMutation" in narrow).toBe(false);
        expect("commandRunner" in narrow).toBe(false);
        expect("gitRemoteSafety" in narrow).toBe(false);
    });

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

    test("projects the maintenance shape without unrelated dependencies", () => {
        const runtime = liveRuntime();
        const narrow = toMaintenanceRuntime(runtime);

        for (const key of MAINTENANCE_REQUIRED_KEYS) {
            expect(narrow[key]).toBe(runtime[key]);
        }
        expect("pipelineDeliveryLifecycle" in narrow).toBe(false);
        expect("pipelineObservation" in narrow).toBe(false);
        expect("issueExecutor" in narrow).toBe(false);
        expect("githubIssues" in narrow).toBe(false);
        expect("gitIssueOperations" in narrow).toBe(false);
        expect("runStateStore" in narrow).toBe(false);
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

    test("projects the pipeline delivery shape without unrelated dependencies", () => {
        const runtime = liveRuntime();
        const narrow = toPipelineDeliveryRuntime(runtime);

        expect(Object.keys(narrow).sort()).toEqual([...PIPELINE_KEYS].sort());
        for (const key of PIPELINE_KEYS) {
            expect(narrow[key]).toBe(runtime[key]);
        }
        expect("pipelineObservation" in narrow).toBe(false);
        expect("pipelineDiagnostics" in narrow).toBe(false);
        expect("issueExecutor" in narrow).toBe(false);
        expect("maintenanceSnapshot" in narrow).toBe(false);
        expect("gitIssueOperations" in narrow).toBe(false);
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
});