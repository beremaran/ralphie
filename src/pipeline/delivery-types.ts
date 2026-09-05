import type { AgentSelection } from "../agent/model.ts";
import type { AgentSessionDiagnostics } from "../agent/task-session.ts";
import type {
    PipelineCommitResult,
    PipelinePushAttempt,
} from "../git/pipeline-delivery.ts";
import type { PipelineObservationOptions } from "../github/pipeline-observation.ts";
import type { PipelineSnapshot } from "../github/pipeline-snapshot.ts";
import type { PipelineRepairOutcome } from "../issues/pipeline-repair-executor.ts";
import type { AgentClient } from "../opencode/client.ts";
import type { ProgressIssue } from "../progress/progress.ts";
import type { CommitMessageDecision } from "../issues/decisions.ts";
import type { Octokit } from "octokit";

export const PIPELINE_DELIVERY_EXTERNAL_MOVEMENT_LIMIT = 3;

export type PipelineDeliveryPhase =
    | "remote-read"
    | "observation"
    | "prepare"
    | "diagnostics"
    | "repair"
    | "commit-message"
    | "commit"
    | "push"
    | "reconcile"
    | "final-verification";

export type PipelineDeliveryPhaseOutcome = {
    readonly phase: PipelineDeliveryPhase;
    readonly outcome: "succeeded" | "failed";
    readonly attempt?: number;
    readonly message?: string;
};

export type PipelineDeliveryCommitOutcome = {
    readonly status: "created" | "failed";
    readonly sha?: string;
    readonly parentSha?: string;
    readonly treeSha?: string;
    readonly message?: string;
};

export type PipelineDeliveryPushOutcome = {
    readonly status:
        | "confirmed"
        | "confirmed-after-response-loss"
        | "rejected"
        | "ambiguous"
        | "external-movement";
    readonly response: PipelinePushAttempt["response"];
    readonly failureKind?: PipelinePushAttempt["failureKind"];
    readonly remoteSha?: string;
    readonly message?: string;
};

export type PipelineDeliveryAttempt = {
    /** One-based prospective repair number; external movements do not charge it. */
    readonly attempt: number;
    readonly baseSha: string;
    readonly failureFingerprint: string;
    readonly repair?: PipelineRepairOutcome["status"];
    readonly commit?: PipelineDeliveryCommitOutcome;
    readonly push?: PipelineDeliveryPushOutcome;
};

export type PipelineDeliveryOutcomeKind =
    | "green"
    | "no-pipelines-discovered"
    | "no-change"
    | "review-exhausted"
    | "identical-failure"
    | "attempts-exhausted"
    | "external-movement"
    | "ambiguous-push"
    | "non-fast-forward"
    | "timeout"
    | "cancelled"
    | "dry-run"
    | "failed";

export type PipelineDeliveryOutcome = {
    readonly kind: PipelineDeliveryOutcomeKind;
    /** Alias used by durable state consumers that call terminal results status. */
    readonly status: PipelineDeliveryOutcomeKind;
    readonly source?: "already-green" | "pushed-repair";
    readonly repository: string;
    readonly branch: string;
    readonly remoteSha?: string;
    readonly failureFingerprint?: string;
    readonly diagnosticsPath?: string;
    readonly message?: string;
    readonly pushedAttempts: number;
    readonly externalMovements: number;
    readonly attempts: ReadonlyArray<PipelineDeliveryAttempt>;
    readonly phases: ReadonlyArray<PipelineDeliveryPhaseOutcome>;
    readonly snapshot?: PipelineSnapshot;
};

/** Evidence for one observable state transition in a delivery lifecycle. */
export type PipelineDeliveryPhaseEvent = {
    readonly phase: PipelineDeliveryPhase;
    readonly status: "before" | "succeeded" | "failed" | "reconciled";
    readonly attempt?: number;
    readonly currentRemoteSha?: string;
    readonly pushedAttempts: number;
    readonly externalMovements: number;
    readonly failureFingerprint?: string;
    readonly snapshot?: PipelineSnapshot;
    readonly diagnosticsPath?: string;
    readonly message?: string;
    readonly attemptState?: PipelineDeliveryAttempt;
    readonly commit?: PipelineCommitResult;
};

/** Semantic events are fanned out to durable state and user-facing progress. */
export type PipelineDeliveryEvent =
    | { readonly kind: "phase"; readonly event: PipelineDeliveryPhaseEvent }
    | { readonly kind: "outcome"; readonly outcome: PipelineDeliveryOutcome };

export type PipelineDeliveryContext = {
    readonly repository: string;
    /** Omit for a fresh run so repository preparation can select main/master. */
    readonly branch?: string;
    readonly workspace: string;
    readonly runId: string;
    readonly maxAttempts: number;
    /** Fresh runs use this to establish one absolute deadline. */
    readonly pipelineTimeoutMs?: number;
    readonly client?: Octokit;
    readonly signal?: AbortSignal;
    readonly observationOptions?: PipelineObservationOptions;
    readonly progressIssue?: ProgressIssue;
    readonly reviewBudget?: number;
    /** A validated message is useful when a pending push is resumed. */
    readonly commitMessage?: CommitMessageDecision;
};

/** The command owns acquisition/lifetime; the lifecycle requests it lazily. */
export type PipelineDeliveryAgent = {
    readonly agent: AgentClient;
    readonly agentSelection: AgentSelection;
    readonly agentDiagnostics?: AgentSessionDiagnostics;
};

export type PipelineDeliveryAgentProvider =
    () => Promise<PipelineDeliveryAgent>;

export type PipelineDeliveryLiveRequest = {
    readonly mode: "live";
    readonly context: PipelineDeliveryContext;
    readonly acquireAgent: PipelineDeliveryAgentProvider;
};

export type PipelineDeliveryDryRunRequest = {
    readonly mode: "dry-run";
    readonly context: PipelineDeliveryContext;
};

export type PipelineDeliveryResumeRequest =
    | {
          readonly mode: "resume";
          readonly resumePath: string;
          readonly dryRun: true;
          readonly context: PipelineDeliveryContext;
      }
    | {
          readonly mode: "resume";
          readonly resumePath: string;
          readonly dryRun?: false;
          readonly context: PipelineDeliveryContext;
          readonly acquireAgent: PipelineDeliveryAgentProvider;
      };

export type PipelineDeliveryRequest =
    | PipelineDeliveryLiveRequest
    | PipelineDeliveryDryRunRequest
    | PipelineDeliveryResumeRequest;

export type PipelineDeliveryResult = {
    readonly runId: string;
    readonly repository: string;
    readonly branch: string;
    readonly statePath: string;
    readonly outcome: PipelineDeliveryOutcome;
    readonly wouldRepair: boolean;
};

export type PipelineDeliveryLifecycle = {
    readonly execute: (
        request: PipelineDeliveryRequest,
    ) => Promise<PipelineDeliveryResult>;
};