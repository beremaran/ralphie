import { describe, expect, test } from "bun:test";
import type { Octokit } from "octokit";

import type { AgentClient } from "../../src/opencode/client.ts";
import {
    ReviewFindingSeverity,
    ReviewVerdict,
} from "../../src/issues/decisions.ts";
import {
    IssueArtifactKind,
    makeIssueArtifactStore,
    type IssueArtifactStore,
} from "../../src/issues/artifacts.ts";
import {
    makePullRequestReviewAttemptService,
    type PullRequestReviewAttemptServiceDependencies,
} from "../../src/issues/pull-request-review.ts";
import type { PullRequestSnapshot } from "../../src/github/pull-requests.ts";
import type { GitHubIssue } from "../../src/github/issues.ts";

const baseSha = "a".repeat(40);
const staleHeadSha = "b".repeat(40);
const reviewedHeadSha = "c".repeat(40);
const issue: GitHubIssue = {
    number: 42,
    title: "Review this pull request",
    url: "https://github.com/owner/repository/issues/42",
    body: "Keep the source issue grounded.",
    labels: ["ready-for-agent"],
    updatedAt: "2026-09-04T00:00:00Z",
    commentCount: 0,
    commentVersion: "2026-09-04T00:00:00Z",
};
const suppliedSnapshot: PullRequestSnapshot = {
    number: 17,
    url: "https://github.com/owner/repository/pull/17",
    baseSha,
    headSha: staleHeadSha,
};
const authoritativeSnapshot: PullRequestSnapshot = {
    ...suppliedSnapshot,
    headSha: reviewedHeadSha,
};

const approved = {
    verdict: ReviewVerdict.Approved,
    summary: "The committed change is safe.",
    findings: [],
};
const changesRequested = {
    verdict: ReviewVerdict.ChangesRequested,
    summary: "One blocking issue remains.",
    findings: [
        {
            severity: ReviewFindingSeverity.Blocking,
            description: "The change does not handle the failure path.",
        },
    ],
};

type AgentCall = {
    readonly input: Record<string, unknown>;
    readonly signal?: AbortSignal;
};

const fakeAgent = (outputs: ReadonlyArray<unknown>) => {
    const creates: AgentCall[] = [];
    const prompts: AgentCall[] = [];
    let nextOutput = 0;
    const client: AgentClient = {
        session: {
            create: async (input, options) => {
                creates.push({
                    input: input as unknown as Record<string, unknown>,
                    signal: options?.signal,
                });
                const sessionID = `fresh-session-${creates.length}`;
                return { data: { id: sessionID } };
            },
            prompt: async (input, options) => {
                prompts.push({
                    input: input as unknown as Record<string, unknown>,
                    signal: options?.signal,
                });
                const structured = outputs[nextOutput++];
                return {
                    data: {
                        info: {
                            id: `message-${prompts.length}`,
                            role: "assistant",
                            structured,
                        },
                        parts: [],
                    },
                };
            },
        },
    };
    return { client, creates, prompts };
};

const makeInput = (input: {
    readonly artifacts: IssueArtifactStore;
    readonly agent: AgentClient;
    readonly snapshot?: PullRequestSnapshot;
    readonly signal?: AbortSignal;
}) => ({
    client: {} as Octokit,
    repository: "owner/repository",
    repositoryPath: "/work/repository",
    targetBranch: "main",
    issue,
    snapshot: input.snapshot ?? suppliedSnapshot,
    agent: input.agent,
    agentSelection: { agent: "reviewer" },
    artifacts: input.artifacts,
    runId: "run-42",
    signal: input.signal,
});

const makeDependencies = (options?: {
    readonly reread?: PullRequestSnapshot;
    readonly diff?: string;
    readonly onReread?: (signal: AbortSignal | undefined) => void;
    readonly onDiff?: (
        base: string,
        head: string,
        signal: AbortSignal | undefined,
    ) => void;
}): PullRequestReviewAttemptServiceDependencies => ({
    pullRequests: {
        rereadMatchingSnapshot: async (
            _client,
            _repository,
            _snapshot,
            signal,
        ) => {
            options?.onReread?.(signal);
            return options?.reread ?? authoritativeSnapshot;
        },
    },
    issueOperations: {
        readCommittedBinaryDiff: async (
            _repositoryPath,
            base,
            head,
            signal,
        ) => {
            options?.onDiff?.(base, head, signal);
            return options?.diff ?? "diff --git a/file b/file\n+exact patch\n";
        },
    },
});

const waitForAbort = (signal: AbortSignal | undefined): Promise<never> =>
    new Promise((_, reject) => {
        if (signal?.aborted === true) {
            reject(signal.reason ?? new Error("cancelled"));
            return;
        }
        signal?.addEventListener(
            "abort",
            () => reject(signal.reason ?? new Error("cancelled")),
            { once: true },
        );
    });

describe("pull-request review attempt service", () => {
    test("rereads the PR, grounds a fresh restricted session in the authoritative exact diff, and persists approval", async () => {
        const artifacts = await makeIssueArtifactStore(issue.number);
        const agent = fakeAgent([approved]);
        const controller = new AbortController();
        let rereadSignal: AbortSignal | undefined;
        let diffInput:
            | {
                  readonly base: string;
                  readonly head: string;
                  readonly signal?: AbortSignal;
              }
            | undefined;
        const service = makePullRequestReviewAttemptService(
            makeDependencies({
                onReread: (signal) => {
                    rereadSignal = signal;
                },
                onDiff: (base, head, signal) => {
                    diffInput = { base, head, signal };
                },
            }),
        );

        const result = await service.review(
            makeInput({
                artifacts,
                agent: agent.client,
                signal: controller.signal,
            }),
        );

        expect(result.approved).toBe(true);
        expect(result.snapshot).toEqual(authoritativeSnapshot);
        expect(result.identity).toEqual({
            pullRequestNumber: 17,
            baseSha,
            reviewedHeadSha,
            attempt: 1,
            sessionID: "fresh-session-1",
        });
        expect(rereadSignal).toBe(controller.signal);
        expect(diffInput).toEqual({
            base: baseSha,
            head: reviewedHeadSha,
            signal: controller.signal,
        });
        expect(agent.creates).toHaveLength(1);
        expect(agent.creates[0]?.input.profile).toBe("review");
        expect(agent.creates[0]?.input.title).toBe(
            "Review pull request #17 (attempt 1)",
        );
        expect(agent.creates[0]?.signal).toBe(controller.signal);
        expect(agent.prompts[0]?.signal).toBe(controller.signal);
        const prompt = agent.prompts[0]?.input.parts as ReadonlyArray<{
            readonly text: string;
        }>;
        expect(prompt[0]?.text).toContain(issue.title);
        expect(prompt[0]?.text).toContain(issue.body ?? "");
        expect(prompt[0]?.text).toContain(issue.url);
        expect(prompt[0]?.text).toContain(suppliedSnapshot.url);
        expect(prompt[0]?.text).toContain(baseSha);
        expect(prompt[0]?.text).toContain(reviewedHeadSha);
        expect(prompt[0]?.text).toContain("+exact patch");
        expect(prompt[0]?.text).not.toContain(staleHeadSha);

        expect(
            await artifacts.read(IssueArtifactKind.PullRequestReviewAttempts),
        ).toEqual([result.attempt]);
        expect(
            await artifacts.read(
                IssueArtifactKind.ApprovedPullRequestReviewEvidence,
            ),
        ).toEqual(result.attempt);
    });

    test("uses a fresh session and ordered attempt for a subsequent review", async () => {
        const artifacts = await makeIssueArtifactStore(issue.number);
        const agent = fakeAgent([changesRequested, approved]);
        const service = makePullRequestReviewAttemptService(makeDependencies());

        const first = await service.execute(
            makeInput({ artifacts, agent: agent.client }),
        );
        const second = await service.review(
            makeInput({ artifacts, agent: agent.client }),
        );

        expect(first.approved).toBe(false);
        expect(second.approved).toBe(true);
        expect(first.identity.attempt).toBe(1);
        expect(second.identity.attempt).toBe(2);
        expect(first.identity.sessionID).not.toBe(second.identity.sessionID);
        expect(agent.creates.map(({ input }) => input.profile)).toEqual([
            "review",
            "review",
        ]);
        expect(
            (
                await artifacts.read(
                    IssueArtifactKind.PullRequestReviewAttempts,
                )
            ).map(({ attempt, sessionID }) => ({ attempt, sessionID })),
        ).toEqual([
            { attempt: 1, sessionID: "fresh-session-1" },
            { attempt: 2, sessionID: "fresh-session-2" },
        ]);
    });

    test("rejects a changed PR number or base before reading a diff or starting Pi", async () => {
        const artifacts = await makeIssueArtifactStore(issue.number);
        const agent = fakeAgent([approved]);
        let diffReads = 0;
        const service = makePullRequestReviewAttemptService(
            makeDependencies({
                reread: {
                    ...authoritativeSnapshot,
                    number: 18,
                },
                onDiff: () => {
                    diffReads += 1;
                },
            }),
        );

        await expect(
            service.review(makeInput({ artifacts, agent: agent.client })),
        ).rejects.toThrow("no longer matches");
        expect(diffReads).toBe(0);
        expect(agent.creates).toHaveLength(0);
        expect(artifacts.has(IssueArtifactKind.PullRequestReviewAttempts)).toBe(
            false,
        );
    });

    test("fails closed for invalid structured output and leaves no review attempt", async () => {
        const artifacts = await makeIssueArtifactStore(issue.number);
        const agent = fakeAgent([{ verdict: ReviewVerdict.Approved }]);
        const service = makePullRequestReviewAttemptService(makeDependencies());

        await expect(
            service.review(makeInput({ artifacts, agent: agent.client })),
        ).rejects.toThrow("invalid structured output");
        expect(artifacts.has(IssueArtifactKind.PullRequestReviewAttempts)).toBe(
            false,
        );
        expect(
            artifacts.has(IssueArtifactKind.ApprovedPullRequestReviewEvidence),
        ).toBe(false);
    });

    test("passes the caller signal through every in-flight boundary", async () => {
        const rereadController = new AbortController();
        let rereadStarted = false;
        const rereadService = makePullRequestReviewAttemptService({
            pullRequests: {
                rereadMatchingSnapshot: async (
                    _client,
                    _repo,
                    _snapshot,
                    signal,
                ) => {
                    rereadStarted = true;
                    await waitForAbort(signal);
                    return authoritativeSnapshot;
                },
            },
            issueOperations: {
                readCommittedBinaryDiff: async () => "never reached",
            },
        });
        const rereadStore = await makeIssueArtifactStore(issue.number);
        const rereadPending = rereadService.review(
            makeInput({
                artifacts: rereadStore,
                agent: fakeAgent([approved]).client,
                signal: rereadController.signal,
            }),
        );
        while (!rereadStarted) await Promise.resolve();
        rereadController.abort(new Error("cancelled during reread"));
        await expect(rereadPending).rejects.toThrow("cancelled during reread");

        const diffController = new AbortController();
        let diffStarted = false;
        const diffService = makePullRequestReviewAttemptService({
            pullRequests: {
                rereadMatchingSnapshot: async () => authoritativeSnapshot,
            },
            issueOperations: {
                readCommittedBinaryDiff: async (
                    _repositoryPath,
                    _base,
                    _head,
                    signal,
                ) => {
                    diffStarted = true;
                    await waitForAbort(signal);
                    return "never reached";
                },
            },
        });
        const diffStore = await makeIssueArtifactStore(issue.number);
        const diffPending = diffService.review(
            makeInput({
                artifacts: diffStore,
                agent: fakeAgent([approved]).client,
                signal: diffController.signal,
            }),
        );
        while (!diffStarted) await Promise.resolve();
        diffController.abort(new Error("cancelled during committed diff"));
        await expect(diffPending).rejects.toThrow(
            "cancelled during committed diff",
        );

        const agentController = new AbortController();
        let promptStarted = false;
        const cancellingAgent: AgentClient = {
            session: {
                create: async () => ({ data: { id: "cancelled-session" } }),
                prompt: async (_input, options) => {
                    promptStarted = true;
                    await waitForAbort(options?.signal);
                    return { data: undefined };
                },
            },
        };
        const agentService = makePullRequestReviewAttemptService(
            makeDependencies(),
        );
        const agentStore = await makeIssueArtifactStore(issue.number);
        const agentPending = agentService.review(
            makeInput({
                artifacts: agentStore,
                agent: cancellingAgent,
                signal: agentController.signal,
            }),
        );
        while (!promptStarted) await Promise.resolve();
        agentController.abort(new Error("cancelled during Pi review"));
        await expect(agentPending).rejects.toThrow();
        expect(
            agentStore.has(IssueArtifactKind.PullRequestReviewAttempts),
        ).toBe(false);

        const persistenceController = new AbortController();
        let appendStarted = false;
        const persistenceBase = await makeIssueArtifactStore(issue.number);
        const cancellingStore: IssueArtifactStore = {
            ...persistenceBase,
            appendPullRequestReview: async (_review, signal) => {
                appendStarted = true;
                await waitForAbort(signal);
            },
        };
        const persistenceService = makePullRequestReviewAttemptService(
            makeDependencies(),
        );
        const persistencePending = persistenceService.review(
            makeInput({
                artifacts: cancellingStore,
                agent: fakeAgent([approved]).client,
                signal: persistenceController.signal,
            }),
        );
        while (!appendStarted) await Promise.resolve();
        persistenceController.abort(new Error("cancelled during persistence"));
        await expect(persistencePending).rejects.toThrow(
            "cancelled during persistence",
        );
    });

    test("fails fast on a pre-aborted signal without starting reread or Pi", async () => {
        const controller = new AbortController();
        const artifacts = await makeIssueArtifactStore(issue.number);
        const agent = fakeAgent([approved]);
        let rereads = 0;
        const service = makePullRequestReviewAttemptService(
            makeDependencies({
                onReread: () => {
                    rereads += 1;
                },
            }),
        );

        controller.abort(new Error("cancelled before reread"));
        await expect(
            service.review(
                makeInput({
                    artifacts,
                    agent: agent.client,
                    signal: controller.signal,
                }),
            ),
        ).rejects.toThrow();
        expect(rereads).toBe(0);
        expect(agent.creates).toHaveLength(0);
    });

    test("does not report approval when a valid decision carries a needs-attention side channel", async () => {
        const artifacts = await makeIssueArtifactStore(issue.number);
        const client = {
            session: {
                create: async () => ({ data: { id: "side-channel-session" } }),
                prompt: async () => ({
                    data: {
                        info: {
                            id: "side-channel-message",
                            role: "assistant" as const,
                            structured: approved,
                        },
                        parts: [],
                        needsAttention: {
                            reason: "external_dependency",
                            message: "The remote dependency is unavailable.",
                        },
                    },
                }),
            },
        } as AgentClient;
        const service = makePullRequestReviewAttemptService(makeDependencies());

        const result = await service.review(
            makeInput({ artifacts, agent: client }),
        );

        expect(result.approved).toBe(false);
        expect(result.needsAttention?.reason).toBe("external_dependency");
        expect(
            artifacts.has(IssueArtifactKind.ApprovedPullRequestReviewEvidence),
        ).toBe(false);
    });
});