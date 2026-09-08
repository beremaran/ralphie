import { describe, expect, test } from "bun:test";
import type { Octokit } from "octokit";

import type { AgentClient } from "../../src/opencode/client.ts";
import type {
    GitHubPullRequest,
    GitHubPullRequestService,
    PullRequestSnapshot,
} from "../../src/github/pull-requests.ts";
import type {
    PipelineObservationOutcome,
    PipelineObservationService,
    PipelineSnapshot,
} from "../../src/github/pipeline-observation.ts";
import type {
    PullRequestReviewCoordinatorResult,
    PullRequestReviewCoordinatorService,
} from "../../src/issues/pull-request-review-coordinator.ts";
import type { PullRequestReviewAttempt } from "../../src/issues/pull-request-review.ts";
import {
    IssueArtifactKind,
    type IssueArtifactStore,
    type IssueArtifactStoreService,
} from "../../src/issues/artifacts.ts";
import { makeIssueArtifactStore } from "../../src/issues/artifacts.ts";
import type { GitIssueOperationsService } from "../../src/git/issue-operations.ts";
import type { GitHubIssue } from "../../src/github/issues.ts";
import type { ProgressUpdate } from "../../src/progress/progress.ts";
import { makeTestProgressRecorder } from "../shared/progress-recorder.ts";
import { DEFAULT_AGENT } from "../../src/agent/model.ts";
import { ReviewVerdict } from "../../src/issues/decisions.ts";
import type { RunState } from "../../src/run/state.ts";
import { runStateSchema } from "../../src/run/state.ts";
import { RalphieError } from "../../src/shared/error.ts";
import {
    makePullRequestClosureService,
    type PullRequestClosureInput,
} from "../../src/issues/pull-request-closure.ts";

const ISSUE: GitHubIssue = {
    number: 42,
    title: "Test issue",
    url: "https://github.com/owner/repo/issues/42",
    body: "Test body",
    labels: ["bug"],
    state: "open",
    updatedAt: "2026-08-28T00:00:00.000Z",
    comments: [],
    commentCount: 0,
    commentVersion: "2026-08-28T00:00:00.000Z",
};

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

const snapshot: PullRequestSnapshot = {
    number: 1,
    url: "https://github.com/owner/repo/pull/1",
    baseSha: BASE,
    headSha: HEAD,
};

const greenSnapshot = (commitSha: string): PipelineSnapshot => ({
    repository: "owner/repo",
    branch: "ralphie/issue-42",
    commitSha,
    state: "non-empty",
    items: [],
    sourceErrors: [],
    completenessErrors: [],
    diagnostics: [],
    reason: "success",
    greenCandidate: true,
    fingerprint: `success-${commitSha}`,
});

const approvedAttempt: PullRequestReviewAttempt = {
    pullRequestNumber: 1,
    baseSha: BASE,
    reviewedHeadSha: HEAD,
    attempt: 1,
    sessionID: "review-1",
    decision: {
        verdict: ReviewVerdict.Approved,
        summary: "Safe to merge.",
        findings: [],
    },
};

const approvedResult = (
    headSha = HEAD,
): PullRequestReviewCoordinatorResult => ({
    reviews: [],
    revisions: [],
    status: "approved",
    snapshot: { ...snapshot, headSha },
    review: {
        identity: {
            pullRequestNumber: 1,
            baseSha: BASE,
            reviewedHeadSha: headSha,
            attempt: 1,
            sessionID: "review-1",
        },
        attempt: { ...approvedAttempt, reviewedHeadSha: headSha },
        snapshot: { ...snapshot, headSha },
        decision: { ...approvedAttempt.decision },
        committedDiff: "diff",
        approved: true,
    },
});

const greenOutcome = (observedSha = HEAD): PipelineObservationOutcome => ({
    kind: "green",
    observedSha,
    snapshot: greenSnapshot(observedSha),
    elapsedMs: 1_000,
    polls: 2,
});

type ClosureFakes = {
    readonly calls: string[];
    readonly closures: Array<RunState["prClosure"]>;
    readonly events: ProgressUpdate[];
    readonly stores: Map<number, IssueArtifactStore>;
    readonly pullRequests: GitHubPullRequestService;
    readonly observation: Pick<PipelineObservationService, "observe">;
    readonly operations: Pick<GitIssueOperationsService, "restoreBaseCheckout">;
    readonly artifacts: IssueArtifactStoreService;
    coordinatorCalls: number;
    resumeRevisionSeen: unknown;
};

const openPr = (headSha = HEAD): GitHubPullRequest => ({
    number: 1,
    url: "https://github.com/owner/repo/pull/1",
    merged: false,
    headSha,
    state: "open",
});

const makeFakes = (
    options: {
        readonly coordinatorResult?:
            | PullRequestReviewCoordinatorResult
            | ((attempt: number) => PullRequestReviewCoordinatorResult);
        readonly observationOutcomes?: ReadonlyArray<PipelineObservationOutcome>;
        readonly pr?: GitHubPullRequest;
        readonly prReads?: ReadonlyArray<GitHubPullRequest>;
        readonly mergeFailure?: RalphieError;
        readonly withCoordinator?: boolean;
    } = {},
): ClosureFakes => {
    const calls: string[] = [];
    const closures: Array<RunState["prClosure"]> = [];
    const events: ProgressUpdate[] = [];
    const stores = new Map<number, IssueArtifactStore>();
    let readIndex = 0;
    let observeIndex = 0;
    const fakes: ClosureFakes = {
        calls,
        closures,
        events,
        stores,
        pullRequests: {
            createOrFind: async () => {
                calls.push("createPullRequest");
                return options.pr ?? openPr();
            },
            read: async (_client, _repo, number) => {
                calls.push(`readPullRequest:${number}`);
                const sequenced =
                    options.prReads?.[
                        Math.min(readIndex, options.prReads.length - 1)
                    ];
                readIndex += 1;
                return sequenced ?? options.pr ?? openPr();
            },
            readSnapshot: async (_client, _repo, number) => {
                calls.push(`readSnapshot:${number}`);
                return { ...snapshot };
            },
            rereadMatchingSnapshot: async () => {
                throw new RalphieError({ message: "unused" });
            },
            publishPullRequestReviewAttempts: async () => {
                calls.push("publishPullRequestReviews");
            },
            publishReviewAttempts: async () => {
                calls.push("publishReviews");
            },
            merge: async (_client, _repo, number, expectedHeadSha) => {
                calls.push(`merge:${number}:${expectedHeadSha}`);
                if (options.mergeFailure) throw options.mergeFailure;
                return {
                    number,
                    url: "https://github.com/owner/repo/pull/1",
                    merged: true,
                    headSha: expectedHeadSha,
                    state: "closed",
                };
            },
            mergeWithProof: async (_client, _repo, proof) => {
                calls.push(
                    `mergeWithProof:${proof?.pullRequestNumber}:${proof?.headSha}`,
                );
                if (options.mergeFailure) throw options.mergeFailure;
                return {
                    number: proof!.pullRequestNumber,
                    url: "https://github.com/owner/repo/pull/1",
                    merged: true,
                    headSha: proof!.headSha,
                    state: "closed",
                };
            },
        },
        observation: {
            observe: async (input) => {
                calls.push("observe");
                const list = options.observationOutcomes ?? [
                    greenOutcome(input.request?.commitSha ?? HEAD),
                ];
                const outcome = list[Math.min(observeIndex, list.length - 1)]!;
                observeIndex += 1;
                return { outcome, transitions: [] };
            },
        },
        operations: {
            restoreBaseCheckout: async () => {
                calls.push("restoreBase");
            },
        },
        artifacts: {
            forIssue: async (issueNumber) => {
                const existing = stores.get(issueNumber);
                if (existing !== undefined) return existing;
                const created = await makeIssueArtifactStore(issueNumber);
                stores.set(issueNumber, created);
                return created;
            },
        },
        coordinatorCalls: 0,
        resumeRevisionSeen: undefined,
    };
    return fakes;
};

const coordinatorFor = (
    fakes: ClosureFakes,
    result:
        | PullRequestReviewCoordinatorResult
        | ((attempt: number) => PullRequestReviewCoordinatorResult),
): PullRequestReviewCoordinatorService => ({
    review: async (input) => {
        fakes.coordinatorCalls += 1;
        fakes.resumeRevisionSeen = input.resumeRevision;
        return typeof result === "function"
            ? result(fakes.coordinatorCalls)
            : result;
    },
});

const closureInput = (
    fakes: ClosureFakes,
    overrides: Partial<PullRequestClosureInput> = {},
): PullRequestClosureInput => ({
    client: {} as Octokit,
    repository: "owner/repo",
    branch: "develop",
    featureBranch: "ralphie/issue-42",
    issue: ISSUE,
    repositoryPath: "/tmp/ralphie/repo",
    agent: {} as AgentClient,
    agentSelection: { agent: DEFAULT_AGENT },
    runId: "test-run",
    workspace: "/tmp/ralphie",
    progress: makeTestProgressRecorder(fakes.events),
    current: 1,
    total: 1,
    onClosure: async (next) => {
        fakes.closures.push(structuredClone(next));
    },
    ...overrides,
});

const minimalStateFor = (
    closure: RunState["prClosure"],
): Record<string, unknown> => ({
    version: 9,
    status: "active",
    runId: "test-run",
    repository: "owner/repo",
    branch: "develop",
    onNeedsAttention: "continue",
    selection: { agent: DEFAULT_AGENT },
    queue: { pending: [], completedIssueNumbers: [], processedCount: 0 },
    outcomes: [],
    checkout: { branch: "develop", head: "head-0" },
    updatedAt: new Date().toISOString(),
    ...(closure === undefined ? {} : { prClosure: closure }),
});

describe("pull request closure seam", () => {
    test("merges an approved PR with a merge proof after a green observation", async () => {
        const fakes = makeFakes();
        const service = makePullRequestClosureService({
            pullRequests: fakes.pullRequests,
            reviewCoordinator: coordinatorFor(fakes, approvedResult()),
            observation: fakes.observation,
            artifacts: fakes.artifacts,
            issueOperations: fakes.operations,
        });
        const outcome = await service.close(closureInput(fakes));

        expect(fakes.coordinatorCalls).toBe(1);
        expect(fakes.calls).toContain(`mergeWithProof:1:${HEAD}`);
        expect(fakes.calls).not.toContain("merge:1");
        expect(fakes.calls).toContain("restoreBase");
        expect(outcome.closure).toMatchObject({
            pullRequestNumber: 1,
            observedHeadSha: HEAD,
            gate: "merged",
            review: {
                status: "approved",
                stage: "merge",
                currentHeadSha: HEAD,
            },
        });
        expect(fakes.calls.indexOf("publishPullRequestReviews")).toBeLessThan(
            fakes.calls.indexOf("observe"),
        );
        // Persisted closure stays compatible with resume behavior.
        expect(() =>
            runStateSchema.parse(minimalStateFor(outcome.closure)),
        ).not.toThrow();
        const deliveryState = await fakes.stores
            .get(42)
            ?.read(IssueArtifactKind.PullRequestDeliveryState);
        expect(deliveryState?.status).toBe("merged");
    });

    test("persists a failed review without merging on changes-requested", async () => {
        const fakes = makeFakes();
        const service = makePullRequestClosureService({
            pullRequests: fakes.pullRequests,
            reviewCoordinator: coordinatorFor(fakes, {
                reviews: [],
                revisions: [],
                status: "review-failed",
                snapshot: { ...snapshot },
                attempt: 1,
                message: "blocking finding",
            }),
            observation: fakes.observation,
            artifacts: fakes.artifacts,
            issueOperations: fakes.operations,
        });
        await expect(service.close(closureInput(fakes))).rejects.toThrow(
            "Post-PR review did not pass",
        );
        expect(fakes.coordinatorCalls).toBe(1);
        expect(fakes.calls).not.toContainEqual(
            expect.stringContaining("merge"),
        );
        expect(fakes.calls).toContain("restoreBase");
        expect(fakes.closures.at(-1)).toMatchObject({
            gate: "pending",
            review: { status: "failed", stage: "review" },
        });
        expect(() =>
            runStateSchema.parse(minimalStateFor(fakes.closures.at(-1))),
        ).not.toThrow();
    });

    test("records a stale closure when the head moves before the merge", async () => {
        const fakes = makeFakes({
            prReads: [openPr("c".repeat(40))],
        });
        const service = makePullRequestClosureService({
            pullRequests: fakes.pullRequests,
            observation: fakes.observation,
            artifacts: fakes.artifacts,
            issueOperations: fakes.operations,
        });
        await expect(service.close(closureInput(fakes))).rejects.toThrow(
            "head changed",
        );
        expect(fakes.calls).toContain("observe");
        expect(fakes.calls).not.toContainEqual(
            expect.stringContaining("merge:"),
        );
        expect(fakes.closures.at(-1)).toMatchObject({
            observedHeadSha: "c".repeat(40),
            gate: "stale",
        });
        expect(fakes.calls).toContain("restoreBase");
    });

    test("surfaces external movement without merging", async () => {
        const delivery = {
            status: "external-movement" as const,
            repository: "owner/repo",
            branch: "ralphie/issue-42",
            headSha: HEAD,
            parentSha: BASE,
            expectedRemoteSha: HEAD,
            actualRemoteSha: "d".repeat(40),
        };
        const fakes = makeFakes();
        const service = makePullRequestClosureService({
            pullRequests: fakes.pullRequests,
            reviewCoordinator: coordinatorFor(fakes, {
                reviews: [],
                revisions: [],
                status: "delivery-recoverable",
                snapshot: { ...snapshot },
                delivery,
            }),
            observation: fakes.observation,
            artifacts: fakes.artifacts,
            issueOperations: fakes.operations,
        });
        await expect(service.close(closureInput(fakes))).rejects.toThrow(
            "Post-PR review did not pass",
        );
        expect(fakes.calls).not.toContainEqual(
            expect.stringContaining("merge"),
        );
        expect(fakes.closures.at(-1)).toMatchObject({
            review: {
                status: "delivery-recoverable",
                stage: "revision-delivery",
            },
        });
    });

    test("reconciles a merge failure into a terminal gate", async () => {
        const fakes = makeFakes({
            mergeFailure: new RalphieError({
                message: "PR is not definitively mergeable.",
            }),
        });
        const service = makePullRequestClosureService({
            pullRequests: fakes.pullRequests,
            observation: fakes.observation,
            artifacts: fakes.artifacts,
            issueOperations: fakes.operations,
        });
        await expect(service.close(closureInput(fakes))).rejects.toThrow(
            "Failed to merge",
        );
        expect(fakes.calls).toContain(`merge:1:${HEAD}`);
        expect(fakes.closures.at(-1)).toMatchObject({ gate: "unmergeable" });
        expect(fakes.calls).toContain("restoreBase");
    });

    test("carries an interrupted revision intent into the resumed coordinator", async () => {
        const revisionIntent = {
            attempt: 1,
            expectedPriorHeadSha: HEAD,
            expectedStagedTreeSha: "c".repeat(40),
            message: { subject: "Fix: resume", body: "Resume body." },
        };
        const initialClosure: RunState["prClosure"] = {
            pullRequestNumber: 1,
            baseSha: BASE,
            observedHeadSha: HEAD,
            startedAt: "2026-09-05T00:00:00.000Z",
            updatedAt: "2026-09-05T00:00:00.000Z",
            gate: "pending",
            review: {
                status: "failed",
                stage: "revision-delivery",
                attempts: [],
                revisionIntent,
                currentHeadSha: HEAD,
                revisionCount: 1,
            },
        };
        const fakes = makeFakes();
        const service = makePullRequestClosureService({
            pullRequests: fakes.pullRequests,
            reviewCoordinator: coordinatorFor(fakes, approvedResult()),
            observation: fakes.observation,
            artifacts: fakes.artifacts,
            issueOperations: fakes.operations,
        });
        const outcome = await service.close(
            closureInput(fakes, { initialClosure }),
        );
        expect(fakes.resumeRevisionSeen).toEqual(revisionIntent);
        expect(fakes.calls).toContain(`mergeWithProof:1:${HEAD}`);
        expect(outcome.closure).toMatchObject({ gate: "merged" });
    });

    test("reconciles an already-merged PR without observing or merging", async () => {
        const merged: GitHubPullRequest = {
            number: 1,
            url: "https://github.com/owner/repo/pull/1",
            merged: true,
            headSha: HEAD,
            state: "closed",
        };
        const fakes = makeFakes({ pr: merged });
        const service = makePullRequestClosureService({
            pullRequests: fakes.pullRequests,
            observation: fakes.observation,
            artifacts: fakes.artifacts,
            issueOperations: fakes.operations,
        });
        const outcome = await service.close(closureInput(fakes));
        expect(fakes.calls).not.toContain("observe");
        expect(fakes.calls).not.toContainEqual(
            expect.stringContaining("merge"),
        );
        expect(fakes.calls).toContain("restoreBase");
        expect(outcome.closure).toMatchObject({ gate: "merged" });
    });
});