import type { GitHubClientService } from "../github/ports.ts";
import type { GitHubIssuesService } from "../github/ports.ts";
import type { GitHubIssueMutationService } from "../github/ports.ts";
import type { GitHubNeedsAttentionNotificationService } from "../github/ports.ts";
import type { ParentCompletionService } from "../github/ports.ts";
import type {
    GitIssueCheckpointService,
    GitIssueOperationsService,
    GitRepositoryInvariantService,
    GitRepositoryService,
} from "../git/ports.ts";
import type { PiAgentService } from "../pi/ports.ts";
import type { ProgressReporterService } from "../progress/ports.ts";
import type { RunEventLog, RunStateStoreService } from "../run/ports.ts";
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
    readonly workspace: WorkspaceService;
    readonly githubClient: GitHubClientService;
    readonly githubIssues: GitHubIssuesService;
    readonly githubIssueMutations: GitHubIssueMutationService;
    readonly githubNeedsAttentionNotification: GitHubNeedsAttentionNotificationService;
    readonly gitRepository: GitRepositoryService;
    readonly gitRepositoryInvariant: GitRepositoryInvariantService;
    readonly gitIssueCheckpoint: GitIssueCheckpointService;
    readonly gitIssueOperations: GitIssueOperationsService;
    readonly parentCompletion: ParentCompletionService;
    readonly issueExecutor: IssueExecutorService;
    readonly agentRuntime: PiAgentService;
};