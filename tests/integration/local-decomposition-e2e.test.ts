import { expect, test } from "bun:test";
import type { PiClient } from "../../src/pi/client.ts";
import type { Octokit } from "octokit";

import {
    IssueArtifactKind,
    makeIssueArtifactStore,
} from "../../src/issues/artifacts.ts";
import {
    ComplexityLevel,
    GroundingDisposition,
    ImplementationComplexityLevel,
} from "../../src/issues/decisions.ts";
import { makeDecompositionExecutorService } from "../../src/issues/decomposition-executor.ts";
import {
    IssueExecutionOutcomeKind,
    type IssueExecutionContext,
} from "../../src/issues/execution.ts";
import { makeIssueExecutorService } from "../../src/issues/executor.ts";
import { makeGitHubIssueMutationsService } from "../../src/github/issue-mutations.ts";
import { makeGitHubIssuesService } from "../../src/github/issues.ts";
import { makeGitHubIssueRelationshipService } from "../../src/github/issue-relationships.ts";
import { makePiSessionDiagnostics } from "../../src/agent/task-session.ts";
import {
    makeProgressRecorder,
    type ProgressUpdate,
} from "../../src/progress/progress.ts";

const breakdown = {
    rationale: "Separate storage migration from API adoption.",
    issues: [
        {
            key: "storage",
            title: "Migrate storage",
            body: "Move persistence behind the new storage interface.",
            estimatedComplexity: ImplementationComplexityLevel.Level2,
            dependsOn: [],
        },
        {
            key: "api",
            title: "Adopt storage API",
            body: "Update API consumers after storage migration.",
            estimatedComplexity: ImplementationComplexityLevel.Level1,
            dependsOn: ["storage"],
        },
    ],
};

type StoredIssue = {
    id: number;
    number: number;
    title: string;
    body: string;
    state: "open" | "closed";
    state_reason?: string;
    updated_at: string;
    comments: number;
    html_url: string;
    labels: ReadonlyArray<string>;
};

type RecordedRequest = {
    readonly method: "create" | "update" | "attach" | "dependency";
    readonly parameters: Record<string, unknown>;
};

const makeOctokit = () => {
    const issues = new Map<number, StoredIssue>([
        [
            42,
            {
                id: 1_000_042,
                number: 42,
                title: "Modernize persistence",
                body: "Preserve this original issue content.",
                state: "open",
                updated_at: "2026-08-28T00:00:00.000Z",
                comments: 0,
                html_url: "https://github.com/owner/repository/issues/42",
                labels: ["architecture"],
            },
        ],
    ]);
    const subIssues = new Map<number, Set<number>>();
    const blockedBy = new Map<number, Set<number>>();
    const requests: Array<RecordedRequest> = [];
    let nextIssueNumber = 101;
    const toResponse = (issue: StoredIssue) => ({ ...issue });
    const record = (
        method: RecordedRequest["method"],
        parameters: Record<string, unknown>,
    ) => requests.push({ method, parameters });
    const issueRecord = (issue: StoredIssue) => ({
        ...toResponse(issue),
        labels: issue.labels,
    });
    const unknownIssue = (parameters: Record<string, unknown>) => {
        const issue = issues.get(Number(parameters.issue_number));
        if (!issue)
            throw new Error(`Unknown issue ${String(parameters.issue_number)}`);
        return issue;
    };

    const handleParent = async (issueNumber: number) => {
        for (const [parentNumber, children] of subIssues) {
            if (children.has(issueNumber)) {
                const parent = issues.get(parentNumber);
                if (parent) return { data: issueRecord(parent) };
            }
        }
        throw { status: 404 };
    };

    const handleSubIssues = async (
        route: string,
        parameters: Record<string, unknown>,
        issueNumber: number,
    ) => {
        if (route.startsWith("GET")) {
            const children = [...(subIssues.get(issueNumber) ?? [])]
                .map((number) => issues.get(number))
                .filter((issue): issue is StoredIssue => issue !== undefined)
                .map(issueRecord);
            return { data: children };
        }
        const childId = Number(parameters.sub_issue_id);
        const child = [...issues.values()].find(
            (issue) => issue.id === childId,
        );
        if (!child) throw { status: 404 };
        const children = subIssues.get(issueNumber) ?? new Set<number>();
        children.add(child.number);
        subIssues.set(issueNumber, children);
        record("attach", { parent: issueNumber, child: child.number });
        return {
            data: issueRecord(unknownIssue({ issue_number: issueNumber })),
        };
    };

    const handleDependencies = async (
        route: string,
        parameters: Record<string, unknown>,
        issueNumber: number,
    ) => {
        if (route.startsWith("GET")) {
            const blockers = [...(blockedBy.get(issueNumber) ?? [])]
                .map((number) => issues.get(number))
                .filter((issue): issue is StoredIssue => issue !== undefined)
                .map(issueRecord);
            return { data: blockers };
        }
        const blockerId = Number(parameters.issue_id);
        const blocker = [...issues.values()].find(
            (issue) => issue.id === blockerId,
        );
        if (!blocker) throw { status: 404 };
        const blockers = blockedBy.get(issueNumber) ?? new Set<number>();
        blockers.add(blocker.number);
        blockedBy.set(issueNumber, blockers);
        record("dependency", {
            issue: issueNumber,
            blocker: blocker.number,
        });
        return {
            data: issueRecord(unknownIssue({ issue_number: issueNumber })),
        };
    };

    const request = async (
        route: string,
        parameters: Record<string, unknown>,
    ) => {
        const issueNumber = Number(parameters.issue_number);
        if (route.includes("/parent")) return await handleParent(issueNumber);
        if (route.includes("/sub_issues"))
            return await handleSubIssues(route, parameters, issueNumber);
        if (route.includes("/dependencies/blocked_by"))
            return await handleDependencies(route, parameters, issueNumber);
        throw { status: 404 };
    };

    const client = {
        rest: {
            issues: {
                listForRepo: Symbol("listForRepo"),
                get: async (parameters: Record<string, unknown>) => ({
                    data: toResponse(unknownIssue(parameters)),
                }),
                create: async (parameters: Record<string, unknown>) => {
                    const number = nextIssueNumber++;
                    const issue: StoredIssue = {
                        id: 1_000_000 + number,
                        number,
                        title: String(parameters.title),
                        body: String(parameters.body ?? ""),
                        state: "open",
                        updated_at: "2026-08-28T00:00:00.000Z",
                        comments: 0,
                        html_url: `https://github.com/owner/repository/issues/${number}`,
                        labels: [],
                    };
                    issues.set(number, issue);
                    record("create", parameters);
                    return { data: toResponse(issue) };
                },
                update: async (parameters: Record<string, unknown>) => {
                    const issue = unknownIssue(parameters);
                    if (parameters.title !== undefined)
                        issue.title = String(parameters.title);
                    if (parameters.body !== undefined)
                        issue.body = String(parameters.body);
                    if (parameters.state === "closed") issue.state = "closed";
                    if (parameters.state_reason !== undefined)
                        issue.state_reason = String(parameters.state_reason);
                    record("update", parameters);
                    return { data: toResponse(issue) };
                },
            },
        },
        paginate: async () => [...issues.values()].map(toResponse),
        request,
    } as unknown as Octokit;
    return { client, issues, requests, subIssues, blockedBy };
};

const pi = {
    session: {
        create: async () => ({ data: { id: "decomposition-session" } }),
        prompt: async () => ({
            data: { info: { structured: breakdown }, parts: [] },
        }),
    },
} as unknown as PiClient;

const context = (octokit: Octokit): IssueExecutionContext => ({
    issue: {
        number: 42,
        title: "Modernize persistence",
        url: "https://github.com/owner/repository/issues/42",
        body: "Preserve this original issue content.",
        labels: ["architecture"],
        state: "open",
        updatedAt: "2026-08-28T00:00:00.000Z",
        comments: [],
        commentCount: 0,
        commentVersion: "2026-08-28T00:00:00.000Z",
    },
    repository: "owner/repository",
    repositoryPath: "/tmp/ralphie-local-decomposition",
    targetBranch: "main",
    workspace: "/tmp/ralphie-local-decomposition-workspace",
    runId: "local-decomposition-e2e",
    octokit,
    pi,
    piSelection: { agent: "build" },
    piDiagnostics: makePiSessionDiagnostics(() => "now"),
    repositoryInvariant: {
        capture: async () => ({ branch: "main", head: "abc123" }),
        verify: async () => {},
    },
});

test("runs the real decomposition workflow against a disposable in-memory GitHub", async () => {
    const fake = makeOctokit();
    const artifacts = await makeIssueArtifactStore(42);
    let assessmentCalls = 0;
    let implementationCalls = 0;
    const progressEvents: ProgressUpdate[] = [];
    const artifactService = { forIssue: async () => artifacts };
    const issues = makeGitHubIssuesService();
    const decomposition = makeDecompositionExecutorService(
        makeGitHubIssueMutationsService(),
        issues,
        makeGitHubIssueRelationshipService(),
        makeProgressRecorder(progressEvents),
    );
    const executor = makeIssueExecutorService(
        artifactService,
        {
            assess: async () => {
                assessmentCalls += 1;
                return {
                    decision: {
                        complexity: ComplexityLevel.Level4,
                        rationale: "This spans storage and API concerns.",
                    },
                    sessionID: "complexity-session",
                };
            },
        },
        {
            execute: async () => {
                implementationCalls += 1;
                throw new Error(
                    "implementation workflow must not run for complexity 4",
                );
            },
        },
        decomposition,
        {
            assess: async () => ({
                sessionID: "grounding-session",
                decision: { disposition: GroundingDisposition.Actionable },
            }),
        },
        {
            verify: async () => {
                throw new Error("resolution verification must not run");
            },
        },
    );
    const result = await executor.execute(context(fake.client));
    const mapping = await artifacts.read(IssueArtifactKind.CreatedIssueNumbers);
    const dependencyMapping = await artifacts.read(
        IssueArtifactKind.CreatedIssueDependencies,
    );

    expect(assessmentCalls).toBe(1);
    expect(implementationCalls).toBe(0);
    expect(result).toEqual({
        kind: IssueExecutionOutcomeKind.Decomposed,
        childIssueNumbers: [101, 102],
    });
    expect(mapping).toEqual({ storage: 101, api: 102 });
    expect(dependencyMapping).toEqual({ storage: [], api: [101] });
    expect(
        fake.requests.map(({ method, parameters }) => [method, parameters]),
    ).toEqual([
        ["create", expect.objectContaining({ title: "Migrate storage" })],
        ["create", expect.objectContaining({ title: "Adopt storage API" })],
        ["update", expect.objectContaining({ issue_number: 101 })],
        ["update", expect.objectContaining({ issue_number: 102 })],
        ["attach", expect.objectContaining({ parent: 42, child: 101 })],
        ["attach", expect.objectContaining({ parent: 42, child: 102 })],
        ["dependency", expect.objectContaining({ issue: 102, blocker: 101 })],
        ["update", expect.objectContaining({ issue_number: 42 })],
    ]);
    const storage = fake.issues.get(101)!;
    const api = fake.issues.get(102)!;
    const original = fake.issues.get(42)!;
    // Children keep the stable marker and dependency edges, but no longer
    // carry redundant parent/sibling/lineage lists in their bodies.
    expect(storage.body).toContain("root=42 parent=42");
    expect(storage.body).not.toContain("## Decomposition lineage");
    expect(storage.body).not.toContain("#42");
    expect(api.body).toContain("#101 (storage)");
    // Native hierarchy and dependencies exist on the fake GitHub.
    expect([...(fake.subIssues.get(42) ?? [])].sort()).toEqual([101, 102]);
    expect([...(fake.blockedBy.get(102) ?? [])]).toEqual([101]);
    // The decomposed parent stays open as the native tracking issue.
    expect(original.body).toContain("Preserve this original issue content.");
    expect(original.body).toContain("#101");
    expect(original.body).toContain("#102");
    expect(original.state).toBe("open");
    expect(original.state_reason).toBeUndefined();
    expect(progressEvents.length).toBeGreaterThan(0);
});