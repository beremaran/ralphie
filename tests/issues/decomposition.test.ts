import { describe, expect, test } from "bun:test";

import type { AgentSessions } from "../../src/agent/sessions.ts";
import type { GitHubIssue } from "../../src/github/domain.ts";
import type {
    GitHubIssueMutationService,
    GitHubIssueRelationshipService,
    GitHubIssuesService,
} from "../../src/github/ports.ts";
import type {
    GitRepositoryInvariant,
    GitRepositoryInvariantService,
} from "../../src/git/ports.ts";
import type { HarnessService } from "../../src/harness/ports.ts";
import {
    IssueArtifactKind,
    makeIssueArtifactStore,
} from "../../src/issues/app/artifacts.ts";
import { makeDecompositionExecutorService } from "../../src/issues/app/decomposition-executor.ts";
import {
    IssueExecutionOutcomeKind,
    type IssueExecutionContext,
} from "../../src/issues/app/execution-model.ts";
import type { IssueBreakdownDecision } from "../../src/issues/domain/decisions.ts";
import { sessionsFor } from "../shared/agent-sessions.ts";
import { makeTestProgressRecorder } from "../shared/progress-recorder.ts";
import { testLayout } from "../shared/test-values.ts";

const parent: GitHubIssue = {
    number: 42,
    title: "Large parent",
    url: "https://github.com/owner/repo/issues/42",
    body: "Original parent body.",
    labels: ["ready-for-agent"],
    state: "open",
    updatedAt: "2026-08-28T00:00:00.000Z",
    comments: [],
    commentCount: 0,
    commentVersion: "2026-08-28T00:00:00.000Z",
};

const invariant: GitRepositoryInvariant = {
    branch: "develop",
    head: "a".repeat(40),
};

const breakdown: IssueBreakdownDecision = {
    rationale: "Split by layer of behaviour.",
    issues: [
        {
            key: "second",
            title: "Second slice",
            whatToBuild: "Build the second slice.",
            acceptanceCriteria: ["Second works.", "Second is tested."],
            dependsOn: ["first"],
        },
        {
            key: "first",
            title: "First slice",
            whatToBuild: "Build the first slice.",
            acceptanceCriteria: ["First works."],
            dependsOn: [],
        },
    ],
};

type Created = {
    readonly number: number;
    readonly title: string;
    readonly body: string;
    readonly labels: ReadonlyArray<string> | undefined;
};

const setup = async (
    options: {
        readonly existing?: ReadonlyArray<GitHubIssue>;
        readonly agentPrompts?: string[];
        readonly parentLabels?: ReadonlyArray<string>;
        readonly intakeLabels?: ReadonlyArray<string>;
    } = {},
) => {
    const created: Created[] = [];
    const calls: string[] = [];
    const attached: Array<[number, number]> = [];
    const blockedBy: Array<[number, number]> = [];
    let next = 100;
    const mutations: GitHubIssueMutationService = {
        create: async (_repository, input) => {
            next += 1;
            created.push({
                number: next,
                title: input.title,
                body: input.body,
                labels: input.labels,
            });
            calls.push(`create:${next}`);
            return { ...parent, number: next, title: input.title };
        },
        update: async (_repository, issueNumber) => {
            calls.push(`update:${issueNumber}`);
            return parent;
        },
        close: async (_repository, issueNumber) => {
            calls.push(`close:${issueNumber}`);
            return parent;
        },
        comment: async (_repository, issueNumber) => {
            calls.push(`comment:${issueNumber}`);
        },
    };
    const issues: GitHubIssuesService = {
        listOpen: async () => [],
        refresh: async () => parent,
        listDecompositionChildren: async () =>
            (options.existing ?? []).map((issue) => ({
                ...issue,
                decompositionKey: /key="([^"]+)"/.exec(issue.body ?? "")![1]!,
            })),
    };
    const relationships: GitHubIssueRelationshipService = {
        listSubIssues: async () => [],
        parentOf: async () => undefined,
        attachSubIssue: async (_repository, parentNumber, childNumber) => {
            attached.push([parentNumber, childNumber]);
        },
        listBlockedBy: async () => [],
        addBlockedBy: async (_repository, childNumber, blockerNumber) => {
            blockedBy.push([childNumber, blockerNumber]);
        },
    };
    const harness: HarnessService = {
        run: (async (request: { readonly prompt: string }) => {
            options.agentPrompts?.push(request.prompt);
            return {
                ok: true,
                harnessSessionID: "s1",
                text: "",
                value: { result: breakdown },
            };
        }) as unknown as HarnessService["run"],
    };
    const agent: AgentSessions = sessionsFor(harness);
    const repositoryInvariant: GitRepositoryInvariantService = {
        capture: async () => invariant,
        verify: async () => {},
    };
    const context: IssueExecutionContext = {
        issue:
            options.parentLabels === undefined
                ? parent
                : { ...parent, labels: options.parentLabels },
        ...(options.intakeLabels === undefined
            ? {}
            : { intakeLabels: options.intakeLabels }),
        repository: "owner/repo",
        repositoryPath: "/work/repository",
        targetBranch: "develop",
        workspace: "/work/workspace",
        runId: "test-run",
        runLayout: testLayout("/work/workspace", "test-run"),
        agent,
        repositoryInvariant,
    };
    const store = await makeIssueArtifactStore(parent.number);
    const executor = makeDecompositionExecutorService(
        mutations,
        issues,
        relationships,
        makeTestProgressRecorder([]),
        undefined,
        "agent-ready",
    );
    return { executor, store, context, created, calls, attached, blockedBy };
};

describe("decomposition publishing", () => {
    test("children inherit the parent's intake labels plus the agent-ready label", async () => {
        const harness = await setup({
            parentLabels: ["Agent-Ready", "bug", "backend", "unrelated"],
            intakeLabels: ["agent-ready", "bug", "backend", "frontend"],
        });
        await harness.store.write(
            IssueArtifactKind.IssueBreakdownDecision,
            breakdown,
        );
        await harness.executor.execute({
            context: harness.context,
            artifacts: harness.store,
        });
        expect(harness.created.map(({ labels }) => labels)).toEqual([
            ["agent-ready", "bug", "backend"],
            ["agent-ready", "bug", "backend"],
        ]);
    });

    test("publishes children in the ticket template with the label and native links, blockers first", async () => {
        const harness = await setup();
        await harness.store.write(
            IssueArtifactKind.IssueBreakdownDecision,
            breakdown,
        );
        const outcome = await harness.executor.execute({
            context: harness.context,
            artifacts: harness.store,
        });

        expect(harness.created.map(({ title }) => title)).toEqual([
            "First slice",
            "Second slice",
        ]);
        expect(
            harness.created.every(
                ({ labels }) => labels?.[0] === "agent-ready",
            ),
        ).toBe(true);
        expect(harness.created[1]?.body).toContain(
            '<!-- ralphie:decomposition root=42 parent=42 key="second" depth=1 -->',
        );
        expect(harness.created[1]?.body).toContain("## Parent\n\n#42");
        expect(harness.created[1]?.body).toContain(
            "## What to build\n\nBuild the second slice.",
        );
        expect(harness.created[1]?.body).toContain(
            "## Acceptance criteria\n\n- [ ] Second works.\n- [ ] Second is tested.",
        );
        expect(harness.created[1]?.body).toContain("## Blocked by\n\n- #101");
        expect(harness.created[0]?.body).toContain(
            "## Blocked by\n\nNone (can start immediately)",
        );
        expect(harness.attached).toEqual([
            [42, 102],
            [42, 101],
        ]);
        expect(harness.blockedBy).toEqual([[102, 101]]);
        expect(outcome).toEqual({
            kind: IssueExecutionOutcomeKind.Decomposed,
            childIssueNumbers: [102, 101],
        });
    });

    test("never modifies, comments on or closes the parent", async () => {
        const harness = await setup();
        await harness.store.write(
            IssueArtifactKind.IssueBreakdownDecision,
            breakdown,
        );
        await harness.executor.execute({
            context: harness.context,
            artifacts: harness.store,
        });
        expect(
            harness.calls.filter((call) => !call.startsWith("create:")),
        ).toEqual([]);
    });

    test("reuses children that already exist by marker", async () => {
        const existing: GitHubIssue = {
            ...parent,
            number: 77,
            title: "First slice",
            body: '<!-- ralphie:decomposition root=42 parent=42 key="first" depth=1 -->\n\nBody.',
        };
        const harness = await setup({ existing: [existing] });
        await harness.store.write(
            IssueArtifactKind.IssueBreakdownDecision,
            breakdown,
        );
        const outcome = await harness.executor.execute({
            context: harness.context,
            artifacts: harness.store,
        });
        expect(harness.created.map(({ title }) => title)).toEqual([
            "Second slice",
        ]);
        expect(harness.created[0]?.body).toContain("- #77");
        expect(outcome).toEqual({
            kind: IssueExecutionOutcomeKind.Decomposed,
            childIssueNumbers: [101, 77],
        });
    });

    test("asks the decomposer to run /to-tickets with the skip-quiz and no-publish overlay", async () => {
        const prompts: string[] = [];
        const harness = await setup({ agentPrompts: prompts });
        await harness.executor.execute({
            context: harness.context,
            artifacts: harness.store,
        });
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toContain("/to-tickets");
        expect(prompts[0]).toContain("Skip the quiz");
        expect(prompts[0]).toContain("Do not publish anything");
        expect(prompts[0]).toContain("fit one agent session");
    });
});