import {
    GitIssueAction,
    type GitIssueStage,
    GitIssueOutput,
} from "../git/issue-task.ts";
import type { GitHubIssue } from "../github/issues.ts";
import {
    GitHubIssueAction,
    type GitHubIssueStage,
    IssueLinkStrategy,
} from "../github/issue-task.ts";
import {
    PiSessionContext,
    PiSessionPurpose,
    type PiSessionStage,
    StructuredOutputName,
} from "../agent/session.ts";
import type { PiSelection } from "../agent/model.ts";
import { ComplexityLevel, ReviewVerdict } from "./decisions.ts";
import {
    CheckoutRestorePoint,
    IssueStageKind,
    IssueQueueResumeStrategy,
    IssueWorkflowKind,
    REVIEW_ITERATION_LIMIT,
    ReviewLoopExhaustion,
} from "./stage.ts";

export type IssueAtomicStage =
    | GitIssueStage
    | GitHubIssueStage
    | PiSessionStage;

export type ReviewLoopStage = {
    readonly kind: IssueStageKind.ReviewLoop;
    readonly maxIterations: typeof REVIEW_ITERATION_LIMIT;
    readonly onExhausted: {
        readonly action: ReviewLoopExhaustion;
        readonly preserveDiagnostics: true;
        readonly restore: CheckoutRestorePoint;
        readonly resume: IssueQueueResumeStrategy;
    };
    readonly convergeWhen: {
        readonly output: StructuredOutputName.ReviewDecision;
        readonly verdict: ReviewVerdict.Approved;
    };
    readonly stageChanges: GitIssueStage;
    readonly review: PiSessionStage;
    readonly onChangesRequested: PiSessionStage;
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
    readonly pi: PiSelection;
    readonly assessment: PiSessionStage;
    readonly workflows: readonly [IssueWorkflow, IssueWorkflow];
};

export type IssuePipelineService = {
    readonly plan: (input: {
        readonly issue: GitHubIssue;
        readonly repositoryPath: string;
        readonly targetBranch: string;
        readonly pi: PiSelection;
    }) => Promise<IssueExecutionPlan>;
};

const assessment: PiSessionStage = {
    kind: IssueStageKind.PiSession,
    purpose: PiSessionPurpose.AssessComplexity,
    output: StructuredOutputName.ComplexityDecision,
};

const implementationWorkflow: IssueWorkflow = {
    kind: IssueWorkflowKind.Implementation,
    complexity: {
        min: ComplexityLevel.Level0,
        max: ComplexityLevel.Level3,
    },
    stages: [
        {
            kind: IssueStageKind.GitTask,
            action: GitIssueAction.CaptureIssueBase,
            output: GitIssueOutput,
        },
        {
            kind: IssueStageKind.PiSession,
            purpose: PiSessionPurpose.Implement,
        },
        {
            kind: IssueStageKind.ReviewLoop,
            maxIterations: REVIEW_ITERATION_LIMIT,
            onExhausted: {
                action: ReviewLoopExhaustion,
                preserveDiagnostics: true,
                restore: CheckoutRestorePoint,
                resume: IssueQueueResumeStrategy,
            },
            convergeWhen: {
                output: StructuredOutputName.ReviewDecision,
                verdict: ReviewVerdict.Approved,
            },
            stageChanges: {
                kind: IssueStageKind.GitTask,
                action: GitIssueAction.StageAll,
            },
            review: {
                kind: IssueStageKind.PiSession,
                purpose: PiSessionPurpose.ReviewDiff,
                output: StructuredOutputName.ReviewDecision,
            },
            onChangesRequested: {
                kind: IssueStageKind.PiSession,
                purpose: PiSessionPurpose.AddressReview,
                context: PiSessionContext,
                input: StructuredOutputName.ReviewDecision,
            },
        },
        {
            kind: IssueStageKind.PiSession,
            purpose: PiSessionPurpose.GenerateCommitMessage,
            output: StructuredOutputName.CommitMessageDecision,
        },
        {
            kind: IssueStageKind.GitTask,
            action: GitIssueAction.Commit,
            messageFrom: StructuredOutputName.CommitMessageDecision,
        },
        {
            kind: IssueStageKind.GitTask,
            action: GitIssueAction.Push,
        },
    ],
};

const decompositionWorkflow: IssueWorkflow = {
    kind: IssueWorkflowKind.Decomposition,
    complexity: {
        min: ComplexityLevel.Level4,
        max: ComplexityLevel.Level5,
    },
    stages: [
        {
            kind: IssueStageKind.PiSession,
            purpose: PiSessionPurpose.DecomposeIssue,
            output: StructuredOutputName.IssueBreakdownDecision,
        },
        {
            kind: IssueStageKind.GitHubTask,
            action: GitHubIssueAction.CreateBreakdownIssues,
            input: StructuredOutputName.IssueBreakdownDecision,
            links: IssueLinkStrategy,
            includeDependencies: true,
        },
        {
            kind: IssueStageKind.GitHubTask,
            action: GitHubIssueAction.RewriteOriginalAsDuplicate,
            input: StructuredOutputName.IssueBreakdownDecision,
        },
        {
            kind: IssueStageKind.GitHubTask,
            action: GitHubIssueAction.CloseOriginalAsDuplicate,
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