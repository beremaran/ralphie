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

const makeOctokit = () => {
    const issues = new Map<number, StoredIssue>([
        [
            42,
            {
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
    const requests: Array<{
        readonly method: "create" | "update";
        readonly parameters: Record<string, unknown>;
    }> = [];
    let nextIssueNumber = 101;
    const toResponse = (issue: StoredIssue) => ({
        ...issue,
        labels: issue.labels,
    });
    const client = {
        rest: {
            issues: {
                listForRepo: Symbol("listForRepo"),
                get: async (parameters: Record<string, unknown>) => {
                    const issue = issues.get(Number(parameters.issue_number));
                    if (!issue)
                        throw new Error(
                            `Unknown issue ${String(parameters.issue_number)}`,
                        );
                    return { data: toResponse(issue) };
                },
                create: async (parameters: Record<string, unknown>) => {
                    const number = nextIssueNumber++;
                    const issue: StoredIssue = {
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
                    requests.push({ method: "create", parameters });
                    return { data: toResponse(issue) };
                },
                update: async (parameters: Record<string, unknown>) => {
                    const number = Number(parameters.issue_number);
                    const issue = issues.get(number);
                    if (!issue) throw new Error(`Unknown issue ${number}`);
                    if (parameters.title !== undefined)
                        issue.title = String(parameters.title);
                    if (parameters.body !== undefined)
                        issue.body = String(parameters.body);
                    if (parameters.state === "closed") issue.state = "closed";
                    if (parameters.state_reason !== undefined)
                        issue.state_reason = String(parameters.state_reason);
                    requests.push({ method: "update", parameters });
                    return { data: toResponse(issue) };
                },
            },
        },
        paginate: async () => [...issues.values()].map(toResponse),
    } as unknown as Octokit;
    return { client, issues, requests };
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

    expect(assessmentCalls).toBe(1);
    expect(implementationCalls).toBe(0);
    expect(result).toEqual({
        kind: IssueExecutionOutcomeKind.Decomposed,
        childIssueNumbers: [101, 102],
    });
    expect(mapping).toEqual({ storage: 101, api: 102 });
    expect(
        fake.requests.map(({ method, parameters }) => [
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
    const storage = fake.issues.get(101)!;
    const api = fake.issues.get(102)!;
    const original = fake.issues.get(42)!;
    expect(storage.body).toContain("#42");
    expect(storage.body).toContain("#102");
    expect(api.body).toContain("#42");
    expect(api.body).toContain("#101");
    expect(original.body).toContain("Preserve this original issue content.");
    expect(original.body).toContain("#101");
    expect(original.body).toContain("#102");
    expect(original.state).toBe("closed");
    expect(original.state_reason).toBe("duplicate");
    expect(progressEvents.length).toBeGreaterThan(0);
});
