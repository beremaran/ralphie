import { CommandRunnerLive } from "./process/adapters/command-runner.ts";
import { type CommandRunnerService } from "./process/ports.ts";
import { makeGitIssueCheckpointService } from "./git/adapters/issue-checkpoint.ts";
import { type GitIssueCheckpointService } from "./git/ports.ts";
import { makeGitIssueOperationsService } from "./git/adapters/issue-operations.ts";
import { type GitIssueOperationsService } from "./git/ports.ts";
import { makeGitIssuePreparationService } from "./issues/app/issue-preparation.ts";
import { type GitIssuePreparationService } from "./issues/ports.ts";
import { makeGitRemoteSafetyService } from "./git/adapters/remote-safety.ts";
import { type GitRemoteSafetyService } from "./git/ports.ts";
import { makeGitRepositoryInvariantService } from "./git/adapters/repository-invariant.ts";
import { type GitRepositoryInvariantService } from "./git/ports.ts";
import { makeGitRepositoryService } from "./git/adapters/repository.ts";
import { type GitRepositoryService } from "./git/ports.ts";
import { makeGitHubConnection } from "./github/adapters/session.ts";
import { type GitHubConnectionService } from "./github/ports.ts";
import { makeGitHubIssueMutationsService } from "./github/adapters/issue-mutations.ts";
import { type GitHubIssueMutationService } from "./github/ports.ts";
import { makeGitHubIssueRelationshipService } from "./github/adapters/issue-relationships.ts";
import { type GitHubIssueRelationshipService } from "./github/ports.ts";
import { makeParentCompletionService } from "./issues/app/parent-completion.ts";
import { type ParentCompletionService } from "./issues/ports.ts";
import { makeGitHubIssuesService } from "./github/adapters/issues.ts";
import { type GitHubIssuesService } from "./github/ports.ts";
import { makeGitHubNeedsAttentionNotificationService } from "./github/adapters/needs-attention.ts";
import { type GitHubNeedsAttentionNotificationService } from "./github/ports.ts";
import {
    makeIssueArtifactStoreService,
    type IssueArtifactStoreService,
} from "./issues/app/artifacts.ts";
import { nodeIssueArtifactFileSystem } from "./issues/adapters/artifact-file-system.ts";
import {
    makeComplexityAssessmentService,
    type ComplexityAssessmentService,
} from "./issues/app/complexity.ts";
import {
    makeDecompositionExecutorService,
    type DecompositionExecutorService,
} from "./issues/app/decomposition-executor.ts";
import {
    makeImplementationExecutorService,
    type ImplementationExecutorService,
} from "./issues/app/implementation-executor.ts";
import { makeIssueVerificationService } from "./issues/app/verification.ts";
import {
    makeResolutionVerificationService,
    type ResolutionVerificationService,
} from "./issues/app/resolution-verification.ts";
import {
    makeIssueExecutorService,
    type IssueExecutorService,
} from "./issues/app/executor.ts";
import {
    makeIssueRecoveryService,
    type IssueRecoveryService,
} from "./issues/app/recovery.ts";
import { nodeRecoveryFileSystem } from "./issues/adapters/recovery-file-system.ts";
import {
    makeGroundingAssessmentService,
    type GroundingAssessmentService,
} from "./issues/app/grounding.ts";
import {
    makeNeedsAttentionRouterService,
    type NeedsAttentionRouterService,
} from "./issues/app/needs-attention.ts";
import { type PiAgentService } from "./pi/ports.ts";
import { type ProgressReporterService } from "./progress/ports.ts";
import {
    type Clock,
    type IdGenerator,
    type RunEventLog,
    type RunLayout,
} from "./run/ports.ts";
import { RunStateStoreLive } from "./run/adapters/state.ts";
import { type RunStateStoreService } from "./run/ports.ts";
import { makeIdGenerator, systemClock } from "./run/adapters/env.ts";
import { WorkspaceLive } from "./workspace/adapters/workspace.ts";
import { type WorkspaceService } from "./workspace/ports.ts";

export type { IssueWorkflowRuntime } from "./workflow/ports.ts";

/** Concrete adapter assembly for one run. Only the command wiring consumes this broad shape; the workflow depends on its focused seam. */
export type RalphieRuntime = {
    readonly commandRunner: CommandRunnerService;
    readonly githubConnection: GitHubConnectionService;
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
    readonly layout: RunLayout;
    readonly clock: Clock;
    readonly ids: IdGenerator;
    readonly workspace: WorkspaceService;
};

export type RuntimeOverrides = {
    readonly agentRuntime: PiAgentService;
    readonly progress: ProgressReporterService;
    readonly runEventLog: RunEventLog;
    readonly layout: RunLayout;
    readonly clock?: Clock;
    readonly ids?: IdGenerator;
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
    layout,
    clock = systemClock,
    ids = makeIdGenerator(),
    commandRunner = CommandRunnerLive,
    runStateStore = RunStateStoreLive,
    workspace = WorkspaceLive,
}: RuntimeOverrides): RalphieRuntime => {
    const githubConnection = makeGitHubConnection(commandRunner);
    const githubIssues = makeGitHubIssuesService(githubConnection.session);
    const githubIssueMutations = makeGitHubIssueMutationsService(
        githubConnection.session,
    );
    const githubIssueRelationships = makeGitHubIssueRelationshipService(
        githubConnection.session,
    );
    const parentCompletion = makeParentCompletionService({
        issues: githubIssues,
        relationships: githubIssueRelationships,
        mutations: githubIssueMutations,
    });
    const githubNeedsAttentionNotification =
        makeGitHubNeedsAttentionNotificationService(githubConnection.session);
    const gitRepository = makeGitRepositoryService(commandRunner);
    const gitRepositoryInvariant =
        makeGitRepositoryInvariantService(commandRunner);
    const gitIssueCheckpoint = makeGitIssueCheckpointService(commandRunner);
    const gitIssueOperations = makeGitIssueOperationsService(commandRunner);
    const gitRemoteSafety = makeGitRemoteSafetyService(commandRunner);
    const issueArtifactStore = makeIssueArtifactStoreService({
        fileSystem: nodeIssueArtifactFileSystem,
        layout,
        ids,
    });
    const actualGitIssuePreparation = makeGitIssuePreparationService(
        gitIssueCheckpoint,
        issueArtifactStore,
    );
    const issueRecovery = makeIssueRecoveryService(
        {
            fileSystem: nodeRecoveryFileSystem,
            layout,
            clock,
            ids,
        },
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
        githubConnection,
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
        layout,
        clock,
        ids,
        workspace,
    };
};