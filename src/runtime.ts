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
    makePipelineDeliveryGitService,
    type PipelineDeliveryGitService,
} from "./git/pipeline-delivery.ts";
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
    makePullRequestReviewCoordinatorService,
    type PullRequestReviewCoordinatorService,
} from "./issues/pull-request-review-coordinator.ts";
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
    makePipelineDiagnosticsService,
    type PipelineDiagnosticsService,
    type PipelineDiagnosticsServiceDependencies,
} from "./github/pipeline-diagnostics-service.ts";
import {
    makePipelineRepairExecutorService,
    type PipelineRepairExecutorService,
} from "./issues/pipeline-repair-executor.ts";
import {
    makePipelineDeliveryLifecycle,
    type PipelineDeliveryLifecycle,
} from "./pipeline/delivery-lifecycle.ts";
import {
    makePipelineDeliveryStateAdapter,
    PipelineRunStateStoreLive,
    type PipelineRunStateStoreService,
} from "./run/pipeline-state.ts";
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
import { makeMaintainIssuesGroundingReader } from "./maintain-issues-grounding-reader.ts";
import {
    makeMaintenanceSnapshotService,
    type MaintenanceSnapshotService,
} from "./maintain-issues-snapshot-service.ts";
import {
    makeGitHubIssueMaintenanceService,
    type GitHubIssueMaintenanceService,
} from "./github/issue-maintenance.ts";
import {
    makeGitHubIssueMaintenanceRelationshipService,
    type GitHubIssueMaintenanceRelationshipService,
} from "./github/issue-maintenance-relationships.ts";
import {
    MaintenanceRunStateStoreLive,
    type MaintenanceRunStateStoreService,
} from "./maintain-issues-state.ts";
import {
    makeMaintenancePlanService,
    type MaintenancePlanService,
} from "./maintain-issues-plan.ts";
import type { AgentClient } from "./opencode/client.ts";
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
    /** Collects, persists, and prompt-bounds diagnostics for a failed run. */
    readonly pipelineDiagnostics: PipelineDiagnosticsService;
    /** Pipeline-only diagnose/edit/review boundary; never commits or pushes. */
    readonly pipelineRepairExecutor: PipelineRepairExecutorService;
    /** Complete Pipeline delivery lifecycle, including state and resume. */
    readonly pipelineDeliveryLifecycle: PipelineDeliveryLifecycle;
    /** Lower-level Git adapter used by the lifecycle and deterministic tests. */
    readonly pipelineDeliveryGit: PipelineDeliveryGitService;
    readonly githubIssues: GitHubIssuesService;
    readonly githubIssueMutations: GitHubIssueMutationService;
    readonly githubIssueRelationships: GitHubIssueRelationshipService;
    readonly parentCompletion: ParentCompletionService;
    readonly githubPullRequests: GitHubPullRequestService;
    /** One immutable, fresh-session PR review attempt. */
    readonly pullRequestReviewAttempt: PullRequestReviewAttemptService;
    /** Shared-budget post-creation PR review/revision coordinator. */
    readonly pullRequestReviewCoordinator: PullRequestReviewCoordinatorService;
    /** Publishes structured needs-attention outcomes outside issue execution. */
    readonly githubNeedsAttentionNotification: GitHubNeedsAttentionNotificationService;
    /** Fresh, immutable, read-only maintenance context for one run. */
    readonly maintenanceSnapshot: MaintenanceSnapshotService;
    /** Optional injected maintenance planner; production creates one per agent session. */
    readonly maintenancePlanner?: MaintenancePlanService;
    /** Build a planner around the agent client created for one run. */
    readonly maintenancePlannerForAgent?: (
        agent: AgentClient,
    ) => MaintenancePlanService;
    /** Deterministic additive/comment maintenance mutation boundary. */
    readonly maintenanceMutation?: GitHubIssueMaintenanceService;
    /** Deterministic duplicate/related relationship mutation boundary. */
    readonly maintenanceRelationships?: GitHubIssueMaintenanceRelationshipService;
    /** Mode-specific state store; it is never shared with issue queue state. */
    readonly maintenanceRunStateStore?: MaintenanceRunStateStoreService;
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
    /** Pipeline-only state; never shared with issue-mode state. */
    readonly pipelineRunStateStore: PipelineRunStateStoreService;
    readonly workspace: WorkspaceService;
};

export type RuntimeOverrides = {
    readonly opencode: OpenCodeService;
    readonly progress: ProgressReporterService;
    /** Optional deterministic seams for the read-only pipeline observer. */
    readonly pipelineObservationDependencies?: PipelineObservationServiceDependencies;
    /** Optional deterministic seams for the pipeline diagnostics runtime path. */
    readonly pipelineDiagnosticsDependencies?: PipelineDiagnosticsServiceDependencies;
    /** Optional deterministic pipeline repair executor for orchestration tests. */
    readonly pipelineRepairExecutor?: PipelineRepairExecutorService;
    /** Optional deterministic Pipeline delivery lifecycle for orchestration tests. */
    readonly pipelineDeliveryLifecycle?: PipelineDeliveryLifecycle;
    /** Optional deterministic Git boundary for pipeline orchestration tests. */
    readonly pipelineDeliveryGit?: PipelineDeliveryGitService;
    /** Optional deterministic state store for pipeline orchestration tests. */
    readonly pipelineRunStateStore?: PipelineRunStateStoreService;
    /** Optional deterministic seam for maintenance snapshot tests. */
    readonly maintenanceSnapshot?: MaintenanceSnapshotService;
    /** Optional deterministic maintenance planner used by runner tests. */
    readonly maintenancePlanner?: MaintenancePlanService;
    /** Optional factory for a planner bound to the live OpenCode client. */
    readonly maintenancePlannerForAgent?: (
        agent: AgentClient,
    ) => MaintenancePlanService;
    /** Optional deterministic maintenance mutation seams. */
    readonly maintenanceMutation?: GitHubIssueMaintenanceService;
    readonly maintenanceRelationships?: GitHubIssueMaintenanceRelationshipService;
    readonly maintenanceRunStateStore?: MaintenanceRunStateStoreService;
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
    pipelineRunStateStore = PipelineRunStateStoreLive,
    workspace = WorkspaceLive,
    pipelineObservationDependencies,
    pipelineDiagnosticsDependencies,
    pipelineRepairExecutor: pipelineRepairExecutorOverride,
    pipelineDeliveryLifecycle: pipelineDeliveryLifecycleOverride,
    pipelineDeliveryGit: pipelineDeliveryGitOverride,
    pipelineRunStateStore: pipelineRunStateStoreOverride,
    maintenanceSnapshot: maintenanceSnapshotOverride,
    maintenancePlanner: maintenancePlannerOverride,
    maintenancePlannerForAgent: maintenancePlannerForAgentOverride,
    maintenanceMutation: maintenanceMutationOverride,
    maintenanceRelationships: maintenanceRelationshipsOverride,
    maintenanceRunStateStore: maintenanceRunStateStoreOverride,
}: RuntimeOverrides): RalphieRuntime => {
    const githubClient = makeGitHubClientService(commandRunner);
    const pipelineSnapshot = makePipelineSnapshotCollectorService();
    const pipelineObservation = makePipelineObservationService(
        pipelineObservationDependencies,
    );
    const pipelineDiagnostics = makePipelineDiagnosticsService(
        pipelineDiagnosticsDependencies,
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
    const maintenanceSnapshot =
        maintenanceSnapshotOverride ??
        makeMaintenanceSnapshotService({
            githubClient,
            groundingReader: makeMaintainIssuesGroundingReader(commandRunner),
        });
    const maintenanceMutation =
        maintenanceMutationOverride ?? makeGitHubIssueMaintenanceService();
    const maintenanceRelationships =
        maintenanceRelationshipsOverride ??
        makeGitHubIssueMaintenanceRelationshipService();
    const maintenanceRunStateStore =
        maintenanceRunStateStoreOverride ?? MaintenanceRunStateStoreLive;
    const gitRepository = makeGitRepositoryService(commandRunner);
    const gitRepositoryInvariant =
        makeGitRepositoryInvariantService(commandRunner);
    const maintenancePlannerForAgent =
        maintenancePlannerForAgentOverride ??
        ((agent: AgentClient) =>
            makeMaintenancePlanService({
                agent,
                repositoryInvariant: gitRepositoryInvariant,
            }));
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
    const pipelineRepairExecutor =
        pipelineRepairExecutorOverride ??
        makePipelineRepairExecutorService({
            issueOperations: gitIssueOperations,
            checkpoint: gitIssueCheckpoint,
            captureCheckpoint: gitIssueCheckpoint.capture,
            stagedTreeSha: issueVerification.stagedTreeSha,
        });
    const pipelineDeliveryGit: PipelineDeliveryGitService =
        pipelineDeliveryGitOverride ??
        makePipelineDeliveryGitService(commandRunner);
    const actualPipelineRunStateStore =
        pipelineRunStateStoreOverride ?? pipelineRunStateStore;
    const pipelineDeliveryLifecycle =
        pipelineDeliveryLifecycleOverride ??
        makePipelineDeliveryLifecycle({
            repository: gitRepository,
            git: pipelineDeliveryGit,
            observation: pipelineObservation,
            diagnostics: async (input) => {
                const result = await pipelineDiagnostics.collectAndStore(input);
                return { boundary: result.boundary, path: result.path };
            },
            repair: pipelineRepairExecutor,
            repositoryInvariant: gitRepositoryInvariant,
            remoteSafety: gitRemoteSafety,
            state: makePipelineDeliveryStateAdapter({
                store: actualPipelineRunStateStore,
            }),
            progress,
        });
    const pullRequestReviewCoordinator =
        makePullRequestReviewCoordinatorService({
            pullRequests: githubPullRequests,
            reviewAttempt: pullRequestReviewAttempt,
            issueOperations: gitIssueOperations,
            verification: issueVerification,
            revisionDelivery: gitRevisionDelivery,
            commandRunner,
        });
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
        pipelineDiagnostics,
        pipelineRepairExecutor,
        pipelineDeliveryLifecycle,
        pipelineDeliveryGit,
        githubIssues,
        githubIssueMutations,
        githubIssueRelationships,
        parentCompletion,
        githubPullRequests,
        pullRequestReviewAttempt,
        pullRequestReviewCoordinator,
        githubNeedsAttentionNotification,
        maintenanceSnapshot,
        ...(maintenancePlannerOverride === undefined
            ? {}
            : { maintenancePlanner: maintenancePlannerOverride }),
        maintenancePlannerForAgent,
        maintenanceMutation,
        maintenanceRelationships,
        maintenanceRunStateStore,
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
        pipelineRunStateStore: actualPipelineRunStateStore,
        workspace,
    };
};

export const LiveRuntime = makeLiveRuntime;

export { makeOpenCodeService };