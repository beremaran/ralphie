import type { Octokit } from "octokit";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import type { GitHubIssue } from "../github/issues.ts";
import type { OpenCodeSelection } from "../opencode/model.ts";
import type { OpenCodeSessionDiagnostics } from "../opencode/task-session.ts";
import type { GitRepositoryInvariantService } from "../git/repository-invariant.ts";

/**
 * The terminal state reported by an issue executor.
 *
 * Keeping this as an enum-backed discriminator makes outcomes safe to route
 * and easy to serialize in progress and run diagnostics.
 */
export enum IssueExecutionOutcomeKind {
  Completed = "completed",
  Decomposed = "decomposed",
  Escalated = "escalated",
  Skipped = "skipped",
  Failed = "failed",
}

export enum IssueCompletionKind {
  PushedCommit = "pushed-commit",
  AlreadyResolved = "already-resolved",
}

export type IssueExecutionOutcome =
  | {
      readonly kind: IssueExecutionOutcomeKind.Completed;
      readonly completion: IssueCompletionKind.PushedCommit;
      /** The commit created for the issue's implementation. */
      readonly commitSha: string;
      /** Number of structured review decisions required to converge. */
      readonly reviewCount?: number;
    }
  | {
      readonly kind: IssueExecutionOutcomeKind.Completed;
      readonly completion: IssueCompletionKind.AlreadyResolved;
      readonly resolutionSummary: string;
      readonly evidence: ReadonlyArray<string>;
    }
  | {
      readonly kind: IssueExecutionOutcomeKind.Decomposed;
      /** Issues created from the original issue's decomposition. */
      readonly childIssueNumbers: ReadonlyArray<number>;
    }
  | {
      readonly kind: IssueExecutionOutcomeKind.Escalated;
      /** Where recovery diagnostics for the escalation were written. */
      readonly diagnosticsPath: string;
      readonly reason: string;
      /** Child issues created after the restored checkout entered decomposition. */
      readonly childIssueNumbers?: ReadonlyArray<number>;
    }
  | {
      readonly kind: IssueExecutionOutcomeKind.Skipped;
      readonly reason: string;
    }
  | {
      readonly kind: IssueExecutionOutcomeKind.Failed;
      readonly message: string;
    };

/**
 * Shared inputs available to all per-issue workflow executors.
 *
 * The repository path is the concrete checkout being mutated; workspace is
 * retained separately because it owns run artifacts and cleanup. The clients
 * are passed in from the workflow runtime so an issue executor does not need
 * to perform authentication or start another OpenCode server.
 */
export type IssueExecutionContext = {
  readonly issue: GitHubIssue;
  readonly project?: string;
  /** GitHub owner/repository slug supplied to the run. */
  readonly repository: string;
  readonly repositoryPath: string;
  readonly targetBranch: string;
  readonly workspace: string;
  readonly runId: string;
  readonly octokit: Octokit;
  readonly openCode: OpencodeClient;
  readonly openCodeSelection: OpenCodeSelection;
  readonly openCodeDiagnostics: OpenCodeSessionDiagnostics;
  readonly repositoryInvariant: GitRepositoryInvariantService;
  readonly signal?: AbortSignal;
};
