import { describe, expect, test } from "bun:test";
import type { Octokit } from "octokit";

import {
    type PipelineObservationOptions,
    type PipelineSnapshotRequest,
    type PipelineSnapshotRequestExecutor,
} from "../../src/github/pipeline-observation.ts";
import { makeProgressRecorder } from "../../src/progress/progress.ts";
import { makeLiveRuntime } from "../../src/runtime.ts";

const sha = "a".repeat(40);
const request: PipelineSnapshotRequest = {
    repository: "owner/repository",
    branch: "main",
    commitSha: sha,
};

type Source = "checks" | "statuses" | "head";
type JsonRecord = Record<string, unknown>;
type ObservationClientInput = {
    readonly checkPages: ReadonlyArray<ReadonlyArray<JsonRecord>>;
    readonly statuses: ReadonlyArray<JsonRecord>;
};

type ObservationCall = {
    readonly source: Source;
    readonly parameters: Record<string, unknown>;
};

const makeClient = (input: ObservationClientInput) => {
    const calls: ObservationCall[] = [];
    const checks = async (parameters: Record<string, unknown>) => {
        calls.push({ source: "checks", parameters });
        const page = Number(parameters.page ?? 1);
        return {
            data: {
                check_runs: input.checkPages[page - 1] ?? [],
                total_count: input.checkPages.length * 100,
            },
            headers: {
                link:
                    page < input.checkPages.length
                        ? '<https://api.github.test/checks?page=2>; rel="next"'
                        : "",
            },
        };
    };
    const statuses = async (parameters: Record<string, unknown>) => {
        calls.push({ source: "statuses", parameters });
        return { data: input.statuses, headers: { link: "" } };
    };
    const getBranch = async (parameters: Record<string, unknown>) => {
        calls.push({ source: "head", parameters });
        return { data: { name: request.branch, commit: { sha } } };
    };
    const client = {
        rest: {
            checks: { listForRef: checks },
            repos: { listCommitStatusesForRef: statuses, getBranch },
        },
    } as unknown as Octokit;
    return { client, calls };
};

const makeRuntime = () => {
    let currentTime = 0;
    const sleeps: number[] = [];
    const signals: AbortSignal[] = [];
    const runtime = makeLiveRuntime({
        pi: {
            start: async () => {
                throw new Error("Pi must not start while observing");
            },
        },
        progress: makeProgressRecorder([]),
        pipelineObservationDependencies: {
            now: () => currentTime,
            sleep: async (milliseconds, signal) => {
                signal?.throwIfAborted();
                sleeps.push(milliseconds);
                currentTime += milliseconds;
            },
            request: (async (endpoint, parameters, signal) => {
                if (signal !== undefined) signals.push(signal);
                return endpoint(parameters);
            }) as PipelineSnapshotRequestExecutor,
        },
    });
    return { runtime, sleeps, signals };
};

const options = (
    overrides: Partial<PipelineObservationOptions> = {},
): PipelineObservationOptions => ({
    registrationGraceMs: 0,
    quiescenceMs: 5,
    deadlineMs: 1_000,
    initialBackoffMs: 10,
    maxBackoffMs: 10,
    backoffFactor: 1,
    rateLimitRetries: 0,
    maxRateLimitDelayMs: 10,
    stableTerminalConfirmations: 2,
    ...overrides,
});

const buildCheck = {
    id: 101,
    name: "build",
    app: { slug: "ci-provider" },
    head_sha: sha,
    head_branch: "main",
    status: "completed",
    conclusion: "success",
    check_suite: {
        id: 201,
        head_sha: sha,
        head_branch: "main",
        workflow_run: {
            id: 301,
            run_attempt: 2,
            workflow_id: 7,
            run_number: 42,
        },
    },
    output: { title: "Build passed", summary: "raw audit detail" },
};

const lintCheck = {
    id: 102,
    name: "lint",
    app: { slug: "ci-provider" },
    head_sha: sha,
    head_branch: "main",
    status: "completed",
    conclusion: "success",
};

const legacyStatus = {
    id: 401,
    context: "legacy-build",
    state: "success",
    description: "legacy raw audit detail",
};

describe("pipeline observation runtime contract", () => {
    test("observes paginated checks and legacy statuses through the live runtime", async () => {
        const { runtime, sleeps, signals } = makeRuntime();
        const { client, calls } = makeClient({
            checkPages: [[buildCheck], [lintCheck]],
            statuses: [legacyStatus],
        });
        const controller = new AbortController();

        const result = await runtime.pipelineObservation.observe({
            client,
            request,
            signal: controller.signal,
            options: options(),
        });

        expect(result.outcome.kind).toBe("green");
        if (result.outcome.kind !== "green") return;
        expect(result.outcome.observedSha).toBe(sha);
        expect(result.outcome.polls).toBe(2);
        expect(sleeps).toEqual([10]);
        expect(signals.length).toBeGreaterThan(0);
        expect(signals.every(({ aborted }) => aborted === false)).toBe(true);

        const build = result.outcome.snapshot.items.find(
            ({ name }) => name === "build",
        );
        expect(build).toMatchObject({
            source: "check-run",
            provider: "ci-provider",
            name: "build",
            status: "passing",
            rawState: { status: "completed", conclusion: "success" },
            diagnostic: {
                source: "check-run",
                provider: "ci-provider",
                runId: 301,
                runAttempt: 2,
                suiteId: 201,
                checkRunId: 101,
                rawValues: {
                    id: 101,
                    app: { slug: "ci-provider" },
                    output: {
                        title: "Build passed",
                        summary: "raw audit detail",
                    },
                },
            },
        });
        expect(
            result.outcome.snapshot.items.find(
                ({ name }) => name === "legacy-build",
            ),
        ).toMatchObject({
            source: "status-context",
            provider: "github.status",
            status: "passing",
            diagnostic: {
                statusId: 401,
                rawValues: {
                    id: 401,
                    context: "legacy-build",
                    description: "legacy raw audit detail",
                },
            },
        });

        expect(calls.filter(({ source }) => source === "checks")).toHaveLength(
            6,
        );
        expect(calls.filter(({ source }) => source === "head")).toHaveLength(2);
        expect(
            calls
                .filter(({ source }) => source === "checks")
                .every(
                    ({ parameters }) =>
                        parameters.ref === sha && parameters.per_page === 100,
                ),
        ).toBe(true);
        expect(
            calls
                .filter(({ source }) => source === "statuses")
                .every(({ parameters }) => parameters.ref === sha),
        ).toBe(true);
    });

    test("fails closed for an unknown API value and for no checks after grace", async () => {
        const unknownRuntime = makeRuntime();
        const unknownClient = makeClient({
            checkPages: [
                [
                    {
                        name: "future-check",
                        head_sha: sha,
                        head_branch: "main",
                        status: "completed",
                        conclusion: "future-api-value",
                    },
                ],
            ],
            statuses: [],
        });
        const unknown =
            await unknownRuntime.runtime.pipelineObservation.observe({
                client: unknownClient.client,
                request,
                options: options({ quiescenceMs: 0 }),
            });

        expect(unknown.outcome).toMatchObject({
            kind: "failed",
            reason: "unknown",
            observedSha: sha,
        });

        const emptyRuntime = makeRuntime();
        const emptyClient = makeClient({ checkPages: [[]], statuses: [] });
        const empty = await emptyRuntime.runtime.pipelineObservation.observe({
            client: emptyClient.client,
            request,
            options: options({
                registrationGraceMs: 5,
                quiescenceMs: 0,
                deadlineMs: 100,
                initialBackoffMs: 5,
                maxBackoffMs: 5,
            }),
        });

        expect(empty.outcome).toMatchObject({
            kind: "no-pipelines-discovered",
            observedSha: sha,
            polls: 2,
        });
        expect(emptyRuntime.sleeps).toEqual([5]);
    });
});