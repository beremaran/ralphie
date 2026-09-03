import {
    type GitIssueAction,
    type GitIssueStage,
    GitIssueOutput,
} from "../git/issue-task.ts";
import type { GitHubIssue } from "../github/issues.ts";
import {
    type GitHubIssueAction,
    type GitHubIssueStage,
    IssueLinkStrategy,
} from "../github/issue-task.ts";
import {
    AgentSessionContext,
    type AgentSessionPurpose,
    type AgentSessionStage,
    type StructuredOutputName,
} from "../agent/session.ts";
import type { AgentSelection } from "../agent/model.ts";
import { ComplexityLevel, ReviewVerdict } from "./decisions.ts";
import {
    CheckoutRestorePoint,
    type IssueStageKind,
    IssueQueueResumeStrategy,
    type IssueWorkflowKind,
    REVIEW_ITERATION_LIMIT,
    ReviewLoopExhaustion,
} from "./stage.ts";

export type IssueAtomicStage =
    | GitIssueStage
    | GitHubIssueStage
    | AgentSessionStage;

export type ReviewLoopStage = {
    readonly kind: "review-loop";
    readonly maxIterations: typeof REVIEW_ITERATION_LIMIT;
    readonly onExhausted: {
        readonly action: ReviewLoopExhaustion;
        readonly preserveDiagnostics: true;
        readonly restore: CheckoutRestorePoint;
        readonly resume: IssueQueueResumeStrategy;
    };
    readonly convergeWhen: {
        readonly output: "review-decision";
        readonly verdict: ReviewVerdict.Approved;
    };
    readonly stageChanges: GitIssueStage;
    readonly review: AgentSessionStage;
    readonly onChangesRequested: AgentSessionStage;
};

export type IssueStage = IssueAtomicStage | ReviewLoopStage;

export type IssueWorkflow = {
    readonly kind: IssueWorkflowKind;
    readonly complexity: {
        readonly min: ComplexityLevel;
        readonly max: ComplexityLevel;
    };
    readonly stages: ReadonlyArray<IssueStage>;
};

export type IssueExecutionPlan = {
    readonly issue: GitHubIssue;
    readonly repositoryPath: string;
    readonly targetBranch: string;
    readonly pi: AgentSelection;
    readonly assessment: AgentSessionStage;
    readonly workflows: readonly [IssueWorkflow, IssueWorkflow];
};

export type IssuePipelineService = {
    readonly plan: (input: {
        readonly issue: GitHubIssue;
        readonly repositoryPath: string;
        readonly targetBranch: string;
        readonly pi: AgentSelection;
    }) => Promise<IssueExecutionPlan>;
};

const assessment: AgentSessionStage = {
    kind: "agent-session",
    purpose: "assess-complexity",
    output: "complexity-decision",
};

const implementationWorkflow: IssueWorkflow = {
    kind: "implementation",
    complexity: {
        min: ComplexityLevel.Level0,
        max: ComplexityLevel.Level3,
    },
    stages: [
        {
            kind: "git-task",
            action: "capture-issue-base",
            output: GitIssueOutput,
        },
        {
            kind: "agent-session",
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
                kind: "agent-session",
                purpose: "review-diff",
                output: "review-decision",
            },
            onChangesRequested: {
                kind: "agent-session",
                purpose: "address-review",
                context: AgentSessionContext,
                input: "review-decision",
            },
        },
        {
            kind: "agent-session",
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
    ],
};

const decompositionWorkflow: IssueWorkflow = {
    kind: "decomposition",
    complexity: {
        min: ComplexityLevel.Level4,
        max: ComplexityLevel.Level5,
    },
    stages: [
        {
            kind: "agent-session",
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
            action: "attach-native-sub-issues",
        },
        {
            kind: "github-task",
            action: "create-native-dependencies",
            input: "issue-breakdown-decision",
        },
        {
            kind: "github-task",
            action: "rewrite-original",
            input: "issue-breakdown-decision",
        },
    ],
};

export const makeIssuePipelineService = (): IssuePipelineService => ({
    plan: async ({ issue, repositoryPath, targetBranch, pi }) => ({
        issue,
        repositoryPath,
        targetBranch,
        pi,
        assessment,
        workflows: [implementationWorkflow, decompositionWorkflow],
    }),
});

export const IssuePipelineLive = makeIssuePipelineService;

export const selectWorkflow = (
    plan: IssueExecutionPlan,
    complexity: number,
): IssueWorkflow | undefined =>
    Number.isInteger(complexity)
        ? plan.workflows.find(
              (workflow) =>
                  complexity >= workflow.complexity.min &&
                  complexity <= workflow.complexity.max,
          )
        : undefined;

export const selectWorkflowByKind = (
    plan: IssueExecutionPlan,
    kind: IssueWorkflowKind,
): IssueWorkflow | undefined =>
    plan.workflows.find((workflow) => workflow.kind === kind);

export const selectIssues = (
    issues: ReadonlyArray<GitHubIssue>,
    maxIssues?: number,
): ReadonlyArray<GitHubIssue> =>
    maxIssues === undefined ? issues : issues.slice(0, maxIssues);