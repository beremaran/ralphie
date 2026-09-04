import {
    CommandRunnerLive,
    type CommandRunnerService,
} from "./process/command-runner.ts";
import {
    makeGitIssueCheckpointService,
    type GitIssueCheckpointService,
} from "./git/issue-checkpoint.ts";
import {
    makeGitIssueOperationsService,
    type GitIssueOperationsService,
} from "./git/issue-operations.ts";
import {
    makeGitIssuePreparationService,
    type GitIssuePreparationService,
} from "./git/issue-preparation.ts";
import {
    makeGitRemoteSafetyService,
    type GitRemoteSafetyService,
} from "./git/remote-safety.ts";
import {
    makeGitRevisionCommitService,
    type GitRevisionCommitService,
} from "./git/revision-commit.ts";
import {
    makeGitRevisionDeliveryService,
    type GitRevisionDeliveryService,
} from "./git/revision-delivery.ts";
import {
    makeGitRepositoryInvariantService,
    type GitRepositoryInvariantService,
} from "./git/repository-invariant.ts";
import {
    makeGitRepositoryService,
    type GitRepositoryService,
} from "./git/repository.ts";
import {
    makeGitHubClientService,
    type GitHubClientService,
} from "./github/client.ts";
import {
    makeGitHubIssueMutationsService,
    type GitHubIssueMutationService,
} from "./github/issue-mutations.ts";
import {
    makeGitHubIssueRelationshipService,
    type GitHubIssueRelationshipService,
} from "./github/issue-relationships.ts";
import {
    makeParentCompletionService,
    type ParentCompletionService,
} from "./github/parent-completion.ts";
import {
    makeGitHubIssuesService,
    type GitHubIssuesService,
} from "./github/issues.ts";
import {
    makeGitHubPullRequestService,
    type GitHubPullRequestService,
} from "./github/pull-requests.ts";
import {
    makePullRequestReviewAttemptService,
    type PullRequestReviewAttemptService,
} from "./issues/pull-request-review.ts";
import {
    makePipelineSnapshotCollectorService,
    type PipelineSnapshotCollectorService,
} from "./github/pipeline-snapshot-collector.ts";
import {
    makePipelineObservationService,
    type PipelineObservationService,
    type PipelineObservationServiceDependencies,
} from "./github/pipeline-observation.ts";
import {
    makeGitHubNeedsAttentionNotificationService,
    type GitHubNeedsAttentionNotificationService,
} from "./github/needs-attention.ts";
import {
    makeIssueArtifactStoreService,
    type IssueArtifactStoreService,
} from "./issues/artifacts.ts";
import {
    makeComplexityAssessmentService,
    type ComplexityAssessmentService,
} from "./issues/complexity.ts";
import {
    makeDecompositionExecutorService,
    type DecompositionExecutorService,
} from "./issues/decomposition-executor.ts";
import {
    makeDecompositionPlannerService,
    type DecompositionPlannerService,
} from "./issues/decomposition-planner.ts";
import {
    makeDryRunIssueExecutorService,
    type DryRunIssueExecutorService,
} from "./issues/dry-run-executor.ts";
import {
    makeImplementationExecutorService,
    type ImplementationExecutorService,
} from "./issues/implementation-executor.ts";
import { makeIssueVerificationService } from "./issues/verification.ts";
import {
    makeResolutionVerificationService,
    type ResolutionVerificationService,
} from "./issues/resolution-verification.ts";
import {
    makeIssueExecutorService,
    type IssueExecutorService,
} from "./issues/executor.ts";
import {
    makeIssueRecoveryService,
    type IssueRecoveryService,
} from "./issues/recovery.ts";
import {
    makeGroundingAssessmentService,
    type GroundingAssessmentService,
} from "./issues/grounding.ts";
import {
    makeNeedsAttentionRouterService,
    type NeedsAttentionRouterService,
} from "./issues/needs-attention.ts";
import {
    makeOpenCodeService,
    type OpenCodeService,
} from "./opencode/server.ts";
import { type ProgressReporterService } from "./progress/progress.ts";
import { RunStateStoreLive, type RunStateStoreService } from "./run/state.ts";
import { WorkspaceLive, type WorkspaceService } from "./workspace/workspace.ts";

/** All dependencies needed by a workflow run. */
export type RalphieRuntime = {
    readonly commandRunner: CommandRunnerService;
    readonly githubClient: GitHubClientService;
    readonly pipelineSnapshot: PipelineSnapshotCollectorService;
    /** Bounded, read-only pipeline observer for one exact commit SHA. */
    readonly pipelineObservation: PipelineObservationService;
    readonly githubIssues: GitHubIssuesService;
    readonly githubIssueMutations: GitHubIssueMutationService;
    readonly githubIssueRelationships: GitHubIssueRelationshipService;
    readonly parentCompletion: ParentCompletionService;
    readonly githubPullRequests: GitHubPullRequestService;
    /** One immutable, fresh-session PR review attempt. */
    readonly pullRequestReviewAttempt: PullRequestReviewAttemptService;
    /** Publishes structured needs-attention outcomes outside issue execution. */
    readonly githubNeedsAttentionNotification: GitHubNeedsAttentionNotificationService;
    readonly gitRepository: GitRepositoryService;
    readonly gitRepositoryInvariant: GitRepositoryInvariantService;
    readonly gitIssueCheckpoint: GitIssueCheckpointService;
    readonly gitIssueOperations: GitIssueOperationsService;
    readonly gitIssuePreparation: GitIssuePreparationService;
    readonly gitRemoteSafety: GitRemoteSafetyService;
    readonly gitRevisionCommit: GitRevisionCommitService;
    readonly gitRevisionDelivery: GitRevisionDeliveryService;
    readonly issueArtifactStore: IssueArtifactStoreService;
    readonly complexityAssessment: ComplexityAssessmentService;
    readonly groundingAssessment: GroundingAssessmentService;
    /** Shared fresh, read-only resolution verifier for issue routes. */
    readonly resolutionVerification: ResolutionVerificationService;
    readonly decompositionExecutor: DecompositionExecutorService;
    readonly implementationExecutor: ImplementationExecutorService;
    readonly dryRunIssueExecutor: DryRunIssueExecutorService;
    readonly issueExecutor: IssueExecutorService;
    readonly issueRecovery: IssueRecoveryService;
    readonly needsAttentionRouter: NeedsAttentionRouterService;
    readonly opencode: OpenCodeService;
    readonly progress: ProgressReporterService;
    readonly runStateStore: RunStateStoreService;
    readonly workspace: WorkspaceService;
};

export type RuntimeOverrides = {
    readonly opencode: OpenCodeService;
    readonly progress: ProgressReporterService;
    /** Optional deterministic seams for the read-only pipeline observer. */
    readonly pipelineObservationDependencies?: PipelineObservationServiceDependencies;
    readonly commandRunner?: CommandRunnerService;
    readonly runStateStore?: RunStateStoreService;
    readonly workspace?: WorkspaceService;
};

/** Assemble the small object graph for one run. */
export const makeLiveRuntime = ({
    opencode,
    progress,
    commandRunner = CommandRunnerLive,
    runStateStore = RunStateStoreLive,
    workspace = WorkspaceLive,
    pipelineObservationDependencies,
}: RuntimeOverrides): RalphieRuntime => {
    const githubClient = makeGitHubClientService(commandRunner);
    const pipelineSnapshot = makePipelineSnapshotCollectorService();
    const pipelineObservation = makePipelineObservationService(
        pipelineObservationDependencies,
    );
    const githubIssues = makeGitHubIssuesService();
    const githubIssueMutations = makeGitHubIssueMutationsService();
    const githubIssueRelationships = makeGitHubIssueRelationshipService();
    const parentCompletion = makeParentCompletionService({
        issues: githubIssues,
        relationships: githubIssueRelationships,
        mutations: githubIssueMutations,
    });
    const githubPullRequests = makeGitHubPullRequestService();
    const githubNeedsAttentionNotification =
        makeGitHubNeedsAttentionNotificationService();
    const gitRepository = makeGitRepositoryService(commandRunner);
    const gitRepositoryInvariant =
        makeGitRepositoryInvariantService(commandRunner);
    const gitIssueCheckpoint = makeGitIssueCheckpointService(commandRunner);
    const gitIssueOperations = makeGitIssueOperationsService(commandRunner);
    const pullRequestReviewAttempt = makePullRequestReviewAttemptService({
        pullRequests: githubPullRequests,
        issueOperations: gitIssueOperations,
    });
    const gitRemoteSafety = makeGitRemoteSafetyService(commandRunner);
    const gitRevisionCommit = makeGitRevisionCommitService(commandRunner);
    const gitRevisionDelivery = makeGitRevisionDeliveryService(
        commandRunner,
        gitRevisionCommit,
        gitRemoteSafety,
    );
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
    const decompositionPlanner = makeDecompositionPlannerService(
        githubIssues,
        progress,
    );
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
    const dryRunIssueExecutor = makeDryRunIssueExecutorService(
        issueArtifactStore,
        complexityAssessment,
        progress,
        groundingAssessment,
        decompositionPlanner,
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
        pipelineSnapshot,
        pipelineObservation,
        githubIssues,
        githubIssueMutations,
        githubIssueRelationships,
        parentCompletion,
        githubPullRequests,
        pullRequestReviewAttempt,
        githubNeedsAttentionNotification,
        gitRepository,
        gitRepositoryInvariant,
        gitIssueCheckpoint,
        gitIssueOperations,
        gitIssuePreparation: actualGitIssuePreparation,
        gitRemoteSafety,
        gitRevisionCommit,
        gitRevisionDelivery,
        issueArtifactStore,
        complexityAssessment,
        groundingAssessment,
        resolutionVerification,
        decompositionExecutor,
        implementationExecutor,
        dryRunIssueExecutor,
        issueExecutor,
        issueRecovery,
        needsAttentionRouter,
        opencode,
        progress,
        runStateStore,
        workspace,
    };
};

export const LiveRuntime = makeLiveRuntime;

export { makeOpenCodeService };