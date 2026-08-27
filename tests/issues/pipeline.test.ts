import { describe, expect, test } from "bun:test";
import {
    type GitIssueAction,
    GitIssueOutput,
} from "../../src/git/issue-task.ts";
import type { GitHubIssue } from "../../src/github/issues.ts";
import {
    type GitHubIssueAction,
    IssueLinkStrategy,
} from "../../src/github/issue-task.ts";
import {
    PiSessionContext,
    type PiSessionPurpose,
    type StructuredOutputName,
} from "../../src/agent/session.ts";
import { DEFAULT_PI_AGENT } from "../../src/agent/model.ts";
import { ComplexityLevel, ReviewVerdict } from "../../src/issues/decisions.ts";
import {
    IssuePipelineLive,
    selectIssues,
    selectWorkflow,
    selectWorkflowByKind,
} from "../../src/issues/pipeline.ts";
import {
    CheckoutRestorePoint,
    IssueQueueResumeStrategy,
    type IssueStageKind,
    type IssueWorkflowKind,
    REVIEW_ITERATION_LIMIT,
    ReviewLoopExhaustion,
} from "../../src/issues/stage.ts";

const issues: GitHubIssue[] = [
    {
        number: 1,
        title: "One",
        url: "issue/1",
        body: null,
        labels: [],
    },
    {
        number: 2,
        title: "Two",
        url: "issue/2",
        body: null,
        labels: [],
    },
    {
        number: 3,
        title: "Three",
        url: "issue/3",
        body: null,
        labels: [],
    },
];

const makePlan = () =>
    IssuePipelineLive().plan({
        issue: issues[0]!,
        repositoryPath: "/workspace/repository",
        targetBranch: "main",
        pi: {
            agent: DEFAULT_PI_AGENT,
        },
    });

describe("issue pipeline", () => {
    test("assesses complexity and works directly on the requested branch", async () => {
        const plan = await makePlan();

        expect(plan.targetBranch).toBe("main");
        expect(plan.pi).toEqual({
            agent: DEFAULT_PI_AGENT,
        });
        expect(plan).not.toHaveProperty("issueBranch");
        expect(plan.assessment).toEqual({
            kind: "pi-session",
            purpose: "assess-complexity",
            output: "complexity-decision",
        });
    });

    test("routes complexity 0-3 through the bounded review workflow", async () => {
        const plan = await makePlan();

        for (const complexity of [0, 1, 2, 3]) {
            expect(selectWorkflow(plan, complexity)?.kind).toBe(
                "implementation",
            );
        }

        expect(selectWorkflow(plan, 3)?.stages).toEqual([
            {
                kind: "git-task",
                action: "capture-issue-base",
                output: GitIssueOutput,
            },
            {
                kind: "pi-session",
                purpose: "implement",
            },
            {
                kind: "review-loop",
                maxIterations: REVIEW_ITERATION_LIMIT,
                onExhausted: {
                    action: ReviewLoopExhaustion,
                    preserveDiagnostics: true,
                    restore: CheckoutRestorePoint,
                    resume: IssueQueueResumeStrategy,
                },
                convergeWhen: {
                    output: "review-decision",
                    verdict: ReviewVerdict.Approved,
                },
                stageChanges: {
                    kind: "git-task",
                    action: "stage-all",
                },
                review: {
                    kind: "pi-session",
                    purpose: "review-diff",
                    output: "review-decision",
                },
                onChangesRequested: {
                    kind: "pi-session",
                    purpose: "address-review",
                    context: PiSessionContext,
                    input: "review-decision",
                },
            },
            {
                kind: "pi-session",
                purpose: "generate-commit-message",
                output: "commit-message-decision",
            },
            {
                kind: "git-task",
                action: "commit",
                messageFrom: "commit-message-decision",
            },
            {
                kind: "git-task",
                action: "push",
            },
        ]);
    });

    test("routes complexity 4-5 through dependency-aware decomposition", async () => {
        const plan = await makePlan();

        for (const complexity of [4, 5]) {
            expect(selectWorkflow(plan, complexity)?.kind).toBe(
                "decomposition",
            );
        }
        expect(selectWorkflow(plan, 4)?.stages).toEqual([
            {
                kind: "pi-session",
                purpose: "decompose-issue",
                output: "issue-breakdown-decision",
            },
            {
                kind: "github-task",
                action: "create-breakdown-issues",
                input: "issue-breakdown-decision",
                links: IssueLinkStrategy,
                includeDependencies: true,
            },
            {
                kind: "github-task",
                action: "rewrite-original-as-duplicate",
                input: "issue-breakdown-decision",
            },
            {
                kind: "github-task",
                action: "close-original-as-duplicate",
            },
        ]);
        expect(selectWorkflowByKind(plan, "decomposition")?.kind).toBe(
            "decomposition",
        );
    });

    test("does not route invalid complexity values", async () => {
        const plan = await makePlan();

        expect(selectWorkflow(plan, -1)).toBeUndefined();
        expect(selectWorkflow(plan, 2.5)).toBeUndefined();
        expect(selectWorkflow(plan, 6)).toBeUndefined();
    });

    test("selects all issues by default", () => {
        expect(selectIssues(issues)).toEqual(issues);
    });

    test("honors the maximum issue count", () => {
        expect(selectIssues(issues, 2)).toEqual(issues.slice(0, 2));
    });
});