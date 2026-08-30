import { describe, expect, test } from "bun:test";

import {
    makePipelineObservationService,
    type GreenPipelineObservation,
    type PipelineObservationOptions,
    type PipelineObservationOutcome,
    type PipelineObservationRateLimit,
    type PipelineObservationRead,
    type PipelineObservationTransition,
    type PipelineSnapshotFetcher,
    type PipelineRemoteHeadReader,
} from "../../src/github/pipeline-observation.ts";
import {
    isPipelineGreenCandidate,
    pipelineSnapshotFingerprint,
    pipelineSnapshotReason,
    type ExactCommitSha,
    type PipelineItemStatus,
    type PipelineSnapshot,
    type PipelineSnapshotRequest,
} from "../../src/github/pipeline-snapshot.ts";

const sha = "a".repeat(40);
const advanced = "b".repeat(40);
const request: PipelineSnapshotRequest = {
    repository: "owner/repository",
    branch: "main",
    commitSha: sha,
};

const makeFakeClock = () => {
    let current = 0;
    return {
        now: () => current,
        advance: (ms: number) => {
            current += ms;
        },
    };
};

const makeHarness = () => {
    const clock = makeFakeClock();
    const sleeps: number[] = [];
    const sleep = async (ms: number, signal?: AbortSignal) => {
        sleeps.push(ms);
        clock.advance(ms);
        if (signal?.aborted === true) throw new Error("aborted");
    };
    return { clock, sleeps, sleep };
};

const item = (
    name: string,
    status: PipelineItemStatus,
    provider = "github-actions",
    source:
        | "check-run"
        | "check-suite"
        | "status-context"
        | "workflow-run" = "check-run",
) => ({ provider, name, status, source });

const makeSnapshot = (
    items: ReadonlyArray<{
        readonly provider: string;
        readonly name: string;
        readonly status: PipelineItemStatus;
        readonly source?: Parameters<typeof item>[3];
    }>,
    sourceErrors = 0,
): PipelineSnapshot => {
    const snapshot = {
        ...request,
        state: items.length === 0 ? ("empty" as const) : ("non-empty" as const),
        items: items.map(({ provider, name, status, source }) => ({
            source: source ?? "check-run",
            provider,
            name,
            status,
            rawState: {},
            diagnostic: {
                source: source ?? "check-run",
                disposition: "selected" as const,
                provider,
                name,
                rawState: {},
                rawValues: {},
                errors: [],
            },
        })),
        sourceErrors: Array.from({ length: sourceErrors }, (_, index) => ({
            source: `source-${index}`,
            message: "boom",
        })),
        completenessErrors: [],
        diagnostics: [],
    };
    const reason = pipelineSnapshotReason(snapshot);
    const withReason = { ...snapshot, reason };
    return {
        ...withReason,
        greenCandidate: isPipelineGreenCandidate(snapshot),
        fingerprint: pipelineSnapshotFingerprint(withReason),
    };
};

const read = (
    snapshot: PipelineSnapshot,
    rateLimit?: PipelineObservationRateLimit,
): PipelineObservationRead =>
    rateLimit === undefined
        ? { kind: "snapshot", snapshot }
        : { kind: "snapshot", snapshot, rateLimit };

const pass = (): PipelineObservationRead =>
    read(makeSnapshot([item("build", "passing")]));

const pending = (): PipelineObservationRead =>
    read(makeSnapshot([item("build", "pending")]));

const emptyRead = (): PipelineObservationRead => read(makeSnapshot([]));

const failing = (): PipelineObservationRead =>
    read(makeSnapshot([item("build", "failing")]));

const cancelled = (): PipelineObservationRead =>
    read(makeSnapshot([item("build", "cancelled")]));

const unknown = (): PipelineObservationRead =>
    read(makeSnapshot([item("build", "unknown")]));

const acceptable = (): PipelineObservationRead =>
    read(makeSnapshot([item("build", "acceptable")]));

const invalid = (): PipelineObservationRead =>
    read(makeSnapshot([item("build", "passing")], 1));

const failure = (message: string): PipelineObservationRead => ({
    kind: "failure",
    message,
});

const twoPassing = (): PipelineObservationRead =>
    read(
        makeSnapshot([
            item("build", "passing"),
            item("lint", "passing", "provider-b"),
        ]),
    );

const sequence = (
    first: PipelineObservationRead,
    ...rest: ReadonlyArray<PipelineObservationRead>
): PipelineSnapshotFetcher => {
    const reads = [first, ...rest];
    let index = 0;
    return async () => {
        const current = reads[Math.min(index, reads.length - 1)]!;
        index += 1;
        return current;
    };
};

const sameHead = (): PipelineRemoteHeadReader =>
    (async () => sha) as PipelineRemoteHeadReader;

const headSequence = (
    ...shas: ReadonlyArray<ExactCommitSha>
): PipelineRemoteHeadReader => {
    let index = 0;
    return async () => {
        const current = shas[Math.min(index, shas.length - 1)]!;
        index += 1;
        return current;
    };
};

const defaultOptions = (
    overrides: Partial<PipelineObservationOptions> = {},
): PipelineObservationOptions => ({
    registrationGraceMs: 5000,
    quiescenceMs: 1000,
    deadlineMs: 30_000,
    initialBackoffMs: 1000,
    maxBackoffMs: 10_000,
    backoffFactor: 2,
    ...overrides,
});

const run = async (input: {
    readonly fetchSnapshot: PipelineSnapshotFetcher;
    readonly readHead?: PipelineRemoteHeadReader;
    readonly options?: PipelineObservationOptions;
    readonly signal?: AbortSignal;
    readonly onTransition?: (transition: PipelineObservationTransition) => void;
}): Promise<{
    readonly outcome: PipelineObservationOutcome;
    readonly transitions: ReadonlyArray<PipelineObservationTransition>;
    readonly sleeps: ReadonlyArray<number>;
}> => {
    const harness = makeHarness();
    const service = makePipelineObservationService({
        now: harness.clock.now,
        sleep: harness.sleep,
    });
    const result = await service.observe({
        request,
        fetchSnapshot: input.fetchSnapshot,
        readHead: input.readHead ?? sameHead(),
        options: input.options ?? defaultOptions(),
        signal: input.signal,
        ...(input.onTransition === undefined
            ? {}
            : { onTransition: input.onTransition }),
    });
    return { ...result, sleeps: harness.sleeps };
};

const expectGreen = (
    outcome: PipelineObservationOutcome,
): GreenPipelineObservation => {
    if (outcome.kind !== "green")
        throw new Error(`expected green, got ${outcome.kind}`);
    return outcome;
};

describe("pipeline observation", () => {
    test("polls through registration delay, then resolves green after quiescence", async () => {
        const { outcome, transitions } = await run({
            fetchSnapshot: sequence(emptyRead(), emptyRead(), pass()),
        });

        const green = expectGreen(outcome);
        expect(green.observedSha).toBe(sha);
        expect(green.polls).toBe(4);
        expect(green.snapshot.items.map(({ name }) => name)).toEqual(["build"]);
        expect(transitions).toEqual([
            { kind: "registration" },
            { kind: "registered", itemCount: 1 },
        ]);
    });

    test("fails closed with no pipelines discovered once the grace period expires", async () => {
        const { outcome, transitions } = await run({
            fetchSnapshot: sequence(emptyRead()),
            options: defaultOptions({ registrationGraceMs: 5000 }),
        });

        expect(outcome.kind).toBe("no-pipelines-discovered");
        if (outcome.kind !== "no-pipelines-discovered") return;
        expect(outcome.observedSha).toBe(sha);
        expect(outcome.polls).toBe(4);
        expect(outcome.elapsedMs).toBe(5000);
        expect(transitions).toEqual([{ kind: "registration" }]);
    });

    test("resets the quiescence window when the set grows during quiescence", async () => {
        const { outcome, transitions } = await run({
            fetchSnapshot: sequence(pass(), twoPassing()),
        });

        const green = expectGreen(outcome);
        expect(green.polls).toBe(3);
        expect(green.snapshot.items).toHaveLength(2);
        expect(transitions).toContainEqual({
            kind: "checked-in",
            items: ["check-run\u0000provider-b\u0000lint"],
        });
    });

    test("resets the quiescence window when checks disappear and re-register", async () => {
        const { outcome, transitions } = await run({
            fetchSnapshot: sequence(pass(), emptyRead(), pass()),
        });

        const green = expectGreen(outcome);
        expect(green.polls).toBe(4);
        expect(green.elapsedMs).toBe(7000);
        expect(green.snapshot.items.map(({ name }) => name)).toEqual(["build"]);
        expect(transitions).toEqual([
            { kind: "registered", itemCount: 1 },
            {
                kind: "disappeared",
                items: ["check-run\u0000github-actions\u0000build"],
            },
            { kind: "registered", itemCount: 1 },
        ]);
    });

    test("resolves green after a stable quiescence window", async () => {
        const { outcome, sleeps } = await run({
            fetchSnapshot: sequence(pass()),
        });

        const green = expectGreen(outcome);
        expect(green.polls).toBe(2);
        expect(sleeps).toEqual([1000]);
    });

    test("emits a status-changed transition for pending-to-terminal", async () => {
        const { outcome, transitions } = await run({
            fetchSnapshot: sequence(pending(), pass()),
        });

        const green = expectGreen(outcome);
        expect(green.polls).toBe(3);
        expect(transitions).toEqual([
            { kind: "registered", itemCount: 1 },
            {
                kind: "status-changed",
                item: "check-run\u0000github-actions\u0000build",
                from: "pending",
                to: "passing",
            },
        ]);
    });

    test("fails closed when a pending item moves to failing", async () => {
        const { outcome, transitions } = await run({
            fetchSnapshot: sequence(pending(), failing()),
        });

        expect(outcome.kind).toBe("failed");
        if (outcome.kind !== "failed") return;
        expect(outcome.reason).toBe("failing");
        expect(outcome.snapshot?.items[0]?.status).toBe("failing");
        // One pending poll plus one failing poll held stable across quiescence.
        expect(outcome.polls).toBe(3);
        expect(transitions).toEqual([
            { kind: "registered", itemCount: 1 },
            {
                kind: "status-changed",
                item: "check-run\u0000github-actions\u0000build",
                from: "pending",
                to: "failing",
            },
        ]);
    });

    test("tracks mixed Check Run and commit-status items through a status change", async () => {
        const mixed = (lint: PipelineItemStatus) =>
            read(
                makeSnapshot([
                    item("build", "passing", "github-actions", "check-run"),
                    item("lint", lint, "github-actions", "status-context"),
                ]),
            );
        const { outcome, transitions } = await run({
            fetchSnapshot: sequence(mixed("pending"), mixed("passing")),
        });

        const green = expectGreen(outcome);
        expect(green.snapshot.items).toHaveLength(2);
        expect(transitions).toEqual([
            { kind: "registered", itemCount: 2 },
            {
                kind: "status-changed",
                item: "status-context\u0000github-actions\u0000lint",
                from: "pending",
                to: "passing",
            },
        ]);
    });

    test("invokes onTransition only for meaningful state changes", async () => {
        const transitions: PipelineObservationTransition[] = [];
        const { outcome } = await run({
            fetchSnapshot: sequence(emptyRead(), pending(), pending(), pass()),
            onTransition: (transition) => transitions.push(transition),
        });

        expectGreen(outcome);
        expect(transitions).toEqual([
            { kind: "registration" },
            { kind: "registered", itemCount: 1 },
            {
                kind: "status-changed",
                item: "check-run\u0000github-actions\u0000build",
                from: "pending",
                to: "passing",
            },
        ]);
    });

    test("times out at the absolute deadline without sleeping past it", async () => {
        const { outcome, transitions, sleeps } = await run({
            fetchSnapshot: sequence(pending()),
            options: defaultOptions({ deadlineMs: 5000 }),
        });

        expect(outcome.kind).toBe("timeout");
        if (outcome.kind !== "timeout") return;
        expect(outcome.polls).toBe(3);
        expect(outcome.elapsedMs).toBe(5000);
        expect(outcome.lastSnapshot).toBeDefined();
        expect(transitions).toEqual([{ kind: "registered", itemCount: 1 }]);
        expect(sleeps).toEqual([1000, 2000, 2000]);
    });

    test("returns aborted immediately for a pre-aborted signal", async () => {
        const controller = new AbortController();
        controller.abort();
        const { outcome, transitions } = await run({
            fetchSnapshot: sequence(pass()),
            signal: controller.signal,
        });

        expect(outcome.kind).toBe("aborted");
        if (outcome.kind !== "aborted") return;
        expect(outcome.polls).toBe(0);
        expect(transitions).toEqual([]);
    });

    test("returns aborted when the signal fires during a poll", async () => {
        const controller = new AbortController();
        const { outcome } = await run({
            fetchSnapshot: async () => {
                controller.abort();
                return pass();
            },
            signal: controller.signal,
        });

        expect(outcome.kind).toBe("aborted");
        if (outcome.kind !== "aborted") return;
        expect(outcome.polls).toBe(1);
    });

    test("honors GitHub rate-limit reset and retry-after hints", async () => {
        const limited = await run({
            fetchSnapshot: sequence(
                read(makeSnapshot([item("build", "pending")]), {
                    resetAtMs: 4000,
                    remaining: 0,
                }),
                pass(),
            ),
        });
        const green = expectGreen(limited.outcome);
        expect(green.polls).toBe(3);
        expect(limited.sleeps[0]).toBe(4000);

        const retryAfter = await run({
            fetchSnapshot: sequence(
                read(makeSnapshot([item("build", "pending")]), {
                    retryAfterMs: 3000,
                }),
                pass(),
            ),
        });
        expectGreen(retryAfter.outcome);
        expect(retryAfter.sleeps[0]).toBe(3000);
    });

    test("keeps backoff bounded by exponential growth and the configured cap", async () => {
        const { outcome, sleeps } = await run({
            fetchSnapshot: sequence(pending()),
            options: defaultOptions({
                deadlineMs: 9500,
                maxBackoffMs: 3000,
                initialBackoffMs: 1000,
                backoffFactor: 2,
            }),
        });

        expect(outcome.kind).toBe("timeout");
        expect(sleeps.slice(0, 4)).toEqual([1000, 2000, 3000, 3000]);
        expect(Math.max(...sleeps)).toBeLessThanOrEqual(3000);
    });

    test("fails closed on acceptable, failing, cancelled, unknown, and invalid terminal states", async () => {
        for (const scenario of [
            { fetcher: acceptable, reason: "failing" },
            { fetcher: failing, reason: "failing" },
            { fetcher: cancelled, reason: "cancelled" },
            { fetcher: unknown, reason: "unknown" },
            { fetcher: invalid, reason: "invalid" },
        ] as const) {
            const { outcome } = await run({
                fetchSnapshot: sequence(scenario.fetcher()),
            });

            expect(outcome.kind).toBe("failed");
            if (outcome.kind !== "failed") return;
            expect(outcome.reason).toBe(scenario.reason);
            expect(outcome.polls).toBe(2);
        }
    });

    test("fails closed with invalid and the fetch message when a fetch failure follows a registered set", async () => {
        const { outcome, transitions } = await run({
            fetchSnapshot: sequence(pass(), failure("network down")),
        });

        expect(outcome.kind).toBe("failed");
        if (outcome.kind !== "failed") return;
        expect(outcome.reason).toBe("invalid");
        expect(outcome.message).toBe("network down");
        expect(outcome.snapshot).toBeUndefined();
        expect(outcome.polls).toBe(2);
        expect(transitions).toEqual([{ kind: "registered", itemCount: 1 }]);
    });

    test("fails closed with invalid instead of no pipelines when the fetcher fails during registration", async () => {
        const { outcome } = await run({
            fetchSnapshot: sequence(failure("auth rejected")),
        });

        expect(outcome.kind).toBe("failed");
        if (outcome.kind !== "failed") return;
        expect(outcome.reason).toBe("invalid");
        expect(outcome.message).toBe("auth rejected");
        expect(outcome.polls).toBe(1);
    });

    test("fails closed with invalid when the fetcher throws", async () => {
        const { outcome } = await run({
            fetchSnapshot: async () => {
                throw new Error("exploded");
            },
        });

        expect(outcome.kind).toBe("failed");
        if (outcome.kind !== "failed") return;
        expect(outcome.reason).toBe("invalid");
        expect(outcome.message).toBe("exploded");
        expect(outcome.polls).toBe(1);
    });

    test("reports stale when the remote HEAD advanced before the final snapshot", async () => {
        const { outcome } = await run({
            fetchSnapshot: sequence(pass()),
            readHead: headSequence(advanced, advanced),
        });

        expect(outcome.kind).toBe("stale");
        if (outcome.kind !== "stale") return;
        expect(outcome.observedSha).toBe(sha);
        expect(outcome.headBefore).toBe(advanced);
        expect(outcome.headAfter).toBe(advanced);
        expect(outcome.snapshot.state).toBe("non-empty");
        expect(outcome.polls).toBe(2);
    });

    test("reports stale when the remote HEAD advances after the final snapshot", async () => {
        const { outcome } = await run({
            fetchSnapshot: sequence(pass()),
            readHead: headSequence(sha, advanced),
        });

        expect(outcome.kind).toBe("stale");
        if (outcome.kind !== "stale") return;
        expect(outcome.headBefore).toBe(sha);
        expect(outcome.headAfter).toBe(advanced);
    });

    test("fails closed with invalid when the final verification read fails", async () => {
        const { outcome, transitions } = await run({
            fetchSnapshot: sequence(
                pass(),
                pass(),
                failure("verification failed"),
            ),
        });

        expect(outcome.kind).toBe("failed");
        if (outcome.kind !== "failed") return;
        expect(outcome.reason).toBe("invalid");
        expect(outcome.message).toBe("verification failed");
        expect(outcome.snapshot).toBeUndefined();
        expect(outcome.polls).toBe(2);
        expect(transitions).toEqual([{ kind: "registered", itemCount: 1 }]);
    });

    test("does not emit transitions for unchanged polls", async () => {
        const { outcome, transitions } = await run({
            fetchSnapshot: sequence(pending()),
            options: defaultOptions({ deadlineMs: 3000 }),
        });

        expect(outcome.kind).toBe("timeout");
        expect(transitions).toEqual([{ kind: "registered", itemCount: 1 }]);
    });

    test("fails closed when the final verification snapshot is empty", async () => {
        let reads = 0;
        const { outcome, transitions } = await run({
            fetchSnapshot: async () => {
                reads += 1;
                return reads === 1 ? pass() : emptyRead();
            },
        });

        expect(outcome.kind).toBe("no-pipelines-discovered");
        expect(transitions).toContainEqual({
            kind: "disappeared",
            items: ["check-run\u0000github-actions\u0000build"],
        });
    });
});