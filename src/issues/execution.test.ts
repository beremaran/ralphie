import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { makeOpenCodeSessionDiagnostics } from "../opencode/task-session.ts";

import {
  IssueCompletionKind,
  IssueExecutionOutcomeKind,
  type IssueExecutionOutcome,
  type IssueExecutionContext,
} from "./execution.ts";

describe("issue execution domain types", () => {
  test("exposes stable outcome discriminators", () => {
    expect(String(IssueExecutionOutcomeKind.Completed)).toBe("completed");
    expect(String(IssueExecutionOutcomeKind.Decomposed)).toBe("decomposed");
    expect(String(IssueExecutionOutcomeKind.Escalated)).toBe("escalated");
    expect(String(IssueExecutionOutcomeKind.Skipped)).toBe("skipped");
    expect(String(IssueExecutionOutcomeKind.Failed)).toBe("failed");
  });

  test("supports narrowing each outcome variant by kind", () => {
    const outcomes: ReadonlyArray<IssueExecutionOutcome> = [
      {
        kind: IssueExecutionOutcomeKind.Completed,
        completion: IssueCompletionKind.PushedCommit,
        commitSha: "abc123",
      },
      {
        kind: IssueExecutionOutcomeKind.Decomposed,
        childIssueNumbers: [101, 102],
      },
      {
        kind: IssueExecutionOutcomeKind.Escalated,
        diagnosticsPath: "/tmp/diagnostics",
        reason: "review did not converge",
      },
      { kind: IssueExecutionOutcomeKind.Skipped, reason: "dependency pending" },
      { kind: IssueExecutionOutcomeKind.Failed, message: "agent failed" },
    ];

    const descriptions = outcomes.map((outcome) => {
      switch (outcome.kind) {
        case IssueExecutionOutcomeKind.Completed:
          return outcome.completion === IssueCompletionKind.PushedCommit
            ? outcome.commitSha
            : outcome.resolutionSummary;
        case IssueExecutionOutcomeKind.Decomposed:
          return String(outcome.childIssueNumbers.length);
        case IssueExecutionOutcomeKind.Escalated:
          return outcome.diagnosticsPath;
        case IssueExecutionOutcomeKind.Skipped:
          return outcome.reason;
        case IssueExecutionOutcomeKind.Failed:
          return outcome.message;
      }
    });

    expect(descriptions).toEqual([
      "abc123",
      "2",
      "/tmp/diagnostics",
      "dependency pending",
      "agent failed",
    ]);
  });

  test("context keeps the checkout and shared clients explicit", () => {
    const context: IssueExecutionContext = {
      issue: {
        number: 42,
        title: "Example issue",
        url: "https://github.com/example/repo/issues/42",
        body: null,
        labels: [],
      },
      repository: "example/repo",
      repositoryPath: "/tmp/repository",
      targetBranch: "main",
      workspace: "/tmp/workspace",
      runId: "run-42",
      octokit: {} as IssueExecutionContext["octokit"],
      openCode: {} as IssueExecutionContext["openCode"],
      openCodeSelection: { agent: "build" },
      openCodeDiagnostics: makeOpenCodeSessionDiagnostics(),
      repositoryInvariant: {
        capture: () => Effect.succeed({ branch: "main", head: "abc123" }),
        verify: () => Effect.void,
      },
    };

    expect(context.issue.number).toBe(42);
    expect(context.repository).toBe("example/repo");
    expect(context.repositoryPath).toBe("/tmp/repository");
    expect(context.targetBranch).toBe("main");
    expect(context.workspace).toBe("/tmp/workspace");
    expect(context.runId).toBe("run-42");
    expect(context.openCodeSelection.agent).toBe("build");
  });
});
