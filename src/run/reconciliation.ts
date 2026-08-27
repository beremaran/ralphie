import { RunStateStatus, type RunState } from "./state.ts";
import { RalphieError } from "../shared/error.ts";
import { IssueExecutionOutcomeKind } from "../issues/execution.ts";
import { ProgressStage } from "../progress/progress.ts";

export enum RunReconciliationStatus {
    Compatible = "compatible",
    RepositoryMismatch = "repository-mismatch",
    BranchMismatch = "branch-mismatch",
    GitMismatch = "git-mismatch",
    GitHubMismatch = "github-mismatch",
    Stale = "stale",
}

export type RunGitInputs = {
    readonly branch: string;
    readonly head: string;
};

export type RunGitHubInputs = {
    readonly openIssueNumbers: ReadonlyArray<number>;
};

export type RunReconciliationInputs = {
    readonly repository: string;
    readonly branch: string;
    readonly git?: RunGitInputs;
    readonly github?: RunGitHubInputs;
    readonly now?: Date;
    readonly maxAgeMs?: number;
};

export type RunReconciliation = {
    readonly compatible: boolean;
    readonly status: RunReconciliationStatus;
    readonly reasons: ReadonlyArray<string>;
};

export const reconcileRunState = (
    state: RunState,
    inputs: RunReconciliationInputs,
): RunReconciliation => {
    const reasons: string[] = [];
    let status = RunReconciliationStatus.Compatible;

    if (state.repository !== inputs.repository) {
        status = RunReconciliationStatus.RepositoryMismatch;
        reasons.push(
            `saved repository is ${state.repository}, requested repository is ${inputs.repository}`,
        );
    } else if (state.branch !== inputs.branch) {
        status = RunReconciliationStatus.BranchMismatch;
        reasons.push(
            `saved branch is ${state.branch}, requested branch is ${inputs.branch}`,
        );
    }

    if (inputs.git !== undefined) {
        if (inputs.git.branch !== state.branch) {
            status = RunReconciliationStatus.GitMismatch;
            reasons.push(
                `current checkout is on ${inputs.git.branch}, expected ${state.branch}`,
            );
        }
        if (
            state.checkout !== undefined &&
            inputs.git.head.toLowerCase() !== state.checkout.head.toLowerCase()
        ) {
            status = RunReconciliationStatus.GitMismatch;
            reasons.push(
                `current HEAD is ${inputs.git.head}, expected ${state.checkout.head}`,
            );
        }
    }

    if (inputs.github !== undefined) {
        const openIssues = new Set(inputs.github.openIssueNumbers);
        const recoverableClosureIssue =
            state.activeIssue?.stage === ProgressStage.IssueClosure &&
            state.outcomes.some(
                ({ issueNumber, outcome }) =>
                    issueNumber === state.activeIssue?.issueNumber &&
                    outcome.kind === IssueExecutionOutcomeKind.Completed,
            )
                ? state.activeIssue.issueNumber
                : undefined;
        const missing = state.queue.pending
            .map((issue) => issue.number)
            .filter(
                (number) =>
                    !openIssues.has(number) &&
                    number !== recoverableClosureIssue,
            );
        if (missing.length > 0) {
            status = RunReconciliationStatus.GitHubMismatch;
            reasons.push(
                `saved pending issues are no longer open: ${missing.join(", ")}`,
            );
        }
    }

    if (
        inputs.maxAgeMs !== undefined &&
        inputs.now !== undefined &&
        inputs.now.getTime() - new Date(state.updatedAt).getTime() >
            inputs.maxAgeMs
    ) {
        status = RunReconciliationStatus.Stale;
        reasons.push(`saved state was last updated at ${state.updatedAt}`);
    }

    return {
        compatible: reasons.length === 0,
        status,
        reasons,
    };
};

export type RunReconciliationService = {
    readonly reconcile: (
        state: RunState,
        inputs: RunReconciliationInputs,
    ) => Promise<RunReconciliation>;
};

export const makeRunReconciliationService = (): RunReconciliationService => ({
    reconcile: async (state, inputs) => {
        try {
            const result = reconcileRunState(state, inputs);
            if (
                result.compatible &&
                state.status !== RunStateStatus.Active &&
                state.status !== RunStateStatus.Complete
            ) {
                throw new Error("Unsupported run-state status.");
            }
            return result;
        } catch (cause) {
            throw new RalphieError({
                message: "Could not reconcile run state.",
                cause,
            });
        }
    },
});

export enum RunStateCleanupAction {
    Preserve = "preserve",
    Remove = "remove",
}

export const planRunStateCleanup = (
    state: RunState,
    cleanupRequested: boolean,
): RunStateCleanupAction =>
    state.status === RunStateStatus.Complete && cleanupRequested
        ? RunStateCleanupAction.Remove
        : RunStateCleanupAction.Preserve;