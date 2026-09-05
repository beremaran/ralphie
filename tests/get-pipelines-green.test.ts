import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, test } from "bun:test";
import type { Octokit } from "octokit";

import type { AgentClient } from "../src/opencode/client.ts";
import type { PipelineDiagnosticsService } from "../src/github/pipeline-diagnostics-service.ts";
import type {
    PipelineObservationOutcome,
    PipelineObservationService,
} from "../src/github/pipeline-observation.ts";
import { normalizePipelineSnapshot } from "../src/github/pipeline-snapshot.ts";
import type {
    PipelineDeliveryGitService,
    PipelinePushAttempt,
} from "../src/git/pipeline-delivery.ts";
import type {
    PipelineDeliveryLoopService,
    PipelineDeliveryOutcome,
} from "../src/issues/pipeline-delivery-loop.ts";
import {
    getPipelinesGreen,
    PipelineDeliveryOutcomeError,
} from "../src/get-pipelines-green.ts";
import {
    ExecutionMode,
    resolveRalphieConfig,
    type GetPipelinesGreenRalphieConfig,
} from "../src/options.ts";
import {
    makeProgressRecorder,
    type ProgressUpdate,
} from "../src/progress/progress.ts";
import { PipelineRunStateStoreLive } from "../src/run/pipeline-state.ts";
import type { RalphieRuntime } from "../src/runtime.ts";

const BASE = "a".repeat(40);
const NEXT = "b".repeat(40);
const TREE = "c".repeat(40);

const greenSnapshot = (sha: string) =>
    normalizePipelineSnapshot({
        repository: "owner/repository",
        branch: "main",
        commitSha: sha,
        checkRuns: [
            {
                name: "build",
                head_sha: sha,
                head_branch: "main",
                status: "completed",
                conclusion: "success",
            },
        ],
    });

const failingSnapshot = (sha: string) =>
    normalizePipelineSnapshot({
        repository: "owner/repository",
        branch: "main",
        commitSha: sha,
        checkRuns: [
            {
                name: "build",
                head_sha: sha,
                head_branch: "main",
                status: "completed",
                conclusion: "failure",
            },
        ],
    });

const configFor = (
    workspace: string,
    dryRun = false,
): GetPipelinesGreenRalphieConfig => {
    const config = resolveRalphieConfig({
        repo: "owner/repository",
        mode: ExecutionMode.GetPipelinesGreen,
        branch: "main",
        workspace,
        dryRun,
        maxAttempts: 3,
    });
    if (config.mode !== ExecutionMode.GetPipelinesGreen) {
        throw new Error("Expected a pipeline configuration.");
    }
    return config;
};

const fakeGit = (
    calls: string[],
    remote = BASE,
): PipelineDeliveryGitService => ({
    readRemoteHead: async () => {
        calls.push("readRemoteHead");
        return remote;
    },
    prepareExactCheckout: async () => {
        calls.push("prepareExactCheckout");
    },
    discardToExactCheckout: async () => {
        calls.push("discardToExactCheckout");
    },
    readCheckout: async () => ({ branch: "main", head: remote, status: "" }),
    readStagedTreeSha: async () => TREE,
    commitStaged: async () => ({
        sha: NEXT,
        parentSha: BASE,
        treeSha: TREE,
    }),
    pushNonForce: async (): Promise<PipelinePushAttempt> => {
        calls.push("pushNonForce");
        return { response: "accepted", output: "" };
    },
});

const makeRuntime = (input: {
    readonly workspace: string;
    readonly calls: string[];
    readonly observation?: PipelineObservationService;
    readonly diagnostics?: PipelineDiagnosticsService;
    readonly loop?: PipelineDeliveryLoopService;
    readonly progressEvents: ProgressUpdate[];
}): RalphieRuntime => {
    const { workspace, calls } = input;
    const loop =
        input.loop ??
        ({
            execute: async (request): Promise<PipelineDeliveryOutcome> => {
                calls.push("loop");
                const outcome: PipelineDeliveryOutcome = {
                    kind: "green",
                    status: "green",
                    source: "already-green",
                    repository: "owner/repository",
                    branch: "main",
                    remoteSha: BASE,
                    pushedAttempts: 0,
                    externalMovements: 0,
                    attempts: [],
                    phases: [],
                    snapshot: greenSnapshot(BASE),
                };
                await request.onOutcome?.(outcome);
                return outcome;
            },
        } satisfies PipelineDeliveryLoopService);
    const progress = makeProgressRecorder(input.progressEvents);
    return {
        githubClient: {
            initialize: async () => {
                calls.push("initializeGitHub");
                return {} as Octokit;
            },
        },
        gitRepository: {
            verifyInstalled: async () => {
                calls.push("verifyGitInstalled");
            },
            prepare: async () => ({
                path: join(workspace, "repo"),
                branch: "main",
                cloned: false,
                branchChanged: false,
                cleaned: false,
            }),
        },
        pipelineDeliveryGit: fakeGit(calls),
        pipelineDeliveryLoop: loop,
        pipelineObservation:
            input.observation ?? ({ observe: async () => ({}) } as never),
        pipelineDiagnostics: input.diagnostics ?? ({} as never),
        pipelineRunStateStore: PipelineRunStateStoreLive,
        gitRemoteSafety: { verifyDirectPush: async () => ({}) } as never,
        workspace: {
            prepare: async () => {
                calls.push("prepareWorkspace");
            },
            remove: async () => {
                calls.push("removeWorkspace");
            },
        },
        opencode: {
            start: async () => {
                calls.push("startOpenCode");
                return {
                    url: "http://127.0.0.1:4096",
                    client: {} as AgentClient,
                    close: async () => {
                        calls.push("closeOpenCode");
                    },
                };
            },
        },
        progress,
    } as unknown as RalphieRuntime;
};

describe("get-pipelines-green orchestration", () => {
    test("runs an already-green remote through the pipeline loop and persists completion", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "ralphie-gpgreen-"));
        const calls: string[] = [];
        const progressEvents: ProgressUpdate[] = [];
        try {
            const summary = await getPipelinesGreen(
                {
                    config: configFor(workspace),
                    runId: "green-run",
                },
                makeRuntime({ workspace, calls, progressEvents }),
            );
            expect(summary.outcome.kind).toBe("green");
            expect(summary.wouldRepair).toBe(false);
            expect(calls).toContain("loop");
            expect(calls).toContain("startOpenCode");
            const state = JSON.parse(
                await readFile(
                    join(
                        workspace,
                        ".ralphie",
                        "runs",
                        "green-run",
                        "pipeline",
                        "state.json",
                    ),
                    "utf8",
                ),
            );
            expect(state.status).toBe("complete");
            expect(state.outcome.kind).toBe("green");
            expect(
                progressEvents.some(
                    ({ stage, status }) =>
                        stage === "pipeline-outcome" && status === "succeeded",
                ),
            ).toBe(true);
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    test("dry-run observes and diagnoses a failure without starting Pi or mutating Git", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "ralphie-gpgreen-"));
        const calls: string[] = [];
        const progressEvents: ProgressUpdate[] = [];
        const snapshot = failingSnapshot(BASE);
        const observation: PipelineObservationService = {
            observe: async () => ({
                outcome: {
                    kind: "failed",
                    observedSha: BASE,
                    reason: "failing",
                    snapshot,
                    elapsedMs: 1,
                    polls: 1,
                } satisfies PipelineObservationOutcome,
                transitions: [],
            }),
        };
        const diagnostics = {
            collectAndStore: async () => ({ path: "/tmp/dry-run.json" }),
        } as unknown as PipelineDiagnosticsService;
        try {
            await expect(
                getPipelinesGreen(
                    {
                        config: configFor(workspace, true),
                        runId: "dry-run",
                    },
                    makeRuntime({
                        workspace,
                        calls,
                        observation,
                        diagnostics,
                        progressEvents,
                    }),
                ),
            ).rejects.toBeInstanceOf(PipelineDeliveryOutcomeError);
            expect(calls).not.toContain("startOpenCode");
            expect(calls).not.toContain("loop");
            expect(calls).not.toContain("pushNonForce");
            expect(calls).not.toContain("prepareExactCheckout");
            const state = JSON.parse(
                await readFile(
                    join(
                        workspace,
                        ".ralphie",
                        "runs",
                        "dry-run",
                        "pipeline",
                        "state.json",
                    ),
                    "utf8",
                ),
            );
            expect(state.status).toBe("stopped");
            expect(state.outcome.kind).toBe("dry-run");
            expect(state.diagnostics.path).toBe("/tmp/dry-run.json");
            expect(state.snapshot.fingerprint).not.toContain("rawValues");
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });
});