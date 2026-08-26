import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { GitIssueAction, GitIssueOutput } from "../git/issue-task.ts";
import type { GitHubIssue } from "../github/issues.ts";
import { GitHubIssueAction, IssueLinkStrategy } from "../github/issue-task.ts";
import {
  PiSessionContext,
  PiSessionPurpose,
  StructuredOutputName,
} from "../agent/session.ts";
import { DEFAULT_PI_AGENT } from "../agent/model.ts";
import { ComplexityLevel, ReviewVerdict } from "./decisions.ts";
import {
  IssuePipeline,
  IssuePipelineLive,
  selectIssues,
  selectWorkflow,
  selectWorkflowByKind,
} from "./pipeline.ts";
import {
  CheckoutRestorePoint,
  IssueQueueResumeStrategy,
  IssueStageKind,
  IssueWorkflowKind,
  REVIEW_ITERATION_LIMIT,
  ReviewLoopExhaustion,
} from "./stage.ts";

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
  Effect.gen(function* () {
    const pipeline = yield* IssuePipeline;
    return yield* pipeline.plan({
      issue: issues[0]!,
      repositoryPath: "/workspace/repository",
      targetBranch: "main",
      pi: {
        agent: DEFAULT_PI_AGENT,
      },
    });
  }).pipe(Effect.provide(IssuePipelineLive), Effect.runPromise);

describe("issue pipeline", () => {
  test("assesses complexity and works directly on the requested branch", async () => {
    const plan = await makePlan();

    expect(plan.targetBranch).toBe("main");
    expect(plan.pi).toEqual({
      agent: DEFAULT_PI_AGENT,
    });
    expect(plan).not.toHaveProperty("issueBranch");
    expect(plan.assessment).toEqual({
      kind: IssueStageKind.PiSession,
      purpose: PiSessionPurpose.AssessComplexity,
      output: StructuredOutputName.ComplexityDecision,
    });
  });

  test("routes complexity 0-3 through the bounded review workflow", async () => {
    const plan = await makePlan();

    for (const complexity of [0, 1, 2, 3]) {
      expect(selectWorkflow(plan, complexity)?.kind).toBe(
        IssueWorkflowKind.Implementation,
      );
    }

    expect(selectWorkflow(plan, 3)?.stages).toEqual([
      {
        kind: IssueStageKind.GitTask,
        action: GitIssueAction.CaptureIssueBase,
        output: GitIssueOutput.IssueBase,
      },
      {
        kind: IssueStageKind.PiSession,
        purpose: PiSessionPurpose.Implement,
      },
      {
        kind: IssueStageKind.ReviewLoop,
        maxIterations: REVIEW_ITERATION_LIMIT,
        onExhausted: {
          action: ReviewLoopExhaustion.EscalateToDecomposition,
          preserveDiagnostics: true,
          restore: CheckoutRestorePoint.IssueBase,
          resume: IssueQueueResumeStrategy.RefreshOpenIssues,
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
          context: PiSessionContext.Fresh,
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
    ]);
  });

  test("routes complexity 4-5 through dependency-aware decomposition", async () => {
    const plan = await makePlan();

    for (const complexity of [4, 5]) {
      expect(selectWorkflow(plan, complexity)?.kind).toBe(
        IssueWorkflowKind.Decomposition,
      );
    }
    expect(selectWorkflow(plan, 4)?.stages).toEqual([
      {
        kind: IssueStageKind.PiSession,
        purpose: PiSessionPurpose.DecomposeIssue,
        output: StructuredOutputName.IssueBreakdownDecision,
      },
      {
        kind: IssueStageKind.GitHubTask,
        action: GitHubIssueAction.CreateBreakdownIssues,
        input: StructuredOutputName.IssueBreakdownDecision,
        links: IssueLinkStrategy.OriginalAndSiblings,
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
    ]);
    expect(
      selectWorkflowByKind(plan, IssueWorkflowKind.Decomposition)?.kind,
    ).toBe(IssueWorkflowKind.Decomposition);
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