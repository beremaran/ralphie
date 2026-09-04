import { describe, expect, test } from "bun:test";
import type { Octokit } from "octokit";

import type { AgentClient } from "../../src/opencode/client.ts";
import {
    ReviewFindingSeverity,
    ReviewVerdict,
    type CommitMessageDecision,
    type ReviewDecision,
} from "../../src/issues/decisions.ts";
import {
    makeIssueArtifactStore,
    type IssueArtifactStore,
} from "../../src/issues/artifacts.ts";
import type { GitIssueOperationsService } from "../../src/git/issue-operations.ts";
import type {
    CommandResult,
    CommandRunnerService,
} from "../../src/process/command-runner.ts";
import type {
    GitRevisionDeliveryOutcome,
    GitRevisionDeliveryInput,
} from "../../src/git/revision-delivery.ts";
import type { IssueVerificationService } from "../../src/issues/verification.ts";
import type {
    PullRequestReviewAttemptResult,
    PullRequestReviewAttemptInput,
} from "../../src/issues/pull-request-review.ts";
import {
    makePullRequestReviewCoordinatorService,
    type PullRequestReviewCoordinatorDependencies,
    type PullRequestReviewCoordinatorInput,
} from "../../src/issues/pull-request-review-coordinator.ts";
import type { PullRequestSnapshot } from "../../src/github/pull-requests.ts";
import type { GitHubIssue } from "../../src/github/issues.ts";

const BASE = "a".repeat(40);
const INITIAL_HEAD = "b".repeat(40);
const REVISION_HEAD = "c".repeat(40);
const SECOND_REVISION_HEAD = "d".repeat(40);
const TREE = "e".repeat(40);

const issue: GitHubIssue = {
    number: 42,
    title: "Coordinate PR review",
    url: "https://github.com/owner/repository/issues/42",
    body: "The issue describes the requested change.",
    labels: [],
};
const initialSnapshot: PullRequestSnapshot = {
    number: 17,
    url: "https://github.com/owner/repository/pull/17",
    baseSha: BASE,
    headSha: INITIAL_HEAD,
};

const approved: ReviewDecision = {
    verdict: ReviewVerdict.Approved,
    summary: "No blocking findings remain.",
    findings: [],
};
const changesRequested: ReviewDecision = {
    verdict: ReviewVerdict.ChangesRequested,
    summary: "A blocking finding remains.",
    findings: [
        {
            severity: ReviewFindingSeverity.Blocking,
            description: "The failure path needs a correction.",
        },
    ],
};
const commitMessage: CommitMessageDecision = {
    subject: "Fix: address pull request findings",
    body: "Apply the approved revision.",
};

const reviewResultFor = (
    input: PullRequestReviewAttemptInput,
    attempt: number,
    decision: ReviewDecision,
): PullRequestReviewAttemptResult => ({
    identity: {
        pullRequestNumber: input.snapshot.number,
        baseSha: input.snapshot.baseSha,
        reviewedHeadSha: input.snapshot.headSha,
        attempt,
        sessionID: `review-session-${attempt}`,
    },
    attempt: {
        pullRequestNumber: input.snapshot.number,
        baseSha: input.snapshot.baseSha,
        reviewedHeadSha: input.snapshot.headSha,
        attempt,
        sessionID: `review-session-${attempt}`,
        decision,
    },
    snapshot: input.snapshot,
    decision,
    committedDiff: `diff for ${input.snapshot.headSha}`,
    approved: decision.verdict === ReviewVerdict.Approved,
});

type AgentCall = {
    readonly title?: string;
    readonly profile?: unknown;
    readonly structured: boolean;
};

const makeAgent = () => {
    const calls: AgentCall[] = [];
    let sessionNumber = 0;
    const client: AgentClient = {
        session: {
            create: async (input) => {
                sessionNumber += 1;
                calls.push({
                    title: input.title,
                    profile: input.profile,
                    structured: false,
                });
                return { data: { id: `coordinator-session-${sessionNumber}` } };
            },
            prompt: async (input) => {
                const structured = input.format !== undefined;
                const call = calls[calls.length - 1];
                if (call !== undefined && structured) {
                    calls[calls.length - 1] = { ...call, structured };
                }
                return {
                    data: {
                        info: {
                            id: `message-${sessionNumber}`,
                            role: "assistant" as const,
                            ...(structured
                                ? { structured: commitMessage }
                                : { text: "The requested fix is complete." }),
                        },
                        parts: [],
                    },
                };
            },
        },
    };
    return { client, calls };
};

const confirmedDelivery = (
    input: GitRevisionDeliveryInput,
    headSha: string,
): GitRevisionDeliveryOutcome => ({
    status: "confirmed",
    repository: input.repository,
    branch: input.branch,
    headSha,
    parentSha: input.expectedPriorHeadSha,
    treeSha: input.expectedStagedTreeSha,
    remoteSha: headSha,
    pushResponseLost: false,
});

type HarnessOptions = {
    readonly decisions: ReadonlyArray<ReviewDecision | Error>;
    readonly reread?: (
        snapshot: PullRequestSnapshot,
        call: number,
    ) => PullRequestSnapshot;
    readonly delivery?: (
        input: GitRevisionDeliveryInput,
        call: number,
    ) => GitRevisionDeliveryOutcome;
};

const makeHarness = (options: HarnessOptions) => {
    const agent = makeAgent();
    const reviewCalls: PullRequestReviewAttemptInput[] = [];
    const rereadCalls: PullRequestSnapshot[] = [];
    const deliveryCalls: GitRevisionDeliveryInput[] = [];
    let rereadIndex = 0;
    let reviewIndex = 0;
    let deliveryIndex = 0;
    let staged = false;

    const reviewAttempt = {
        review: async (input: PullRequestReviewAttemptInput) => {
            reviewCalls.push(input);
            const decision = options.decisions[reviewIndex++];
            if (decision instanceof Error) throw decision;
            if (decision === undefined) throw new Error("missing decision");
            return reviewResultFor(input, reviewIndex, decision);
        },
    };
    const pullRequests = {
        rereadMatchingSnapshot: async (
            _client: Octokit,
            _repository: string,
            snapshot: PullRequestSnapshot,
            _signal?: AbortSignal,
        ) => {
            rereadCalls.push(snapshot);
            return options.reread?.(snapshot, rereadIndex++) ?? snapshot;
        },
    };
    const operations: Pick<
        GitIssueOperationsService,
        "stageAll" | "hasStagedChanges" | "readStagedBinaryDiff"
    > = {
        stageAll: async () => {
            staged = true;
        },
        hasStagedChanges: async () => staged,
        readStagedBinaryDiff: async () => "staged revision diff",
    };
    const verification: Pick<IssueVerificationService, "verify"> = {
        verify: async () => ({
            stagedTreeSha: TREE,
            commands: [
                { command: "bun test", exitCode: 0, stdout: "", stderr: "" },
            ],
        }),
    };
    const commandRunner: Pick<CommandRunnerService, "run"> = {
        run: async (
            _command: string,
            _args: ReadonlyArray<string>,
        ): Promise<CommandResult> => {
            staged = false;
            return { exitCode: 0, stdout: "", stderr: "" };
        },
    };
    const revisionDelivery = {
        deliverRevision: async (input: GitRevisionDeliveryInput) => {
            deliveryCalls.push(input);
            const delivery = options.delivery?.(input, deliveryIndex++);
            return delivery ?? confirmedDelivery(input, REVISION_HEAD);
        },
    };
    const dependencies: PullRequestReviewCoordinatorDependencies = {
        pullRequests,
        reviewAttempt,
        issueOperations: operations,
        verification,
        revisionDelivery,
        commandRunner,
    };
    const coordinatorInput = (inputArtifacts: IssueArtifactStore) =>
        ({
            client: {} as Octokit,
            repository: "owner/repository",
            repositoryPath: "/work/repository",
            branch: "ralphie/issue-42",
            targetBranch: "main",
            issue,
            snapshot: initialSnapshot,
            agent: agent.client,
            agentSelection: { agent: "reviewer" },
            artifacts: inputArtifacts,
            verificationCommands: ["bun test"],
        }) satisfies PullRequestReviewCoordinatorInput;

    return {
        agent,
        dependencies,
        coordinatorInput,
        reviewCalls,
        rereadCalls,
        deliveryCalls,
    };
};

const run = async (options: HarnessOptions) => {
    const harness = makeHarness(options);
    const artifacts = await makeIssueArtifactStore(issue.number);
    const coordinator = makePullRequestReviewCoordinatorService(
        harness.dependencies,
    );
    const result = await coordinator.review(
        harness.coordinatorInput(artifacts),
    );
    return { ...harness, artifacts, result };
};

describe("pull-request review coordinator", () => {
    test("returns first-pass approval without starting a revision", async () => {
        const { result, deliveryCalls, agent } = await run({
            decisions: [approved],
        });

        expect(result.status).toBe("approved");
        expect(result.reviews).toHaveLength(1);
        expect(result.revisions).toHaveLength(0);
        expect(deliveryCalls).toHaveLength(0);
        expect(agent.calls).toHaveLength(0);
    });

    test("runs a fresh edit/test session, exact-tree preparation, and one non-force revision before re-reviewing", async () => {
        const { result, deliveryCalls, agent, rereadCalls } = await run({
            decisions: [changesRequested, approved],
        });

        expect(result.status).toBe("approved");
        expect(result.reviews).toHaveLength(2);
        expect(result.revisions).toHaveLength(1);
        expect(deliveryCalls).toHaveLength(1);
        expect(deliveryCalls[0]?.expectedPriorHeadSha).toBe(INITIAL_HEAD);
        expect(deliveryCalls[0]?.expectedStagedTreeSha).toBe(TREE);
        expect(deliveryCalls[0]?.message).toEqual(commitMessage);
        expect(agent.calls).toEqual([
            {
                title: "Address pull request review for #42 (attempt 1)",
                profile: undefined,
                structured: false,
            },
            {
                title: "Generate PR revision commit message for #42 (attempt 1)",
                profile: "review",
                structured: true,
            },
        ]);
        expect(rereadCalls.map(({ headSha }) => headSha)).toEqual([
            INITIAL_HEAD,
            INITIAL_HEAD,
            REVISION_HEAD,
        ]);
    });

    test("shares one five-attempt budget and returns a distinct exhaustion result", async () => {
        const { result, deliveryCalls, agent } = await run({
            decisions: [
                changesRequested,
                changesRequested,
                changesRequested,
                changesRequested,
                changesRequested,
            ],
        });

        expect(result.status).toBe("pr-review-exhausted");
        expect(result.reviews).toHaveLength(5);
        expect(result.revisions).toHaveLength(4);
        expect(deliveryCalls).toHaveLength(4);
        expect(agent.calls).toHaveLength(8);
    });

    test("retries review on a head that moves before the fix without delivering the old head", async () => {
        const movedSnapshot = {
            ...initialSnapshot,
            headSha: SECOND_REVISION_HEAD,
        };
        const { result, reviewCalls, deliveryCalls } = await run({
            decisions: [changesRequested, approved],
            reread: (_snapshot, call) =>
                call === 0 ? movedSnapshot : _snapshot,
        });

        expect(result.status).toBe("approved");
        expect(result.reviews).toHaveLength(2);
        expect(reviewCalls.map(({ snapshot }) => snapshot.headSha)).toEqual([
            INITIAL_HEAD,
            SECOND_REVISION_HEAD,
        ]);
        expect(deliveryCalls).toHaveLength(0);
    });

    test("retains a recoverable external-movement delivery outcome without retrying or guessing", async () => {
        const moved: GitRevisionDeliveryOutcome = {
            status: "external-movement",
            repository: "owner/repository",
            branch: "ralphie/issue-42",
            headSha: REVISION_HEAD,
            parentSha: INITIAL_HEAD,
            expectedRemoteSha: INITIAL_HEAD,
            actualRemoteSha: SECOND_REVISION_HEAD,
        };
        const { result, deliveryCalls } = await run({
            decisions: [changesRequested],
            delivery: () => moved,
        });

        expect(result.status).toBe("delivery-recoverable");
        expect(result.revisions).toHaveLength(1);
        expect(
            (
                result as Extract<
                    typeof result,
                    { readonly status: "delivery-recoverable" }
                >
            ).delivery,
        ).toEqual(moved);
        expect(deliveryCalls).toHaveLength(1);
    });

    test("does not approve an invalid review attempt", async () => {
        const { result, deliveryCalls } = await run({
            decisions: [new Error("invalid structured output")],
        });

        expect(result.status).toBe("review-failed");
        expect("approved" in result).toBe(false);
        expect(deliveryCalls).toHaveLength(0);
    });

    test("propagates cancellation before a later session or mutation", async () => {
        const controller = new AbortController();
        let resolveReview: (() => void) | undefined;
        const harness = makeHarness({ decisions: [approved] });
        const dependencies: PullRequestReviewCoordinatorDependencies = {
            ...harness.dependencies,
            reviewAttempt: {
                review: async () => {
                    await new Promise<void>((resolve) => {
                        resolveReview = resolve;
                    });
                    return reviewResultFor(
                        harness.coordinatorInput(
                            await makeIssueArtifactStore(issue.number),
                        ),
                        1,
                        approved,
                    );
                },
            },
        };
        const artifacts = await makeIssueArtifactStore(issue.number);
        const coordinator =
            makePullRequestReviewCoordinatorService(dependencies);
        const pending = coordinator.review({
            ...harness.coordinatorInput(artifacts),
            signal: controller.signal,
        });
        while (resolveReview === undefined) await Promise.resolve();
        controller.abort(new Error("cancelled"));
        resolveReview?.();

        await expect(pending).rejects.toThrow();
        expect(harness.deliveryCalls).toHaveLength(0);
    });
});