import { RunStateStatus, type RunState } from "./state.ts";
import { RalphieError } from "../shared/error.ts";
import { IssueExecutionOutcomeKind } from "../issues/execution.ts";

export type RunReconciliationStatus =
    | "compatible"
    | "repository-mismatch"
    | "branch-mismatch"
    | "git-mismatch"
    | "github-mismatch"
    | "stale";

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

type ReconciliationFinding = {
    readonly status: RunReconciliationStatus;
    readonly reason: string;
};

const repositoryFindings = (
    state: RunState,
    inputs: RunReconciliationInputs,
): ReadonlyArray<ReconciliationFinding> => {
    if (state.repository !== inputs.repository) {
        return [
            {
                status: "repository-mismatch",
                reason: `saved repository is ${state.repository}, requested repository is ${inputs.repository}`,
            },
        ];
    }
    if (state.branch !== inputs.branch) {
        return [
            {
                status: "branch-mismatch",
                reason: `saved branch is ${state.branch}, requested branch is ${inputs.branch}`,
            },
        ];
    }
    return [];
};

const gitFindings = (
    state: RunState,
    inputs: RunReconciliationInputs,
): ReadonlyArray<ReconciliationFinding> => {
    if (inputs.git === undefined) return [];
    const findings: ReconciliationFinding[] = [];
    if (inputs.git.branch !== state.branch) {
        findings.push({
            status: "git-mismatch",
            reason: `current checkout is on ${inputs.git.branch}, expected ${state.branch}`,
        });
    }
    if (
        state.checkout !== undefined &&
        inputs.git.head.toLowerCase() !== state.checkout.head.toLowerCase()
    ) {
        findings.push({
            status: "git-mismatch",
            reason: `current HEAD is ${inputs.git.head}, expected ${state.checkout.head}`,
        });
    }
    return findings;
};

const githubFindings = (
    state: RunState,
    inputs: RunReconciliationInputs,
): ReadonlyArray<ReconciliationFinding> => {
    if (inputs.github === undefined) return [];
    const openIssues = new Set(inputs.github.openIssueNumbers);
    const recoverableClosureIssue =
        state.activeIssue?.stage === "issue-closure" &&
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
                !openIssues.has(number) && number !== recoverableClosureIssue,
        );
    if (missing.length === 0) return [];
    return [
        {
            status: "github-mismatch",
            reason: `saved pending issues are no longer open: ${missing.join(", ")}`,
        },
    ];
};

const ageFindings = (
    state: RunState,
    inputs: RunReconciliationInputs,
): ReadonlyArray<ReconciliationFinding> => {
    if (
        inputs.maxAgeMs === undefined ||
        inputs.now === undefined ||
        inputs.now.getTime() - new Date(state.updatedAt).getTime() <=
            inputs.maxAgeMs
    ) {
        return [];
    }
    return [
        {
            status: "stale",
            reason: `saved state was last updated at ${state.updatedAt}`,
        },
    ];
};

export const reconcileRunState = (
    state: RunState,
    inputs: RunReconciliationInputs,
): RunReconciliation => {
    const findings = [
        ...repositoryFindings(state, inputs),
        ...gitFindings(state, inputs),
        ...githubFindings(state, inputs),
        ...ageFindings(state, inputs),
    ];
    let status: RunReconciliationStatus = "compatible";
    const reasons: string[] = [];
    for (const finding of findings) {
        status = finding.status;
        reasons.push(finding.reason);
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

export type RunStateCleanupAction = "preserve" | "remove";

export const planRunStateCleanup = (
    state: RunState,
    cleanupRequested: boolean,
): RunStateCleanupAction =>
    state.status === RunStateStatus.Complete && cleanupRequested
        ? "remove"
        : "preserve";