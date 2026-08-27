import { describe, expect, test } from "bun:test";
import type { PiClient } from "../../src/pi/client.ts";
import type { Octokit } from "octokit";

import {
    IssueArtifactKind,
    type IssueArtifactStore,
    makeIssueArtifactStore,
    makeIssueArtifactStoreService,
} from "../../src/issues/artifacts.ts";
import { makeComplexityAssessmentService } from "../../src/issues/complexity.ts";
import {
    ComplexityLevel,
    ImplementationComplexityLevel,
} from "../../src/issues/decisions.ts";
import { makeDecompositionExecutorService } from "../../src/issues/decomposition-executor.ts";
import type { IssueExecutionContext } from "../../src/issues/execution.ts";
import {
    IssueCompletionKind,
    IssueExecutionOutcomeKind,
} from "../../src/issues/execution.ts";
import type { GitIssueOperationsService } from "../../src/git/issue-operations.ts";
import { makeImplementationExecutorService } from "../../src/issues/implementation-executor.ts";
import type { GitIssuePreparationService } from "../../src/git/issue-preparation.ts";
import {
    GitPushMode,
    type GitRemoteSafetyService,
} from "../../src/git/remote-safety.ts";
import type { GitHubIssueMutationService } from "../../src/github/issue-mutations.ts";
import type { GitHubIssuesService } from "../../src/github/issues.ts";
import { makePiSessionDiagnostics } from "../../src/agent/task-session.ts";
import {
    makeProgressRecorder,
    type ProgressUpdate,
} from "../../src/progress/progress.ts";
import type { IssueRecoveryService } from "../../src/issues/recovery.ts";
import {
    IssueQueueResumeStrategy,
    IssueWorkflowKind,
} from "../../src/issues/stage.ts";
import { ReviewExhaustionOutcome } from "../../src/issues/recovery.ts";
import { createIssueQueue, toQueuedIssues } from "../../src/issues/queue.ts";
import { makeIssueExecutorService } from "../../src/issues/executor.ts";
import { RalphieError } from "../../src/shared/error.ts";

const checkpoint = { branch: "main", sha: "abc123" } as const;
const issue = (number: number, title: string, body = "Task body") => ({
    number,
    title,
    url: `https://github.com/owner/repository/issues/${number}`,
    body,
    labels: [],
});

const context = (
    client: PiClient,
    current = issue(42, "Complete task"),
): IssueExecutionContext => ({
    issue: current,
    repository: "owner/repository",
    repositoryPath: "/workspace/repository",
    targetBranch: "main",
    workspace: "/workspace",
    runId: "run-e2e",
    octokit: {} as Octokit,
    pi: client,
    piSelection: { agent: "build" },
    piDiagnostics: makePiSessionDiagnostics(() => "now"),
    repositoryInvariant: {
        capture: async () => ({
            branch: checkpoint.branch,
            head: checkpoint.sha,
        }),
        verify: async () => {},
    },
});

const clientFor = (outputs: ReadonlyArray<unknown>) => {
    let index = 0;
    let session = 0;
    return {
        session: {
            create: async () => ({ data: { id: `session-${++session}` } }),
            prompt: async (parameters: { format?: unknown }) => {
                const output = outputs[index++];
                return {
                    data: {
                        info:
                            parameters.format === undefined
                                ? {}
                                : { structured: output },
                        parts: [],
                    },
                };
            },
        },
    } as unknown as PiClient;
};

const reviewApproved = {
    verdict: "approved",
    summary: "Looks good.",
    findings: [],
} as const;
const breakdown = {
    rationale: "Split storage before dependent tests.",
    issues: [
        {
            key: "storage",
            title: "Implement storage",
            body: "Implement the storage layer.",
            estimatedComplexity: ImplementationComplexityLevel.Level2,
            dependsOn: [],
        },
        {
            key: "tests",
            title: "Add storage tests",
            body: "Add tests for the storage layer.",
            estimatedComplexity: ImplementationComplexityLevel.Level1,
            dependsOn: ["storage"],
        },
    ],
};

const implementationDependencies = (
    operations: Partial<GitIssueOperationsService> = {},
    progress: ProgressUpdate[] = [],
) => {
    const preparation: GitIssuePreparationService = {
        prepare: async () => checkpoint,
    };
    const git: GitIssueOperationsService = {
        stageAll: async () => {},
        readStagedBinaryDiff: async () => "diff --git a/file b/file\n",
        hasStagedChanges: async () => true,
        commit: async () => ({ sha: "commit-e2e", treeSha: "tree-e2e" }),
        push: async () => {},
        createOrCheckoutFeatureBranch: async () => ({
            branch: "feature",
            baseBranch: "main",
            baseSha: checkpoint.sha,
            headSha: checkpoint.sha,
            created: true,
        }),
        restoreBaseCheckout: async () => {},
        ...operations,
    };
    const safety: GitRemoteSafetyService = {
        verifyDirectPush: async (input) => ({
            repository: input.repository,
            branch: input.branch,
            origin: "https://github.com/owner/repository.git",
            commitsBehindBase: 0,
            commitsAheadBase: input.expectedCommitSha === undefined ? 0 : 1,
            pushMode: GitPushMode.NonForce,
        }),
    };
    const recovery: IssueRecoveryService = {
        handleReviewExhaustion: async () => ({
            outcome: ReviewExhaustionOutcome.EscalatedToDecomposition,
            diagnosticsPath: "/workspace/recovery",
            nextWorkflow: IssueWorkflowKind.Decomposition,
            resume: IssueQueueResumeStrategy.RefreshOpenIssues,
        }),
    };
    return makeImplementationExecutorService(
        preparation,
        git,
        safety,
        recovery,
        makeProgressRecorder(progress),
    );
};

const decompositionService = (state: {
    readonly created: number[];
    readonly updates: Array<{ issueNumber: number; body?: string }>;
    readonly closeCount: { value: number };
    readonly failSecondLink?: { value: boolean };
}) => {
    const mutations: GitHubIssueMutationService = {
        create: async (_client, _repository, input) => {
            const number = state.created.length === 0 ? 101 : 102;
            state.created.push(number);
            return issue(number, input.title, input.body);
        },
        update: async (_client, _repository, issueNumber, input) => {
            if (state.failSecondLink?.value && issueNumber === 102) {
                state.failSecondLink.value = false;
                throw new RalphieError({ message: "link failed" });
            }
            state.updates.push({ issueNumber, body: input.body });
            return issue(issueNumber, "Updated", input.body ?? "");
        },
        close: async (_client, _repository, issueNumber) => {
            state.closeCount.value += 1;
            return issue(issueNumber, "Closed");
        },
    };
    const issues: GitHubIssuesService = {
        listOpen: async () => [],
        listDecompositionChildren: async () => [],
    };
    return makeDecompositionExecutorService(
        mutations,
        issues,
        makeProgressRecorder([]),
    );
};

describe("mocked end-to-end issue workflows", () => {
    test("executes a complexity-2 issue through push", async () => {
        const progress: ProgressUpdate[] = [];
        const client = clientFor([
            undefined,
            reviewApproved,
            { subject: "complete task" },
        ]);
        const artifacts = await makeIssueArtifactStore(42);
        const result = await implementationDependencies({}, progress).execute({
            context: context(client),
            artifacts,
        });
        expect(result).toEqual({
            kind: IssueExecutionOutcomeKind.Completed,
            completion: IssueCompletionKind.PushedCommit,
            commitSha: "commit-e2e",
            reviewCount: 1,
        });
    });

    test("executes a complexity-4 issue through closure and refreshes dependent queue work", async () => {
        const state = {
            created: [] as number[],
            updates: [] as Array<{ issueNumber: number; body?: string }>,
            closeCount: { value: 0 },
        };
        const client = clientFor([breakdown]);
        const artifacts = await makeIssueArtifactStore(42);
        const decomposition = decompositionService(state);
        const outcome = await decomposition.execute({
            context: context(client),
            artifacts,
        });
        expect(outcome).toEqual({
            kind: IssueExecutionOutcomeKind.Decomposed,
            childIssueNumbers: [101, 102],
        });
        expect(state.closeCount.value).toBe(1);
        const childBodies = state.updates
            .filter(
                ({ issueNumber }) => issueNumber === 101 || issueNumber === 102,
            )
            .map(({ issueNumber, body }) => ({
                ...issue(issueNumber, `Child ${issueNumber}`),
                body: body ?? "",
            }));
        const queue = createIssueQueue([{ issue: issue(42, "Original") }]);
        expect(queue.next()?.number).toBe(42);
        queue.complete(42);
        expect(queue.refresh(toQueuedIssues(childBodies))).toBe(2);
        expect(queue.next()?.number).toBe(101);
        queue.complete(101);
        expect(queue.next()?.number).toBe(102);
    });

    test("resumes a partially completed decomposition without duplicating children", async () => {
        const state = {
            created: [] as number[],
            updates: [] as Array<{ issueNumber: number; body?: string }>,
            closeCount: { value: 0 },
            failSecondLink: { value: true },
        };
        const artifacts = await makeIssueArtifactStore(42);
        const client = clientFor([breakdown]);
        const executor = decompositionService(state);
        await expect(
            executor.execute({ context: context(client), artifacts }),
        ).rejects.toThrow("recovery is required");
        expect(state.created).toEqual([101, 102]);
        await executor.execute({ context: context(client), artifacts });
        expect(state.created).toEqual([101, 102]);
        expect(state.closeCount.value).toBe(1);
    });

    test("hands five-review exhaustion from implementation to decomposition without commit or push", async () => {
        const review = {
            verdict: "changes_requested",
            summary: "Blocker remains.",
            findings: [{ severity: "blocking", description: "Fix it." }],
        };
        const outputs: unknown[] = [];
        for (let index = 0; index < 5; index += 1)
            outputs.push(undefined, review);
        const client = clientFor(outputs);
        const artifacts = await makeIssueArtifactStore(42);
        let decompositionCalls = 0;
        const progress: ProgressUpdate[] = [];
        const implementation = implementationDependencies({}, progress);
        const decomposition: IssueExecutionContext["repositoryInvariant"] =
            context(client).repositoryInvariant;
        const executor = makeIssueExecutorService(
            { forIssue: async () => artifacts },
            {
                assess: async () => ({
                    decision: {
                        complexity: ComplexityLevel.Level2,
                        rationale: "Small enough to implement.",
                    },
                    sessionID: "complexity",
                }),
            },
            implementation,
            {
                execute: async () => {
                    decompositionCalls += 1;
                    return {
                        kind: IssueExecutionOutcomeKind.Decomposed,
                        childIssueNumbers: [101, 102],
                    };
                },
            },
        );
        const result = await executor.execute({
            ...context(client),
            repositoryInvariant: decomposition,
        });
        expect(result).toEqual({
            kind: IssueExecutionOutcomeKind.Escalated,
            diagnosticsPath: "/workspace/recovery",
            reason: "Review did not converge within the review iteration budget.",
            childIssueNumbers: [101, 102],
        });
        expect(decompositionCalls).toBe(1);
        expect(
            await artifacts.read(IssueArtifactKind.ReviewAttempts),
        ).toHaveLength(5);
    });
});