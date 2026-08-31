import type { Octokit } from "octokit";
import type { PiClient } from "../pi/client.ts";

import type { GitHubIssue } from "../github/issues.ts";
import type { NeedsAttentionReason } from "./decisions.ts";
import type { PiModel, PiSelection } from "../agent/model.ts";
import type { PiSessionDiagnostics } from "../agent/task-session.ts";
import type { GitRepositoryInvariantService } from "../git/repository-invariant.ts";
import type { NeedsAttentionPolicy } from "../options.ts";

export const DRY_RUN_ROUTES = [
    "implementation",
    "decomposition",
    "already-resolved",
    "needs-attention",
] as const;

export type DryRunRoute = (typeof DRY_RUN_ROUTES)[number];

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
                readonly route?: "needs-attention";
                readonly policy?: NeedsAttentionPolicy;
            }
          | {
                /** Alternate name used when the local record is diagnostic output. */
                readonly artifactPath?: never;
                readonly diagnosticsPath: string;
                readonly route?: "needs-attention";
                readonly policy?: NeedsAttentionPolicy;
            }
          | {
                /** Dry-run route; no per-issue artifact is written. */
                readonly route: "needs-attention";
                readonly policy?: NeedsAttentionPolicy;
                readonly artifactPath?: never;
                readonly diagnosticsPath?: never;
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
          /** Dry-run routing result; ordinary skips leave this unset. */
          readonly route?: DryRunRoute;
      }
    | {
          readonly kind: IssueExecutionOutcomeKind.Failed;
          readonly message: string;
      };

/**
 * Shared inputs available to all per-issue workflow executors.
 *
 * The repository path is the concrete checkout used by the issue workflow;
 * dry-run decision services inspect it without mutation. Workspace is retained
 * separately because it owns run artifacts and cleanup. The clients
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
        readonly implementation?: string;
        readonly grounding?: string;
        readonly complexity?: string;
        readonly review?: string;
        readonly commitMessage?: string;
    };
    readonly implementationAttempts?: number;
    readonly implementationFallbackModel?: PiModel;
    readonly piDiagnostics: PiSessionDiagnostics;
    readonly repositoryInvariant: GitRepositoryInvariantService;
    readonly verificationCommands?: ReadonlyArray<string>;
    readonly signal?: AbortSignal;
    /** The policy selected for this run, used by dry-run reporting. */
    readonly needsAttentionPolicy?: NeedsAttentionPolicy;
};
