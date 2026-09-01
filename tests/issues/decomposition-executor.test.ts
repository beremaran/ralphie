import { describe, expect, test } from "bun:test";
import type { CodexClient } from "../../src/codex/client.ts";
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
    GitHubIssue,
    GitHubIssuesService,
} from "../../src/github/issues.ts";
import type { GitHubIssueRelationshipService } from "../../src/github/issue-relationships.ts";
import { makeCodexSessionDiagnostics } from "../../src/agent/task-session.ts";
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
        id: 1_000_000 + number,
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

const context = (
    codex: CodexClient,
    octokit: Octokit,
): IssueExecutionContext => ({
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
    codex,
    codexSelection: { agent: "build" },
    codexDiagnostics: makeCodexSessionDiagnostics(),
    repositoryInvariant: {
        capture: async () => ({ branch: "main", head: "abc123" }),
        verify: async () => {},
    },
});

const codexClient = (capturePrompt?: (prompt: string) => void) =>
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
    }) as unknown as CodexClient;

const plainIssue = (number: number): GitHubIssue => ({
    number,
    title: `Issue ${number}`,
    url: `issue/${number}`,
    body: null,
    labels: [],
});

/**
 * In-memory relationship service double that records attach and dependency
 * calls and can be pre-seeded with existing native state for resume tests.
 */
const relationshipStub = (log: Array<Record<string, unknown>> = []) => {
    const attached = new Map<number, Set<number>>();
    const blockedBy = new Map<number, Set<number>>();
    const parentOfImpl = async (
        _client: Octokit,
        _repository: string,
        childNumber: number,
    ): Promise<GitHubIssue | undefined> => {
        for (const [parentNumber, children] of attached) {
            if (children.has(childNumber)) return plainIssue(parentNumber);
        }
        return undefined;
    };
    const relationships: GitHubIssueRelationshipService = {
        listSubIssues: async (_client, _repository, parentNumber) =>
            [...(attached.get(parentNumber) ?? [])].map(plainIssue),
        parentOf: parentOfImpl,
        attachSubIssue: async (
            _client,
            _repository,
            parentNumber,
            childNumber,
        ) => {
            log.push({
                method: "attach",
                parent: parentNumber,
                child: childNumber,
            });
            const current = await parentOfImpl(
                _client,
                _repository,
                childNumber,
            );
            if (current !== undefined && current.number !== parentNumber) {
                throw new Error(
                    `Issue #${childNumber} is already a native sub-issue of #${current.number}, not #${parentNumber}.`,
                );
            }
            const children = attached.get(parentNumber) ?? new Set<number>();
            children.add(childNumber);
            attached.set(parentNumber, children);
        },
        listBlockedBy: async (_client, _repository, issueNumber) =>
            [...(blockedBy.get(issueNumber) ?? [])].map(plainIssue),
        addBlockedBy: async (
            _client,
            _repository,
            issueNumber,
            blockerNumber,
        ) => {
            log.push({
                method: "dependency",
                issue: issueNumber,
                blocker: blockerNumber,
            });
            const blockers = blockedBy.get(issueNumber) ?? new Set<number>();
            blockers.add(blockerNumber);
            blockedBy.set(issueNumber, blockers);
        },
    };
    return { relationships, attached, blockedBy, log };
};

const run = async (
    codex: CodexClient,
    octokit: Octokit,
    artifacts: IssueArtifactStore,
    discoveredChildren: ReadonlyArray<GitHubDecompositionChild> = [],
    relationships: GitHubIssueRelationshipService = relationshipStub()
        .relationships,
) => {
    const issues: GitHubIssuesService = {
        listOpen: async () => [],
        refresh: async () => discoveredChildren[0]!,
        listDecompositionChildren: async () => discoveredChildren,
    };
    const executor = makeDecompositionExecutorService(
        makeGitHubIssueMutationsService(),
        issues,
        relationships,
        makeProgressRecorder([]),
    );
    return executor.execute({ context: context(codex, octokit), artifacts });
};

describe("decomposition executor", () => {
    test("creates, links, attaches native sub-issues and dependencies, and keeps the parent open", async () => {
        const requests: Array<{
            method: string;
            parameters: Record<string, unknown>;
        }> = [];
        let prompt = "";
        const state = relationshipStub();
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
            codexClient((value) => (prompt = value)),
            octokit,
            artifacts,
            [],
            state.relationships,
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
        ]);
        expect(
            requests.filter(({ parameters }) => parameters.state === "closed")
                .length,
        ).toBe(0);
        expect(requests[2]?.parameters.body).toContain("root=42 parent=42");
        expect(requests[2]?.parameters.body).not.toContain("#102");
        expect(requests[3]?.parameters.body).toContain("#101 (storage)");
        expect(requests[4]?.parameters.body).toContain(
            "Preserve this original content.",
        );
        expect(state.log).toEqual([
            { method: "attach", parent: 42, child: 101 },
            { method: "attach", parent: 42, child: 102 },
            { method: "dependency", issue: 102, blocker: 101 },
        ]);
        expect(
            await artifacts.read(IssueArtifactKind.CreatedIssueNumbers),
        ).toEqual({ storage: 101, api: 102 });
        expect(
            await artifacts.read(IssueArtifactKind.CreatedIssueDependencies),
        ).toEqual({ storage: [], api: [101] });
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
            codexClient((value) => (prompt = value)),
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
        const state = relationshipStub();
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
            codexClient(),
            octokit,
            artifacts,
            discoveredChildren,
            state.relationships,
        );
        expect(outcome).toEqual({
            kind: IssueExecutionOutcomeKind.Decomposed,
            childIssueNumbers: [101, 102],
        });
        expect(createCount).toBe(0);
        expect(
            await artifacts.read(IssueArtifactKind.CreatedIssueNumbers),
        ).toEqual({ storage: 101, api: 102 });
        // Recovered children are still attached natively and dependency edges
        // are created without duplicating issues.
        expect(state.log).toContainEqual({
            method: "attach",
            parent: 42,
            child: 101,
        });
        expect(state.log).toContainEqual({
            method: "attach",
            parent: 42,
            child: 102,
        });
        expect(state.log).toContainEqual({
            method: "dependency",
            issue: 102,
            blocker: 101,
        });
    });

    test("leaves the original open when child linking fails, then resumes safely without closing", async () => {
        let originalUpdated = false;
        let createCount = 0;
        let failLink = true;
        const state = relationshipStub();
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
        await expect(
            run(codexClient(), octokit, artifacts, [], state.relationships),
        ).rejects.toThrow("recovery is required");
        expect(originalUpdated).toBe(false);
        failLink = false;
        await run(codexClient(), octokit, artifacts, [], state.relationships);
        expect(createCount).toBe(2);
        expect(originalUpdated).toBe(true);
        expect(
            state.log.filter((entry) => entry.method === "close").length,
        ).toBe(0);
    });

    test("reconciles already-attached native sub-issues without re-attaching", async () => {
        const state = relationshipStub();
        state.attached.set(42, new Set([101, 102]));
        const artifacts = await makeIssueArtifactStore(42);
        await artifacts.write(
            IssueArtifactKind.IssueBreakdownDecision,
            breakdown,
        );
        await artifacts.write(IssueArtifactKind.CreatedIssueNumbers, {
            storage: 101,
            api: 102,
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
                        throw new Error("must not create");
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
        await run(codexClient(), octokit, artifacts, [], state.relationships);
        expect(state.log.filter((entry) => entry.method === "attach")).toEqual(
            [],
        );
    });

    test("halts when a child is natively attached to the wrong parent", async () => {
        const state = relationshipStub();
        state.attached.set(7, new Set([101]));
        const artifacts = await makeIssueArtifactStore(42);
        await artifacts.write(
            IssueArtifactKind.IssueBreakdownDecision,
            breakdown,
        );
        const octokit = {
            rest: {
                issues: {
                    get: async (parameters: Record<string, unknown>) =>
                        issueResponse(
                            Number(parameters.issue_number),
                            "Original",
                            "Original",
                        ),
                    create: async (parameters: Record<string, unknown>) =>
                        issueResponse(
                            parameters.title === "Migrate storage" ? 101 : 102,
                            "Child",
                            "Child",
                        ),
                    update: async (parameters: Record<string, unknown>) =>
                        issueResponse(
                            Number(parameters.issue_number),
                            "Updated",
                            "Updated",
                        ),
                },
            },
        } as unknown as Octokit;
        await expect(
            run(codexClient(), octokit, artifacts, [], state.relationships),
        ).rejects.toThrow("recovery is required");
    });

    test("halts when a native sub-issue is attached to the wrong parent", async () => {
        const artifacts = await makeIssueArtifactStore(42);
        await artifacts.write(
            IssueArtifactKind.IssueBreakdownDecision,
            breakdown,
        );
        const octokit = {
            rest: {
                issues: {
                    get: async (parameters: Record<string, unknown>) =>
                        issueResponse(
                            Number(parameters.issue_number),
                            "Original",
                            "Original",
                        ),
                    create: async (parameters: Record<string, unknown>) =>
                        issueResponse(
                            parameters.title === "Migrate storage" ? 101 : 102,
                            "Child",
                            "Child",
                        ),
                    update: async (parameters: Record<string, unknown>) =>
                        issueResponse(
                            Number(parameters.issue_number),
                            "Updated",
                            "Updated",
                        ),
                },
            },
        } as unknown as Octokit;
        const nativeConflict: GitHubIssueRelationshipService = {
            listSubIssues: async () => [
                {
                    ...plainIssue(102),
                    body: '<!-- ralphie:decomposition root=42 parent=7 key="api" depth=1 -->',
                },
            ],
            parentOf: async () => undefined,
            attachSubIssue: async () => {},
            listBlockedBy: async () => [],
            addBlockedBy: async () => {},
        };
        await expect(
            run(codexClient(), octokit, artifacts, [], nativeConflict),
        ).rejects.toThrow("ambiguous");
    });
});