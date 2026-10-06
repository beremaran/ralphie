import type { AgentSessions } from "../../agent/sessions.ts";

import { type GitHubIssue } from "../../github/domain.ts";
import type { IssueArtifactStore } from "./artifacts.ts";
import type {
    IssueResolutionDecision,
    HandOffReason,
} from "../domain/decisions.ts";
import { type GitRepositoryInvariantService } from "../../git/ports.ts";
import type { RunLayout } from "../../run/ports.ts";

/**
 * The terminal state reported by an issue executor.
 *
 * Keeping this as an enum-backed discriminator makes outcomes safe to route
 * and easy to serialize in progress and run diagnostics.
 */
export enum IssueExecutionOutcomeKind {
    Completed = "completed",
    Decomposed = "decomposed",
    HandOff = "hand-off",
    Escalated = "escalated",
    Skipped = "skipped",
    /** The environment (limit, outage, expired login) stopped the issue. */
    Deferred = "deferred",
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
          readonly kind: IssueExecutionOutcomeKind.HandOff;
          readonly reason: HandOffReason;
          readonly summary: string;
          readonly evidence: ReadonlyArray<string>;
          readonly questions: ReadonlyArray<string>;
      } & (
          | {
                /** Where the validated hand-off artifact was written. */
                readonly artifactPath: string;
                readonly diagnosticsPath?: never;
                readonly route?: "hand-off";
            }
          | {
                /** Alternate name used when the local record is diagnostic output. */
                readonly artifactPath?: never;
                readonly diagnosticsPath: string;
                readonly route?: "hand-off";
            }
          | {
                /** Controlled route with no per-issue recovery artifact. */
                readonly route: "hand-off";
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
      }
    | {
          readonly kind: IssueExecutionOutcomeKind.Deferred;
          /** Why the run halted, naming the failure and any reset time. */
          readonly reason: string;
          readonly cause: "transient" | "auth";
          readonly resetHint?: string;
      }
    | {
          readonly kind: IssueExecutionOutcomeKind.Failed;
          readonly message: string;
          /**
           * Set when implementation attempts ran out. The implementation
           * executor turns these into hand-offs before they leave it.
           */
          readonly exhausted?: true;
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
    /** Run filesystem layout resolved by the composition root. */
    readonly runLayout: RunLayout;
    /** The harness and the role assignments every agent session uses. */
    readonly agent: AgentSessions;
    readonly implementationAttempts?: number;
    /** Review attempts allowed before escalating; defaults to the stage limit. */
    readonly reviewRounds?: number;
    /** Verification repair attempts allowed; defaults to the stage limit. */
    readonly verificationFixes?: number;
    readonly repositoryInvariant: GitRepositoryInvariantService;
    readonly verificationCommands?: ReadonlyArray<string>;
    readonly signal?: AbortSignal;
    /** Maximum generated-child lineage depth allowed for decomposition. */
    readonly maxDecompositionDepth?: number;
    /**
     * Labels that gate intake. Decomposed children inherit those of them that
     * the parent carries, so a scoped run still picks the children up.
     */
    readonly intakeLabels?: ReadonlyArray<string>;
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