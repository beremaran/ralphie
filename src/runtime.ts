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
    makeGitHubIssuesService,
    type GitHubIssuesService,
} from "./github/issues.ts";
import {
    makeGitHubPullRequestService,
    type GitHubPullRequestService,
} from "./github/pull-requests.ts";
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
    makeDryRunIssueExecutorService,
    type DryRunIssueExecutorService,
} from "./issues/dry-run-executor.ts";
import {
    makeImplementationExecutorService,
    type ImplementationExecutorService,
} from "./issues/implementation-executor.ts";
import { makeIssueVerificationService } from "./issues/verification.ts";
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
import { makePiService, type PiService } from "./pi/server.ts";
import { type ProgressReporterService } from "./progress/progress.ts";
import { RunStateStoreLive, type RunStateStoreService } from "./run/state.ts";
import { WorkspaceLive, type WorkspaceService } from "./workspace/workspace.ts";

/** All dependencies needed by a workflow run. */
export type RalphieRuntime = {
    readonly commandRunner: CommandRunnerService;
    readonly githubClient: GitHubClientService;
    readonly githubIssues: GitHubIssuesService;
    readonly githubIssueMutations: GitHubIssueMutationService;
    readonly githubPullRequests: GitHubPullRequestService;
    readonly gitRepository: GitRepositoryService;
    readonly gitRepositoryInvariant: GitRepositoryInvariantService;
    readonly gitIssueCheckpoint: GitIssueCheckpointService;
    readonly gitIssueOperations: GitIssueOperationsService;
    readonly gitIssuePreparation: GitIssuePreparationService;
    readonly gitRemoteSafety: GitRemoteSafetyService;
    readonly issueArtifactStore: IssueArtifactStoreService;
    readonly complexityAssessment: ComplexityAssessmentService;
    readonly groundingAssessment: GroundingAssessmentService;
    readonly decompositionExecutor: DecompositionExecutorService;
    readonly implementationExecutor: ImplementationExecutorService;
    readonly dryRunIssueExecutor: DryRunIssueExecutorService;
    readonly issueExecutor: IssueExecutorService;
    readonly issueRecovery: IssueRecoveryService;
    readonly pi: PiService;
    readonly progress: ProgressReporterService;
    readonly runStateStore: RunStateStoreService;
    readonly workspace: WorkspaceService;
};

export type RuntimeOverrides = {
    readonly pi: PiService;
    readonly progress: ProgressReporterService;
    readonly commandRunner?: CommandRunnerService;
    readonly runStateStore?: RunStateStoreService;
    readonly workspace?: WorkspaceService;
};

/** Assemble the small object graph for one run. */
export const makeLiveRuntime = ({
    pi,
    progress,
    commandRunner = CommandRunnerLive,
    runStateStore = RunStateStoreLive,
    workspace = WorkspaceLive,
}: RuntimeOverrides): RalphieRuntime => {
    const githubClient = makeGitHubClientService(commandRunner);
    const githubIssues = makeGitHubIssuesService();
    const githubIssueMutations = makeGitHubIssueMutationsService();
    const githubPullRequests = makeGitHubPullRequestService();
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
    );
    const issueVerification = makeIssueVerificationService(commandRunner);
    const complexityAssessment = makeComplexityAssessmentService(progress);
    const groundingAssessment = makeGroundingAssessmentService(progress);
    const decompositionExecutor = makeDecompositionExecutorService(
        githubIssueMutations,
        githubIssues,
        progress,
    );
    const implementationExecutor = makeImplementationExecutorService(
        actualGitIssuePreparation,
        gitIssueOperations,
        gitRemoteSafety,
        issueRecovery,
        progress,
        issueVerification,
    );
    const dryRunIssueExecutor = makeDryRunIssueExecutorService(
        issueArtifactStore,
        complexityAssessment,
        progress,
    );
    const issueExecutor = makeIssueExecutorService(
        issueArtifactStore,
        complexityAssessment,
        implementationExecutor,
        decompositionExecutor,
        groundingAssessment,
    );
    return {
        commandRunner,
        githubClient,
        githubIssues,
        githubIssueMutations,
        githubPullRequests,
        gitRepository,
        gitRepositoryInvariant,
        gitIssueCheckpoint,
        gitIssueOperations,
        gitIssuePreparation: actualGitIssuePreparation,
        gitRemoteSafety,
        issueArtifactStore,
        complexityAssessment,
        groundingAssessment,
        decompositionExecutor,
        implementationExecutor,
        dryRunIssueExecutor,
        issueExecutor,
        issueRecovery,
        pi,
        progress,
        runStateStore,
        workspace,
    };
};

export const LiveRuntime = makeLiveRuntime;

export { makePiService };