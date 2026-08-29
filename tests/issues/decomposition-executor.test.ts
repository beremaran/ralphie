import { describe, expect, test } from "bun:test";
import type { PiClient } from "../../src/pi/client.ts";
import type { Octokit } from "octokit";

import {
    IssueArtifactKind,
    type IssueArtifactStore,
    makeIssueArtifactStore,
} from "../../src/issues/artifacts.ts";
import {
    ImplementationComplexityLevel,
    ReviewFindingSeverity,
    ReviewVerdict,
} from "../../src/issues/decisions.ts";
import { makeDecompositionExecutorService } from "../../src/issues/decomposition-executor.ts";
import {
    IssueExecutionOutcomeKind,
    type IssueExecutionContext,
} from "../../src/issues/execution.ts";
import { makeGitHubIssueMutationsService } from "../../src/github/issue-mutations.ts";
import type {
    GitHubDecompositionChild,
    GitHubIssuesService,
} from "../../src/github/issues.ts";
import { makePiSessionDiagnostics } from "../../src/agent/task-session.ts";
import { makeProgressRecorder } from "../../src/progress/progress.ts";

const breakdown = {
    rationale: "Separate the API and storage work.",
    issues: [
        {
            key: "storage",
            title: "Migrate storage",
            body: "Move storage behind the new interface.",
            estimatedComplexity: ImplementationComplexityLevel.Level2,
            dependsOn: [],
        },
        {
            key: "api",
            title: "Update API",
            body: "Update API consumers to use the interface.",
            estimatedComplexity: ImplementationComplexityLevel.Level1,
            dependsOn: ["storage"],
        },
    ],
};

const issueResponse = (
    number: number,
    title: string,
    body: string,
    state = "open",
    stateReason: string | null = null,
) => ({
    data: {
        number,
        title,
        html_url: `https://github.com/owner/repository/issues/${number}`,
        body,
        labels: [],
        state,
        updated_at: "2026-08-28T00:00:00.000Z",
        comments: 0,
        state_reason: stateReason,
    },
});

const context = (pi: PiClient, octokit: Octokit): IssueExecutionContext => ({
    issue: {
        number: 42,
        title: "Modernize the API",
        url: "https://github.com/owner/repository/issues/42",
        body: "Preserve this original content.",
        labels: ["architecture"],
    },
    repository: "owner/repository",
    repositoryPath: "/workspace/repository",
    targetBranch: "main",
    workspace: "/workspace",
    runId: "run-1",
    octokit,
    pi,
    piSelection: { agent: "build" },
    piDiagnostics: makePiSessionDiagnostics(),
    repositoryInvariant: {
        capture: async () => ({ branch: "main", head: "abc123" }),
        verify: async () => {},
    },
});

const piClient = (capturePrompt?: (prompt: string) => void) =>
    ({
        session: {
            create: async () => ({ data: { id: "decomposition-session" } }),
            prompt: async (parameters: {
                parts: ReadonlyArray<{ text: string }>;
            }) => {
                capturePrompt?.(parameters.parts[0]?.text ?? "");
                return { data: { info: { structured: breakdown }, parts: [] } };
            },
        },
    }) as unknown as PiClient;

const run = async (
    pi: PiClient,
    octokit: Octokit,
    artifacts: IssueArtifactStore,
    discoveredChildren: ReadonlyArray<GitHubDecompositionChild> = [],
) => {
    const issues: GitHubIssuesService = {
        listOpen: async () => [],
        refresh: async () => discoveredChildren[0]!,
        listDecompositionChildren: async () => discoveredChildren,
    };
    const executor = makeDecompositionExecutorService(
        makeGitHubIssueMutationsService(),
        issues,
        makeProgressRecorder([]),
    );
    return executor.execute({ context: context(pi, octokit), artifacts });
};

describe("decomposition executor", () => {
    test("creates, links, rewrites, and closes in deterministic order", async () => {
        const requests: Array<{
            method: string;
            parameters: Record<string, unknown>;
        }> = [];
        let prompt = "";
        const octokit = {
            rest: {
                issues: {
                    get: async (parameters: Record<string, unknown>) =>
                        issueResponse(
                            Number(parameters.issue_number),
                            "Original",
                            "Original",
                        ),
                    create: async (parameters: Record<string, unknown>) => {
                        requests.push({ method: "create", parameters });
                        const number =
                            parameters.title === "Migrate storage" ? 101 : 102;
                        return issueResponse(
                            number,
                            String(parameters.title),
                            String(parameters.body),
                        );
                    },
                    update: async (parameters: Record<string, unknown>) => {
                        requests.push({ method: "update", parameters });
                        return issueResponse(
                            Number(parameters.issue_number),
                            "Updated",
                            String(parameters.body ?? ""),
                        );
                    },
                },
            },
        } as unknown as Octokit;
        const artifacts = await makeIssueArtifactStore(42);
        await run(
            piClient((value) => (prompt = value)),
            octokit,
            artifacts,
        );
        expect(prompt).toContain("Break down the GitHub issue");
        expect(
            requests.map(({ method, parameters }) => [
                method,
                parameters.issue_number,
            ]),
        ).toEqual([
            ["create", undefined],
            ["create", undefined],
            ["update", 101],
            ["update", 102],
            ["update", 42],
            ["update", 42],
        ]);
        expect(requests[2]?.parameters.body).toContain("#102");
        expect(requests[4]?.parameters.body).toContain(
            "Preserve this original content.",
        );
        expect(requests[5]?.parameters.state_reason).toBe("duplicate");
        expect(
            await artifacts.read(IssueArtifactKind.CreatedIssueNumbers),
        ).toEqual({ storage: 101, api: 102 });
    });

    test("passes failed review summaries to decomposition and persists breakdown before creation", async () => {
        let prompt = "";
        let breakdownPersisted = false;
        const artifacts = await makeIssueArtifactStore(42);
        await artifacts.appendReview({
            attempt: 1,
            sessionID: "review-1",
            decision: {
                verdict: ReviewVerdict.ChangesRequested,
                summary: "Split the migration.",
                findings: [
                    {
                        severity: ReviewFindingSeverity.Blocking,
                        description: "The change is too broad.",
                    },
                ],
            },
        });
        const octokit = {
            rest: {
                issues: {
                    get: async (parameters: Record<string, unknown>) =>
                        issueResponse(
                            Number(parameters.issue_number),
                            "Original",
                            "Original",
                        ),
                    create: async () => {
                        breakdownPersisted = artifacts.has(
                            IssueArtifactKind.IssueBreakdownDecision,
                        );
                        return issueResponse(101, "Child", "Child");
                    },
                    update: async () => issueResponse(101, "Child", "Child"),
                },
            },
        } as unknown as Octokit;
        await run(
            piClient((value) => (prompt = value)),
            octokit,
            artifacts,
        );
        expect(prompt).toContain("Split the migration.");
        expect(breakdownPersisted).toBe(true);
    });

    test("reconciles marker-discovered children before creating new issues", async () => {
        let createCount = 0;
        const artifacts = await makeIssueArtifactStore(42);
        await artifacts.write(
            IssueArtifactKind.IssueBreakdownDecision,
            breakdown,
        );
        const discoveredChildren: ReadonlyArray<GitHubDecompositionChild> = [
            {
                number: 101,
                title: "Migrate storage",
                url: "issue/101",
                body: '<!-- ralphie:decomposition root=42 parent=42 key="storage" depth=1 -->',
                labels: [],
                decompositionKey: "storage",
            },
            {
                number: 102,
                title: "Update API",
                url: "issue/102",
                body: '<!-- ralphie:decomposition root=42 parent=42 key="api" depth=1 -->',
                labels: [],
                decompositionKey: "api",
            },
        ];
        const octokit = {
            rest: {
                issues: {
                    get: async (parameters: Record<string, unknown>) =>
                        issueResponse(
                            Number(parameters.issue_number),
                            "Original",
                            "Original",
                        ),
                    create: async () => {
                        createCount += 1;
                        return issueResponse(999, "Unexpected", "Unexpected");
                    },
                    update: async (parameters: Record<string, unknown>) =>
                        issueResponse(
                            Number(parameters.issue_number),
                            "Updated",
                            "Updated",
                        ),
                },
            },
        } as unknown as Octokit;
        const outcome = await run(
            piClient(),
            octokit,
            artifacts,
            discoveredChildren,
        );
        expect(outcome).toEqual({
            kind: IssueExecutionOutcomeKind.Decomposed,
            childIssueNumbers: [101, 102],
        });
        expect(createCount).toBe(0);
        expect(
            await artifacts.read(IssueArtifactKind.CreatedIssueNumbers),
        ).toEqual({ storage: 101, api: 102 });
    });

    test("leaves the original open when child linking fails, then resumes safely", async () => {
        let originalUpdated = false;
        let closeCount = 0;
        let createCount = 0;
        let failLink = true;
        const octokit = {
            rest: {
                issues: {
                    get: async (parameters: Record<string, unknown>) =>
                        issueResponse(
                            Number(parameters.issue_number),
                            "Original",
                            "Original",
                        ),
                    create: async (parameters: Record<string, unknown>) => {
                        createCount += 1;
                        return issueResponse(
                            parameters.title === "Migrate storage" ? 101 : 102,
                            "Child",
                            "Child",
                        );
                    },
                    update: async (parameters: Record<string, unknown>) => {
                        if (parameters.issue_number === 42)
                            originalUpdated = true;
                        if (parameters.issue_number === 102 && failLink)
                            throw new Error("link failed");
                        if (parameters.state === "closed") closeCount += 1;
                        return issueResponse(
                            Number(parameters.issue_number),
                            "Child",
                            "Child",
                        );
                    },
                },
            },
        } as unknown as Octokit;
        const artifacts = await makeIssueArtifactStore(42);
        await expect(run(piClient(), octokit, artifacts)).rejects.toThrow(
            "recovery is required",
        );
        expect(originalUpdated).toBe(false);
        expect(closeCount).toBe(0);
        failLink = false;
        await run(piClient(), octokit, artifacts);
        expect(createCount).toBe(2);
        expect(originalUpdated).toBe(true);
        expect(closeCount).toBe(1);
    });
});