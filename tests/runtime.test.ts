import { describe, expect, test } from "bun:test";

import { normalizePipelineSnapshot } from "../src/github/pipeline-snapshot.ts";
import type { PipelineSnapshotRequest } from "../src/github/pipeline-observation.ts";
import { makeProgressRecorder } from "../src/progress/progress.ts";
import { makeLiveRuntime } from "../src/runtime.ts";

const request: PipelineSnapshotRequest = {
    repository: "owner/repository",
    branch: "main",
    commitSha: "a".repeat(40),
};

describe("runtime factory", () => {
    test("instantiates the read-only pipeline snapshot service", () => {
        const runtime = makeLiveRuntime({
            opencode: {
                start: async () => {
                    throw new Error(
                        "Pi must not start while assembling runtime",
                    );
                },
            },
            progress: makeProgressRecorder([]),
        });

        expect(runtime.pipelineSnapshot).toBeDefined();
        expect(runtime.pipelineSnapshot.collect).toBeFunction();
        expect(runtime.pipelineSnapshot.read).toBe(
            runtime.pipelineSnapshot.collect,
        );
        expect(runtime.pipelineObservation).toBeDefined();
        expect(runtime.pipelineObservation.observe).toBeFunction();
        expect(runtime.gitRevisionCommit).toBeDefined();
        expect(runtime.gitRevisionCommit.commitRevision).toBeFunction();
        expect(runtime.gitRevisionDelivery).toBeDefined();
        expect(runtime.gitRevisionDelivery.deliverRevision).toBeFunction();
    });

    test("lets consumers observe one exact SHA with an abort signal and bounded settings", async () => {
        const runtime = makeLiveRuntime({
            opencode: {
                start: async () => {
                    throw new Error("Pi must not start while observing");
                },
            },
            progress: makeProgressRecorder([]),
        });
        const controller = new AbortController();
        const snapshot = normalizePipelineSnapshot({
            ...request,
            checkRuns: [
                {
                    name: "build",
                    head_sha: request.commitSha,
                    head_branch: request.branch,
                    status: "completed",
                    conclusion: "success",
                },
            ],
        });
        const requests: PipelineSnapshotRequest[] = [];
        const signals: AbortSignal[] = [];
        const result = await runtime.pipelineObservation.observe({
            request,
            fetchSnapshot: async (observedRequest, signal) => {
                requests.push(observedRequest);
                if (signal !== undefined) signals.push(signal);
                return { kind: "snapshot", snapshot };
            },
            readHead: async (observedRequest, signal) => {
                requests.push(observedRequest);
                if (signal !== undefined) signals.push(signal);
                return request.commitSha;
            },
            options: {
                registrationGraceMs: 0,
                quiescenceMs: 0,
                deadlineMs: 1_000,
                initialBackoffMs: 0,
                maxBackoffMs: 0,
                backoffFactor: 1,
                stableTerminalConfirmations: 1,
            },
            signal: controller.signal,
        });

        expect(result.outcome.kind).toBe("green");
        expect(
            requests.every(({ commitSha }) => commitSha === request.commitSha),
        ).toBe(true);
        expect(signals.length).toBeGreaterThan(0);
        expect(signals.every(({ aborted }) => aborted === false)).toBe(true);
    });
});