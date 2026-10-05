import type { GitHubConnectionService } from "../github/ports.ts";
import type { SessionLimits } from "../agent/sessions.ts";
import type { RoleAssignments } from "../harness/app/roles.ts";
import type { HarnessService } from "../harness/ports.ts";
import type { IssueFilters } from "../github/domain.ts";
import type {
    IssueExecutionOutcome,
    IssueExecutionOutcomeKind,
} from "../issues/app/execution.ts";
import type { GitHubIssuesService } from "../github/ports.ts";
import type { GitHubIssueMutationService } from "../github/ports.ts";
import type { GitHubHandOffService } from "../github/ports.ts";
import type { HandOffLabels } from "../issues/domain/hand-off.ts";
import type { ParentCompletionService } from "../issues/ports.ts";
import type {
    GitIssueCheckpointService,
    GitIssueOperationsService,
    GitRepositoryInvariantService,
    GitRepositoryService,
} from "../git/ports.ts";
import type { ProgressReporterService } from "../progress/ports.ts";
import type {
    Clock,
    IdGenerator,
    RunControl,
    RunEventLog,
    RunLayout,
    RunStateStoreService,
} from "../run/ports.ts";
import type { WorkspaceService } from "../workspace/ports.ts";
import type { IssueExecutorService } from "../issues/app/executor.ts";

/**
 * The focused dependency bundle consumed by the issue workflow.
 *
 * Every field is a core-owned port; the composition root supplies concrete
 * adapters. Keeping the bundle in the core prevents the application from
 * depending on the runtime assembly module.
 */
export type IssueWorkflowRuntime = {
    readonly progress: ProgressReporterService;
    readonly runEventLog: RunEventLog;
    readonly runStateStore: RunStateStoreService;
    readonly layout: RunLayout;
    readonly clock: Clock;
    readonly ids: IdGenerator;
    readonly workspace: WorkspaceService;
    readonly githubConnection: GitHubConnectionService;
    readonly githubIssues: GitHubIssuesService;
    readonly githubIssueMutations: GitHubIssueMutationService;
    readonly githubHandOff: GitHubHandOffService;
    readonly gitRepository: GitRepositoryService;
    readonly gitRepositoryInvariant: GitRepositoryInvariantService;
    readonly gitIssueCheckpoint: GitIssueCheckpointService;
    readonly gitIssueOperations: GitIssueOperationsService;
    readonly parentCompletion: ParentCompletionService;
    readonly issueExecutor: IssueExecutorService;
    readonly harness: HarnessService;
};

export type WorkflowOptions = {
    readonly repo: string;
    readonly branch?: string;
    readonly maxDecompositionDepth?: number;
    readonly issueFilters: IssueFilters;
    /** The harness, model and effort every role runs with. */
    readonly roles: RoleAssignments;
    /** Session timeouts and spend cap; defaults apply when omitted. */
    readonly sessionLimits?: SessionLimits;
    readonly verificationCommands?: ReadonlyArray<string>;
    readonly implementationAttempts?: number;
    /** Review rounds allowed before escalating to decomposition. */
    readonly reviewRounds?: number;
    /** Verification repair attempts allowed after a failing verify command. */
    readonly verificationFixes?: number;
    readonly workspace: string;
    readonly signal?: AbortSignal;
    /** Interactive queue control; absent for non-interactive runs. */
    readonly control?: RunControl;
    readonly runId: string;
    /** The triage state labels hand-offs apply; canonical names by default. */
    readonly handOffLabels?: HandOffLabels;
};

export type WorkflowSummary = {
    readonly runId: string;
    readonly outcomes: ReadonlyArray<{
        readonly issueNumber: number;
        readonly outcome: IssueExecutionOutcome;
    }>;
    readonly counts: Readonly<Record<IssueExecutionOutcomeKind, number>>;
};

/** Primary (driving) port: run the issue workflow. */
export type IssueWorkflow = {
    readonly run: (
        options: WorkflowOptions,
        runtime: IssueWorkflowRuntime,
    ) => Promise<WorkflowSummary>;
};