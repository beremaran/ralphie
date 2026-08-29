import type { Octokit } from "octokit";
import type { PiClient } from "../pi/client.ts";

import type { GitHubIssue } from "../github/issues.ts";
import type { NeedsAttentionReason } from "./decisions.ts";
import type { PiSelection } from "../agent/model.ts";
import type { PiSessionDiagnostics } from "../agent/task-session.ts";
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
    NeedsAttention = "needs-attention",
    Escalated = "escalated",
    Skipped = "skipped",
    Failed = "failed",
}

export type IssueCompletionKind = "pushed-commit" | "already-resolved";

export type IssueExecutionOutcome =
    | {
          readonly kind: IssueExecutionOutcomeKind.Completed;
          readonly completion: "pushed-commit";
          /** The commit created for the issue's implementation. */
          readonly commitSha: string;
          /** Number of structured review decisions required to converge. */
          readonly reviewCount?: number;
      }
    | {
          readonly kind: IssueExecutionOutcomeKind.Completed;
          readonly completion: "already-resolved";
          readonly resolutionSummary: string;
          readonly evidence: ReadonlyArray<string>;
      }
    | {
          readonly kind: IssueExecutionOutcomeKind.Decomposed;
          /** Issues created from the original issue's decomposition. */
          readonly childIssueNumbers: ReadonlyArray<number>;
      }
    | ({
          readonly kind: IssueExecutionOutcomeKind.NeedsAttention;
          readonly reason: NeedsAttentionReason;
          readonly summary: string;
          readonly evidence: ReadonlyArray<string>;
          readonly questions: ReadonlyArray<string>;
      } & (
          | {
                /** Where the validated needs-attention artifact was written. */
                readonly artifactPath: string;
                readonly diagnosticsPath?: never;
            }
          | {
                /** Alternate name used when the local record is diagnostic output. */
                readonly artifactPath?: never;
                readonly diagnosticsPath: string;
            }
      ))
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
 * to perform authentication or start another Pi runtime.
 */
export type IssueExecutionContext = {
    readonly issue: GitHubIssue;
    /** GitHub owner/repository slug supplied to the run. */
    readonly repository: string;
    readonly repositoryPath: string;
    readonly targetBranch: string;
    /** PR feature branches may not exist remotely until the first commit is pushed. */
    readonly allowMissingRemoteBranch?: boolean;
    readonly workspace: string;
    readonly runId: string;
    readonly octokit: Octokit;
    readonly pi: PiClient;
    readonly piSelection: PiSelection;
    readonly piStageVariants?: {
        readonly grounding?: string;
        readonly complexity?: string;
        readonly review?: string;
        readonly commitMessage?: string;
    };
    readonly piDiagnostics: PiSessionDiagnostics;
    readonly repositoryInvariant: GitRepositoryInvariantService;
    readonly verificationCommands?: ReadonlyArray<string>;
    readonly signal?: AbortSignal;
};