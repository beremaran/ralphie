import { describe, expect, test } from "bun:test";

import type { AgentSelection } from "../../src/agent/model.ts";
import type { AgentClient } from "../../src/opencode/client.ts";
import type { PipelineDiagnosticsBoundary } from "../../src/github/pipeline-diagnostics-boundary.ts";
import type {
    PipelineObservationResult,
    PipelineObservationService,
} from "../../src/github/pipeline-observation.ts";
import {
    normalizePipelineSnapshot,
    type PipelineSnapshot,
    type PipelineSnapshotRequest,
} from "../../src/github/pipeline-snapshot.ts";
import type {
    PipelineCommitResult,
    PipelineDeliveryGitService,
    PipelinePushAttempt,
} from "../../src/git/pipeline-delivery.ts";
import type { GitRepositoryInvariantService } from "../../src/git/repository-invariant.ts";
import {
    makePipelineDeliveryLoopService,
    pipelineFailureFingerprint,
    type PipelineDeliveryLoopInput,
    type PipelineDeliveryOutcome,
} from "../../src/issues/pipeline-delivery-loop.ts";
import type {
    PipelineRepairExecutorService,
    PipelineRepairOutcome,
} from "../../src/issues/pipeline-repair-executor.ts";

const REPOSITORY = "owner/repository";
const BRANCH = "main";
const BASE = "a".repeat(40);
const EXTERNAL_ONE = "b".repeat(40);
const EXTERNAL_TWO = "c".repeat(40);
const TREE = "d".repeat(40);
const AGENT_SELECTION: AgentSelection = { agent: "builder" };
const AGENT = {} as AgentClient;

const boundary = (
    request: PipelineSnapshotRequest,
): PipelineDiagnosticsBoundary =>
    ({
        structured: {
            version: 1,
            request,
            source: "pipeline-diagnostics",
            disposition: "ok",
            truncated: false,
            limits: {
                maxJobs: 1,
                maxStepsPerJob: 1,
                maxExcerptBytes: 100,
                maxTotalBytes: 100,
                maxCharacters: 100,
            },
            records: [],
            errors: [],
            logs: [],
            omitted: false,
            omittedCounts: { records: 0, logs: 0, errors: 0, fields: 0 },
        },
        text: "<untrusted-pipeline-diagnostics>{}</untrusted-pipeline-diagnostics>",
    }) as PipelineDiagnosticsBoundary;

const requestFor = (sha: string): PipelineSnapshotRequest => ({
    repository: REPOSITORY,
    branch: BRANCH,
    commitSha: sha,
});

const failingSnapshot = (sha: string, checkName = "build"): PipelineSnapshot =>
    normalizePipelineSnapshot({
        ...requestFor(sha),
        checkRuns: [
            {
                name: checkName,
                head_sha: sha,
                head_branch: BRANCH,
                status: "completed",
                conclusion: "failure",
            },
        ],
    });

const failure = (
    sha: string,
    snapshot = failingSnapshot(sha),
): PipelineObservationResult => ({
    outcome: {
        kind: "failed",
        observedSha: sha,
        reason: "failing",
        snapshot,
        elapsedMs: 1,
        polls: 1,
    },
    transitions: [],
});

const green = (sha: string): PipelineObservationResult => ({
    outcome: {
        kind: "green",
        observedSha: sha,
        snapshot: normalizePipelineSnapshot({
            ...requestFor(sha),
            checkRuns: [
                {
                    name: "build",
                    head_sha: sha,
                    head_branch: BRANCH,
                    status: "completed",
                    conclusion: "success",
                },
            ],
        }),
        elapsedMs: 1,
        polls: 1,
    },
    transitions: [],
});

const approvedRepair = (
    snapshot: PipelineSnapshot,
    stagedDiff = "diff --git a/fix b/fix\n+fixed\n",
): PipelineRepairOutcome => ({
    status: "approved",
    failureFingerprint: snapshot.fingerprint,
    diagnostics: boundary(snapshot),
    reviews: [],
    stagedDiff,
    stagedTreeSha: TREE,
});

type HarnessOptions = {
    readonly observations: ReadonlyArray<PipelineObservationResult>;
    readonly repairs?: ReadonlyArray<PipelineRepairOutcome>;
    readonly remoteReads?: ReadonlyArray<string | undefined>;
    readonly push?: PipelinePushAttempt;
    readonly remoteAfterPush?: string;
    readonly maxExternalMovements?: number;
    readonly now?: () => number;
};

type Harness = {
    readonly execute: (
        overrides?: Partial<PipelineDeliveryLoopInput>,
    ) => Promise<PipelineDeliveryOutcome>;
    readonly observations: PipelineSnapshotRequest[];
    readonly repairs: PipelineSnapshotRequest[];
    readonly prepares: string[];
    readonly discards: string[];
    readonly commits: PipelineCommitResult[];
};

const makeHarness = (options: HarnessOptions): Harness => {
    let remote = BASE;
    let local = BASE;
    let localStatus = "";
    let commitNumber = 0;
    const remoteReads = [...(options.remoteReads ?? [])];
    const observations: PipelineSnapshotRequest[] = [];
    const repairs: PipelineSnapshotRequest[] = [];
    const prepares: string[] = [];
    const discards: string[] = [];
    const commits: PipelineCommitResult[] = [];
    const repairResults = [
        ...(options.repairs ?? [approvedRepair(failingSnapshot(BASE))]),
    ];
    const observationResults = [...options.observations];

    const nextRemote = (): string => {
        const scripted = remoteReads.shift();
        if (scripted !== undefined) {
            remote = scripted;
        }
        return remote;
    };

    const git: PipelineDeliveryGitService = {
        readRemoteHead: async () => nextRemote(),
        prepareExactCheckout: async (_path, branch, expectedSha) => {
            expect(branch).toBe(BRANCH);
            prepares.push(expectedSha);
            local = expectedSha;
            localStatus = "";
        },
        discardToExactCheckout: async (_path, branch, expectedSha) => {
            expect(branch).toBe(BRANCH);
            expect(local.toLowerCase()).toBe(expectedSha.toLowerCase());
            discards.push(expectedSha);
            local = expectedSha;
            localStatus = "";
        },
        readCheckout: async () => ({
            branch: BRANCH,
            head: local,
            status: localStatus,
        }),
        readStagedTreeSha: async () => TREE,
        commitStaged: async ({ expectedParentSha }) => {
            expect(local.toLowerCase()).toBe(expectedParentSha.toLowerCase());
            commitNumber += 1;
            const commit = {
                sha: `${commitNumber.toString(16)}${"e".repeat(39)}`,
                parentSha: expectedParentSha,
                treeSha: TREE,
            };
            local = commit.sha;
            localStatus = "";
            commits.push(commit);
            return commit;
        },
        pushNonForce: async ({ expectedCommitSha }) => {
            const result = options.push ?? { response: "accepted", output: "" };
            if (options.remoteAfterPush !== undefined) {
                remote = options.remoteAfterPush;
            } else if (result.response === "accepted") {
                remote = expectedCommitSha;
            }
            return result;
        },
    };

    const repositoryInvariant: GitRepositoryInvariantService = {
        capture: async () => ({ branch: BRANCH, head: local }),
        verify: async (_path, expected) => {
            expect(local.toLowerCase()).toBe(expected.head.toLowerCase());
            expect(expected.branch).toBe(BRANCH);
        },
    };
    const repair: PipelineRepairExecutorService = {
        execute: async (input) => {
            repairs.push(requestFor(input.failingHeadSha));
            const result = repairResults.shift();
            if (result === undefined)
                throw new Error("No fake repair result remains.");
            if (result.status === "approved") localStatus = "M";
            return result;
        },
    };
    const observation: Pick<PipelineObservationService, "observe"> = {
        observe: async (input) => {
            if (input.request === undefined) {
                throw new Error("Fake observer requires an exact request.");
            }
            observations.push(input.request);
            const result = observationResults.shift();
            if (result === undefined)
                throw new Error("No fake observation result remains.");
            return result;
        },
    };
    const diagnostics = async ({
        request,
    }: {
        readonly request: PipelineSnapshotRequest;
    }) => ({
        boundary: boundary(request),
        path: `/tmp/${request.commitSha}.json`,
    });
    const service = makePipelineDeliveryLoopService({
        git,
        observation,
        diagnostics,
        repair,
        repositoryInvariant,
        maxExternalMovements: options.maxExternalMovements,
        now: options.now,
    });
    const input: PipelineDeliveryLoopInput = {
        repository: REPOSITORY,
        repositoryPath: "/tmp/pipeline-checkout",
        workspace: "/tmp/pipeline-workspace",
        branch: BRANCH,
        runId: "pipeline-run",
        agent: AGENT,
        agentSelection: AGENT_SELECTION,
        maxAttempts: 3,
        deadlineAtMs: Date.now() + 60_000,
    };
    return {
        execute: (overrides = {}) =>
            service.execute({ ...input, ...overrides }),
        observations,
        repairs,
        prepares,
        discards,
        commits,
    };
};

describe("pipeline delivery loop", () => {
    test("returns already-green without diagnostics, repair, commit, or push", async () => {
        const harness = makeHarness({ observations: [green(BASE)] });
        const result = await harness.execute();

        expect(result).toMatchObject({
            kind: "green",
            source: "already-green",
            remoteSha: BASE,
            pushedAttempts: 0,
        });
        expect(harness.repairs).toHaveLength(0);
        expect(harness.commits).toHaveLength(0);
    });

    test("commits and pushes one approved repair, then requires a green proof on the new SHA", async () => {
        const harness = makeHarness({
            observations: [failure(BASE), green("1" + "e".repeat(39))],
        });
        const result = await harness.execute();

        expect(result).toMatchObject({
            kind: "green",
            source: "pushed-repair",
            pushedAttempts: 1,
        });
        expect(harness.repairs).toEqual([requestFor(BASE)]);
        expect(harness.commits).toHaveLength(1);
        expect(harness.observations.map(({ commitSha }) => commitSha)).toEqual([
            BASE,
            "1" + "e".repeat(39),
        ]);
        expect(result.attempts[0]?.push?.status).toBe("confirmed");
    });

    test("follows a branch movement after editing without charging an attempt or pushing stale work", async () => {
        const harness = makeHarness({
            observations: [failure(BASE), green(EXTERNAL_ONE)],
            remoteReads: [BASE, BASE, EXTERNAL_ONE, EXTERNAL_ONE, EXTERNAL_ONE],
        });
        const result = await harness.execute();

        expect(result).toMatchObject({
            kind: "green",
            remoteSha: EXTERNAL_ONE,
            pushedAttempts: 0,
        });
        expect(harness.repairs).toEqual([requestFor(BASE)]);
        expect(harness.commits).toHaveLength(0);
        expect(harness.discards).toContain(BASE);
        expect(harness.prepares).toContain(EXTERNAL_ONE);
    });

    test("reconciles a race during the final green proof before declaring success", async () => {
        const harness = makeHarness({
            observations: [green(BASE), green(EXTERNAL_ONE)],
            remoteReads: [BASE, BASE, EXTERNAL_ONE, EXTERNAL_ONE, EXTERNAL_ONE],
        });
        const result = await harness.execute();

        expect(result).toMatchObject({
            kind: "green",
            remoteSha: EXTERNAL_ONE,
            pushedAttempts: 0,
            externalMovements: 1,
        });
        expect(harness.repairs).toHaveLength(0);
        expect(harness.discards).toContain(BASE);
        expect(harness.prepares).toContain(EXTERNAL_ONE);
    });

    test("follows a branch movement detected before repair starts", async () => {
        const harness = makeHarness({
            observations: [failure(BASE), green(EXTERNAL_ONE)],
            remoteReads: [BASE, EXTERNAL_ONE, EXTERNAL_ONE, EXTERNAL_ONE],
        });
        const result = await harness.execute();

        expect(result).toMatchObject({
            kind: "green",
            remoteSha: EXTERNAL_ONE,
            pushedAttempts: 0,
            externalMovements: 1,
        });
        expect(harness.repairs).toHaveLength(0);
        expect(harness.prepares).toContain(EXTERNAL_ONE);
    });

    test("stops after repeated external movement instead of spinning", async () => {
        const harness = makeHarness({
            observations: [failure(BASE), failure(EXTERNAL_ONE)],
            remoteReads: [BASE, EXTERNAL_ONE, EXTERNAL_ONE, EXTERNAL_TWO],
            maxExternalMovements: 1,
        });
        const result = await harness.execute();

        expect(result.kind).toBe("external-movement");
        expect(result.externalMovements).toBe(2);
        expect(result.pushedAttempts).toBe(0);
        expect(harness.repairs).toHaveLength(1);
    });

    test("halts on an ambiguous push and never charges an unconfirmed repair", async () => {
        const harness = makeHarness({
            observations: [failure(BASE)],
            push: { response: "accepted", output: "sent" },
            remoteAfterPush: BASE,
        });
        const result = await harness.execute();

        expect(result).toMatchObject({
            kind: "ambiguous-push",
            pushedAttempts: 0,
            remoteSha: BASE,
        });
        expect(result.attempts[0]?.push).toMatchObject({ status: "ambiguous" });
    });

    test("accepts a response loss only when the authoritative remote read shows the created SHA", async () => {
        const createdSha = "1" + "e".repeat(39);
        const harness = makeHarness({
            observations: [failure(BASE), green(createdSha)],
            push: {
                response: "rejected",
                failureKind: "other",
                output: "connection lost",
            },
            remoteAfterPush: createdSha,
        });
        const result = await harness.execute();

        expect(result.kind).toBe("green");
        expect(result.pushedAttempts).toBe(1);
        expect(result.attempts[0]?.push?.status).toBe(
            "confirmed-after-response-loss",
        );
    });

    test("stops on the identical normalized failure fingerprint after a pushed repair", async () => {
        const createdSha = "1" + "e".repeat(39);
        const harness = makeHarness({
            observations: [failure(BASE), failure(createdSha)],
        });
        const result = await harness.execute();

        expect(result.kind).toBe("identical-failure");
        expect(result.pushedAttempts).toBe(1);
        expect(result.failureFingerprint).toBe(
            pipelineFailureFingerprint(failingSnapshot(BASE)),
        );
    });

    test("stops at max pushed attempts after observing the next failure", async () => {
        const createdSha = "1" + "e".repeat(39);
        const harness = makeHarness({
            observations: [
                failure(BASE),
                failure(createdSha, failingSnapshot(createdSha, "lint")),
            ],
        });
        const result = await harness.execute({ maxAttempts: 1 });

        expect(result.kind).toBe("attempts-exhausted");
        expect(result.pushedAttempts).toBe(1);
        expect(harness.repairs).toHaveLength(1);
    });

    test("reports an absolute deadline before starting observation", async () => {
        const harness = makeHarness({
            observations: [green(BASE)],
            now: () => 10,
        });
        const result = await harness.execute({ deadlineAtMs: 1 });

        expect(result.kind).toBe("timeout");
        expect(harness.observations).toHaveLength(0);
    });

    test("rejects an invalid max-attempt bound before touching the remote", async () => {
        const harness = makeHarness({ observations: [green(BASE)] });
        await expect(harness.execute({ maxAttempts: 0 })).rejects.toMatchObject(
            {
                _tag: "PipelineDeliveryLoopError",
                kind: "invalid-input",
            },
        );
        expect(harness.observations).toHaveLength(0);
    });
});