/**
 * One-shot, sequential maintenance execution.
 *
 * The runner owns scheduling, durable progress, and reporting only.  It does
 * not know how to edit GitHub: plans go through the two deterministic
 * maintenance adapters, and each adapter performs its own authoritative live
 * read/reconciliation before it can mutate anything.
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { type AgentClient } from "./opencode/client.ts";
import {
    makeMaintenancePlanService,
    maintenanceActionKey,
    validateIssueMaintenancePlan,
    type MaintenancePlanService,
    type ValidatedIssueMaintenanceAction,
    type ValidatedIssueMaintenancePlan,
} from "./maintain-issues-plan.ts";
import type {
    MaintenanceCandidate,
    MaintenanceCandidateAnalysis,
} from "./maintain-issues-candidates.ts";
import {
    type MaintenanceSnapshot,
    type MaintenanceSnapshotService,
} from "./maintain-issues-snapshot-service.ts";
import {
    MaintenanceRunStateStoreLive,
    type MaintenanceActionState,
    type MaintenanceIssueState,
    type MaintenanceReconciliationState,
    type MaintenanceRunState,
    type MaintenanceRunStateStoreService,
    type MaintenanceSelectionState,
    type MaintenanceStoredPlan,
    loadMaintenanceRunState,
    validateMaintenanceResumeState,
} from "./maintain-issues-state.ts";
import {
    type GitHubIssueMaintenanceRelationshipService,
    type RelationshipMutationResult,
} from "./github/issue-maintenance-relationships.ts";
import {
    type GitHubIssueMaintenanceService,
    type MaintenanceMutationResult,
} from "./github/issue-maintenance.ts";
import { type RalphieRuntime } from "./runtime.ts";
import {
    DuplicateAction,
    type MaintainIssuesRalphieConfig,
} from "./options.ts";
import {
    type ProgressIssue,
    type ProgressReporterService,
} from "./progress/progress.ts";
import { rateLimitFromUnknown } from "./github/rate-limit.ts";
import { parseRepositorySlug } from "./github/repository.ts";
import { type CommandResult } from "./process/command-runner.ts";
import { RalphieError } from "./shared/error.ts";
import { resolveWorkspacePath } from "./workspace/workspace.ts";

export const MAINTENANCE_MAX_REPLANS = 2;
export const MAINTENANCE_RATE_LIMIT_MAX_RETRIES = 3;
export const MAINTENANCE_RATE_LIMIT_DEFAULT_DELAY_MS = 100;
export const MAINTENANCE_RATE_LIMIT_MAX_DELAY_MS = 1_000;

/** Inputs reserved for the mode-specific maintenance workflow. */
export type MaintainIssuesOptions = {
    readonly config: MaintainIssuesRalphieConfig;
    readonly runId: string;
    readonly signal?: AbortSignal;
    /** Set only when the operator supplied --duplicate-action on resume. */
    readonly explicitDuplicateAction?: DuplicateAction;
    /** Loaded by the command before it creates OpenCode/output resources. */
    readonly resumeState?: MaintenanceRunState;
};

/** Typed dispatch seam for maintenance runs. */
export type MaintainIssuesEntryPoint = (
    options: MaintainIssuesOptions,
    runtime: RalphieRuntime,
) => Promise<void>;

export type MaintenanceActionCounts = {
    readonly unchanged: number;
    readonly changed: number;
    readonly skipped: number;
    readonly replanned: number;
    readonly failed: number;
};

export type MaintenanceRunSummary = {
    readonly runId: string;
    readonly repository: string;
    readonly branch: string;
    readonly statePath: string;
    readonly snapshotFingerprint: string;
    readonly selectedIssueNumbers: ReadonlyArray<number>;
    readonly counts: MaintenanceActionCounts;
    readonly dryRun: boolean;
    /** Lossless action/skip evidence for JSON callers and verbose output. */
    readonly evidence: ReadonlyArray<unknown>;
};

class MaintenanceExecutionError extends RalphieError {
    override readonly _tag = "MaintenanceExecutionError" as const;
}

type MaintenanceResult = MaintenanceMutationResult | RelationshipMutationResult;

type MaintenanceRecordedResult = {
    readonly actionKey: string;
    readonly issueNumber: number;
    readonly status: string;
};

type MaintenanceReportResult = {
    readonly status: "applied" | "unchanged" | "skipped" | "failed";
    readonly result: unknown;
};

type MutableMaintenanceState = MaintenanceRunState;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

const nowIso = (): string => new Date().toISOString();

const checkCancellation = (signal: AbortSignal | undefined): void => {
    if (signal?.aborted !== true) return;
    throw (
        signal.reason ??
        Object.assign(new Error("Maintenance run was cancelled."), {
            name: "AbortError",
        })
    );
};

const issueProgress = (
    snapshot: MaintenanceSnapshot,
    issueNumber: number,
): ProgressIssue => {
    const detailed = snapshot.selectedIssues.find(
        (issue) => issue.number === issueNumber,
    );
    if (detailed !== undefined) {
        return { number: issueNumber, title: detailed.title };
    }
    const summary = snapshot.openIssueSummaries.find(
        (issue) => issue.number === issueNumber,
    );
    return {
        number: issueNumber,
        title: summary?.title ?? `Issue #${String(issueNumber)}`,
    };
};

const isRelationshipAction = (
    action: ValidatedIssueMaintenanceAction,
): action is Extract<
    ValidatedIssueMaintenanceAction,
    {
        readonly action: "link-duplicate" | "close-duplicate" | "link-related";
    }
> =>
    action.action === "link-duplicate" ||
    action.action === "close-duplicate" ||
    action.action === "link-related";

const candidateAnalysisFrom = (
    value: unknown,
): MaintenanceCandidateAnalysis | undefined => {
    if (!isRecord(value) || !Array.isArray(value.candidates)) return undefined;
    if (
        typeof value.status !== "string" ||
        typeof value.subjectIssueNumber !== "number" ||
        typeof value.snapshotFingerprint !== "string" ||
        !Array.isArray(value.skips)
    ) {
        return undefined;
    }
    return value as unknown as MaintenanceCandidateAnalysis;
};

const candidateFor = (
    analysis: MaintenanceCandidateAnalysis | undefined,
    action: ValidatedIssueMaintenanceAction,
): MaintenanceCandidate | undefined => {
    if (!isRelationshipAction(action) || analysis === undefined)
        return undefined;
    return analysis.candidates.find(
        (candidate) => candidate.candidateId === action.candidateId,
    );
};

const actionRecord = (
    action: ValidatedIssueMaintenanceAction,
): Record<string, unknown> => action as unknown as Record<string, unknown>;

const actionStateFor = (
    action: ValidatedIssueMaintenanceAction,
    replanCount: number,
    previous: MaintenanceActionState | undefined,
    preserveSkipped: boolean,
): MaintenanceActionState => {
    const previousCanResume =
        previous !== undefined &&
        (preserveSkipped ||
            (previous.status !== "skipped" && previous.status !== "pending"));
    return {
        actionKey: action.actionKey,
        action: actionRecord(action),
        status: previousCanResume ? previous.status : "pending",
        attempts: previousCanResume ? previous.attempts : 0,
        replanCount,
        ...(previousCanResume && previous.result !== undefined
            ? { result: previous.result }
            : {}),
        updatedAt: nowIso(),
    };
};

const actionStatesFor = (
    plan: ValidatedIssueMaintenancePlan,
    previous: ReadonlyArray<MaintenanceActionState>,
    replanCount: number,
    preserveSkipped: boolean,
): ReadonlyArray<MaintenanceActionState> => {
    const previousByKey = new Map(
        previous.map((action) => [action.actionKey, action]),
    );
    return Object.freeze(
        plan.actions.map((action) =>
            actionStateFor(
                action,
                replanCount,
                previousByKey.get(action.actionKey),
                preserveSkipped,
            ),
        ),
    );
};

const emptyIssueState = (issueNumber: number): MaintenanceIssueState => ({
    issueNumber,
    status: "pending",
    replanCount: 0,
    replanRequested: false,
    skips: [],
    actions: [],
    updatedAt: nowIso(),
});

const selectionFor = (
    config: MaintainIssuesRalphieConfig,
): MaintenanceSelectionState =>
    ({
        agent: config.agent,
        ...(config.model === undefined ? {} : { model: config.model }),
        ...(config.thinking === undefined ? {} : { variant: config.thinking }),
        ...(config.maxIssues === undefined
            ? {}
            : { maxIssues: config.maxIssues }),
        issueLabels: [...config.issueLabels],
        issueSort: config.issueSort,
        issueOrder: config.issueOrder,
    }) as MaintenanceSelectionState;

const selectionInputFor = (selection: MaintenanceSelectionState) => ({
    ...(selection.maxIssues === undefined
        ? {}
        : { maxIssues: selection.maxIssues }),
    issueLabels: [...selection.issueLabels],
    issueSort: selection.issueSort,
    issueOrder: selection.issueOrder,
});

const repositoryPathFor = (config: MaintainIssuesRalphieConfig): string => {
    const repository = parseRepositorySlug(config.repo);
    const workspace = resolveWorkspacePath(config.workspace);
    return join(workspace, repository.owner, repository.name);
};

const existingCheckoutPathFor = async (
    config: MaintainIssuesRalphieConfig,
): Promise<string> => {
    const workspace = resolveWorkspacePath(config.workspace);
    try {
        await stat(join(workspace, ".git"));
        return workspace;
    } catch {
        return repositoryPathFor(config);
    }
};

const statusFrom = (value: unknown): number | undefined => {
    if (!isRecord(value)) return undefined;
    const response = value.response;
    const nested = isRecord(response) ? response.status : undefined;
    const status = nested ?? value.status;
    return typeof status === "number" && Number.isFinite(status)
        ? status
        : undefined;
};

const isRateLimitFailure = (value: unknown): boolean => {
    const status = statusFrom(value);
    if (status === 429) return true;
    const metadata = rateLimitFromUnknown(value);
    if (metadata?.remaining === 0 || metadata?.retryAfterMs !== undefined)
        return true;
    if (status !== 403) return false;
    return metadata?.remaining === 0;
};

const sleepWithCancellation = async (
    milliseconds: number,
    signal: AbortSignal | undefined,
): Promise<void> => {
    checkCancellation(signal);
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, milliseconds);
        const onAbort = () => {
            clearTimeout(timer);
            reject(
                signal?.reason ??
                    Object.assign(new Error("Maintenance run was cancelled."), {
                        name: "AbortError",
                    }),
            );
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
};

/** Retry only an explicitly rate-limited read, with a small hard bound. */
export const withMaintenanceRateLimitRetry = async <Result>(input: {
    readonly operation: string;
    readonly run: () => Promise<Result>;
    readonly signal?: AbortSignal;
    readonly onRetry?: (input: {
        readonly operation: string;
        readonly attempt: number;
        readonly delayMs: number;
        readonly error: unknown;
    }) => Promise<void>;
}): Promise<Result> => {
    let attempt = 0;
    while (true) {
        checkCancellation(input.signal);
        try {
            return await input.run();
        } catch (error) {
            if (
                !isRateLimitFailure(error) ||
                attempt >= MAINTENANCE_RATE_LIMIT_MAX_RETRIES
            ) {
                throw error;
            }
            const metadata = rateLimitFromUnknown(error);
            const exponential =
                MAINTENANCE_RATE_LIMIT_DEFAULT_DELAY_MS * 2 ** attempt;
            const delayMs = Math.min(
                MAINTENANCE_RATE_LIMIT_MAX_DELAY_MS,
                Math.max(0, metadata?.retryAfterMs ?? exponential),
            );
            attempt += 1;
            await input.onRetry?.({
                operation: input.operation,
                attempt,
                delayMs,
                error,
            });
            await sleepWithCancellation(delayMs, input.signal);
        }
    }
};

const commandSucceeded = (value: CommandResult): boolean =>
    value.exitCode === 0;

const readOnlyFallbackBranch = async (
    runtime: RalphieRuntime,
    repositoryPath: string,
    currentBranch: string,
    signal: AbortSignal | undefined,
): Promise<string> => {
    const commandRunner = runtime.commandRunner;
    if (typeof commandRunner?.run !== "function") return currentBranch;
    for (const branch of ["main", "master"] as const) {
        checkCancellation(signal);
        let result: CommandResult;
        try {
            result = await commandRunner.run(
                "git",
                [
                    "-C",
                    repositoryPath,
                    "rev-parse",
                    "--verify",
                    `refs/remotes/origin/${branch}`,
                ],
                { signal },
            );
        } catch {
            continue;
        }
        if (commandSucceeded(result)) return branch;
    }
    return currentBranch;
};

const planForState = (
    snapshot: MaintenanceSnapshot,
    issueNumber: number,
    issueState: MaintenanceIssueState,
):
    | {
          readonly plan: ValidatedIssueMaintenancePlan;
          readonly candidates: MaintenanceCandidateAnalysis;
      }
    | undefined => {
    if (
        issueState.plan === undefined ||
        issueState.replanRequested ||
        issueState.status === "skipped" ||
        issueState.status === "complete"
    ) {
        return undefined;
    }
    const validation = validateIssueMaintenancePlan(
        snapshot,
        issueNumber,
        issueState.plan,
    );
    if (validation.status !== "accepted") return undefined;
    const candidates = candidateAnalysisFrom(issueState.candidates);
    if (candidates === undefined) return undefined;
    return { plan: validation.plan, candidates };
};

const resultStatusForReport = (
    result: MaintenanceResult | { readonly status: "dry-run" },
): MaintenanceReportResult["status"] => {
    if (result.status === "applied") return "applied";
    if (result.status === "unchanged") return "unchanged";
    if (result.status === "recovery-required") return "failed";
    return "skipped";
};

const summaryFromReports = (
    reports: ReadonlyArray<MaintenanceReportResult>,
    state: MaintenanceRunState,
    failedDuringRun: boolean,
): MaintenanceActionCounts => {
    let unchanged = 0;
    let changed = 0;
    let skipped = 0;
    let failed =
        failedDuringRun && !reports.some((report) => report.status === "failed")
            ? 1
            : 0;
    for (const report of reports) {
        switch (report.status) {
            case "applied":
                changed += 1;
                break;
            case "unchanged":
                unchanged += 1;
                break;
            case "skipped":
                skipped += 1;
                break;
            case "failed":
                failed += 1;
                break;
        }
    }
    return {
        unchanged,
        changed,
        skipped,
        replanned: state.issues.reduce(
            (total, issue) => total + issue.replanCount,
            0,
        ),
        failed,
    };
};

const storedPlanFor = (
    issueNumber: number,
    plan: ValidatedIssueMaintenancePlan,
    candidates: MaintenanceCandidateAnalysis,
    replanCount: number,
): MaintenanceStoredPlan => ({
    issueNumber,
    snapshotFingerprint: plan.snapshotFingerprint,
    plan,
    candidates,
    skips: [],
    replanCount,
    recordedAt: nowIso(),
});

const relationshipActionFor = (
    action: ValidatedIssueMaintenanceAction,
): boolean => isRelationshipAction(action);

const evidenceFromResult = (
    result: MaintenanceResult,
): ReadonlyArray<unknown> => ("evidence" in result ? [result.evidence] : []);

const groundedAtSnapshot = async (input: {
    readonly runtime: RalphieRuntime;
    readonly snapshot: MaintenanceSnapshot;
    readonly repositoryPath: string;
    readonly branch: string;
    readonly signal?: AbortSignal;
}): Promise<
    | { readonly current: true }
    | { readonly current: false; readonly detail: string }
> => {
    const grounding = input.snapshot.grounding;
    if (grounding === undefined) return { current: true };
    const current = await input.runtime.gitRepositoryInvariant.capture(
        input.repositoryPath,
        input.signal,
    );
    if (
        current.branch !== input.branch ||
        current.branch !== grounding.branch ||
        current.head.toLowerCase() !== grounding.head.toLowerCase()
    ) {
        return {
            current: false,
            detail:
                `grounding HEAD changed from ${grounding.head} to ${current.head} ` +
                `(branch ${current.branch}); the action must be replanned`,
        };
    }
    return { current: true };
};

const issueStateWith = (
    state: MutableMaintenanceState,
    index: number,
    issue: MaintenanceIssueState,
): MutableMaintenanceState => ({
    ...state,
    issues: state.issues.map((entry, entryIndex) =>
        entryIndex === index ? issue : entry,
    ),
    updatedAt: nowIso(),
});

const plansWith = (
    state: MutableMaintenanceState,
    storedPlan: MaintenanceStoredPlan,
): MutableMaintenanceState => ({
    ...state,
    plans: [
        ...state.plans.filter(
            (plan) => plan.issueNumber !== storedPlan.issueNumber,
        ),
        storedPlan,
    ].sort((left, right) => left.issueNumber - right.issueNumber),
    updatedAt: nowIso(),
});

const resultStateFor = (
    state: MutableMaintenanceState,
    result: MaintenanceRecordedResult,
): MutableMaintenanceState => {
    const entry: MaintenanceReconciliationState = {
        actionKey: result.actionKey,
        issueNumber: result.issueNumber,
        status: result.status,
        result,
        recordedAt: nowIso(),
    };
    return {
        ...state,
        reconciliationResults: [...state.reconciliationResults, entry],
        skips:
            result.status === "skipped"
                ? [...state.skips, result]
                : state.skips,
        updatedAt: nowIso(),
    };
};

const stateActionWith = (
    state: MutableMaintenanceState,
    issueIndex: number,
    actionIndex: number,
    patch: Partial<MaintenanceActionState>,
): MutableMaintenanceState => {
    const issue = state.issues[issueIndex];
    if (issue === undefined) return state;
    const actions = issue.actions.map((action, currentIndex) =>
        currentIndex === actionIndex
            ? { ...action, ...patch, updatedAt: nowIso() }
            : action,
    );
    return issueStateWith(state, issueIndex, {
        ...issue,
        actions,
        updatedAt: nowIso(),
    });
};

const createInitialState = (input: {
    readonly runId: string;
    readonly repository: string;
    readonly branch: string;
    readonly duplicateAction: DuplicateAction;
    readonly selection: MaintenanceSelectionState;
    readonly dryRun: boolean;
}): MutableMaintenanceState => {
    const timestamp = nowIso();
    return {
        version: 1,
        mode: "maintain-issues",
        status: "active",
        runId: input.runId,
        repository: input.repository,
        branch: input.branch,
        duplicateAction: input.duplicateAction,
        dryRun: input.dryRun,
        selection: input.selection,
        selectedIssueNumbers: [],
        nextIssueIndex: 0,
        plans: [],
        issues: [],
        reconciliationResults: [],
        skips: [],
        createdAt: timestamp,
        updatedAt: timestamp,
    };
};

const mutationFailure = (
    message: string,
    cause?: unknown,
): MaintenanceExecutionError =>
    new MaintenanceExecutionError({
        message,
        ...(cause === undefined ? {} : { cause }),
    });

type MaintenanceClient = Awaited<
    ReturnType<RalphieRuntime["githubClient"]["initialize"]>
>;

type MaintenanceEmit = (
    update: Parameters<ProgressReporterService["emit"]>[0],
) => Promise<void>;

type MaintenanceIssueExecutionContext = {
    readonly config: MaintainIssuesRalphieConfig;
    readonly runtime: RalphieRuntime;
    readonly signal: AbortSignal | undefined;
    readonly statePath: string;
    readonly actualRunId: string;
    readonly duplicateAction: DuplicateAction;
    readonly dryRun: boolean;
    readonly selection: MaintenanceSelectionState;
    readonly selectedIssueNumbers: ReadonlyArray<number>;
    readonly maintenanceBranch: string;
    readonly maintenanceRepositoryPath: string;
    readonly maintenanceClient: MaintenanceClient;
    readonly captured: MaintenanceSnapshot;
    readonly planner: MaintenancePlanService;
    readonly reports: MaintenanceReportResult[];
    state: MutableMaintenanceState;
    readonly emit: MaintenanceEmit;
    readonly persist: (state: MutableMaintenanceState) => Promise<void>;
};

type MaintenanceActionStep = {
    readonly issue: MaintenanceIssueState;
    readonly needsReplan: boolean;
};

type ValidatedPlannerOutput = {
    readonly plan: ValidatedIssueMaintenancePlan | undefined;
    readonly skips: ReadonlyArray<{
        readonly reason: string;
        readonly actionIndex: number | null;
        readonly issueNumber: number | null;
        readonly detail: string;
    }>;
};

const validatePlannerOutput = (
    snapshot: MaintenanceSnapshot,
    issueNumber: number,
    planned: Awaited<ReturnType<MaintenancePlanService["plan"]>>,
): ValidatedPlannerOutput => {
    if (planned.status !== "accepted") {
        return { plan: undefined, skips: planned.skips };
    }
    const validation = validateIssueMaintenancePlan(
        snapshot,
        issueNumber,
        planned.plan,
    );
    return validation.status === "accepted"
        ? { plan: validation.plan, skips: planned.skips }
        : { plan: undefined, skips: validation.skips };
};

const restoreMaintenanceIssue = async (
    context: MaintenanceIssueExecutionContext,
    issueIndex: number,
    issueNumber: number,
    currentState: MaintenanceIssueState,
): Promise<MaintenanceIssueState | undefined> => {
    if (
        currentState.status === "complete" ||
        currentState.status === "skipped"
    ) {
        return currentState;
    }
    const restored = planForState(context.captured, issueNumber, currentState);
    if (restored === undefined) return undefined;
    const normalizedIssue: MaintenanceIssueState = {
        ...currentState,
        status: "planned",
        replanRequested: false,
        actions: actionStatesFor(
            restored.plan,
            currentState.actions,
            currentState.replanCount,
            true,
        ),
        updatedAt: nowIso(),
    };
    await context.persist(
        issueStateWith(context.state, issueIndex, normalizedIssue),
    );
    return normalizedIssue;
};

const planFreshMaintenanceIssue = async (
    context: MaintenanceIssueExecutionContext,
    issueIndex: number,
    issueNumber: number,
    currentState: MaintenanceIssueState,
    forceReplan: boolean,
): Promise<MaintenanceIssueState> => {
    const issue = issueProgress(context.captured, issueNumber);
    await context.emit({
        stage: "maintenance-planning",
        status: "started",
        message: `${forceReplan ? "Replanning" : "Planning"} maintenance for issue #${String(issueNumber)}...`,
        repository: context.config.repo,
        issue,
        current: issueIndex + 1,
        total: context.selectedIssueNumbers.length,
        details: {
            kind: "plan",
            replan: forceReplan,
            replanCount: currentState.replanCount,
            snapshotFingerprint: context.captured.fingerprint,
        },
    });
    const planned = await context.planner.plan({
        snapshot: context.captured,
        subjectIssueNumber: issueNumber,
        repositoryPath: context.maintenanceRepositoryPath,
        targetBranch: context.maintenanceBranch,
        signal: context.signal,
        runId: context.actualRunId,
        agentSelection: {
            agent: context.selection.agent,
            ...(context.selection.model === undefined
                ? {}
                : { model: context.selection.model }),
            ...(context.selection.variant === undefined
                ? {}
                : { variant: context.selection.variant }),
        },
    });
    checkCancellation(context.signal);
    const validated = validatePlannerOutput(
        context.captured,
        issueNumber,
        planned,
    );
    const planAccepted = validated.plan !== undefined;
    await context.emit({
        stage: "maintenance-planning",
        status: planAccepted ? "succeeded" : "skipped",
        message: planAccepted
            ? `Maintenance plan accepted for issue #${String(issueNumber)} (${validated.plan.actions.length} actions).`
            : `Maintenance plan skipped for issue #${String(issueNumber)}.`,
        repository: context.config.repo,
        issue,
        current: issueIndex + 1,
        total: context.selectedIssueNumbers.length,
        details: {
            kind: "plan",
            status: planAccepted ? "accepted" : "rejected",
            plannerStatus: planned.status,
            sessionID: planned.sessionID,
            candidates: planned.candidates,
            skips: validated.skips,
            ...(validated.plan === undefined ? {} : { plan: validated.plan }),
        },
    });
    await context.emit({
        stage: "maintenance-validation",
        status: planAccepted ? "succeeded" : "skipped",
        message: planAccepted
            ? `Validated maintenance plan for issue #${String(issueNumber)}.`
            : `No validated maintenance actions for issue #${String(issueNumber)}.`,
        repository: context.config.repo,
        issue,
        current: issueIndex + 1,
        total: context.selectedIssueNumbers.length,
        details: {
            kind: "validation",
            status: planAccepted ? "accepted" : "rejected",
            plannerStatus: planned.status,
            skips: validated.skips,
        },
    });

    if (validated.plan === undefined) {
        const skippedIssue: MaintenanceIssueState = {
            ...currentState,
            status: "skipped",
            replanRequested: false,
            plan: undefined,
            candidates: planned.candidates,
            skips: [...validated.skips],
            actions: [],
            outcome: {
                status: "skipped",
                skips: validated.skips,
            },
            updatedAt: nowIso(),
        };
        context.reports.push({
            status: "skipped",
            result: skippedIssue.outcome,
        });
        await context.persist(
            issueStateWith(
                {
                    ...context.state,
                    skips: [...context.state.skips, ...validated.skips],
                },
                issueIndex,
                skippedIssue,
            ),
        );
        return skippedIssue;
    }

    const nextIssue: MaintenanceIssueState = {
        ...currentState,
        status: "planned",
        replanRequested: false,
        plan: validated.plan,
        candidates: planned.candidates,
        skips: [...validated.skips],
        actions: actionStatesFor(
            validated.plan,
            currentState.actions,
            currentState.replanCount,
            !forceReplan,
        ),
        outcome: undefined,
        updatedAt: nowIso(),
    };
    await context.persist(
        plansWith(
            issueStateWith(context.state, issueIndex, nextIssue),
            storedPlanFor(
                issueNumber,
                validated.plan,
                planned.candidates,
                nextIssue.replanCount,
            ),
        ),
    );
    return nextIssue;
};

const planMaintenanceIssue = async (
    context: MaintenanceIssueExecutionContext,
    issueIndex: number,
    forceReplan: boolean,
): Promise<MaintenanceIssueState> => {
    const currentState = context.state.issues[issueIndex];
    const issueNumber = context.selectedIssueNumbers[issueIndex];
    if (currentState === undefined || issueNumber === undefined) {
        throw mutationFailure(
            `Maintenance issue state ${String(issueIndex)} is missing.`,
        );
    }
    if (!forceReplan) {
        const restored = await restoreMaintenanceIssue(
            context,
            issueIndex,
            issueNumber,
            currentState,
        );
        if (restored !== undefined) return restored;
    }
    return planFreshMaintenanceIssue(
        context,
        issueIndex,
        issueNumber,
        currentState,
        forceReplan,
    );
};

const requestMaintenanceReplan = async (
    context: MaintenanceIssueExecutionContext,
    issueIndex: number,
    issue: MaintenanceIssueState,
    actionIndex: number,
    detail: string,
): Promise<boolean> => {
    if (issue.replanCount >= MAINTENANCE_MAX_REPLANS) return false;
    const nextIssue: MaintenanceIssueState = {
        ...issue,
        status: "pending",
        replanRequested: true,
        replanCount: issue.replanCount + 1,
        skips: [...issue.skips, { reason: "replan", detail }],
        actions: issue.actions.map((action, index) =>
            index === actionIndex
                ? {
                      ...action,
                      status: "pending",
                      result: {
                          status: "skipped",
                          reason: "stale-plan",
                          detail,
                      },
                      updatedAt: nowIso(),
                  }
                : action,
        ),
        updatedAt: nowIso(),
    };
    await context.persist(issueStateWith(context.state, issueIndex, nextIssue));
    await context.emit({
        stage: "maintenance-replan",
        status: "info",
        message: `Replanning issue #${String(issue.issueNumber)} after live state changed.`,
        repository: context.config.repo,
        issue: issueProgress(context.captured, issue.issueNumber),
        current: issueIndex + 1,
        total: context.selectedIssueNumbers.length,
        details: {
            kind: "replan",
            actionIndex,
            replanCount: nextIssue.replanCount,
            detail,
        },
    });
    return true;
};

const emitReconciledAction = async (
    context: MaintenanceIssueExecutionContext,
    issueIndex: number,
    issue: MaintenanceIssueState,
    actionState: MaintenanceActionState,
): Promise<void> => {
    await context.emit({
        stage: "maintenance-action",
        status: "info",
        message: `Resuming past reconciled maintenance action ${actionState.actionKey}.`,
        repository: context.config.repo,
        issue: issueProgress(context.captured, issue.issueNumber),
        current: issueIndex + 1,
        total: context.selectedIssueNumbers.length,
        details: {
            kind: "action",
            actionKey: actionState.actionKey,
            status: actionState.status,
        },
    });
};

const updateIssueAction = (
    issue: MaintenanceIssueState,
    actionIndex: number,
    actionState: MaintenanceActionState,
): MaintenanceIssueState => ({
    ...issue,
    actions: issue.actions.map((entry, index) =>
        index === actionIndex ? actionState : entry,
    ),
    updatedAt: nowIso(),
});

const skipMaintenanceActionForPolicy = async (
    context: MaintenanceIssueExecutionContext,
    issueIndex: number,
    issue: MaintenanceIssueState,
    actionIndex: number,
    action: ValidatedIssueMaintenanceAction,
    actionKey: string,
): Promise<MaintenanceActionStep> => {
    const result = {
        status: "skipped" as const,
        reason: "duplicate-policy" as const,
        actionKey,
        issueNumber: issue.issueNumber,
        detail: "duplicate closure is disabled; use --duplicate-action close to opt in",
        changed: false as const,
    };
    context.reports.push({ status: "skipped", result });
    const updatedIssue = updateIssueAction(issue, actionIndex, {
        ...issue.actions[actionIndex]!,
        status: "skipped",
        result,
        updatedAt: nowIso(),
    });
    await context.persist(
        resultStateFor(
            issueStateWith(context.state, issueIndex, updatedIssue),
            result,
        ),
    );
    await context.emit({
        stage: "maintenance-mutation",
        status: "skipped",
        message: result.detail,
        repository: context.config.repo,
        issue: issueProgress(context.captured, issue.issueNumber),
        current: issueIndex + 1,
        total: context.selectedIssueNumbers.length,
        details: { kind: "mutation", result, action },
    });
    return { issue: updatedIssue, needsReplan: false };
};

const skipMaintenanceActionForGrounding = async (
    context: MaintenanceIssueExecutionContext,
    issueIndex: number,
    issue: MaintenanceIssueState,
    actionIndex: number,
    actionKey: string,
    detail: string,
): Promise<MaintenanceActionStep> => {
    const finalResult = {
        status: "skipped" as const,
        reason: "stale-plan" as const,
        actionKey,
        issueNumber: issue.issueNumber,
        detail,
    };
    context.reports.push({ status: "skipped", result: finalResult });
    const updatedIssue = updateIssueAction(issue, actionIndex, {
        ...issue.actions[actionIndex]!,
        status: "skipped",
        result: finalResult,
        updatedAt: nowIso(),
    });
    await context.persist(
        resultStateFor(
            issueStateWith(context.state, issueIndex, updatedIssue),
            finalResult,
        ),
    );
    await context.emit({
        stage: "maintenance-mutation",
        status: "skipped",
        message: finalResult.detail,
        repository: context.config.repo,
        issue: issueProgress(context.captured, issue.issueNumber),
        current: issueIndex + 1,
        total: context.selectedIssueNumbers.length,
        details: { kind: "mutation", result: finalResult },
    });
    return { issue: updatedIssue, needsReplan: false };
};

const liveStaleMaintenanceReasons = new Set([
    "stale-fingerprint",
    "issue-missing",
    "issue-inaccessible",
    "issue-closed",
    "comment-missing",
    "comment-ambiguous",
    "comment-url-mismatch",
    "source-issue-mismatch",
    "stale-answer",
    "candidate-missing",
    "candidate-invalid",
    "candidate-kind-mismatch",
    "candidate-stale",
    "candidate-not-eligible",
    "pair-missing",
    "pair-inaccessible",
    "pair-closed",
    "pair-changed",
]);

const isLiveStaleMaintenanceResult = (result: MaintenanceResult): boolean =>
    result.status === "skipped" &&
    liveStaleMaintenanceReasons.has(result.reason);

const invokeMaintenanceAdapter = async (
    context: MaintenanceIssueExecutionContext,
    action: ValidatedIssueMaintenanceAction,
    candidate: MaintenanceCandidate | undefined,
): Promise<MaintenanceResult> => {
    if (relationshipActionFor(action)) {
        const service = context.runtime.maintenanceRelationships;
        if (service === undefined) {
            throw mutationFailure(
                "Maintenance relationship service is unavailable.",
            );
        }
        return await service.reconcile(
            context.maintenanceClient,
            context.config.repo,
            {
                action: action as Extract<
                    ValidatedIssueMaintenanceAction,
                    {
                        readonly action:
                            | "link-duplicate"
                            | "close-duplicate"
                            | "link-related";
                    }
                >,
                candidate,
                snapshotFingerprint: context.captured.fingerprint,
                signal: context.signal,
            },
        );
    }
    const service = context.runtime.maintenanceMutation;
    if (service === undefined) {
        throw mutationFailure("Maintenance mutation service is unavailable.");
    }
    const issueUrl =
        context.captured.selectedIssues.find(
            (entry) => entry.number === action.issueNumber,
        )?.url ??
        context.captured.openIssueSummaries.find(
            (entry) => entry.number === action.issueNumber,
        )?.url;
    return await service.reconcile(
        context.maintenanceClient,
        context.config.repo,
        {
            action,
            snapshotFingerprint: context.captured.fingerprint,
            snapshot: context.captured,
            ...(issueUrl === undefined ? {} : { expectedIssueUrl: issueUrl }),
            signal: context.signal,
        },
    );
};

const recordMaintenanceResult = async (
    context: MaintenanceIssueExecutionContext,
    issueIndex: number,
    actionIndex: number,
    issue: MaintenanceIssueState,
    actionKey: string,
    result: MaintenanceResult,
): Promise<void> => {
    context.reports.push({
        status: resultStatusForReport(result),
        result,
    });
    await context.persist(
        resultStateFor(
            stateActionWith(context.state, issueIndex, actionIndex, {
                status:
                    result.status === "applied" ||
                    result.status === "unchanged" ||
                    result.status === "skipped"
                        ? result.status
                        : "in-progress",
                result,
                replanCount: issue.replanCount,
            }),
            result,
        ),
    );
    await context.emit({
        stage: "maintenance-mutation",
        status:
            result.status === "applied" || result.status === "unchanged"
                ? "succeeded"
                : result.status === "skipped"
                  ? "skipped"
                  : "failed",
        message: result.detail,
        repository: context.config.repo,
        issue: issueProgress(context.captured, issue.issueNumber),
        current: issueIndex + 1,
        total: context.selectedIssueNumbers.length,
        details: {
            kind: "mutation",
            actionKey,
            result,
            evidence: evidenceFromResult(result),
        },
    });
};

const reconcileMaintenanceAction = async (
    context: MaintenanceIssueExecutionContext,
    issueIndex: number,
    issue: MaintenanceIssueState,
    actionIndex: number,
    actionState: MaintenanceActionState,
    action: ValidatedIssueMaintenanceAction,
    actionKey: string,
): Promise<MaintenanceActionStep> => {
    await context.emit({
        stage: "maintenance-mutation",
        status: "started",
        message: `Reconciling maintenance action ${actionKey}...`,
        repository: context.config.repo,
        issue: issueProgress(context.captured, issue.issueNumber),
        current: issueIndex + 1,
        total: context.selectedIssueNumbers.length,
        details: {
            kind: "mutation",
            actionKey,
            action,
            snapshotFingerprint: context.captured.fingerprint,
        },
    });
    await context.persist(
        stateActionWith(context.state, issueIndex, actionIndex, {
            status: "in-progress",
            attempts: actionState.attempts + 1,
            replanCount: issue.replanCount,
        }),
    );
    const candidate = candidateFor(
        candidateAnalysisFrom(issue.candidates),
        action,
    );
    const result = await invokeMaintenanceAdapter(context, action, candidate);
    await recordMaintenanceResult(
        context,
        issueIndex,
        actionIndex,
        issue,
        actionKey,
        result,
    );
    // A signal may have fired after GitHub accepted a mutation. Persist and
    // report that authoritative result before observing cancellation so resume
    // does not repeat a completed action.
    checkCancellation(context.signal);
    const updatedIssue = context.state.issues[issueIndex] ?? issue;
    if (result.status === "recovery-required") {
        throw mutationFailure(
            `Maintenance action ${actionKey} requires recovery before another attempt: ${result.detail}`,
        );
    }
    if (!isLiveStaleMaintenanceResult(result)) {
        return { issue: updatedIssue, needsReplan: false };
    }
    const shouldReplan = await requestMaintenanceReplan(
        context,
        issueIndex,
        updatedIssue,
        actionIndex,
        result.detail,
    );
    return {
        issue: context.state.issues[issueIndex] ?? updatedIssue,
        needsReplan: shouldReplan,
    };
};

const executeUnsettledMaintenanceAction = async (
    context: MaintenanceIssueExecutionContext,
    issueIndex: number,
    issue: MaintenanceIssueState,
    actionIndex: number,
    actionState: MaintenanceActionState,
    action: ValidatedIssueMaintenanceAction,
    actionKey: string,
): Promise<MaintenanceActionStep> => {
    if (context.dryRun) {
        const result = {
            status: "dry-run" as const,
            actionKey,
            issueNumber: issue.issueNumber,
            detail: "dry-run reports this validated action without calling a GitHub mutation adapter",
            action,
        };
        context.reports.push({ status: "skipped", result });
        await context.emit({
            stage: "maintenance-mutation",
            status: "skipped",
            message: `Dry run would reconcile action ${actionKey}.`,
            repository: context.config.repo,
            issue: issueProgress(context.captured, issue.issueNumber),
            current: issueIndex + 1,
            total: context.selectedIssueNumbers.length,
            details: { kind: "mutation", ...result },
        });
        return { issue, needsReplan: false };
    }

    if (
        action.action === "close-duplicate" &&
        context.duplicateAction !== DuplicateAction.Close
    ) {
        return skipMaintenanceActionForPolicy(
            context,
            issueIndex,
            issue,
            actionIndex,
            action,
            actionKey,
        );
    }

    if (action.action !== "skip") {
        const grounding = await groundedAtSnapshot({
            runtime: context.runtime,
            snapshot: context.captured,
            repositoryPath: context.maintenanceRepositoryPath,
            branch: context.maintenanceBranch,
            signal: context.signal,
        });
        if (!grounding.current) {
            const shouldReplan = await requestMaintenanceReplan(
                context,
                issueIndex,
                issue,
                actionIndex,
                grounding.detail,
            );
            if (shouldReplan) {
                return {
                    issue: context.state.issues[issueIndex] ?? issue,
                    needsReplan: true,
                };
            }
            return skipMaintenanceActionForGrounding(
                context,
                issueIndex,
                issue,
                actionIndex,
                actionKey,
                grounding.detail,
            );
        }
    }
    return reconcileMaintenanceAction(
        context,
        issueIndex,
        issue,
        actionIndex,
        actionState,
        action,
        actionKey,
    );
};

const executeMaintenanceAction = async (
    context: MaintenanceIssueExecutionContext,
    issueIndex: number,
    issue: MaintenanceIssueState,
    actionIndex: number,
): Promise<MaintenanceActionStep> => {
    const actionState = issue.actions[actionIndex];
    if (actionState === undefined) {
        return { issue, needsReplan: false };
    }
    if (
        actionState.status === "applied" ||
        actionState.status === "unchanged" ||
        actionState.status === "skipped"
    ) {
        await emitReconciledAction(context, issueIndex, issue, actionState);
        return { issue, needsReplan: false };
    }
    const action =
        actionState.action as unknown as ValidatedIssueMaintenanceAction;
    const actionKey = actionState.actionKey || maintenanceActionKey(action);
    await context.emit({
        stage: "maintenance-action",
        status: "info",
        message: `Executing maintenance action ${actionKey}.`,
        repository: context.config.repo,
        issue: issueProgress(context.captured, issue.issueNumber),
        current: issueIndex + 1,
        total: context.selectedIssueNumbers.length,
        details: { kind: "action", actionKey, action },
    });
    return executeUnsettledMaintenanceAction(
        context,
        issueIndex,
        issue,
        actionIndex,
        actionState,
        action,
        actionKey,
    );
};

const executeMaintenanceActions = async (
    context: MaintenanceIssueExecutionContext,
    issueIndex: number,
    initialIssue: MaintenanceIssueState,
): Promise<MaintenanceActionStep> => {
    let issue = initialIssue;
    for (
        let actionIndex = 0;
        actionIndex < issue.actions.length;
        actionIndex++
    ) {
        const step = await executeMaintenanceAction(
            context,
            issueIndex,
            issue,
            actionIndex,
        );
        issue = step.issue;
        if (step.needsReplan) return step;
    }
    return { issue, needsReplan: false };
};

const completeMaintenanceIssue = async (
    context: MaintenanceIssueExecutionContext,
    issueIndex: number,
    issue: MaintenanceIssueState,
): Promise<void> => {
    const completed: MaintenanceIssueState = {
        ...issue,
        status: "complete",
        replanRequested: false,
        outcome: {
            status: "complete",
            actionCount: issue.actions.length,
        },
        updatedAt: nowIso(),
    };
    if (issue.actions.length === 0) {
        context.reports.push({
            status: "unchanged",
            result: completed.outcome,
        });
    }
    await context.persist(
        issueStateWith(
            { ...context.state, nextIssueIndex: issueIndex + 1 },
            issueIndex,
            completed,
        ),
    );
    await context.emit({
        stage: "maintenance-outcome",
        status: "succeeded",
        message: `Maintenance outcome recorded for issue #${String(issue.issueNumber)}.`,
        repository: context.config.repo,
        issue: issueProgress(context.captured, issue.issueNumber),
        current: issueIndex + 1,
        total: context.selectedIssueNumbers.length,
        details: {
            kind: "outcome",
            outcome: completed.outcome,
        },
    });
};

const executeMaintenanceIssue = async (
    context: MaintenanceIssueExecutionContext,
    issueIndex: number,
): Promise<void> => {
    let issue = await planMaintenanceIssue(context, issueIndex, false);
    if (issue.status === "complete" || issue.status === "skipped") return;
    while (true) {
        const actions = await executeMaintenanceActions(
            context,
            issueIndex,
            issue,
        );
        issue = actions.issue;
        if (!actions.needsReplan) {
            await completeMaintenanceIssue(context, issueIndex, issue);
            return;
        }
        issue = await planMaintenanceIssue(context, issueIndex, true);
        if (issue.status === "complete" || issue.status === "skipped") return;
    }
};

type MaintenancePreparedRepository = {
    readonly branch: string;
    readonly repositoryPath: string;
    readonly client: MaintenanceClient;
};

type MaintenanceCaptureResult = {
    readonly state: MutableMaintenanceState;
    readonly snapshot: MaintenanceSnapshot;
    readonly selectedIssueNumbers: ReadonlyArray<number>;
};

const reportsFromResumeState = (
    resumeState: MaintenanceRunState | undefined,
): MaintenanceReportResult[] => {
    const reports: MaintenanceReportResult[] = [];
    for (const reconciliation of resumeState?.reconciliationResults ?? []) {
        if (
            reconciliation.status !== "applied" &&
            reconciliation.status !== "unchanged" &&
            reconciliation.status !== "skipped" &&
            reconciliation.status !== "recovery-required"
        ) {
            continue;
        }
        reports.push({
            status:
                reconciliation.status === "recovery-required"
                    ? "failed"
                    : reconciliation.status,
            result: reconciliation.result,
        });
    }
    return reports;
};

const prepareMaintenanceWorkspace = async (input: {
    readonly config: MaintainIssuesRalphieConfig;
    readonly runtime: RalphieRuntime;
    readonly dryRun: boolean;
    readonly resumeState: MaintenanceRunState | undefined;
    readonly emit: MaintenanceEmit;
}): Promise<void> => {
    const { config, runtime, dryRun, resumeState, emit } = input;
    if (!dryRun && config.cleanStart && resumeState === undefined) {
        await emit({
            stage: "workspace-cleanup",
            status: "started",
            message: `Removing existing workspace ${config.workspace}...`,
            repository: config.repo,
        });
        await runtime.workspace.remove(config.workspace);
        await emit({
            stage: "workspace-cleanup",
            status: "succeeded",
            message: `Workspace removed: ${config.workspace}.`,
            repository: config.repo,
        });
    }
    if (dryRun) return;
    await emit({
        stage: "workspace-preparation",
        status: "started",
        message: `Preparing workspace ${config.workspace}...`,
        repository: config.repo,
    });
    await runtime.workspace.prepare(config.workspace);
    await emit({
        stage: "workspace-preparation",
        status: "succeeded",
        message: `Workspace ready: ${config.workspace}.`,
        repository: config.repo,
    });
};

const prepareMaintenanceRepository = async (input: {
    readonly config: MaintainIssuesRalphieConfig;
    readonly runtime: RalphieRuntime;
    readonly dryRun: boolean;
    readonly requestedBranch: string | undefined;
    readonly signal: AbortSignal | undefined;
    readonly emit: MaintenanceEmit;
}): Promise<MaintenancePreparedRepository> => {
    const { config, runtime, dryRun, requestedBranch, signal, emit } = input;
    await emit({
        stage: "github-authentication",
        status: "started",
        message: "Checking GitHub authentication...",
        repository: config.repo,
    });
    const client = await runtime.githubClient.initialize();
    await emit({
        stage: "github-authentication",
        status: "succeeded",
        message: "GitHub authentication verified.",
        repository: config.repo,
    });
    checkCancellation(signal);

    await emit({
        stage: "git-verification",
        status: "started",
        message: "Checking Git installation...",
        repository: config.repo,
    });
    await runtime.gitRepository.verifyInstalled();
    await emit({
        stage: "git-verification",
        status: "succeeded",
        message: "Git installation verified.",
        repository: config.repo,
    });

    if (dryRun) {
        const repositoryPath = await existingCheckoutPathFor(config);
        const invariant = await runtime.gitRepositoryInvariant.capture(
            repositoryPath,
            signal,
        );
        const branch =
            requestedBranch ??
            (await readOnlyFallbackBranch(
                runtime,
                repositoryPath,
                invariant.branch,
                signal,
            ));
        return { branch, repositoryPath, client };
    }

    const prepared = await runtime.gitRepository.prepare(
        config.repo,
        requestedBranch,
        config.workspace,
    );
    await emit({
        stage: "repository-preparation",
        status: "succeeded",
        message: `Repository ready on ${prepared.branch}: ${prepared.path}.`,
        repository: config.repo,
        details: {
            repositoryPath: prepared.path,
            branch: prepared.branch,
            cloned: prepared.cloned,
            cleaned: prepared.cleaned,
        },
    });
    return {
        branch: prepared.branch,
        repositoryPath: prepared.path,
        client,
    };
};

const pendingIssuesAfterSnapshotChange = (
    state: MutableMaintenanceState,
): MutableMaintenanceState => ({
    ...state,
    issues: state.issues.map((issue) =>
        issue.status === "complete" || issue.status === "skipped"
            ? issue
            : {
                  ...issue,
                  replanRequested: true,
                  status: "pending",
                  updatedAt: nowIso(),
              },
    ),
});

const captureMaintenanceContext = async (input: {
    readonly config: MaintainIssuesRalphieConfig;
    readonly runtime: RalphieRuntime;
    readonly signal: AbortSignal | undefined;
    readonly statePath: string;
    readonly actualRunId: string;
    readonly duplicateAction: DuplicateAction;
    readonly dryRun: boolean;
    readonly selection: MaintenanceSelectionState;
    readonly branch: string;
    readonly repositoryPath: string;
    readonly client: MaintenanceClient;
    readonly resumeState: MaintenanceRunState | undefined;
    readonly emit: MaintenanceEmit;
    readonly persist: (state: MutableMaintenanceState) => Promise<void>;
}): Promise<MaintenanceCaptureResult> => {
    const baseState =
        input.resumeState ??
        createInitialState({
            runId: input.actualRunId,
            repository: input.config.repo,
            branch: input.branch,
            duplicateAction: input.duplicateAction,
            selection: input.selection,
            dryRun: false,
        });
    if (input.resumeState === undefined) await input.persist(baseState);
    await input.emit({
        stage: "maintenance-observation",
        status: "started",
        message: "Capturing the complete maintenance snapshot...",
        repository: input.config.repo,
        details: {
            kind: "observation",
            branch: input.branch,
            selection: input.selection,
        },
    });
    const captured = await withMaintenanceRateLimitRetry({
        operation: "maintenance snapshot",
        signal: input.signal,
        run: () =>
            input.runtime.maintenanceSnapshot.capture({
                repository: input.config.repo,
                repositoryPath: input.repositoryPath,
                branch: input.branch,
                client: input.client,
                signal: input.signal,
                runId: input.actualRunId,
                selection: selectionInputFor(input.selection),
            }),
        onRetry: async ({ operation, attempt, delayMs, error }) => {
            await input.emit({
                stage: "maintenance-observation",
                status: "info",
                message: `Rate limit while reading ${operation}; retrying.`,
                repository: input.config.repo,
                details: { kind: "rate-limit", attempt, delayMs, error },
            });
        },
    });
    await input.emit({
        stage: "maintenance-observation",
        status: "succeeded",
        message: `Maintenance snapshot captured (${captured.selectedIssueNumbers.length} selected issues).`,
        repository: input.config.repo,
        details: {
            kind: "observation",
            snapshotFingerprint: captured.fingerprint,
            groundingFingerprint: captured.grounding?.head,
            metadata: captured.metadata,
            skips: captured.skips,
        },
    });

    const selectedIssueNumbers = Object.freeze([
        ...(input.resumeState?.selectedIssueNumbers ??
            captured.selectedIssueNumbers),
    ]);
    const savedIssues = input.resumeState?.issues ?? [];
    const issues = selectedIssueNumbers.map(
        (issueNumber) =>
            savedIssues.find((issue) => issue.issueNumber === issueNumber) ??
            emptyIssueState(issueNumber),
    );
    const snapshotChanged =
        input.resumeState?.snapshotFingerprint !== undefined &&
        input.resumeState.snapshotFingerprint !== captured.fingerprint;
    let nextState: MutableMaintenanceState = {
        ...baseState,
        branch: input.branch,
        selection: input.selection,
        selectedIssueNumbers,
        snapshotFingerprint: captured.fingerprint,
        ...(captured.grounding?.head === undefined
            ? {}
            : { groundingFingerprint: captured.grounding.head }),
        issues,
        nextIssueIndex: Math.min(
            input.resumeState?.nextIssueIndex ?? 0,
            issues.length,
        ),
        status: "active",
        lastError: undefined,
        updatedAt: nowIso(),
    };
    if (snapshotChanged) {
        nextState = pendingIssuesAfterSnapshotChange(nextState);
        await input.emit({
            stage: "maintenance-replan",
            status: "info",
            message:
                "The resumed snapshot changed; pending plans will be replanned.",
            repository: input.config.repo,
            details: {
                kind: "replan",
                previousSnapshotFingerprint:
                    input.resumeState?.snapshotFingerprint,
                snapshotFingerprint: captured.fingerprint,
            },
        });
    }
    await input.persist(nextState);
    return { state: nextState, snapshot: captured, selectedIssueNumbers };
};

type StartedMaintenanceOpenCode = Awaited<
    ReturnType<RalphieRuntime["opencode"]["start"]>
>;

const startMaintenancePlanner = async (input: {
    readonly config: MaintainIssuesRalphieConfig;
    readonly runtime: RalphieRuntime;
    readonly emit: MaintenanceEmit;
    readonly onStarted: (service: StartedMaintenanceOpenCode) => void;
}): Promise<MaintenancePlanService> => {
    if (input.runtime.maintenancePlanner !== undefined) {
        return input.runtime.maintenancePlanner;
    }
    await input.emit({
        stage: "opencode-runtime",
        status: "started",
        message:
            "Starting OpenCode runtime for read-only maintenance planning...",
        repository: input.config.repo,
    });
    const started = await input.runtime.opencode.start();
    input.onStarted(started);
    const planner =
        input.runtime.maintenancePlannerForAgent?.(started.client) ??
        makeMaintenancePlanService({
            agent: started.client,
            repositoryInvariant: input.runtime.gitRepositoryInvariant,
        });
    await input.emit({
        stage: "opencode-runtime",
        status: "succeeded",
        message: "OpenCode runtime ready for read-only planning.",
        repository: input.config.repo,
    });
    return planner;
};

const finishMaintenanceRun = async (input: {
    readonly config: MaintainIssuesRalphieConfig;
    readonly runtime: RalphieRuntime;
    readonly progress: RalphieRuntime["progress"];
    readonly dryRun: boolean;
    readonly statePath: string;
    readonly captured: MaintenanceSnapshot;
    readonly actualRunId: string;
    readonly branch: string;
    readonly selectedIssueNumbers: ReadonlyArray<number>;
    readonly state: MutableMaintenanceState;
    readonly reports: MaintenanceReportResult[];
    readonly emit: MaintenanceEmit;
    readonly persist: (state: MutableMaintenanceState) => Promise<void>;
    readonly noIssues: boolean;
}): Promise<MaintenanceRunSummary> => {
    const summary: MaintenanceRunSummary = {
        runId: input.actualRunId,
        repository: input.config.repo,
        branch: input.branch,
        statePath: input.statePath,
        snapshotFingerprint: input.captured.fingerprint,
        selectedIssueNumbers: input.selectedIssueNumbers,
        counts: summaryFromReports(input.reports, input.state, false),
        dryRun: input.dryRun,
        evidence: [
            input.captured.metadata,
            ...input.captured.skips,
            ...input.reports.map((report) => report.result),
        ],
    };
    if (!input.dryRun) {
        await input.persist({
            ...input.state,
            status: "complete",
            nextIssueIndex: input.selectedIssueNumbers.length,
            updatedAt: nowIso(),
        });
    }
    if (!input.dryRun && input.config.cleanEnd) {
        await input.emit({
            stage: "workspace-cleanup",
            status: "started",
            message: `Removing workspace ${input.config.workspace}...`,
            repository: input.config.repo,
        });
        await input.runtime.workspace.remove(input.config.workspace);
        await input.progress.stopPersisting();
        await input.emit({
            stage: "workspace-cleanup",
            status: "succeeded",
            message: `Workspace removed: ${input.config.workspace}.`,
            repository: input.config.repo,
        });
    }
    await input.emit({
        stage: "run",
        status: "succeeded",
        message: input.noIssues
            ? "Maintenance completed; no issues matched the selection."
            : `Maintenance completed: ${summary.counts.changed} changed, ${summary.counts.unchanged} unchanged, ${summary.counts.skipped} skipped, ${summary.counts.replanned} replanned.`,
        repository: input.config.repo,
        details: summary,
    });
    return summary;
};

const executeMaintenanceIssues = async (input: {
    readonly config: MaintainIssuesRalphieConfig;
    readonly runtime: RalphieRuntime;
    readonly progress: RalphieRuntime["progress"];
    readonly signal: AbortSignal | undefined;
    readonly statePath: string;
    readonly actualRunId: string;
    readonly duplicateAction: DuplicateAction;
    readonly dryRun: boolean;
    readonly selection: MaintenanceSelectionState;
    readonly branch: string;
    readonly repositoryPath: string;
    readonly client: MaintenanceClient;
    readonly captured: MaintenanceSnapshot;
    readonly selectedIssueNumbers: ReadonlyArray<number>;
    readonly state: MutableMaintenanceState;
    readonly reports: MaintenanceReportResult[];
    readonly emit: MaintenanceEmit;
    readonly persist: (state: MutableMaintenanceState) => Promise<void>;
    readonly onOpenCodeStarted: (service: StartedMaintenanceOpenCode) => void;
}): Promise<MaintenanceRunSummary> => {
    if (input.selectedIssueNumbers.length === 0) {
        return finishMaintenanceRun({ ...input, noIssues: true });
    }
    const planner = await startMaintenancePlanner({
        config: input.config,
        runtime: input.runtime,
        emit: input.emit,
        onStarted: input.onOpenCodeStarted,
    });
    const context: MaintenanceIssueExecutionContext = {
        config: input.config,
        runtime: input.runtime,
        signal: input.signal,
        statePath: input.statePath,
        actualRunId: input.actualRunId,
        duplicateAction: input.duplicateAction,
        dryRun: input.dryRun,
        selection: input.selection,
        selectedIssueNumbers: input.selectedIssueNumbers,
        maintenanceBranch: input.branch,
        maintenanceRepositoryPath: input.repositoryPath,
        maintenanceClient: input.client,
        captured: input.captured,
        planner,
        reports: input.reports,
        state: input.state,
        emit: input.emit,
        persist: async (next) => {
            await input.persist(next);
            context.state = next;
        },
    };
    for (
        let issueIndex = context.state.nextIssueIndex;
        issueIndex < input.selectedIssueNumbers.length;
        issueIndex += 1
    ) {
        checkCancellation(input.signal);
        await executeMaintenanceIssue(context, issueIndex);
    }
    return finishMaintenanceRun({
        ...input,
        state: context.state,
        noIssues: false,
    });
};

const persistMaintenanceFailure = async (input: {
    readonly dryRun: boolean;
    readonly state: MutableMaintenanceState | undefined;
    readonly statePath: string;
    readonly config: MaintainIssuesRalphieConfig;
    readonly emit: MaintenanceEmit;
    readonly persist: (state: MutableMaintenanceState) => Promise<void>;
    readonly error: unknown;
}): Promise<void> => {
    if (input.dryRun || input.state === undefined) return;
    await input.persist({
        ...input.state,
        status: "failed",
        lastError: errorMessage(input.error),
        updatedAt: nowIso(),
    });
    await input.emit({
        stage: "maintenance-recovery",
        status: "succeeded",
        message: "Maintenance failure state was persisted for resume.",
        repository: input.config.repo,
        details: { kind: "recovery", statePath: input.statePath },
    });
};

const emitMaintenanceFailure = async (input: {
    readonly config: MaintainIssuesRalphieConfig;
    readonly actualRunId: string;
    readonly statePath: string;
    readonly dryRun: boolean;
    readonly state: MutableMaintenanceState | undefined;
    readonly reports: ReadonlyArray<MaintenanceReportResult>;
    readonly emit: MaintenanceEmit;
    readonly error: unknown;
}): Promise<void> => {
    await input.emit({
        stage: "run",
        status: "failed",
        message: `Maintenance failed: ${errorMessage(input.error)}`,
        repository: input.config.repo,
        details: {
            kind: "outcome",
            runId: input.actualRunId,
            statePath: input.statePath,
            dryRun: input.dryRun,
            counts:
                input.state === undefined
                    ? undefined
                    : summaryFromReports(input.reports, input.state, true),
            evidence: input.reports.map((report) => report.result),
        },
    });
};

type MaintenanceRunInputs = {
    readonly stateStore: MaintenanceRunStateStoreService;
    readonly statePath: string;
    readonly resumeState: MaintenanceRunState | undefined;
    readonly actualRunId: string;
    readonly duplicateAction: DuplicateAction;
    readonly requestedBranch: string | undefined;
    readonly selection: MaintenanceSelectionState;
    readonly dryRun: boolean;
    readonly reports: MaintenanceReportResult[];
};

const maintenanceRunInputsFor = async (
    options: MaintainIssuesOptions,
    runtime: RalphieRuntime,
): Promise<MaintenanceRunInputs> => {
    const { config, signal } = options;
    checkCancellation(signal);
    const stateStore: MaintenanceRunStateStoreService =
        runtime.maintenanceRunStateStore ?? MaintenanceRunStateStoreLive;
    const statePath =
        config.resume ??
        join(
            resolveWorkspacePath(config.workspace),
            ".ralphie",
            "runs",
            options.runId,
            "state.json",
        );
    const resumeExpectations = {
        repository: config.repo,
        branch: config.branch,
        dryRun: config.dryRun,
        ...(options.explicitDuplicateAction === undefined
            ? {}
            : { duplicateAction: options.explicitDuplicateAction }),
    };
    const resumeState =
        options.resumeState ??
        (config.resume === undefined
            ? undefined
            : await loadMaintenanceRunState(
                  statePath,
                  resumeExpectations,
                  stateStore,
              ));
    if (resumeState !== undefined) {
        validateMaintenanceResumeState(resumeState, resumeExpectations);
    }
    return {
        stateStore,
        statePath,
        resumeState,
        actualRunId: resumeState?.runId ?? options.runId,
        duplicateAction: resumeState?.duplicateAction ?? config.duplicateAction,
        requestedBranch: resumeState?.branch ?? config.branch,
        selection: resumeState?.selection ?? selectionFor(config),
        dryRun: config.dryRun,
        reports: reportsFromResumeState(resumeState),
    };
};

const handleMaintenanceFailure = async (input: {
    readonly dryRun: boolean;
    readonly state: MutableMaintenanceState | undefined;
    readonly statePath: string;
    readonly config: MaintainIssuesRalphieConfig;
    readonly actualRunId: string;
    readonly reports: ReadonlyArray<MaintenanceReportResult>;
    readonly emit: MaintenanceEmit;
    readonly persist: (state: MutableMaintenanceState) => Promise<void>;
    readonly error: unknown;
}): Promise<unknown> => {
    let error = input.error;
    try {
        await persistMaintenanceFailure({
            dryRun: input.dryRun,
            state: input.state,
            statePath: input.statePath,
            config: input.config,
            emit: input.emit,
            persist: input.persist,
            error,
        });
    } catch (persistError) {
        error = mutationFailure(
            `${errorMessage(error)}; failed to persist maintenance recovery state: ${errorMessage(persistError)}`,
            error,
        );
    }
    try {
        await emitMaintenanceFailure({
            config: input.config,
            actualRunId: input.actualRunId,
            statePath: input.statePath,
            dryRun: input.dryRun,
            state: input.state,
            reports: input.reports,
            emit: input.emit,
            error,
        });
    } catch {
        // A renderer failure must not prevent the durable failure state or
        // the original command error from reaching the CLI boundary.
    }
    return error;
};

/** Run one bounded maintenance pass and return its summary internally. */
export const executeMaintenanceRun = async (
    options: MaintainIssuesOptions,
    runtime: RalphieRuntime,
): Promise<MaintenanceRunSummary> => {
    const { config, signal } = options;
    const {
        stateStore,
        statePath,
        resumeState,
        actualRunId,
        duplicateAction,
        requestedBranch,
        selection,
        dryRun,
        reports,
    } = await maintenanceRunInputsFor(options, runtime);
    let state: MutableMaintenanceState | undefined;
    let startedOpenCode: StartedMaintenanceOpenCode | undefined;

    const persist = async (next: MutableMaintenanceState): Promise<void> => {
        state = next;
        if (!dryRun) await stateStore.save(statePath, next);
    };
    const emit: MaintenanceEmit = async (update) => {
        await runtime.progress.emit(update);
    };

    try {
        await emit({
            stage: "run",
            status: "info",
            message: `Ralphie maintenance started for ${config.repo}.`,
            repository: config.repo,
            details: {
                mode: config.mode,
                runId: actualRunId,
                duplicateAction,
                dryRun,
                ...(requestedBranch === undefined ? {} : { requestedBranch }),
                statePath,
                ...(resumeState === undefined ? {} : { resumed: true }),
            },
        });
        await prepareMaintenanceWorkspace({
            config,
            runtime,
            dryRun,
            resumeState,
            emit,
        });
        const prepared = await prepareMaintenanceRepository({
            config,
            runtime,
            dryRun,
            requestedBranch,
            signal,
            emit,
        });
        checkCancellation(signal);
        const captured = await captureMaintenanceContext({
            config,
            runtime,
            signal,
            statePath,
            actualRunId,
            duplicateAction,
            dryRun,
            selection,
            branch: prepared.branch,
            repositoryPath: prepared.repositoryPath,
            client: prepared.client,
            resumeState,
            emit,
            persist,
        });
        state = captured.state;
        return await executeMaintenanceIssues({
            config,
            runtime,
            progress: runtime.progress,
            signal,
            statePath,
            actualRunId,
            duplicateAction,
            dryRun,
            selection,
            branch: prepared.branch,
            repositoryPath: prepared.repositoryPath,
            client: prepared.client,
            captured: captured.snapshot,
            selectedIssueNumbers: captured.selectedIssueNumbers,
            state: captured.state,
            reports,
            emit,
            persist,
            onOpenCodeStarted: (started) => {
                startedOpenCode = started;
            },
        });
    } catch (error) {
        const finalError = await handleMaintenanceFailure({
            dryRun,
            state,
            statePath,
            config,
            actualRunId,
            reports,
            emit,
            persist,
            error,
        });
        if (finalError instanceof Error) throw finalError;
        throw mutationFailure("Maintenance failed.", finalError);
    } finally {
        await startedOpenCode?.close();
    }
};

/** Public command entry point. */
export const maintainIssues: MaintainIssuesEntryPoint = async (
    options,
    runtime,
): Promise<void> => {
    await executeMaintenanceRun(options, runtime);
};