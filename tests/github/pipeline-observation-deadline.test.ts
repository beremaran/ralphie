import { describe, expect, test } from "bun:test";
import type { Octokit } from "octokit";

import {
    makePipelineObservationService,
    type PipelineObservationOptions,
    type PipelineObservationRead,
} from "../../src/github/pipeline-observation.ts";
import {
    normalizePipelineSnapshot,
    type PipelineSnapshot,
    type PipelineSnapshotRequest,
} from "../../src/github/pipeline-snapshot.ts";

const sha = "a".repeat(40);
const request: PipelineSnapshotRequest = {
    repository: "owner/repository",
    branch: "main",
    commitSha: sha,
};

const passingSnapshot = (): PipelineSnapshot =>
    normalizePipelineSnapshot({
        ...request,
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

const options = (
    overrides: Partial<PipelineObservationOptions> = {},
): PipelineObservationOptions => ({
    registrationGraceMs: 0,
    quiescenceMs: 0,
    deadlineMs: 10_000,
    initialBackoffMs: 0,
    maxBackoffMs: 0,
    rateLimitRetries: 3,
    maxRateLimitDelayMs: 10_000,
    stableTerminalConfirmations: 1,
    ...overrides,
});

const makeClock = () => {
    let value = 0;
    return {
        now: () => value,
        advance: (milliseconds: number) => {
            value += milliseconds;
        },
    };
};

const makeRun = (
    fetchSnapshot: (
        request: PipelineSnapshotRequest,
        signal?: AbortSignal,
    ) => Promise<PipelineObservationRead>,
    overrides: Partial<PipelineObservationOptions> = {},
) => {
    const clock = makeClock();
    const sleeps: number[] = [];
    const service = makePipelineObservationService({
        now: clock.now,
        sleep: async (milliseconds) => {
            sleeps.push(milliseconds);
            clock.advance(milliseconds);
        },
    });
    return service
        .observe({
            request,
            fetchSnapshot,
            readHead: async () => sha,
            options: options(overrides),
        })
        .then((result) => ({ ...result, sleeps }));
};

const rateLimitedError = (headers: Record<string, string>): Error => {
    const error = new Error("rate limited") as Error & {
        response?: { headers: Record<string, string> };
    };
    error.response = { headers };
    return error;
};

describe("deadline-aware GitHub pipeline observation", () => {
    test("collects every page from checks and commit statuses for the exact SHA", async () => {
        const calls: Array<{
            readonly source: string;
            readonly parameters: Record<string, unknown>;
        }> = [];
        const page =
            (source: string, pages: ReadonlyArray<unknown[]>) =>
            async (parameters: Record<string, unknown>) => {
                calls.push({ source, parameters });
                const index = Number(parameters.page) - 1;
                const values = pages[index] ?? [];
                if (source === "statuses")
                    return {
                        data: values,
                        headers: {
                            link:
                                index + 1 < pages.length
                                    ? '<https://api.github.test?page=2>; rel="next"'
                                    : "",
                        },
                    };
                return {
                    data: {
                        total_count: pages.length * 100,
                        check_runs: values,
                    },
                };
            };
        const client = {
            rest: {
                checks: {
                    listForRef: page("checks", [
                        [
                            {
                                id: 1,
                                name: "build",
                                head_sha: sha,
                                head_branch: "main",
                                status: "completed",
                                conclusion: "success",
                            },
                        ],
                        [
                            {
                                id: 2,
                                name: "lint",
                                head_sha: sha,
                                head_branch: "main",
                                status: "completed",
                                conclusion: "success",
                            },
                        ],
                    ]),
                },
                repos: {
                    listCommitStatusesForRef: page("statuses", [
                        [{ context: "legacy-build", state: "success" }],
                        [{ context: "legacy-lint", state: "success" }],
                    ]),
                    getBranch: async () => ({
                        data: { commit: { sha } },
                    }),
                },
            },
        } as unknown as Octokit;
        const service = makePipelineObservationService();
        const result = await service.observe({
            client,
            request,
            options: options(),
        });

        expect(result.outcome.kind).toBe("green");
        if (result.outcome.kind !== "green") return;
        expect(result.outcome.snapshot.items).toHaveLength(4);
        expect(calls).toHaveLength(8);
        expect(calls.every(({ parameters }) => parameters.ref === sha)).toBe(
            true,
        );
        expect(
            calls.every(({ parameters }) => parameters.branch === undefined),
        ).toBe(true);
        expect(calls.map(({ source }) => source)).toEqual(
            expect.arrayContaining([
                "checks",
                "checks",
                "statuses",
                "statuses",
            ]),
        );
    });

    test("requires stable terminal confirmations and resets them on a changed rerun", async () => {
        const snapshots = [
            passingSnapshot(),
            normalizePipelineSnapshot({
                ...request,
                observations: [
                    {
                        kind: "check-run",
                        name: "build",
                        checkRunId: 2,
                        sha,
                        branch: "main",
                        status: "completed",
                        conclusion: "success",
                    },
                ],
            }),
            passingSnapshot(),
            passingSnapshot(),
        ];
        let index = 0;
        const result = await makeRun(
            async () => ({
                kind: "snapshot",
                snapshot: snapshots[Math.min(index++, snapshots.length - 1)]!,
            }),
            { stableTerminalConfirmations: 2 },
        );

        expect(result.outcome.kind).toBe("green");
        expect(result.outcome.kind === "green" ? result.outcome.polls : 0).toBe(
            4,
        );
    });

    test("retries a delta-seconds rate limit at the exact server delay", async () => {
        let calls = 0;
        const result = await makeRun(
            async () => {
                calls += 1;
                if (calls === 1) throw rateLimitedError({ "retry-after": "2" });
                return { kind: "snapshot", snapshot: passingSnapshot() };
            },
            { deadlineMs: 5_000 },
        );

        expect(result.outcome.kind).toBe("green");
        expect(result.sleeps).toEqual([2_000]);
    });

    test("uses HTTP-date and GitHub reset metadata without retrying early", async () => {
        for (const headers of [
            { "retry-after": new Date(3_000).toUTCString() },
            {
                "x-ratelimit-reset": "3",
                "x-ratelimit-remaining": "0",
            },
        ] as Array<Record<string, string>>) {
            let calls = 0;
            const result = await makeRun(
                async () => {
                    calls += 1;
                    if (calls === 1) throw rateLimitedError(headers);
                    return { kind: "snapshot", snapshot: passingSnapshot() };
                },
                { deadlineMs: 5_000 },
            );
            expect(result.outcome.kind).toBe("green");
            expect(result.sleeps).toEqual([3_000]);
        }
    });

    test("fails closed instead of capping an impossible rate-limit delay", async () => {
        const result = await makeRun(
            async () => {
                throw rateLimitedError({ "retry-after": "10" });
            },
            { maxRateLimitDelayMs: 1_000 },
        );

        expect(result.outcome).toMatchObject({
            kind: "failed",
            reason: "invalid",
        });
        expect(result.sleeps).toEqual([]);
    });

    test("fails closed after bounded rate-limit retries are exhausted", async () => {
        let calls = 0;
        const result = await makeRun(
            async () => {
                calls += 1;
                throw rateLimitedError({ "retry-after": "1" });
            },
            { deadlineMs: 5_000, rateLimitRetries: 2 },
        );

        expect(result.outcome).toMatchObject({
            kind: "failed",
            reason: "invalid",
        });
        expect(calls).toBe(3);
        expect(result.sleeps).toEqual([1_000, 1_000]);
    });

    test("returns timeout when a fetch resolves after the deadline", async () => {
        const clock = makeClock();
        const service = makePipelineObservationService({
            now: clock.now,
            sleep: async (milliseconds) => clock.advance(milliseconds),
        });
        const result = await service.observe({
            request,
            fetchSnapshot: async () => {
                clock.advance(101);
                return { kind: "snapshot", snapshot: passingSnapshot() };
            },
            options: options({ deadlineMs: 100 }),
        });

        expect(result.outcome.kind).toBe("timeout");
        expect(result.outcome.kind === "green").toBe(false);
    });

    test("returns timeout when the final HEAD read crosses the deadline", async () => {
        const clock = makeClock();
        let headReads = 0;
        const service = makePipelineObservationService({
            now: clock.now,
            sleep: async (milliseconds) => clock.advance(milliseconds),
        });
        const result = await service.observe({
            request,
            fetchSnapshot: async () => ({
                kind: "snapshot",
                snapshot: passingSnapshot(),
            }),
            readHead: async () => {
                headReads += 1;
                if (headReads === 2) clock.advance(101);
                return sha;
            },
            options: options({ deadlineMs: 100 }),
        });

        expect(result.outcome.kind).toBe("timeout");
        expect(headReads).toBe(2);
    });

    test("returns the caller reason for aborts during a request and a sleep", async () => {
        const requestController = new AbortController();
        const requestReason = new Error("caller request cancellation");
        const requestService = makePipelineObservationService();
        const requestResultPromise = requestService.observe({
            request,
            fetchSnapshot: async (_request, signal) =>
                new Promise<PipelineObservationRead>((_resolve, reject) => {
                    signal?.addEventListener(
                        "abort",
                        () => reject(new Error("wrapped request error")),
                        { once: true },
                    );
                }),
            options: options({ deadlineMs: 1_000 }),
            signal: requestController.signal,
        });
        setTimeout(() => requestController.abort(requestReason), 5);
        const requestResult = await requestResultPromise;
        expect(requestResult.outcome).toMatchObject({
            kind: "aborted",
            reason: requestReason,
            abortReason: requestReason,
        });

        const sleepController = new AbortController();
        const sleepReason = new Error("caller sleep cancellation");
        const clock = makeClock();
        const service = makePipelineObservationService({
            now: clock.now,
            sleep: async (_milliseconds, signal) =>
                new Promise<void>((_resolve, reject) => {
                    signal?.addEventListener(
                        "abort",
                        () => reject(new Error("wrapped sleep error")),
                        { once: true },
                    );
                    setTimeout(() => sleepController.abort(sleepReason), 5);
                }),
        });
        const sleepResult = await service.observe({
            request,
            fetchSnapshot: async () => ({
                kind: "snapshot",
                snapshot: normalizePipelineSnapshot({
                    ...request,
                    observations: [],
                }),
            }),
            options: options({
                registrationGraceMs: 100,
                initialBackoffMs: 100,
                maxBackoffMs: 100,
            }),
            signal: sleepController.signal,
        });
        expect(sleepResult.outcome).toMatchObject({
            kind: "aborted",
            reason: sleepReason,
            abortReason: sleepReason,
        });
    });

    test("times out a hung in-flight request at the hard deadline", async () => {
        let requestSignal: AbortSignal | undefined;
        const clock = makeClock();
        const service = makePipelineObservationService({ now: clock.now });
        const result = await service.observe({
            request,
            fetchSnapshot: async (_request, signal) =>
                new Promise<PipelineObservationRead>((_resolve, reject) => {
                    requestSignal = signal;
                    signal?.addEventListener(
                        "abort",
                        () => reject(new Error("request cancelled")),
                        { once: true },
                    );
                }),
            options: options({ deadlineMs: 10 }),
        });

        expect(result.outcome.kind).toBe("timeout");
        expect(requestSignal?.aborted).toBe(true);
    });
});