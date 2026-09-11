import {
    CommandRunnerLive,
    type CommandRunnerService,
} from "./adapters/process/command-runner.ts";
import {
    makeGitIssueCheckpointService,
    type GitIssueCheckpointService,
} from "./adapters/git/issue-checkpoint.ts";
import {
    makeGitIssueOperationsService,
    type GitIssueOperationsService,
} from "./adapters/git/issue-operations.ts";
import {
    makeGitIssuePreparationService,
    type GitIssuePreparationService,
} from "./adapters/git/issue-preparation.ts";
import {
    makeGitRemoteSafetyService,
    type GitRemoteSafetyService,
} from "./adapters/git/remote-safety.ts";
import {
    makeGitRepositoryInvariantService,
    type GitRepositoryInvariantService,
} from "./adapters/git/repository-invariant.ts";
import {
    makeGitRepositoryService,
    type GitRepositoryService,
} from "./adapters/git/repository.ts";
import {
    makeGitHubClientService,
    type GitHubClientService,
} from "./adapters/github/client.ts";
import {
    makeGitHubIssueMutationsService,
    type GitHubIssueMutationService,
} from "./adapters/github/issue-mutations.ts";
import {
    makeGitHubIssueRelationshipService,
    type GitHubIssueRelationshipService,
} from "./adapters/github/issue-relationships.ts";
import {
    makeParentCompletionService,
    type ParentCompletionService,
} from "./adapters/github/parent-completion.ts";
import {
    makeGitHubIssuesService,
    type GitHubIssuesService,
} from "./adapters/github/issues.ts";
import {
    makeGitHubNeedsAttentionNotificationService,
    type GitHubNeedsAttentionNotificationService,
} from "./adapters/github/needs-attention.ts";
import {
    makeIssueArtifactStoreService,
    type IssueArtifactStoreService,
} from "./adapters/issues/artifacts.ts";
import {
    makeComplexityAssessmentService,
    type ComplexityAssessmentService,
} from "./core/app/issues/complexity.ts";
import {
    makeDecompositionExecutorService,
    type DecompositionExecutorService,
} from "./core/app/issues/decomposition-executor.ts";
import {
    makeImplementationExecutorService,
    type ImplementationExecutorService,
} from "./core/app/issues/implementation-executor.ts";
import { makeIssueVerificationService } from "./core/app/issues/verification.ts";
import {
    makeResolutionVerificationService,
    type ResolutionVerificationService,
} from "./core/app/issues/resolution-verification.ts";
import {
    makeIssueExecutorService,
    type IssueExecutorService,
} from "./core/app/issues/executor.ts";
import {
    makeIssueRecoveryService,
    type IssueRecoveryService,
} from "./adapters/issues/recovery.ts";
import {
    makeGroundingAssessmentService,
    type GroundingAssessmentService,
} from "./core/app/issues/grounding.ts";
import {
    makeNeedsAttentionRouterService,
    type NeedsAttentionRouterService,
} from "./core/app/issues/needs-attention.ts";
import { type PiAgentService } from "./adapters/pi/runtime.ts";
import { type ProgressReporterService } from "./core/ports/progress.ts";
import { type RunEventLog } from "./adapters/run/event-log.ts";
import {
    RunStateStoreLive,
    type RunStateStoreService,
} from "./adapters/run/state.ts";
import {
    WorkspaceLive,
    type WorkspaceService,
} from "./adapters/workspace/workspace.ts";

/** Concrete adapter assembly for one run. Only the command wiring consumes this broad shape; the workflow depends on its focused seam. */
export type RalphieRuntime = {
    readonly commandRunner: CommandRunnerService;
    readonly githubClient: GitHubClientService;
    readonly githubIssues: GitHubIssuesService;
    readonly githubIssueMutations: GitHubIssueMutationService;
    readonly githubIssueRelationships: GitHubIssueRelationshipService;
    readonly parentCompletion: ParentCompletionService;
    /** Publishes structured needs-attention outcomes outside issue execution. */
    readonly githubNeedsAttentionNotification: GitHubNeedsAttentionNotificationService;
    readonly gitRepository: GitRepositoryService;
    readonly gitRepositoryInvariant: GitRepositoryInvariantService;
    readonly gitIssueCheckpoint: GitIssueCheckpointService;
    readonly gitIssueOperations: GitIssueOperationsService;
    readonly gitIssuePreparation: GitIssuePreparationService;
    readonly gitRemoteSafety: GitRemoteSafetyService;
    readonly issueArtifactStore: IssueArtifactStoreService;
    readonly complexityAssessment: ComplexityAssessmentService;
    readonly groundingAssessment: GroundingAssessmentService;
    /** Shared fresh, read-only resolution verifier for issue routes. */
    readonly resolutionVerification: ResolutionVerificationService;
    readonly decompositionExecutor: DecompositionExecutorService;
    readonly implementationExecutor: ImplementationExecutorService;
    readonly issueExecutor: IssueExecutorService;
    readonly issueRecovery: IssueRecoveryService;
    readonly needsAttentionRouter: NeedsAttentionRouterService;
    readonly agentRuntime: PiAgentService;
    readonly progress: ProgressReporterService;
    readonly runEventLog: RunEventLog;
    readonly runStateStore: RunStateStoreService;
    readonly workspace: WorkspaceService;
};

/** Focused dependencies consumed directly by the issue workflow entrypoint. */
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

export type RuntimeOverrides = {
    readonly agentRuntime: PiAgentService;
    readonly progress: ProgressReporterService;
    readonly runEventLog: RunEventLog;
    /** Optional deterministic seam for the issue artifact store. */
    readonly commandRunner?: CommandRunnerService;
    readonly runStateStore?: RunStateStoreService;
    readonly workspace?: WorkspaceService;
};

/** Assemble the small object graph for one run. */
export const makeLiveRuntime = ({
    agentRuntime,
    progress,
    runEventLog,
    commandRunner = CommandRunnerLive,
    runStateStore = RunStateStoreLive,
    workspace = WorkspaceLive,
}: RuntimeOverrides): RalphieRuntime => {
    const githubClient = makeGitHubClientService(commandRunner);
    const githubIssues = makeGitHubIssuesService();
    const githubIssueMutations = makeGitHubIssueMutationsService();
    const githubIssueRelationships = makeGitHubIssueRelationshipService();
    const parentCompletion = makeParentCompletionService({
        issues: githubIssues,
        relationships: githubIssueRelationships,
        mutations: githubIssueMutations,
    });
    const githubNeedsAttentionNotification =
        makeGitHubNeedsAttentionNotificationService();
    const gitRepository = makeGitRepositoryService(commandRunner);
    const gitRepositoryInvariant =
        makeGitRepositoryInvariantService(commandRunner);
    const gitIssueCheckpoint = makeGitIssueCheckpointService(commandRunner);
    const gitIssueOperations = makeGitIssueOperationsService(commandRunner);
    const gitRemoteSafety = makeGitRemoteSafetyService(commandRunner);
    const issueArtifactStore = makeIssueArtifactStoreService();
    const actualGitIssuePreparation = makeGitIssuePreparationService(
        gitIssueCheckpoint,
        issueArtifactStore,
    );
    const issueRecovery = makeIssueRecoveryService(
        gitIssueCheckpoint,
        progress,
        gitRepositoryInvariant,
    );
    const needsAttentionRouter = makeNeedsAttentionRouterService(issueRecovery);
    const issueVerification = makeIssueVerificationService(commandRunner);
    const complexityAssessment = makeComplexityAssessmentService(progress);
    const groundingAssessment = makeGroundingAssessmentService(progress);
    const resolutionVerification = makeResolutionVerificationService(progress);
    const decompositionExecutor = makeDecompositionExecutorService(
        githubIssueMutations,
        githubIssues,
        githubIssueRelationships,
        progress,
        needsAttentionRouter,
    );
    const implementationExecutor = makeImplementationExecutorService(
        actualGitIssuePreparation,
        gitIssueOperations,
        gitRemoteSafety,
        issueRecovery,
        progress,
        issueVerification,
        resolutionVerification,
        needsAttentionRouter,
    );
    const issueExecutor = makeIssueExecutorService(
        issueArtifactStore,
        complexityAssessment,
        implementationExecutor,
        decompositionExecutor,
        groundingAssessment,
        resolutionVerification,
        progress,
        needsAttentionRouter,
    );
    return {
        commandRunner,
        githubClient,
        githubIssues,
        githubIssueMutations,
        githubIssueRelationships,
        parentCompletion,
        githubNeedsAttentionNotification,
        gitRepository,
        gitRepositoryInvariant,
        gitIssueCheckpoint,
        gitIssueOperations,
        gitIssuePreparation: actualGitIssuePreparation,
        gitRemoteSafety,
        issueArtifactStore,
        complexityAssessment,
        groundingAssessment,
        resolutionVerification,
        decompositionExecutor,
        implementationExecutor,
        issueExecutor,
        issueRecovery,
        needsAttentionRouter,
        agentRuntime,
        progress,
        runEventLog,
        runStateStore,
        workspace,
    };
};