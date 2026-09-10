import type { Octokit } from "octokit";
import type { AgentClient } from "../agent/contracts.ts";

import type { GitHubIssue } from "../github/issues.ts";
import type { IssueArtifactStore } from "./artifacts.ts";
import type {
    IssueResolutionDecision,
    NeedsAttentionReason,
} from "./decisions.ts";
import type { AgentModel, AgentSelection } from "../agent/model.ts";
import type { AgentSessionDiagnostics } from "../agent/task-session.ts";
import type { GitRepositoryInvariantService } from "../git/repository-invariant.ts";

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
            }
          | {
                /** Alternate name used when the local record is diagnostic output. */
                readonly artifactPath?: never;
                readonly diagnosticsPath: string;
                readonly route?: "needs-attention";
            }
          | {
                /** Controlled route with no per-issue recovery artifact. */
                readonly route: "needs-attention";
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
 * to perform authentication or start another agent runtime.
 */
export type IssueExecutionContext = {
    readonly issue: GitHubIssue;
    /** GitHub owner/repository slug supplied to the run. */
    readonly repository: string;
    readonly repositoryPath: string;
    readonly targetBranch: string;
    readonly workspace: string;
    readonly runId: string;
    readonly octokit: Octokit;
    readonly agent: AgentClient;
    readonly agentSelection: AgentSelection;
    readonly implementationAttempts?: number;
    readonly implementationFallbackModel?: AgentModel;
    readonly agentDiagnostics: AgentSessionDiagnostics;
    readonly repositoryInvariant: GitRepositoryInvariantService;
    readonly verificationCommands?: ReadonlyArray<string>;
    readonly signal?: AbortSignal;
    /** Maximum generated-child lineage depth allowed for decomposition. */
    readonly maxDecompositionDepth?: number;
};

/**
 * Inputs shared by the concrete per-issue workflow executors.
 *
 * The artifact store is passed explicitly so an executor can persist each
 * decision and deterministic checkpoint as it progresses. Keeping it next to
 * the execution context also makes the boundary easy to exercise with a
 * per-issue store in tests and in a future live implementation.
 */
export type WorkflowExecutorInput = {
    readonly context: IssueExecutionContext;
    readonly artifacts: IssueArtifactStore;
    /** Fresh evidence that corrected an already-resolved grounding route. */
    readonly unresolvedResolution?: IssueResolutionDecision;
};

export type WorkflowExecutorResult = IssueExecutionOutcome;